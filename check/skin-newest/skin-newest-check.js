require("dotenv").config();

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { chromium } = require("playwright");

const STATE_FILE = path.join(__dirname, "skin-newest-state.json");
const DEBUG_JSON_FILE = path.join(__dirname, "debug-opgg-skins.json");
const DEBUG_HTML_FILE = path.join(__dirname, "debug-opgg-skins.html");
const DEBUG_SCREENSHOT_FILE = path.join(__dirname, "debug-opgg-skins.png");

const SKINS_URL = "https://op.gg/lol/skins";

const DISCORD_WEBHOOK_URL =
  process.env.SKIN_NEWEST_WEBHOOK_URL ||
  process.env.SKIN_SALE_WEBHOOK_URL ||
  process.env.DISCORD_WEBHOOK_URL;

const SEND_TO_DISCORD = process.env.SEND_TO_DISCORD !== "false";

// ================= STATE =================

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return {
      hash: null,
      skins: [],
      updatedAt: null,
    };
  }

  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {
      hash: null,
      skins: [],
      updatedAt: null,
    };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ================= HELPERS =================

function normalizeSkinUrl(url = "") {
  if (!url) return SKINS_URL;

  if (url.endsWith("/null")) {
    return url.replace(/\/null$/, "");
  }

  return url;
}

function normalizeText(text = "") {
  return text
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}

function createHash(payload) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

function cleanLine(line = "") {
  return normalizeText(line)
    .replace(/^new$/i, "")
    .replace(/^sale$/i, "")
    .replace(/^chroma$/i, "")
    .trim();
}

function isNoiseLine(line = "") {
  const value = normalizeText(line).toLowerCase();

  if (!value) return true;

  const noise = [
    "skins",
    "skin ranking",
    "newest release",
    "newest releases",
    "popular",
    "all tier",
    "select option",
    "champion",
    "skin search",
    "advertisement",
    "remove ads",
    "op.gg",
    "league of legends",
    "lol",
    "tier",
    "rp",
    "chromas",
    "chroma",
  ];

  if (noise.includes(value)) return true;
  if (/^\d+$/.test(value)) return true;
  if (/^\d+\s*rp$/i.test(value)) return true;
  if (/^patch\s*\d+/i.test(value)) return true;

  return false;
}

function sortSkins(skins) {
  return [...skins].sort((a, b) => {
    const aKey = `${a.name}-${a.champion}-${a.href}`;
    const bKey = `${b.name}-${b.champion}-${b.href}`;

    return aKey.localeCompare(bKey);
  });
}

function getSkinKey(skin) {
  return `${skin.name}|${skin.champion || "Unknown"}|${skin.href || ""}`;
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

function dedupeSkins(skins) {
  const map = new Map();

  for (const skin of skins) {
    const key = getSkinKey(skin);

    if (!map.has(key)) {
      map.set(key, skin);
    }
  }

  return [...map.values()];
}

// ================= SCRAPE =================

async function fetchNewestSkins() {
  const browser = await chromium.launch({
    headless: true,
  });

  const page = await browser.newPage({
    viewport: {
      width: 1440,
      height: 1600,
    },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 League Skin Newest Tracker/1.0",
  });

  try {
    await page.goto(SKINS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await page
      .waitForLoadState("load", {
        timeout: 30000,
      })
      .catch(() => {
        console.log("Page load state timeout, continuing anyway...");
      });

    // Give client-rendered content time to appear.
    await page.waitForTimeout(4000);

    // Try to scroll a bit so lazy-loaded skin cards/images appear.
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, 900);
      await page.waitForTimeout(800);
    }

    const html = await page.content();

    const rawCards = await page.evaluate(() => {
      function textOf(el) {
        return (el.innerText || el.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
      }

      function linesOf(el) {
        return (el.innerText || el.textContent || "")
          .split("\n")
          .map((line) => line.replace(/\s+/g, " ").trim())
          .filter(Boolean);
      }

      const selectors = ["a", "article", "li", "[role='listitem']", "div"];

      const nodes = Array.from(document.querySelectorAll(selectors.join(",")));

      const cards = [];

      for (const el of nodes) {
        const rect = el.getBoundingClientRect();
        const img = el.querySelector("img");

        if (!img) continue;
        if (rect.width < 80 || rect.height < 80) continue;
        if (rect.height > 800) continue;

        const text = textOf(el);
        const lines = linesOf(el);

        const href =
          el.href || el.closest("a")?.href || el.querySelector("a")?.href || "";

        const imgSrc =
          img.currentSrc || img.src || img.getAttribute("src") || "";

        const imgAlt =
          img.alt || img.getAttribute("alt") || img.getAttribute("title") || "";

        cards.push({
          text,
          lines,
          href,
          imgSrc,
          imgAlt,
          className: el.className ? String(el.className) : "",
        });
      }

      return cards;
    });

    if (process.env.DEBUG_OPGG_SKINS === "true") {
      fs.writeFileSync(DEBUG_JSON_FILE, JSON.stringify(rawCards, null, 2));
      fs.writeFileSync(DEBUG_HTML_FILE, html);
      await page.screenshot({
        path: DEBUG_SCREENSHOT_FILE,
        fullPage: true,
      });
    }

    const skins = parseCards(rawCards);

    return {
      skins,
      rawCardsCount: rawCards.length,
    };
  } finally {
    await browser.close();
  }
}

function parseCards(rawCards = []) {
  const tierRegex =
    /^(ultimate|legendary|epic|mythic|prestige|exalted|transcendent)$/i;

  const skins = [];

  for (const card of rawCards) {
    const lines = [...(card.lines || []), card.imgAlt]
      .map(cleanLine)
      .filter((line) => line && !isNoiseLine(line));

    const uniqueLines = [...new Set(lines)];

    if (uniqueLines.length === 0) continue;

    const tierLine = uniqueLines.find((line) => tierRegex.test(line));
    const tier = tierLine || "Unknown";

    const rpLine = uniqueLines.find((line) => /\d+\s*rp/i.test(line));
    let price = null;

    if (rpLine) {
      const match = rpLine.match(/(\d+)\s*rp/i);
      if (match) price = Number(match[1]);
    }

    const candidateLines = uniqueLines.filter((line) => {
      if (!line) return false;
      if (tierRegex.test(line)) return false;
      if (/\d+\s*rp/i.test(line)) return false;
      if (/no price data/i.test(line)) return false;
      if (/newest|release|skin|champion|search|ranking|select/i.test(line)) {
        return false;
      }

      return true;
    });

    /*
      Important:
      OP.GG often gives us parent containers like:
      ["PROJECT: Quinn", "Rain Shepherd Ivern"]
      Those are NOT one skin with champion=Rain Shepherd Ivern.
      They are two separate child cards grouped together.
      So if there are multiple candidate names, we skip this parent container.
    */
    if (candidateLines.length !== 1) {
      continue;
    }

    let name = normalizeText(candidateLines[0]);

    if (!name) continue;
    if (name.length > 80) continue;
    if (tierRegex.test(name)) continue;

    // Avoid obvious non-skin fragments.
    if (/select|search|ranking|advertisement/i.test(name)) continue;

    skins.push({
      name,
      champion: "Unknown",
      tier,
      price,
      href: normalizeSkinUrl(card.href),
      image: card.imgSrc || null,
      source: "OP.GG",
    });
  }

  return dedupeSkins(skins).slice(0, 30);
}

// ================= FORMAT =================

function formatSkinLine(skin) {
  const tierPart =
    skin.tier && skin.tier !== "Unknown" ? ` | ${skin.tier}` : "";

  const pricePart = skin.price ? ` | ${skin.price} RP` : "";

  return `• ${skin.name}${tierPart}${pricePart}`;
}

function formatDiscordMessage({ added }) {
  let msg = "";

  msg += `✨ New League Skins Released\n\n`;

  for (const skin of added) {
    const tierPart =
      skin.tier && skin.tier !== "Unknown" ? ` — ${skin.tier}` : "";

    msg += `• ${skin.name}${tierPart}\n`;
  }

  return msg.trim();
}

// ================= DISCORD =================

async function sendToDiscord(message, skins = []) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log("No Discord webhook found");
    return;
  }

  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      embeds: [
        {
          description: message.slice(0, 3900),
          color: 0xc084fc,
          footer: {
            text: "League Newest Skin Tracker",
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
  console.log("Checking newest League skins");
  console.log(`SEND_TO_DISCORD = ${SEND_TO_DISCORD}`);

  const result = await fetchNewestSkins();
  const skins = result.skins;

  console.log(`Raw cards found: ${result.rawCardsCount}`);
  console.log(`Skins parsed: ${skins.length}`);

  if (skins.length < 3) {
    throw new Error(
      `Too few skins parsed from OP.GG. Check debug files in check/skin-newest/.`,
    );
  }

  for (const skin of skins.slice(0, 20)) {
    console.log(formatSkinLine(skin));
    console.log(`  href: ${skin.href}`);
    console.log(`  image: ${skin.image}`);
  }

  const newHash = createHash({
    skins,
  });

  const state = loadState();

  if (!state.hash) {
    console.log("Initializing newest skins state");

    saveState({
      hash: newHash,
      skins,
      updatedAt: new Date().toISOString(),
    });

    return;
  }

  if (state.hash === newHash) {
    console.log("No newest skin changes");
    return;
  }

  const diff = getDiff(state.skins, skins);

  if (diff.added.length === 0) {
    console.log("Skin list changed, but no new skins were detected.");
    console.log("Saving updated state.");

    saveState({
      hash: newHash,
      skins,
      updatedAt: new Date().toISOString(),
    });

    return;
  }

  const message = formatDiscordMessage({
    added: diff.added,
  });

  console.log("\n=== DISCORD MESSAGE PREVIEW ===\n");
  console.log(message);
  console.log("\n===============================\n");

  if (SEND_TO_DISCORD) {
    await sendToDiscord(message, diff.added);
    console.log("Sent newest skin update to Discord");
  } else {
    console.log("Dry run only");
  }

  saveState({
    hash: newHash,
    skins,
    updatedAt: new Date().toISOString(),
  });
}

main().catch(async (err) => {
  console.error(err);

  await sendErrorToDiscord(err);

  process.exitCode = 1;
});
