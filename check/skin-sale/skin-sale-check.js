require("dotenv").config();

const fs = require("fs");
const crypto = require("crypto");
const cheerio = require("cheerio");

const STATE_FILE = "check/skin-sale/skin-sale-state.json";

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const SEND_TO_DISCORD = process.env.SEND_TO_DISCORD !== "false";

const SALE_URL = "https://mobalytics.gg/lol/guides/weekly-skin-sale";

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
      skins: sectionSkins,
    }))
    .sort((a, b) => b.discount - a.discount);
}

function getDiscountEmoji(discount) {
  if (discount >= 60) return "🔥";
  if (discount >= 50) return "🟢";
  if (discount >= 40) return "🟡";
  if (discount >= 30) return "🟠";
  return "🔵";
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ================= HELPERS =================

function normalizeText(text = "") {
  return text.replace(/\s+/g, " ").trim();
}

function titleCase(text = "") {
  return text
    .split(" ")
    .filter(Boolean)
    .map((word) => {
      if (word.length <= 2) return word.toUpperCase();

      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

function createHash(payload) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

function sortSkins(skins) {
  return [...skins].sort((a, b) => {
    const aKey = `${a.skinName}-${a.champion}-${a.salePrice}`;
    const bKey = `${b.skinName}-${b.champion}-${b.salePrice}`;

    return aKey.localeCompare(bKey);
  });
}

// ================= FETCH =================

async function fetchHtml() {
  const res = await fetch(SALE_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 League Skin Sale Tracker/1.0",
      Accept: "text/html,application/xhtml+xml",
    },
  });

  if (!res.ok) {
    throw new Error(`Sale page failed: ${res.status}`);
  }

  return res.text();
}

// ================= SCRAPE =================

function parseSalePage(html) {
  const $ = cheerio.load(html);

  const pageText = html
    .replace(/\\u002F/g, "/")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");

  let saleRange = null;

  const rangeMatch =
    pageText.match(/LoL Skin Sale:\s*([^"<\\]+)/i) ||
    pageText.match(/headline":"LoL Skin Sale:\s*([^"]+)/i);

  if (rangeMatch) {
    saleRange = normalizeText(rangeMatch[1]);
  }

  const skins = [];
  const regex = /"text":"([^"]+?)-(\d+)\s*RP\s*\((\d+)\s*RP\)-(\d+)%\s*Off"/gi;

  let match;

  while ((match = regex.exec(pageText)) !== null) {
    const fullName = normalizeText(match[1]);
    const salePrice = Number(match[2]);
    const originalPrice = Number(match[3]);
    const discount = Number(match[4]);

    const words = fullName.split(" ");
    const champion = words[words.length - 1];
    const skinName = words.slice(0, -1).join(" ");

    skins.push({
      fullName,
      displayName:
        skinName && champion ? `${champion} - ${skinName}` : fullName,
      skinName: titleCase(skinName || fullName),
      champion: titleCase(skinName ? champion : "Unknown"),
      tier: "Unknown",
      discount,
      salePrice,
      originalPrice,
    });
  }

  const unique = new Map();

  for (const skin of skins) {
    const key =
      `${skin.skinName}|${skin.champion}|` +
      `${skin.salePrice}|${skin.originalPrice}|${skin.discount}`;

    unique.set(key, skin);
  }

  return {
    saleRange,
    skins: sortSkins([...unique.values()]),
  };
}

// ================= DIFF =================

function getSkinKey(skin) {
  return (
    `${skin.skinName}|${skin.champion}|` +
    `${skin.salePrice}|${skin.originalPrice}|${skin.discount}`
  );
}

function getDiff(oldSkins = [], newSkins = []) {
  const oldMap = new Map(oldSkins.map((skin) => [getSkinKey(skin), skin]));

  const newMap = new Map(newSkins.map((skin) => [getSkinKey(skin), skin]));

  const added = [];
  const removed = [];

  for (const [key, skin] of newMap) {
    if (!oldMap.has(key)) {
      added.push(skin);
    }
  }

  for (const [key, skin] of oldMap) {
    if (!newMap.has(key)) {
      removed.push(skin);
    }
  }

  return { added, removed };
}

// ================= FORMAT =================

function formatSkinLine(skin) {
  return (
    `• ${skin.displayName} — ` +
    `${skin.salePrice} RP ${skin.originalPrice} RP ` +
    `(${skin.discount}% OFF)`
  );
}

function formatDiscordMessage({ saleRange, skins }) {
  let msg = "";

  msg += `🛒 League Weekly Skin Sale Updated\n`;

  if (saleRange) {
    msg += `📅 ${saleRange}\n`;
  }

  msg += `\n`;

  const sections = groupSkinsByExactDiscount(skins);

  for (const section of sections) {
    msg += `${section.title}\n`;

    const sorted = [...section.skins].sort((a, b) =>
      a.displayName.localeCompare(b.displayName),
    );

    for (const skin of sorted) {
      msg += `${formatSkinLine(skin)}\n`;
    }

    msg += `\n`;
  }

  return msg.trim();
}

// ================= DISCORD =================

function splitDiscordMessage(text, maxLength = 1900) {
  const lines = text.split("\n");

  const chunks = [];
  let current = "";

  for (const line of lines) {
    if ((current + line + "\n").length > maxLength) {
      if (current.trim()) {
        chunks.push(current.trim());
      }

      current = "";
    }

    current += line + "\n";
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

async function sendToDiscord(message, skins = []) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log("No DISCORD_WEBHOOK_URL found");
    return;
  }

  let color = 0x5865f2;

  const bestDiscount = Math.max(...skins.map((s) => s.discount), 0);

  if (bestDiscount >= 50) {
    color = 0x57f287;
  } else if (bestDiscount >= 35) {
    color = 0xfee75c;
  }

  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      embeds: [
        {
          title: "🛒 League Weekly Skin Sale Updated",
          description: message,
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

// ================= MAIN =================

async function main() {
  console.log("Checking League weekly skin sale");
  console.log(`SEND_TO_DISCORD = ${SEND_TO_DISCORD}`);

  const html = await fetchHtml();

  const sale = parseSalePage(html);

  if (sale.skins.length < 5) {
    throw new Error("Too few skins parsed. Page structure may have changed.");
  }

  console.log(`Sale range: ${sale.saleRange || "Unknown"}`);
  console.log(`Skins found: ${sale.skins.length}`);

  const hashPayload = {
    saleRange: sale.saleRange,
    skins: sale.skins,
  };

  const newHash = createHash(hashPayload);

  const state = loadState();

  if (!state.hash) {
    console.log("Initializing skin sale state");

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
    return;
  }

  const diff = getDiff(state.skins, sale.skins);

  const message = formatDiscordMessage({
    saleRange: sale.saleRange,
    skins: sale.skins,
    diff,
  });

  console.log("\n=== DISCORD MESSAGE PREVIEW ===\n");
  console.log(message);
  console.log("\n===============================\n");

  if (SEND_TO_DISCORD) {
    await sendToDiscord(message, sale.skins);
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

main().catch(console.error);
