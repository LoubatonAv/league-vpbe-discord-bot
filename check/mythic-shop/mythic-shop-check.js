require("dotenv").config();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cheerio = require("cheerio");

const STATE_FILE = path.join(__dirname, "mythic-shop-state.json");
const MYTHIC_ONLY_CHANGES =
  String(process.env.MYTHIC_ONLY_CHANGES || "false").toLowerCase() === "true";
const MYTHIC_SHOW_REMOVED =
  String(process.env.MYTHIC_SHOW_REMOVED || "false").toLowerCase() === "true";

const MYTHIC_HIGHLIGHT_KEYWORDS = (process.env.MYTHIC_HIGHLIGHT_KEYWORDS || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

const DISCORD_WEBHOOK_URL = process.env.MYTHIC_SHOP_WEBHOOK_URL;
const ERROR_WEBHOOK_URL = process.env.ERROR_WEBHOOK_URL;
const SEND_TO_DISCORD = process.env.SEND_TO_DISCORD !== "false";

const LOLDB_MYTHIC_URL = "https://loldb.info/mythic-shop";
const WIKI_MYTHIC_URL =
  "https://leagueoflegends.fandom.com/wiki/Mythic_Shop_Rotation";

const MYTHIC_URL = LOLDB_MYTHIC_URL;

// ================= STATE =================

function getDefaultState() {
  return {
    hash: null,
    title: null,
    rotationTitle: null,
    items: [],
    upcomingItems: [],
    updatedAt: null,
    emporium: {
      status: "UNKNOWN",
      lastChangedAt: null,
    },
  };
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return getDefaultState();
  }

  try {
    return {
      ...getDefaultState(),
      ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")),
    };
  } catch {
    return getDefaultState();
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

function itemForHash(item) {
  return {
    section: item.section || "Current",
    type: item.type,
    name: item.name,
    price: item.price,
  };
}

function buildHashPayload(mythic) {
  return {
    rotationTitle: mythic.rotationTitle,
    items: mythic.items.map(itemForHash),
    upcomingItems: (mythic.upcomingItems || []).map(itemForHash),
  };
}

// ================= FETCH =================

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (res.status === 403) {
    throw new Error(`Source blocked request with 403: ${url}`);
  }

  if (!res.ok) {
    throw new Error(`Source failed ${res.status}: ${url}`);
  }

  return await res.text();
}

// ================= TEXT HELPERS =================

function normalizeText(text = "") {
  return String(text).replace(/\s+/g, " ").trim();
}

function cleanHtmlText(text = "") {
  return normalizeText(
    String(text)
      .replace(/\\u002F/g, "/")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g, "&"),
  );
}

function getTextBetween(text, start, end) {
  const startIndex = text.indexOf(start);

  if (startIndex === -1) return "";

  const fromStart = text.slice(startIndex + start.length);
  const endIndex = fromStart.indexOf(end);

  if (endIndex === -1) return fromStart;

  return fromStart.slice(0, endIndex);
}

// ================= CLASSIFY =================

function classifyItem(name = "", price = null) {
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

  // LoLDB sometimes strips item category text from the visible name.
  // These price-based guesses are only used when the name itself is ambiguous.
  if (price === 5) return "icon";
  if (price === 25) return "emote";
  if (price === 35 || price === 40) return "chroma";
  if (price === 50) return "ward";
  if (price === 125 || price === 150 || price === 200 || price === 250) {
    return "skin";
  }

  return "skin";
}

// ================= LOLDB CURRENT PARSER =================

function parseLolDbMythicShop(html) {
  const $ = cheerio.load(html);

  const title = normalizeText($("h1").first().text()) || "Mythic Shop Rotation";

  const bodyText = cleanHtmlText($("body").text());

  const shopText = getTextBetween(
    bodyText,
    "Check out the current Mythic Shop rotation",
    "Categories",
  );

  if (!shopText) {
    return {
      source: "LoLDB",
      title,
      rotationTitle: "Current Mythic Shop Rotation",
      items: [],
      upcomingItems: [],
    };
  }

  const sectionRanges = buildLolDbSectionRanges(shopText);

  const timerRegex =
    /Expires in\s+((?:\d+\s*(?:days?|day|hours?|hour|hrs?|hr|h|minutes?|minute|mins?|min|m)\s*)+)/gi;

  const timerMatches = [...shopText.matchAll(timerRegex)];
  const items = [];

  for (let i = 0; i < timerMatches.length; i++) {
    const match = timerMatches[i];

    const expiresIn = normalizeText(match[1]);
    const segmentStart = match.index + match[0].length;
    const segmentEnd =
      i + 1 < timerMatches.length ? timerMatches[i + 1].index : shopText.length;

    let segment = normalizeText(shopText.slice(segmentStart, segmentEnd));

    // Section-level timer has no item after it.
    if (!segment) continue;

    // Last item before next section can look like: Dat Boi25Bi-Weekly
    segment = segment
      .replace(/(Featured|Bi-Weekly|Weekly|Daily|Categories)$/i, "")
      .trim();

    if (!segment) continue;

    // LoLDB text can be compressed like: Prestige Soul Fighter Shaco150
    const itemMatch = segment.match(/^(.+?)(\d{1,3})$/);

    if (!itemMatch) continue;

    let name = normalizeText(itemMatch[1]);
    const price = Number(itemMatch[2]);

    name = name
      .replace(/\s+(Skin|Chroma|Icon|Emote|Ward|Nexus Finisher)$/i, "")
      .trim();

    if (!name || name.length < 3 || !price) continue;

    const section = findLolDbSection(match.index, sectionRanges);
    const type = classifyItem(name, price);

    items.push({
      section,
      type,
      name,
      price,
      expiresIn,
    });
  }

  const unique = new Map();

  for (const item of items) {
    const key = `${item.section}|${item.type}|${item.name}|${item.price}`;
    unique.set(key, item);
  }

  return {
    source: "LoLDB",
    title,
    rotationTitle: "Current Mythic Shop Rotation",
    items: [...unique.values()],
    upcomingItems: [],
  };
}

function buildLolDbSectionRanges(text) {
  const featuredIndex = text.indexOf("Featured");
  const biWeeklyIndex =
    featuredIndex === -1 ? -1 : text.indexOf("Bi-Weekly", featuredIndex + 1);

  const weeklyIndex =
    biWeeklyIndex === -1
      ? -1
      : text.indexOf("Weekly", biWeeklyIndex + "Bi-Weekly".length);

  const dailyIndex =
    weeklyIndex === -1
      ? -1
      : text.indexOf("Daily", weeklyIndex + "Weekly".length);

  const categoriesIndex =
    dailyIndex === -1
      ? text.length
      : text.indexOf("Categories", dailyIndex + "Daily".length);

  const raw = [
    { name: "Featured", index: featuredIndex },
    { name: "Bi-Weekly", index: biWeeklyIndex },
    { name: "Weekly", index: weeklyIndex },
    { name: "Daily", index: dailyIndex },
    {
      name: "Categories",
      index: categoriesIndex === -1 ? text.length : categoriesIndex,
    },
  ].filter((section) => section.index !== -1);

  const ranges = [];

  for (let i = 0; i < raw.length - 1; i++) {
    ranges.push({
      name: raw[i].name,
      start: raw[i].index,
      end: raw[i + 1].index,
    });
  }

  return ranges;
}

function findLolDbSection(index, ranges) {
  const section = ranges.find(
    (range) => index >= range.start && index < range.end,
  );

  return section ? section.name : "Current";
}

// ================= FANDOM UPCOMING PARSER =================

function parseFandomMythicShop(html) {
  const $ = cheerio.load(html);

  const title = normalizeText($("h1").first().text()) || "Mythic Shop Rotation";

  const tables = $(".mw-parser-output").first().find("table");

  const currentItems = parseFandomTable($, tables.eq(0), "Current");
  const upcomingItems = parseFandomTable($, tables.eq(1), "Upcoming");

  return {
    source: "League Wiki",
    title,
    rotationTitle: "Current Mythic Shop Rotation",
    items: currentItems,
    upcomingItems,
  };
}

function parseFandomTable($, table, section) {
  if (!table || !table.length) return [];

  const tableText = cleanHtmlText(table.text());

  const prices = [];
  const priceRegex =
    /(?:^|[^\d])(\d{1,3})\s+(?:File:.*?\s+)?Patch\s+\d+\.\d+(?:\s*-\s*\d+\.\d+)?/gi;

  let priceMatch;

  while ((priceMatch = priceRegex.exec(tableText)) !== null) {
    prices.push(Number(priceMatch[1]));
  }

  const names = table
    .find("h2")
    .map((_, h2) =>
      normalizeText($(h2).text())
        .replace(/\[edit\]/gi, "")
        .replace(/\(\+ Border and Icon\)/gi, "")
        .replace(/\(\+ Border\)/gi, "")
        .replace(/\+ Border and Icon/gi, "")
        .replace(/\+ Border/gi, "")
        .trim(),
    )
    .get()
    .filter(Boolean);

  const items = [];
  const count = Math.min(names.length, prices.length);

  for (let i = 0; i < count; i++) {
    items.push({
      section,
      type: classifyItem(names[i], prices[i]),
      name: names[i],
      price: prices[i],
      expiresIn: null,
    });
  }

  return items;
}

// ================= DIFF =================

function getItemKey(item) {
  return `${item.section || "Current"}|${item.type}|${item.name}|${item.price}`;
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

// ================= FORMAT HELPERS =================

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
  return "🔹 Other Items";
}

function emojiForSection(section) {
  if (section === "Featured") return "📌";
  if (section === "Bi-Weekly") return "🗓️";
  if (section === "Weekly") return "📆";
  if (section === "Daily") return "⏰";
  if (section === "Upcoming") return "🔮";
  return "📦";
}

function groupByType(items = []) {
  const grouped = {};

  for (const item of items) {
    if (!grouped[item.type]) grouped[item.type] = [];
    grouped[item.type].push(item);
  }

  return grouped;
}

function groupBySection(items = []) {
  const grouped = {};

  for (const item of items) {
    const section = item.section || "Current";

    if (!grouped[section]) grouped[section] = [];
    grouped[section].push(item);
  }

  return grouped;
}

function getMostCommonExpiresIn(items = []) {
  const counts = {};

  for (const item of items) {
    if (!item.expiresIn) continue;
    counts[item.expiresIn] = (counts[item.expiresIn] || 0) + 1;
  }

  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

function formatItemLine(item) {
  const expires = item.expiresIn ? ` — expires in ${item.expiresIn}` : "";
  return `• ${highlightWantedText(item.name)} — ${item.price} ME${expires}`;
}

function formatItemLineWithoutRepeatedExpiry(item, sectionExpiresIn) {
  const shouldShowExpiry =
    item.expiresIn && item.expiresIn !== sectionExpiresIn;

  const expires = shouldShowExpiry ? ` — expires in ${item.expiresIn}` : "";

  return `• ${highlightWantedText(item.name)} — ${item.price} ME${expires}`;
}

function formatGroupedItems(items = [], typeOrder) {
  let msg = "";

  const grouped = groupByType(items);

  for (const type of typeOrder) {
    const typeItems = grouped[type];
    if (!typeItems || !typeItems.length) continue;

    msg += `${titleForType(type)}\n`;

    for (const item of typeItems) {
      msg += `${formatItemLine(item)}\n`;
    }

    msg += `\n`;
  }

  return msg;
}

// ================= FORMAT DISCORD =================

function formatDiscordMessage({ mythic, diff }) {
  let msg = "";

  const typeOrder = [
    "prestige",
    "mythic",
    "skin",
    "chroma",
    "ward",
    "emote",
    "icon",
    "finisher",
  ];

  const sectionOrder = ["Featured", "Bi-Weekly", "Weekly", "Daily", "Current"];

  const addedItems = diff?.added || [];
  const removedItems = diff?.removed || [];

  const shouldShowAdded = addedItems.length > 0;
  const shouldShowRemoved = MYTHIC_SHOW_REMOVED && removedItems.length > 0;

  const hasVisibleChanges = shouldShowAdded || shouldShowRemoved;

  if (MYTHIC_ONLY_CHANGES && !hasVisibleChanges) {
    return "";
  }

  msg += `💎 **League Mythic Shop Rotation Updated**\n`;

  if (mythic.rotationTitle) {
    msg += `📅 ${mythic.rotationTitle}\n`;
  }

  msg += `🔗 <${MYTHIC_URL}>\n\n`;

  if (hasVisibleChanges) {
    msg += `🧾 **Changes Since Last Check**\n\n`;

    if (shouldShowAdded) {
      msg += `🟢 **Added / Changed**\n`;

      for (const item of addedItems) {
        msg += `${emojiForType(item.type)} ${highlightWantedText(item.name)} — ${item.price} ME`;

        if (item.expiresIn) {
          msg += ` — expires in ${item.expiresIn}`;
        }

        if (item.section) {
          msg += ` — ${item.section}`;
        }

        msg += `\n`;
      }

      msg += `\n`;
    }

    if (shouldShowRemoved) {
      msg += `🔴 **Removed / Expired**\n`;

      for (const item of removedItems) {
        msg += `${emojiForType(item.type)} ${highlightWantedText(item.name)} — ${item.price} ME`;

        if (item.section) {
          msg += ` — ${item.section}`;
        }

        msg += `\n`;
      }

      msg += `\n`;
    }
  }

  if (MYTHIC_ONLY_CHANGES) {
    return msg.trim();
  }

  if (mythic.upcomingItems && mythic.upcomingItems.length) {
    msg += `🔮 **Upcoming Rotation / Next Known Rotation**\n\n`;
    msg += formatGroupedItems(mythic.upcomingItems, typeOrder);
  }

  msg += `📋 **Current Rotation**\n\n`;

  const groupedBySection = groupBySection(mythic.items);

  for (const section of sectionOrder) {
    const sectionItems = groupedBySection[section];
    if (!sectionItems || !sectionItems.length) continue;

    const sectionExpiresIn = getMostCommonExpiresIn(sectionItems);

    msg += `${emojiForSection(section)} **${section}**`;

    if (sectionExpiresIn) {
      msg += ` — expires in ${sectionExpiresIn}`;
    }

    msg += `\n\n`;

    const groupedByType = groupByType(sectionItems);

    for (const type of typeOrder) {
      const typeItems = groupedByType[type];
      if (!typeItems || !typeItems.length) continue;

      msg += `${titleForType(type)}\n`;

      for (const item of typeItems) {
        msg += `${formatItemLineWithoutRepeatedExpiry(
          item,
          sectionExpiresIn,
        )}\n`;
      }

      msg += `\n`;
    }
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
    console.log("No MYTHIC_SHOP_WEBHOOK_URL found");
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

async function sendErrorToDiscord(error) {
  if (!ERROR_WEBHOOK_URL) {
    console.log("No ERROR_WEBHOOK_URL found");
    return;
  }

  const content =
    `🚨 Bot Error\n` +
    `📄 Script: ${path.basename(__filename)}\n\n` +
    `❌ ${error.stack || error.message || error}`;

  try {
    await fetch(ERROR_WEBHOOK_URL, {
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

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightWantedText(text) {
  if (!text || MYTHIC_HIGHLIGHT_KEYWORDS.length === 0) {
    return text;
  }

  let result = text;

  for (const keyword of MYTHIC_HIGHLIGHT_KEYWORDS) {
    const regex = new RegExp(`(${escapeRegExp(keyword)})`, "gi");
    result = result.replace(regex, "✨ __**$1**__ ✨");
  }

  return result;
}
// ================= MAIN =================

async function main() {
  console.log("Checking Mythic Shop rotation");
  console.log(`SEND_TO_DISCORD = ${SEND_TO_DISCORD}`);
  console.log(`STATE_FILE = ${STATE_FILE}`);

  const state = loadState();
  const errors = [];

  let mythic = null;

  try {
    const loldbHtml = await fetchHtml(LOLDB_MYTHIC_URL);
    mythic = parseLolDbMythicShop(loldbHtml);
    console.log(
      `Loaded current Mythic Shop from LoLDB: ${mythic.items.length} items`,
    );
  } catch (err) {
    errors.push(`LoLDB failed: ${err.message}`);
    console.log(`LoLDB failed: ${err.message}`);
  }

  try {
    const wikiHtml = await fetchHtml(WIKI_MYTHIC_URL);
    const wikiMythic = parseFandomMythicShop(wikiHtml);

    if (!mythic && wikiMythic.items.length) {
      mythic = wikiMythic;
      console.log("Loaded current Mythic Shop from League Wiki fallback");
    }

    if (mythic && wikiMythic.upcomingItems.length) {
      mythic.upcomingItems = wikiMythic.upcomingItems;
      console.log(
        `Loaded upcoming Mythic Shop from League Wiki: ${wikiMythic.upcomingItems.length} items`,
      );
    }
  } catch (err) {
    errors.push(`League Wiki failed: ${err.message}`);
    console.log(`League Wiki failed: ${err.message}`);

    if (mythic) {
      mythic.upcomingItems = state.upcomingItems || [];
      console.log(
        `Using previous upcoming items from state: ${mythic.upcomingItems.length}`,
      );
    }
  }

  if (!mythic) {
    throw new Error(
      "All Mythic Shop sources failed:\n" +
        errors.map((error) => `- ${error}`).join("\n"),
    );
  }

  console.log(`Title: ${mythic.title}`);
  console.log(`Rotation: ${mythic.rotationTitle || "Unknown"}`);
  console.log(`Current items parsed: ${mythic.items.length}`);
  console.log(`Upcoming items parsed: ${mythic.upcomingItems?.length || 0}`);

  if (mythic.items.length < 5) {
    throw new Error(
      "Too few current Mythic Shop items parsed. Page structure may have changed.",
    );
  }

  const newHash = createHash(buildHashPayload(mythic));

  if (!state.hash) {
    console.log("Initializing Mythic Shop state");

    saveState({
      ...state,
      hash: newHash,
      title: mythic.title,
      rotationTitle: mythic.rotationTitle,
      items: mythic.items,
      upcomingItems: mythic.upcomingItems || [],
      updatedAt: new Date().toISOString(),
    });

    return;
  }

  if (state.hash === newHash) {
    console.log("No Mythic Shop changes detected");

    saveState({
      ...state,
      title: mythic.title,
      rotationTitle: mythic.rotationTitle,
      items: mythic.items,
      upcomingItems: mythic.upcomingItems || state.upcomingItems || [],
      updatedAt: new Date().toISOString(),
    });

    return;
  }

  const diff = getDiff(state.items, mythic.items);

  const message = formatDiscordMessage({
    mythic,
    diff,
  });

  if (!message) {
    console.log(
      "Mythic Shop hash changed, but there are no visible changes to alert.",
    );

    saveState({
      ...state,
      hash: newHash,
      title: mythic.title,
      rotationTitle: mythic.rotationTitle,
      items: mythic.items,
      upcomingItems: mythic.upcomingItems || [],
      updatedAt: new Date().toISOString(),
    });

    return;
  }

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
    ...state,
    hash: newHash,
    title: mythic.title,
    rotationTitle: mythic.rotationTitle,
    items: mythic.items,
    upcomingItems: mythic.upcomingItems || [],
    updatedAt: new Date().toISOString(),
  });
}

main().catch(async (err) => {
  console.error(err);

  await sendErrorToDiscord(err);

  process.exitCode = 1;
});
