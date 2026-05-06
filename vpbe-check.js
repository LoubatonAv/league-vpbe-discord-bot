require("dotenv").config();
const fs = require("fs");

const STATE_FILE = "./state.json";

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
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

  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
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

// ================= CLEANING =================

function cleanWikiText(text = "") {
  return text
    .replace(/<ref[\s\S]*?<\/ref>/g, "")
    .replace(/<ref[^/]*\/>/g, "")
    .replace(/{{NumberSup\|([^}]+)}}/g, "$1")
    .replace(/{{RP\|([^}]+)}}/g, "$1 RP")
    .replace(/{{OE\|([^}]+)}}/g, "$1")
    .replace(/{{BE\|([^}]+)}}/g, "$1")
    .replace(/{{tip\|([^}]+)}}/g, "$1")
    .replace(/{{ci\|([^}]+)}}/g, "$1")
    .replace(/{{c\|([^}]+)}}/g, "$1")
    .replace(/{{ii\|([^}]+)}}/g, "$1")
    .replace(/{{univ\|([^}]+)}}/g, "$1")
    .replace(/{{csl\|([^|}]+)\|([^|}]+)\|chromas=true}}/g, "$2 $1")
    .replace(/{{csl\|([^|}]+)\|([^|}]+)}}/g, "$2 $1")
    .replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[https?:\/\/[^\s\]]+\s+([^\]]+)\]/g, "$1")
    .replace(/\[https?:\/\/[^\]]+\]/g, "")
    .replace(/'''/g, "**")
    .replace(/''/g, "")
    .replace(/^\*+\s*/, "")
    .replace(/^:+\s*/, "")
    .replace(/^;+\s*/, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLine(line = "") {
  return line.trim();
}

function shouldIgnoreLine(line = "") {
  const l = line.trim();

  if (!l) return true;
  if (l.startsWith("<!--")) return true;
  if (l.startsWith("-->")) return true;
  if (l.includes("¦")) return true;

  if (l.startsWith("|")) return true;
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

// ================= SECTIONS =================

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

// ================= PARSING =================

function parseDiffLines(addedEntries) {
  const items = [];

  for (const entry of addedEntries) {
    const rawLine = entry.raw;

    if (shouldIgnoreLine(rawLine)) continue;

    const text = cleanWikiText(rawLine);
    if (!text || text.length < 3) continue;

    const type = classifyDiffLine(rawLine, text, entry.section);

    items.push({
      type,
      text,
      raw: rawLine,
      section: entry.section || "General",
    });
  }

  return items;
}

function classifyDiffLine(rawLine, text, section = "") {
  const raw = rawLine.toLowerCase();
  const t = text.toLowerCase();
  const s = section.toLowerCase();

  if (raw.includes("chromas=true")) return "chromas";
  if (raw.includes("{{csl|")) return "skins";

  if (
    s.includes("cosmetic") ||
    t.includes("skin") ||
    t.includes("skins") ||
    t.includes("chroma") ||
    t.includes("emote") ||
    t.includes("ward") ||
    t.includes("icon")
  ) {
    return "cosmetics";
  }

  if (
    s.includes("champion roadmap") ||
    t.includes("new champion") ||
    t.includes("champion roadmap") ||
    t.includes("locke") ||
    t.includes("assassin mid")
  ) {
    return "champions";
  }

  if (
    t.includes("increased") ||
    t.includes("buff") ||
    t.includes("cooldown decreased") ||
    t.includes("damage increased") ||
    /\+\d/.test(t)
  ) {
    return "buffs";
  }

  if (
    t.includes("decreased") ||
    t.includes("reduced") ||
    t.includes("nerf") ||
    t.includes("cooldown increased") ||
    t.includes("damage decreased") ||
    /-\d/.test(t)
  ) {
    return "nerfs";
  }

  return "systems";
}

// ================= FORMAT =================

function groupBySection(items) {
  const grouped = {};

  for (const item of items) {
    if (!grouped[item.section]) {
      grouped[item.section] = [];
    }

    grouped[item.section].push(item);
  }

  return grouped;
}

function emojiForType(type) {
  if (type === "skins") return "🎨";
  if (type === "chromas") return "🌈";
  if (type === "cosmetics") return "🎁";
  if (type === "champions") return "🆕";
  if (type === "buffs") return "🟢";
  if (type === "nerfs") return "🔴";
  return "⚙️";
}

function formatDiffMessage(items, newest, previous) {
  let msg = "";

  msg += `🟣 **VPBE Revision Diff**\n`;
  msg += `🕒 ${newest.timestamp}\n`;
  msg += `🔗 <${VPBE_URL}>\n`;
  msg += `🧾 Revision: ${previous.id} → ${newest.id}\n\n`;

  if (!items.length) {
    msg += "No readable added lines found.";
    return msg;
  }

  const grouped = groupBySection(items);

  for (const [section, sectionItems] of Object.entries(grouped)) {
    msg += `📂 **${section}**\n`;

    for (const item of sectionItems) {
      msg += `${emojiForType(item.type)} ${item.text}\n`;
    }

    msg += "\n";
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

async function main() {
  console.log("Checking VPBE");
  console.log(`SEND_TO_DISCORD = ${SEND_TO_DISCORD}`);

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

  console.log(`Previous revision: ${previous.id}`);
  console.log(`Newest revision: ${newest.id}`);
  console.log(`Raw added lines: ${addedEntries.length}`);
  console.log(`Readable items: ${items.length}`);

  if (!items.length) {
    console.log("No readable changes");

    saveState({
      lastRevisionId: newest.id,
    });

    return;
  }

  const message = formatDiffMessage(items, newest, previous);

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

main().catch(console.error);
