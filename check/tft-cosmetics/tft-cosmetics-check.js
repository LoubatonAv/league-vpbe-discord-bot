require("dotenv").config();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const STATE_FILE = path.join(__dirname, "tft-cosmetics-state.json");

const DISCORD_WEBHOOK_URL = process.env.TFT_COSMETICS_WEBHOOK_URL;
const ERROR_WEBHOOK_URL = process.env.ERROR_WEBHOOK_URL;
const SEND_TO_DISCORD = process.env.SEND_TO_DISCORD !== "false";

const SOURCES = [
  "https://teamfighttactics.leagueoflegends.com/en-us/news/",
  "https://teamfighttactics.leagueoflegends.com/en-us/news/game-updates/",
  "https://support-teamfighttactics.riotgames.com/hc/en-us/categories/360002290174-Teamfight-Tactics",
];

const KEYWORDS = [
  "treasure realm",
  "treasure realms",
  "rotating shop",
  "mythic shop",
  "seasonal shop",
  "realm crystal",
  "realm crystals",
  "mythic medallion",
  "mythic medallions",
  "chibi",
  "tactician",
  "arena",
  "boom",
  "cosmetic",
  "cosmetics",
];

// ================= STATE =================

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return {
      hash: null,
      title: null,
      url: null,
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
      url: null,
      items: [],
      updatedAt: null,
    };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function createHash(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

// ================= FETCH =================

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 TFT Cosmetics Tracker/1.0",
      Accept: "text/html,application/xhtml+xml,application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`Fetch failed ${res.status}: ${url}`);
  }

  return res.text();
}

// ================= PARSE HELPERS =================

function normalize(text = "") {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function hasCosmeticsKeywords(text = "") {
  const lower = text.toLowerCase();
  return KEYWORDS.some((keyword) => lower.includes(keyword));
}

function absoluteUrl(href) {
  if (!href) return null;
  if (href.startsWith("http")) return href;
  if (href.startsWith("/")) return `https://teamfighttactics.leagueoflegends.com${href}`;
  return null;
}

function extractTitle(html) {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  if (h1) return normalize(h1);

  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return title ? normalize(title).replace(/\s*-\s*Teamfight Tactics.*$/i, "") : "TFT Cosmetics Update";
}

function extractCandidateLinks(html) {
  const links = [];
  const regex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const href = absoluteUrl(match[1]);
    const label = normalize(match[2]);

    if (!href || !label) continue;
    if (!href.includes("teamfighttactics.leagueoflegends.com")) continue;
    if (!hasCosmeticsKeywords(`${label} ${href}`)) continue;

    links.push({ title: label, url: href });
  }

  const seen = new Set();
  return links.filter((link) => {
    if (seen.has(link.url)) return false;
    seen.add(link.url);
    return true;
  });
}

function extractItemsFromText(text) {
  const items = [];

  const patterns = [
    /(?:Chibi|Prestige Chibi|Unbound)\s+[A-Z][A-Za-z0-9:'’&().+\-/\s]{2,60}/g,
    /[A-Z][A-Za-z0-9:'’&().+\-/\s]{2,60}\s+(?:Arena|Boom|Tactician)/g,
    /(?:Treasure Realms?|Mythic Shop|Seasonal Shop|Rotating Shop|Realm Crystals?|Mythic Medallions?)[A-Za-z0-9:'’&().+\-/\s]{0,80}/gi,
  ];

  for (const pattern of patterns) {
    const matches = text.match(pattern) || [];
    for (const raw of matches) {
      const name = normalize(raw)
        .replace(/\s*[|–—-]\s*Teamfight Tactics.*$/i, "")
        .replace(/\s+/g, " ")
        .trim();

      if (name.length < 4 || name.length > 100) continue;
      items.push(name);
    }
  }

  return [...new Set(items)].slice(0, 80);
}

function getRelevantSnippets(text) {
  const sentences = text.split(/(?<=[.!?])\s+/);

  return sentences
    .filter((sentence) => hasCosmeticsKeywords(sentence))
    .map((sentence) => normalize(sentence))
    .filter((sentence) => sentence.length >= 20)
    .slice(0, 12);
}

// ================= CORE =================

async function findLatestCosmeticsArticle() {
  const allCandidates = [];

  for (const source of SOURCES) {
    try {
      const html = await fetchText(source);
      const links = extractCandidateLinks(html);
      allCandidates.push(...links);
    } catch (err) {
      console.log(`Source skipped: ${source} (${err.message})`);
    }
  }

  const seen = new Set();
  const candidates = allCandidates.filter((candidate) => {
    if (seen.has(candidate.url)) return false;
    seen.add(candidate.url);
    return true;
  });

  if (!candidates.length) {
    throw new Error("No TFT cosmetics candidate articles found");
  }

  for (const candidate of candidates.slice(0, 10)) {
    try {
      const html = await fetchText(candidate.url);
      const text = normalize(html);

      if (!hasCosmeticsKeywords(text)) continue;

      const title = extractTitle(html) || candidate.title;
      const items = extractItemsFromText(text);
      const snippets = getRelevantSnippets(text);

      return {
        title,
        url: candidate.url,
        items,
        snippets,
      };
    } catch (err) {
      console.log(`Candidate skipped: ${candidate.url} (${err.message})`);
    }
  }

  throw new Error("Could not read a valid TFT cosmetics article");
}

function getDiff(oldItems = [], newItems = []) {
  const oldSet = new Set(oldItems);
  const newSet = new Set(newItems);

  return {
    added: [...newSet].filter((item) => !oldSet.has(item)),
    removed: [...oldSet].filter((item) => !newSet.has(item)),
  };
}

// ================= DISCORD =================

function formatDiscordMessage({ current, diff }) {
  let msg = "";

  msg += `🛍️ **TFT Cosmetics Update Detected**\n`;
  msg += `📌 ${current.title}\n`;
  msg += `🔗 <${current.url}>\n\n`;

  if (diff.added.length) {
    msg += `🟢 **New / Changed**\n`;
    for (const item of diff.added.slice(0, 30)) {
      msg += `• ${item}\n`;
    }
    msg += "\n";
  }

  if (diff.removed.length) {
    msg += `🔴 **Removed / Missing From Latest Parse**\n`;
    for (const item of diff.removed.slice(0, 20)) {
      msg += `• ${item}\n`;
    }
    msg += "\n";
  }

  if (current.snippets?.length) {
    msg += `📋 **Relevant Notes**\n`;
    for (const snippet of current.snippets.slice(0, 6)) {
      msg += `• ${snippet.slice(0, 240)}\n`;
    }
  }

  return msg.trim();
}

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
    console.log("No TFT_COSMETICS_WEBHOOK_URL found");
    return;
  }

  for (const chunk of splitDiscordMessage(message)) {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: chunk }),
    });

    if (!res.ok) {
      console.log(await res.text());
      throw new Error(`Discord failed ${res.status}`);
    }
  }
}

async function sendErrorToDiscord(error) {
  if (!ERROR_WEBHOOK_URL) return;

  try {
    await fetch(ERROR_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: (`🚨 TFT Cosmetics Bot Error\n\n${error.stack || error.message || error}`).slice(0, 1900),
      }),
    });
  } catch (err) {
    console.error("Failed sending error webhook:", err);
  }
}

// ================= MAIN =================

async function main() {
  console.log("Checking TFT cosmetics");
  console.log(`SEND_TO_DISCORD = ${SEND_TO_DISCORD}`);
  console.log(`STATE_FILE = ${STATE_FILE}`);

  const current = await findLatestCosmeticsArticle();

  const hashPayload = {
    title: current.title,
    url: current.url,
    items: current.items,
    snippets: current.snippets,
  };

  const newHash = createHash(hashPayload);
  const state = loadState();

  console.log(`Title: ${current.title}`);
  console.log(`URL: ${current.url}`);
  console.log(`Items/snippets parsed: ${current.items.length}/${current.snippets.length}`);

  if (!state.hash) {
    console.log("Initializing TFT cosmetics state");
    saveState({
      hash: newHash,
      title: current.title,
      url: current.url,
      items: current.items,
      updatedAt: new Date().toISOString(),
    });
    return;
  }

  if (state.hash === newHash) {
    console.log("No TFT cosmetics changes");
    return;
  }

  const diff = getDiff(state.items, current.items);
  const message = formatDiscordMessage({ current, diff });

  console.log("\n=== DISCORD MESSAGE PREVIEW ===\n");
  console.log(message);
  console.log("\n===============================\n");

  if (SEND_TO_DISCORD) {
    await sendToDiscord(message);
    console.log("Sent TFT cosmetics update to Discord");
  } else {
    console.log("Dry run only");
  }

  saveState({
    hash: newHash,
    title: current.title,
    url: current.url,
    items: current.items,
    updatedAt: new Date().toISOString(),
  });
}

main().catch(async (err) => {
  console.error(err);
  await sendErrorToDiscord(err);
  process.exitCode = 1;
});
