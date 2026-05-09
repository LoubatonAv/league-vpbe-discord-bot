require("dotenv").config();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cheerio = require("cheerio");

const STATE_FILE = path.join(__dirname, "mythic-shop-state.json");

const DISCORD_WEBHOOK_URL = process.env.MYTHIC_SHOP_WEBHOOK_URL;
const SEND_TO_DISCORD = process.env.SEND_TO_DISCORD !== "false";

const MYTHIC_URL = "https://mobalytics.gg/lol/guides/mythic-shop-rotation";

// ================= STATE =================

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return {
      hash: null,
      title: null,
      rotationTitle: null,
      items: [],
      updatedAt: null,
    };
  }

  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {
      hash: null,
      title: null,
      rotationTitle: null,
      items: [],
      updatedAt: null,
    };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function createHash(payload) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

// ================= FETCH =================

async function fetchHtml() {
  const res = await fetch(MYTHIC_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 League Mythic Shop Tracker/1.0",
      Accept: "text/html,application/xhtml+xml",
    },
  });

  if (!res.ok) {
    throw new Error(`Mobalytics Mythic Shop page failed: ${res.status}`);
  }

  return res.text();
}

// ================= PARSE =================

function normalizeText(text = "") {
  return text.replace(/\s+/g, " ").trim();
}

function cleanHtmlText(text = "") {
  return normalizeText(
    text
      .replace(/\\u002F/g, "/")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g, "&"),
  );
}

function classifyItem(name = "") {
  const n = name.toLowerCase();

  if (n.includes("chroma")) return "chroma";
  if (n.includes("icon")) return "icon";
  if (n.includes("emote")) return "emote";
  if (n.includes("ward")) return "ward";
  if (n.includes("nexus finisher")) return "finisher";
  if (n.includes("prestige")) return "prestige";
  if (n.includes("hextech")) return "mythic";
  if (n.includes("ashen")) return "mythic";
  if (n.includes("crystalis")) return "mythic";
  if (n.includes("soulstealer")) return "mythic";

  return "skin";
}

function parseMythicShop(html) {
  const $ = cheerio.load(html);

  const bodyText = cleanHtmlText($("body").text());

  const title =
    normalizeText($("h1").first().text()) || "LoL Mythic Shop Rotation";

  const rotationTitleMatch = bodyText.match(
    /New Rotation\s*-\s*Until\s*([A-Za-z0-9\s]+?)(?:Prestige|Hextech|Soulstealer|Crystalis)/i,
  );

  const rotationTitle = rotationTitleMatch
    ? `Until ${normalizeText(rotationTitleMatch[1])}`
    : null;

  const items = [];

  const regex =
    /([A-Z][A-Za-z0-9:'’&().+\-/\s]+?)\s*[-–—]?\s*(\d+)\s*(?:ME|Mythic Essence)/gi;
  let match;

  while ((match = regex.exec(bodyText)) !== null) {
    let name = normalizeText(match[1]);
    const price = Number(match[2]);

    // ================= CLEAN =================

    name = name
      .replace(/GuideCountersCombos/gi, "")
      .replace(
        /make sure you head over to our Mobalytics Champion Page\.?/gi,
        "",
      )
      .replace(/New Rotation\s*-\s*Until\s*[A-Za-z0-9\s]+/gi, "")
      .replace(/\s+/g, " ")
      .trim();

    // ================= FILTER BAD MATCHES =================

    if (!name) continue;

    if (name.length < 4) continue;

    if (
      name.includes("Patch") ||
      name.includes("Mobalytics") ||
      name.includes("Champion Page") ||
      name.includes("Guides") ||
      name.includes("Counters") ||
      name.includes("Combos")
    ) {
      continue;
    }

    // ================= VALID ITEM CHECK =================

    const validPrefixes = [
      "Prestige",
      "Hextech",
      "Ashen",
      "Crystalis",
      "Soulstealer",
      "Mythic",
    ];

    const isValid = validPrefixes.some((prefix) => name.startsWith(prefix));

    if (!isValid) continue;

    items.push({
      type: classifyItem(name),
      name,
      price,
    });
  }

  // ================= DEDUPE =================

  const unique = new Map();

  for (const item of items) {
    const key = `${item.type}|${item.name}|${item.price}`;
    unique.set(key, item);
  }

  return {
    title,
    rotationTitle,
    items: [...unique.values()],
  };
}

// ================= DIFF =================

function getItemKey(item) {
  return `${item.type}|${item.name}|${item.price}`;
}

function getDiff(oldItems = [], newItems = []) {
  const oldMap = new Map(oldItems.map((item) => [getItemKey(item), item]));
  const newMap = new Map(newItems.map((item) => [getItemKey(item), item]));

  const added = [];
  const removed = [];

  for (const [key, item] of newMap) {
    if (!oldMap.has(key)) added.push(item);
  }

  for (const [key, item] of oldMap) {
    if (!newMap.has(key)) removed.push(item);
  }

  return { added, removed };
}

// ================= FORMAT =================

function emojiForType(type) {
  if (type === "prestige") return "✨";
  if (type === "mythic") return "💎";
  if (type === "chroma") return "🌈";
  if (type === "icon") return "🖼️";
  if (type === "emote") return "😄";
  if (type === "ward") return "👁️";
  if (type === "finisher") return "💥";
  return "🔹";
}

function titleForType(type) {
  if (type === "prestige") return "✨ Prestige Skins";
  if (type === "mythic") return "💎 Mythic Skins";
  if (type === "chroma") return "🌈 Chromas";
  if (type === "icon") return "🖼️ Icons";
  if (type === "emote") return "😄 Emotes";
  if (type === "ward") return "👁️ Ward Skins";
  if (type === "finisher") return "💥 Nexus Finishers";
  return "🔹 Other Skins";
}

function groupByType(items) {
  const grouped = {};

  for (const item of items) {
    if (!grouped[item.type]) grouped[item.type] = [];
    grouped[item.type].push(item);
  }

  return grouped;
}

function formatItemLine(item) {
  return `• ${item.name} — ${item.price} ME`;
}

function formatDiscordMessage({ mythic, diff }) {
  let msg = "";

  msg += `💎 **League Mythic Shop Rotation Updated**\n`;

  if (mythic.rotationTitle) {
    msg += `📅 ${mythic.rotationTitle}\n`;
  }

  msg += `🔗 <${MYTHIC_URL}>\n\n`;

  if (diff && (diff.added.length || diff.removed.length)) {
    if (diff.added.length) {
      msg += `🟢 **Added / Changed**\n`;
      for (const item of diff.added) {
        msg += `${emojiForType(item.type)} ${item.name} — ${item.price} ME\n`;
      }
      msg += `\n`;
    }

    if (diff.removed.length) {
      msg += `🔴 **Removed**\n`;
      for (const item of diff.removed) {
        msg += `• ${item.name} — ${item.price} ME\n`;
      }
      msg += `\n`;
    }
  }

  msg += `📋 **Current Rotation**\n\n`;

  const grouped = groupByType(mythic.items);
  const order = [
    "prestige",
    "mythic",
    "skin",
    "chroma",
    "ward",
    "emote",
    "icon",
    "finisher",
  ];

  for (const type of order) {
    const items = grouped[type];
    if (!items || !items.length) continue;

    msg += `${titleForType(type)}\n`;

    for (const item of items) {
      msg += `${formatItemLine(item)}\n`;
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
      if (current.trim()) chunks.push(current.trim());
      current = "";
    }

    current += line + "\n";
  }

  if (current.trim()) chunks.push(current.trim());

  return chunks;
}

async function sendToDiscord(message) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log("No DISCORD_WEBHOOK_URL found");
    return;
  }

  const chunks = splitDiscordMessage(message);

  for (const chunk of chunks) {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: chunk }),
    });

    if (!res.ok) {
      console.log(await res.text());
      throw new Error(`Discord failed ${res.status}`);
    }
  }
}

// ================= MAIN =================
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

async function main() {
  console.log("Checking Mythic Shop rotation");
  console.log(`SEND_TO_DISCORD = ${SEND_TO_DISCORD}`);
  console.log(`STATE_FILE = ${STATE_FILE}`);

  const html = await fetchHtml();
  const mythic = parseMythicShop(html);

  console.log(`Title: ${mythic.title}`);
  console.log(`Rotation: ${mythic.rotationTitle || "Unknown"}`);
  console.log(`Items parsed: ${mythic.items.length}`);
  console.log(mythic.items);

  if (mythic.items.length < 5) {
    throw new Error(
      "Too few Mythic Shop items parsed. Page structure may have changed.",
    );
  }

  const hashPayload = {
    rotationTitle: mythic.rotationTitle,
    items: mythic.items,
  };

  const newHash = createHash(hashPayload);
  const state = loadState();

  if (!state.hash) {
    console.log("Initializing Mythic Shop state");

    saveState({
      hash: newHash,
      title: mythic.title,
      rotationTitle: mythic.rotationTitle,
      items: mythic.items,
      updatedAt: new Date().toISOString(),
    });

    return;
  }

  if (state.hash === newHash) {
    console.log("No Mythic Shop changes");
    return;
  }

  const diff = getDiff(state.items, mythic.items);

  const message = formatDiscordMessage({
    mythic,
    diff,
  });

  console.log("\n=== DISCORD MESSAGE PREVIEW ===\n");
  console.log(message);
  console.log("\n===============================\n");

  if (SEND_TO_DISCORD) {
    await sendToDiscord(message);
    console.log("Sent Mythic Shop update to Discord");
  } else {
    console.log("Dry run only");
  }

  saveState({
    hash: newHash,
    title: mythic.title,
    rotationTitle: mythic.rotationTitle,
    items: mythic.items,
    updatedAt: new Date().toISOString(),
  });
}

main().catch(async (err) => {
  console.error(err);

  await sendErrorToDiscord(err);

  process.exitCode = 1;
});
