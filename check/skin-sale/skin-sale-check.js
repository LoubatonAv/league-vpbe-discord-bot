require("dotenv").config();
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const cheerio = require("cheerio");

const STATE_FILE = path.join(__dirname, "skin-sale-state.json");
const DEBUG_HTML_FILE = path.join(__dirname, "debug-loldb-skin-sale.html");
const DEBUG_JSON_FILE = path.join(__dirname, "debug-loldb-skin-sale.json");

const SALE_URL = "https://loldb.info/skin-sale";

const DISCORD_WEBHOOK_URL =
  process.env.SKIN_SALE_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL;

const SEND_TO_DISCORD = process.env.SEND_TO_DISCORD !== "false";

const SKIN_SALE_SHOW_REMOVED =
  String(process.env.SKIN_SALE_SHOW_REMOVED || "false").toLowerCase() ===
  "true";
// ================= STATE =================

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return {
      hash: null,
      saleRange: null,
      skins: [],
      updatedAt: null,
    };
  }

  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {
      hash: null,
      saleRange: null,
      skins: [],
      updatedAt: null,
    };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ================= HELPERS =================

function normalizeText(text = "") {
  return text.replace(/\s+/g, " ").trim();
}

function createHash(payload) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

function getDiscountEmoji(discount) {
  if (discount >= 60) return "🔥";
  if (discount >= 50) return "🟢";
  if (discount >= 40) return "🟡";
  if (discount >= 30) return "🟠";
  return "🔵";
}

function getSkinKey(skin) {
  return `${skin.name}|${skin.discount}|${skin.salePrice}|${skin.originalPrice}`;
}

function skinForHash(skin) {
  return {
    name: skin.name,
    discount: skin.discount,
    salePrice: skin.salePrice,
    originalPrice: skin.originalPrice,
  };
}

function buildHashPayload(sale) {
  return {
    skins: sale.skins.map(skinForHash),
  };
}

function sortSkins(skins) {
  return [...skins].sort((a, b) => {
    if (b.discount !== a.discount) return b.discount - a.discount;
    return a.name.localeCompare(b.name);
  });
}

function dedupeSkins(skins) {
  const map = new Map();

  for (const skin of skins) {
    map.set(getSkinKey(skin), skin);
  }

  return [...map.values()];
}

function groupSkinsByExactDiscount(skins) {
  const grouped = {};

  for (const skin of skins) {
    const key = skin.discount;

    if (!grouped[key]) {
      grouped[key] = [];
    }

    grouped[key].push(skin);
  }

  return Object.entries(grouped)
    .map(([discount, sectionSkins]) => ({
      discount: Number(discount),
      title: `${getDiscountEmoji(Number(discount))} ${discount}% OFF`,
      skins: sortSkins(sectionSkins),
    }))
    .sort((a, b) => b.discount - a.discount);
}

function splitDiscordMessage(text, maxLength = 3900) {
  const lines = text.split("\n");
  const chunks = [];
  let current = "";

  for (const line of lines) {
    if ((current + line + "\n").length > maxLength) {
      if (current.trim()) chunks.push(current.trim());
      current = "";
    }

    current += line + "\n";
  }

  if (current.trim()) chunks.push(current.trim());

  return chunks;
}

// ================= FETCH =================

async function fetchHtml() {
  const browser = await chromium.launch({
    headless: true,
  });

  const page = await browser.newPage({
    viewport: {
      width: 1440,
      height: 1600,
    },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });

  try {
    await page.goto(SALE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    await page.waitForTimeout(5000);

    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 900);
      await page.waitForTimeout(700);
    }

    return await page.content();
  } finally {
    await browser.close();
  }
}

// ================= SCRAPE =================

function parseSaleText(text, href = "") {
  const clean = normalizeText(text);

  if (!clean) return null;
  if (/showing/i.test(clean)) return null;
  if (/skin sale/i.test(clean)) return null;
  if (/discounts end/i.test(clean)) return null;

  const patterns = [
    /^-?\s*(\d{1,2})\s*%\s+(.+?)\s+(\d{3,4})\s+(\d{3,4})$/i,
    /^(.+?)\s+-?\s*(\d{1,2})\s*%\s+(\d{3,4})\s+(\d{3,4})$/i,
    /^(.+?)\s+(\d{3,4})\s+(\d{3,4})\s+-?\s*(\d{1,2})\s*%$/i,
  ];

  for (let i = 0; i < patterns.length; i++) {
    const match = clean.match(patterns[i]);

    if (!match) continue;

    let name;
    let discount;
    let salePrice;
    let originalPrice;

    if (i === 0) {
      discount = Number(match[1]);
      name = normalizeText(match[2]);
      salePrice = Number(match[3]);
      originalPrice = Number(match[4]);
    } else if (i === 1) {
      name = normalizeText(match[1]);
      discount = Number(match[2]);
      salePrice = Number(match[3]);
      originalPrice = Number(match[4]);
    } else {
      name = normalizeText(match[1]);
      salePrice = Number(match[2]);
      originalPrice = Number(match[3]);
      discount = Number(match[4]);
    }

    if (!name) return null;
    if (name.length > 80) return null;
    if (!discount || !salePrice || !originalPrice) return null;
    if (discount < 1 || discount > 90) return null;

    return {
      name,
      discount,
      salePrice,
      originalPrice,
      href: href
        ? href.startsWith("http")
          ? href
          : `https://loldb.info${href}`
        : SALE_URL,
      source: "LoLDB",
    };
  }

  return null;
}

function parseSalePage(html) {
  const $ = cheerio.load(html);

  const rawText = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"');

  const pageText = normalizeText(rawText);

  const rangeMatch = pageText.match(/Discounts End in\s+(.+?)\s+Check out/i);

  const saleRange = rangeMatch
    ? `Discounts End in ${normalizeText(rangeMatch[1])}`
    : "Skin Sale";

  const found = [];

  const saleBlockMatch = pageText.match(
    /Showing\s+\d+\s+of\s+\d+\s+discounts\s+(.+?)\s+Filters/i,
  );

  const saleText = saleBlockMatch ? saleBlockMatch[1] : pageText;

  const saleRegex =
    /-\s*(\d{1,2})\s*%\s+(.+?)\s+(\d{3,4})\s+(\d{3,4})(?=\s+-\s*\d{1,2}\s*%|\s*$)/g;

  let match;

  while ((match = saleRegex.exec(saleText)) !== null) {
    found.push({
      discount: Number(match[1]),
      name: normalizeText(match[2]),
      salePrice: Number(match[3]),
      originalPrice: Number(match[4]),
      href: SALE_URL,
      source: "LoLDB",
    });
  }

  return {
    saleRange,
    skins: sortSkins(dedupeSkins(found)),
  };
}

// ================= DIFF =================

function getDiff(oldSkins = [], newSkins = []) {
  const oldMap = new Map(oldSkins.map((skin) => [getSkinKey(skin), skin]));
  const newMap = new Map(newSkins.map((skin) => [getSkinKey(skin), skin]));

  const added = [];
  const removed = [];

  for (const [key, skin] of newMap) {
    if (!oldMap.has(key)) added.push(skin);
  }

  for (const [key, skin] of oldMap) {
    if (!newMap.has(key)) removed.push(skin);
  }

  return { added, removed };
}

// ================= FORMAT =================

function formatSkinLine(skin) {
  return `• ${skin.name} — ${skin.salePrice} RP / ${skin.originalPrice} RP`;
}

function formatDiscordMessage({
  saleRange,
  skins,
  diff = null,
  onlyChanges = false,
}) {
  let msg = "";

  msg += `🔗 ${SALE_URL}\n`;

  if (saleRange && !onlyChanges) {
    msg += `📅 ${saleRange}\n`;
  }

  msg += `\n`;

  if (onlyChanges) {
    const added = diff?.added || [];
    const removed = diff?.removed || [];

    const shouldShowRemoved = SKIN_SALE_SHOW_REMOVED && removed.length > 0;

    if (!added.length && !shouldShowRemoved) {
      return "";
    }

    msg += `🧾 **Changes Since Last Check**\n\n`;

    if (added.length) {
      msg += `🟢 **Added / Changed**\n`;

      const sections = groupSkinsByExactDiscount(added);

      for (const section of sections) {
        msg += `${section.title}\n`;

        for (const skin of section.skins) {
          msg += `${formatSkinLine(skin)}\n`;
        }

        msg += `\n`;
      }
    }

    if (shouldShowRemoved) {
      msg += `🔴 **Removed / Expired**\n`;

      const sections = groupSkinsByExactDiscount(removed);

      for (const section of sections) {
        msg += `${section.title}\n`;

        for (const skin of section.skins) {
          msg += `${formatSkinLine(skin)}\n`;
        }

        msg += `\n`;
      }
    }

    return msg.trim();
  }

  const sections = groupSkinsByExactDiscount(skins);

  for (const section of sections) {
    msg += `${section.title}\n`;

    for (const skin of section.skins) {
      msg += `${formatSkinLine(skin)}\n`;
    }

    msg += `\n`;
  }

  return msg.trim();
}

// ================= DISCORD =================

async function sendToDiscord(message, skins = []) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log("No DISCORD_WEBHOOK_URL found");
    return;
  }

  const bestDiscount = Math.max(...skins.map((s) => s.discount), 0);

  let color = 0x5865f2;

  if (bestDiscount >= 50) {
    color = 0x57f287;
  } else if (bestDiscount >= 35) {
    color = 0xfee75c;
  }

  const chunks = splitDiscordMessage(message);

  for (const [index, chunk] of chunks.entries()) {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        embeds: [
          {
            title:
              chunks.length > 1
                ? `🛒 League Weekly Skin Sale Updated (${index + 1}/${chunks.length})`
                : "🛒 League Weekly Skin Sale Updated",
            description: chunk,
            color,
            footer: {
              text: "League Skin Sale Tracker",
            },
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });

    if (!res.ok) {
      console.log(await res.text());
      throw new Error(`Discord failed ${res.status}`);
    }
  }
}

async function sendErrorToDiscord(error) {
  const webhook = process.env.ERROR_WEBHOOK_URL;

  if (!webhook) {
    console.log("No ERROR_WEBHOOK_URL found");
    return;
  }

  const content =
    `🚨 Bot Error\n` +
    `📄 Script: ${path.basename(__filename)}\n\n` +
    `❌ ${error.stack || error.message || error}`;

  try {
    await fetch(webhook, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: content.slice(0, 1900),
      }),
    });
  } catch (err) {
    console.error("Failed sending error webhook:", err);
  }
}

// ================= MAIN =================

async function main() {
  console.log("Checking League weekly skin sale from LoLDB");
  console.log(`SEND_TO_DISCORD = ${SEND_TO_DISCORD}`);

  const html = await fetchHtml();

  if (process.env.DEBUG_SKIN_SALE === "true") {
    fs.writeFileSync(DEBUG_HTML_FILE, html);
  }

  const sale = parseSalePage(html);

  if (process.env.DEBUG_SKIN_SALE === "true") {
    fs.writeFileSync(DEBUG_JSON_FILE, JSON.stringify(sale, null, 2));
  }

  console.log(`Sale range: ${sale.saleRange || "Unknown"}`);
  console.log(`Skins found: ${sale.skins.length}`);

  for (const skin of sale.skins) {
    console.log(formatSkinLine(skin));
  }

  if (sale.skins.length < 3) {
    throw new Error(
      "Too few skins parsed from LoLDB. Page structure may have changed.",
    );
  }

  const newHash = createHash(buildHashPayload(sale));

  const state = loadState();

  if (!state.hash) {
    console.log("Initializing skin sale state");

    const message = formatDiscordMessage({
      saleRange: sale.saleRange,
      skins: sale.skins,
    });

    console.log("\n=== DISCORD MESSAGE PREVIEW ===\n");
    console.log(message);
    console.log("\n===============================\n");

    if (SEND_TO_DISCORD) {
      await sendToDiscord(message, sale.skins);
      console.log("Sent initial skin sale list to Discord");
    }

    saveState({
      hash: newHash,
      saleRange: sale.saleRange,
      skins: sale.skins,
      updatedAt: new Date().toISOString(),
    });

    return;
  }

  if (state.hash === newHash) {
    console.log("No skin sale changes");

    saveState({
      hash: newHash,
      saleRange: sale.saleRange,
      skins: sale.skins,
      updatedAt: new Date().toISOString(),
    });

    return;
  }

  const diff = getDiff(state.skins, sale.skins);

  console.log(`Added: ${diff.added.length}`);
  console.log(`Removed: ${diff.removed.length}`);

  if (!diff.added.length && (!SKIN_SALE_SHOW_REMOVED || !diff.removed.length)) {
    console.log(
      "Skin sale hash changed, but there are no visible changes to alert.",
    );

    saveState({
      hash: newHash,
      saleRange: sale.saleRange,
      skins: sale.skins,
      updatedAt: new Date().toISOString(),
    });

    return;
  }

  const message = formatDiscordMessage({
    saleRange: sale.saleRange,
    skins: sale.skins,
    diff,
    onlyChanges: true,
  });

  if (!message) {
    console.log("No visible skin sale message to send.");

    saveState({
      hash: newHash,
      saleRange: sale.saleRange,
      skins: sale.skins,
      updatedAt: new Date().toISOString(),
    });

    return;
  }

  console.log("\n=== DISCORD MESSAGE PREVIEW ===\n");
  console.log(message);
  console.log("\n===============================\n");

  const changedSkins = [
    ...diff.added,
    ...(SKIN_SALE_SHOW_REMOVED ? diff.removed : []),
  ];

  if (SEND_TO_DISCORD) {
    await sendToDiscord(message, changedSkins);
    console.log("Sent skin sale update to Discord");
  } else {
    console.log("Dry run only");
  }

  saveState({
    hash: newHash,
    saleRange: sale.saleRange,
    skins: sale.skins,
    updatedAt: new Date().toISOString(),
  });
}

main().catch(async (err) => {
  console.error(err);

  await sendErrorToDiscord(err);

  process.exitCode = 1;
});
