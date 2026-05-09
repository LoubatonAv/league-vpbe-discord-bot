require("dotenv").config();

const fs = require("fs");
const path = require("path");

const STATE_FILE = path.join(__dirname, "vpbe-check-state.json");

const DISCORD_WEBHOOK_URL = process.env.VPBE_WEBHOOK_URL;
const VPBE_URL = "https://wiki.leagueoflegends.com/en-us/VPBE";

const REVISION_LIMIT = 50;
const SEND_TO_DISCORD = process.env.SEND_TO_DISCORD !== "false";

const API =
  `https://wiki.leagueoflegends.com/en-us/api.php?action=query&titles=VPBE` +
  `&prop=revisions&rvprop=ids|timestamp|content&rvslots=main` +
  `&rvlimit=${REVISION_LIMIT}&format=json&origin=*`;

// ================= STATE =================

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return { lastRevisionId: null };
  }

  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { lastRevisionId: null };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ================= FETCH =================

async function getRevisions() {
  const res = await fetch(API);

  if (!res.ok) {
    throw new Error(`Wiki API failed: ${res.status}`);
  }

  const data = await res.json();
  const pageId = Object.keys(data.query.pages)[0];
  const revisions = data.query.pages[pageId].revisions;

  if (!revisions || !revisions.length) {
    throw new Error("No revisions found");
  }

  return revisions.map((rev) => ({
    id: rev.revid,
    timestamp: rev.timestamp,
    content: rev.slots.main["*"],
  }));
}

// ================= WIKI CLEANING =================

function normalizeLine(line = "") {
  return line.trim();
}

function parseTemplateParts(inner = "") {
  return inner.split("|").map((part) => part.trim());
}

function getTemplateParam(params, index, fallback = "") {
  return params[index] || fallback;
}

function cleanTemplateValue(value = "") {
  return cleanWikiText(value).replace(/\s+/g, " ").trim();
}

function formatRankValue(params) {
  const cleanParams = params
    .filter((p) => p && !p.includes("="))
    .map(cleanTemplateValue)
    .filter(Boolean);

  if (!cleanParams.length) return "";

  const first = cleanParams[0];

  if (first.includes(";")) {
    return first.split(";").join("/");
  }

  return first;
}

function formatPercentTemplate(params) {
  const suffixParam = params.find((p) => p.startsWith("key="));
  const suffix = suffixParam ? suffixParam.replace("key=", "") : "";

  const cleanParams = params
    .filter((p) => p && !p.includes("="))
    .map(cleanTemplateValue)
    .filter(Boolean);

  if (!cleanParams.length) return "";

  let value = cleanParams[0];

  if (value.includes(";")) {
    value = value.split(";").join("/");
  }

  return `${value}${suffix}`;
}

function replaceTemplate(inner = "") {
  const parts = parseTemplateParts(inner);
  const name = (parts.shift() || "").toLowerCase();
  const params = parts;

  switch (name) {
    case "ai":
      return cleanTemplateValue(getTemplateParam(params, 0));

    case "ri":
      return cleanTemplateValue(getTemplateParam(params, 0));

    case "csl":
    case "skin": {
      const champion = cleanTemplateValue(getTemplateParam(params, 0));
      const skin = cleanTemplateValue(getTemplateParam(params, 1));
      return skin && champion ? `${skin} ${champion}` : skin || champion;
    }

    case "ap":
    case "fd":
    case "rd":
      return formatRankValue(params);

    case "pp":
      return formatPercentTemplate(params);

    case "as":
      return cleanTemplateValue(getTemplateParam(params, 0));

    case "sbc":
      return `**${cleanTemplateValue(getTemplateParam(params, 0))}**`;

    case "g":
      return `${cleanTemplateValue(getTemplateParam(params, 0))} gold`;

    case "rp":
      return `${cleanTemplateValue(getTemplateParam(params, 0))} RP`;

    case "me":
      return `${cleanTemplateValue(getTemplateParam(params, 0))} Mythic Essence`;

    case "numbersup":
    case "tip":
    case "ci":
    case "c":
    case "ii":
    case "univ":
    case "oe":
    case "be":
      return cleanTemplateValue(getTemplateParam(params, 0));

    default: {
      const useful = params
        .filter((p) => p && !p.includes("="))
        .map(cleanTemplateValue)
        .filter(Boolean);

      return useful[0] || "";
    }
  }
}

function cleanWikiText(text = "") {
  let cleaned = text;

  cleaned = cleaned
    .replace(/<ref[\s\S]*?<\/ref>/g, "")
    .replace(/<ref[^/]*\/>/g, "")
    .replace(/\[\[File:[^\]]+\]\]/gi, "")
    .replace(/\[\[Image:[^\]]+\]\]/gi, "")
    .replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[https?:\/\/[^\s\]]+\s+([^\]]+)\]/g, "$1")
    .replace(/\[https?:\/\/[^\]]+\]/g, "");

  let safety = 0;

  while (cleaned.includes("{{") && cleaned.includes("}}") && safety < 50) {
    const next = cleaned.replace(/{{([^{}]+)}}/g, (_, inner) =>
      replaceTemplate(inner),
    );

    if (next === cleaned) break;

    cleaned = next;
    safety += 1;
  }

  return cleaned
    .replace(/'''/g, "**")
    .replace(/''/g, "")
    .replace(/^\*+\s*/, "")
    .replace(/^:+\s*/, "")
    .replace(/^;+\s*/, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,:;])/g, "$1")
    .trim();
}

function shouldIgnoreLine(line = "") {
  const l = line.trim();

  if (!l) return true;
  if (l.startsWith("<!--")) return true;
  if (l.startsWith("-->")) return true;
  if (l.includes("¦")) return true;

  if (l.startsWith("|")) return true;
  if (l.startsWith("{|")) return true;
  if (l.startsWith("|}")) return true;
  if (l.startsWith("!")) return true;

  if (l.startsWith("{{Infobox")) return true;
  if (l.includes("{{Infobox pbe")) return true;
  if (l.startsWith("{{GalleryHelper")) return true;
  if (l.startsWith("}}")) return true;

  if (l.startsWith("[[Category")) return true;
  if (l.startsWith("[[cs:")) return true;
  if (l.startsWith("[[de:")) return true;
  if (l.startsWith("[[es:")) return true;
  if (l.startsWith("[[pt-br:")) return true;

  if (l.startsWith("<gallery")) return true;
  if (l.startsWith("</gallery")) return true;
  if (l.startsWith("<center")) return true;
  if (l.startsWith("</center")) return true;

  if (l.includes("{{References}}")) return true;
  if (l.includes("{{Release history}}")) return true;
  if (l.includes("{{DISPLAYTITLE")) return true;

  if (l.includes("This page documents all confirmed changes")) return true;
  if (l.includes("Documented changes may or may not be final")) return true;

  return false;
}

// ================= SECTIONS / DIFF =================

function parseHeading(line = "") {
  const match = line.match(/^(={2,6})\s*(.*?)\s*\1$/);
  if (!match) return null;

  return {
    level: match[1].length,
    title: cleanWikiText(match[2]),
  };
}

function getAddedLinesWithSections(oldText, newText) {
  const oldLines = new Set(
    oldText.split("\n").map(normalizeLine).filter(Boolean),
  );

  const added = [];
  const sectionStack = [];

  for (const rawLine of newText.split("\n")) {
    const line = normalizeLine(rawLine);
    if (!line) continue;

    const heading = parseHeading(line);

    if (heading) {
      while (
        sectionStack.length &&
        sectionStack[sectionStack.length - 1].level >= heading.level
      ) {
        sectionStack.pop();
      }

      sectionStack.push(heading);
      continue;
    }

    if (oldLines.has(line)) continue;

    const sectionPath = sectionStack.map((s) => s.title).filter(Boolean);
    const section = sectionPath.length ? sectionPath.join(" / ") : "General";

    added.push({
      raw: line,
      section,
      sectionPath,
    });
  }

  return added;
}

// ================= CLASSIFICATION =================

function extractAbilityName(raw = "") {
  const abilityMatch = raw.match(/{{ai\|([^|}]+)\|?/i);
  if (abilityMatch) return cleanWikiText(abilityMatch[1]);

  const runeMatch = raw.match(/{{ri\|([^|}]+)\|?/i);
  if (runeMatch) return cleanWikiText(runeMatch[1]);

  return null;
}

function getMainSection(section = "") {
  const s = section.toLowerCase();

  if (s.includes("champion")) return "Champions";
  if (s.includes("item")) return "Items";
  if (s.includes("rune")) return "Runes";
  if (s.includes("skin") || s.includes("cosmetic")) return "Cosmetics";
  if (s.includes("system")) return "Systems";

  return "Other";
}

function isLikelyHeader(text = "") {
  const t = text.toLowerCase();

  if (!text) return false;
  if (text.length > 45) return false;

  const changeWords = [
    "increased",
    "decreased",
    "reduced",
    "changed",
    "removed",
    "new effect",
    "bug fix",
    "damage",
    "cooldown",
    "cost",
    "ratio",
    "duration",
    "healing",
    "shield",
  ];

  return !changeWords.some((word) => t.includes(word));
}

function classifyChange(text = "") {
  const t = text.toLowerCase();

  if (t.includes("bug fix")) return "fix";
  if (t.includes("new effect")) return "new";
  if (t.includes("removed")) return "removed";

  const isCostOrCooldown =
    t.includes("cost") ||
    t.includes("cooldown") ||
    t.includes("mana") ||
    t.includes("energy");

  if (
    t.includes("reduced") ||
    t.includes("decreased") ||
    t.includes("lowered")
  ) {
    return isCostOrCooldown ? "buff" : "nerf";
  }

  if (t.includes("increased") || t.includes("raised")) {
    return isCostOrCooldown ? "nerf" : "buff";
  }

  if (t.includes("changed")) return "adjusted";

  return "neutral";
}

function emojiForChange(type) {
  if (type === "buff") return "🟢";
  if (type === "nerf") return "🔴";
  if (type === "adjusted") return "🟡";
  if (type === "new") return "✨";
  if (type === "removed") return "🗑️";
  if (type === "fix") return "🛠️";
  return "⚙️";
}

function parseDiffLines(addedEntries) {
  const items = [];

  for (const entry of addedEntries) {
    const rawLine = entry.raw;

    if (shouldIgnoreLine(rawLine)) continue;

    const text = cleanWikiText(rawLine);
    if (!text || text.length < 2) continue;

    const abilityName = extractAbilityName(rawLine);
    const mainSection = getMainSection(entry.section);
    const kind = abilityName
      ? "ability"
      : isLikelyHeader(text)
        ? "header"
        : "change";

    items.push({
      raw: rawLine,
      text,
      abilityName,
      section: entry.section || "General",
      mainSection,
      kind,
      changeType: classifyChange(text),
    });
  }

  return items;
}

// ================= PATCH NOTES FORMAT =================

function buildPatchNotes(items) {
  const sections = {};

  for (const item of items) {
    if (!sections[item.mainSection]) {
      sections[item.mainSection] = [];
    }

    sections[item.mainSection].push(item);
  }

  return sections;
}

function formatSectionTitle(sectionName) {
  if (sectionName === "Champions") return "⚔️ Champions";
  if (sectionName === "Items") return "🛡️ Items";
  if (sectionName === "Runes") return "🧬 Runes";
  if (sectionName === "Cosmetics") return "🎨 Cosmetics";
  if (sectionName === "Systems") return "⚙️ Systems";
  return "📌 Other";
}

function formatPatchSection(sectionItems) {
  let msg = "";

  let currentHeader = null;
  let currentAbility = null;
  let wroteAny = false;

  for (const item of sectionItems) {
    if (item.kind === "header") {
      currentHeader = item.text;
      currentAbility = null;

      msg += `\n**${currentHeader}**\n`;
      wroteAny = true;
      continue;
    }

    if (item.kind === "ability") {
      currentAbility = item.abilityName || item.text;

      msg += `• **${currentAbility}**\n`;
      wroteAny = true;
      continue;
    }

    const emoji = emojiForChange(item.changeType);

    if (!currentHeader) {
      msg += `\n**General**\n`;
      currentHeader = "General";
    }

    if (!currentAbility && item.section.toLowerCase().includes("stats")) {
      currentAbility = "Stats";
      msg += `• **Stats**\n`;
    }

    msg += `  ${emoji} ${item.text}\n`;
    wroteAny = true;
  }

  return wroteAny ? msg.trim() : "";
}

function formatReadableMessage(items, newest, previous) {
  let msg = "";

  msg += `🟣 **VPBE Patch Notes Update**\n`;
  msg += `🕒 ${newest.timestamp}\n`;
  msg += `🔗 <${VPBE_URL}>\n`;
  msg += `🧾 Revision: ${previous.id} → ${newest.id}\n\n`;

  if (!items.length) {
    msg += "No readable added lines found.";
    return msg;
  }

  msg += `Legend: 🟢 Buff | 🔴 Nerf | 🟡 Adjusted | ✨ New | 🗑️ Removed | 🛠️ Bug Fix\n`;

  const sections = buildPatchNotes(items);
  const order = [
    "Champions",
    "Items",
    "Runes",
    "Systems",
    "Cosmetics",
    "Other",
  ];

  for (const sectionName of order) {
    const sectionItems = sections[sectionName];

    if (!sectionItems || !sectionItems.length) continue;

    const formatted = formatPatchSection(sectionItems);

    if (!formatted) continue;

    msg += `\n## ${formatSectionTitle(sectionName)}\n`;
    msg += `${formatted}\n`;
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
    console.log("No DISCORD_WEBHOOK_URL found in .env");
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
  console.log("Checking VPBE");
  console.log(`SEND_TO_DISCORD = ${SEND_TO_DISCORD}`);
  console.log(`STATE_FILE = ${STATE_FILE}`);

  const revisions = await getRevisions();
  const newest = revisions[0];

  const state = loadState();

  if (!state.lastRevisionId) {
    console.log("Init state");

    saveState({
      lastRevisionId: newest.id,
    });

    return;
  }

  const lastIndex = revisions.findIndex((r) => r.id === state.lastRevisionId);

  if (lastIndex === -1) {
    console.log("Last revision not found in fetched revision list.");
    console.log("Resetting state to newest revision.");

    saveState({
      lastRevisionId: newest.id,
    });

    return;
  }

  if (lastIndex === 0) {
    console.log("No changes");
    return;
  }

  const previous = revisions[lastIndex];

  const addedEntries = getAddedLinesWithSections(
    previous.content,
    newest.content,
  );

  const items = parseDiffLines(addedEntries);
  const message = formatReadableMessage(items, newest, previous);

  console.log(`Previous revision: ${previous.id}`);
  console.log(`Newest revision: ${newest.id}`);
  console.log(`Raw added lines: ${addedEntries.length}`);
  console.log(`Readable items: ${items.length}`);

  console.log("\n=== DISCORD MESSAGE PREVIEW ===\n");
  console.log(message);
  console.log("\n===============================\n");

  if (SEND_TO_DISCORD) {
    await sendToDiscord(message);
    console.log("Sent to Discord");
  } else {
    console.log("Dry run only. Discord message was not sent.");
  }

  saveState({
    lastRevisionId: newest.id,
  });
}

main().catch(async (err) => {
  console.error(err);

  await sendErrorToDiscord(err);

  process.exitCode = 1;
});
