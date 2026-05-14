require("dotenv").config();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cheerio = require("cheerio");

const STATE_FILE = path.join(__dirname, "tft-balance-state.json");

const TFT_PATCH_NOTES_URL =
  "https://teamfighttactics.leagueoflegends.com/en-us/news/tags/patch-notes/";

const BASE_URL = "https://teamfighttactics.leagueoflegends.com";

const DISCORD_WEBHOOK_URL = process.env.TFT_BALANCE_WEBHOOK_URL;
const SEND_TO_DISCORD = process.env.SEND_TO_DISCORD !== "false";

const SECTION_KEYWORDS = {
  buffs: ["buff", "buffs"],
  nerfs: ["nerf", "nerfs"],
  adjustments: ["adjustment", "adjustments", "changed", "changes"],
  traits: ["trait", "traits"],
  champions: ["champion", "champions", "units", "unit"],
  augments: ["augment", "augments"],
  items: ["item", "items", "artifact", "artifacts", "support item", "support items"],
  systems: ["system", "systems", "encounter", "encounters", "mechanic", "mechanics"],
  bugfixes: ["bugfix", "bugfixes", "bug fix", "bug fixes", "bugs"],
};

const SECTION_ORDER = [
  "buffs",
  "nerfs",
  "adjustments",
  "traits",
  "champions",
  "augments",
  "items",
  "systems",
  "bugfixes",
];

// ================= STATE =================

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return {
      hash: null,
      title: null,
      url: null,
      sections: {},
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
      sections: {},
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

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 TFT Balance Tracker/1.0",
      Accept: "text/html,application/xhtml+xml",
    },
  });

  if (!res.ok) {
    throw new Error(`Fetch failed ${res.status}: ${url}`);
  }

  return res.text();
}

// ================= PARSE =================

function normalizeText(text = "") {
  return text
    .replace(/\u002F/g, "/")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function absoluteUrl(url) {
  if (!url) return null;
  if (url.startsWith("http")) return url;
  if (url.startsWith("/")) return `${BASE_URL}${url}`;
  return `${BASE_URL}/${url}`;
}

function findLatestPatchArticle(listHtml) {
  const $ = cheerio.load(listHtml);
  const candidates = [];

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    const text = normalizeText($(el).text());

    const combined = `${href || ""} ${text}`.toLowerCase();

    if (
      href &&
      combined.includes("patch") &&
      (combined.includes("teamfight-tactics") || combined.includes("tft"))
    ) {
      candidates.push({
        title: text || "TFT Patch Notes",
        url: absoluteUrl(href),
      });
    }
  });

  const unique = [];
  const seen = new Set();

  for (const candidate of candidates) {
    if (!candidate.url || seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    unique.push(candidate);
  }

  const best = unique.find((item) =>
    /teamfight tactics patch|tft patch|patch \d+/i.test(item.title),
  );

  if (!best) {
    throw new Error("Could not find latest TFT patch article");
  }

  return best;
}

function detectSectionKey(heading = "") {
  const lower = heading.toLowerCase();

  for (const [key, keywords] of Object.entries(SECTION_KEYWORDS)) {
    if (keywords.some((keyword) => lower.includes(keyword))) {
      return key;
    }
  }

  return null;
}

function collectListItems($, startEl) {
  const items = [];
  let current = $(startEl).next();

  while (current.length) {
    const tag = current.get(0)?.tagName?.toLowerCase();

    if (["h1", "h2", "h3"].includes(tag)) break;

    if (tag === "ul" || tag === "ol") {
      current.find("li").each((_, li) => {
        const line = normalizeText($(li).text());
        if (line && line.length > 2) items.push(line);
      });
    }

    if (tag === "p") {
      const line = normalizeText(current.text());
      if (
        line &&
        line.length > 15 &&
        !line.toLowerCase().includes("welcome") &&
        !line.toLowerCase().includes("table of contents")
      ) {
        items.push(line);
      }
    }

    current = current.next();
  }

  return items;
}

function parsePatchArticle(html, fallbackTitle, url) {
  const $ = cheerio.load(html);

  const title =
    normalizeText($("h1").first().text()) || fallbackTitle || "TFT Patch Notes";

  const sections = {};

  $("h2, h3").each((_, el) => {
    const heading = normalizeText($(el).text());
    const sectionKey = detectSectionKey(heading);

    if (!sectionKey) return;

    const lines = collectListItems($, el)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    if (!lines.length) return;

    if (!sections[sectionKey]) sections[sectionKey] = [];

    for (const line of lines) {
      if (!sections[sectionKey].includes(line)) {
        sections[sectionKey].push(line);
      }
    }
  });

  return {
    title,
    url,
    sections,
  };
}

// ================= FORMAT =================

function sectionTitle(key) {
  const titles = {
    buffs: "🟢 Buffs",
    nerfs: "🔴 Nerfs",
    adjustments: "🟡 Adjustments",
    traits: "🧬 Traits",
    champions: "👤 Champions / Units",
    augments: "🔺 Augments",
    items: "🧰 Items",
    systems: "⚙️ Systems",
    bugfixes: "🐛 Bugfixes",
  };

  return titles[key] || key;
}

function truncateLine(line, max = 240) {
  if (line.length <= max) return line;
  return `${line.slice(0, max - 3)}...`;
}

function formatDiscordMessage(patch) {
  let msg = "";

  msg += `⚖️ **TFT Balance Update Detected**\n`;
  msg += `📌 **${patch.title}**\n`;
  msg += `🔗 <${patch.url}>\n\n`;

  let hasSections = false;

  for (const key of SECTION_ORDER) {
    const lines = patch.sections[key];
    if (!lines || !lines.length) continue;

    hasSections = true;
    msg += `${sectionTitle(key)}\n`;

    for (const line of lines.slice(0, 12)) {
      msg += `• ${truncateLine(line)}\n`;
    }

    if (lines.length > 12) {
      msg += `• ...and ${lines.length - 12} more\n`;
    }

    msg += "\n";
  }

  if (!hasSections) {
    msg += "Could not extract clean balance sections. Open the source link for full patch notes.\n";
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

// ================= DISCORD =================

async function sendToDiscord(message) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log("No TFT_BALANCE_WEBHOOK_URL found");
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
  const webhook = process.env.ERROR_WEBHOOK_URL;

  if (!webhook) {
    console.log("No ERROR_WEBHOOK_URL found");
    return;
  }

  const content =
    `🚨 TFT Balance Bot Error\n` +
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
  console.log("Checking TFT balance updates");
  console.log(`SEND_TO_DISCORD = ${SEND_TO_DISCORD}`);
  console.log(`STATE_FILE = ${STATE_FILE}`);

  const listHtml = await fetchHtml(TFT_PATCH_NOTES_URL);
  const latest = findLatestPatchArticle(listHtml);

  console.log(`Latest patch article: ${latest.title}`);
  console.log(`URL: ${latest.url}`);

  const articleHtml = await fetchHtml(latest.url);
  const patch = parsePatchArticle(articleHtml, latest.title, latest.url);

  console.log(`Parsed title: ${patch.title}`);
  console.log(`Parsed sections: ${Object.keys(patch.sections).join(", ") || "none"}`);

  const hashPayload = {
    title: patch.title,
    url: patch.url,
    sections: patch.sections,
  };

  const newHash = createHash(hashPayload);
  const state = loadState();

  if (!state.hash) {
    console.log("Initializing TFT balance state");

    const message = formatDiscordMessage(patch);
    console.log("\n=== DISCORD MESSAGE PREVIEW ===\n");
    console.log(message);
    console.log("\n===============================\n");

    if (SEND_TO_DISCORD) {
      await sendToDiscord(message);
      console.log("Sent initial TFT balance alert to Discord");
    } else {
      console.log("Dry run only");
    }

    saveState({
      hash: newHash,
      title: patch.title,
      url: patch.url,
      sections: patch.sections,
      updatedAt: new Date().toISOString(),
    });

    return;
  }

  if (state.hash === newHash) {
    console.log("No TFT balance changes");
    return;
  }

  const message = formatDiscordMessage(patch);

  console.log("\n=== DISCORD MESSAGE PREVIEW ===\n");
  console.log(message);
  console.log("\n===============================\n");

  if (SEND_TO_DISCORD) {
    await sendToDiscord(message);
    console.log("Sent TFT balance update to Discord");
  } else {
    console.log("Dry run only");
  }

  saveState({
    hash: newHash,
    title: patch.title,
    url: patch.url,
    sections: patch.sections,
    updatedAt: new Date().toISOString(),
  });
}

main().catch(async (err) => {
  console.error(err);

  await sendErrorToDiscord(err);

  process.exitCode = 1;
});
