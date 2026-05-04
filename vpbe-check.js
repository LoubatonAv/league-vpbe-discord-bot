require("dotenv").config();
const fs = require("fs");
const STATE_FILE = "./state.json";

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const VPBE_URL = "https://wiki.leagueoflegends.com/en-us/VPBE";

const MODE = "diff";
// "full" = בדיקות פורמט, כל מה שקיים בדף עכשיו
// "diff" = רק מה שנוסף בין revisions

const REVISION_LIMIT = 20;
const SEND_TO_DISCORD = true;

const API =
  `https://wiki.leagueoflegends.com/en-us/api.php?action=query&titles=VPBE` +
  `&prop=revisions&rvprop=ids|timestamp|content&rvslots=main` +
  `&rvlimit=${REVISION_LIMIT}&format=json&origin=*`;

// ================= FETCH =================

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return { lastRevisionId: null };
  }

  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

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

// ================= BASIC HELPERS =================

function sectionBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start === -1) return "";

  const end = text.indexOf(endMarker, start + startMarker.length);
  return text.slice(start, end === -1 ? undefined : end);
}

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
  if (l.startsWith("|")) return true;
  if (l.startsWith("{{Infobox")) return true;
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

  return false;
}

// ================= CURRENT PAGE PARSING =================

function parseCurrentCosmetics(content) {
  const block = sectionBetween(
    content,
    "== New Cosmetics ==",
    "== League of Legends VPBE ==",
  );

  const skins = [];
  const chromas = [];

  const skinRegex =
    /\*\s*\{\{csl\|([^|}]+)\|([^|}]+)\}\}\s*\(\{\{RP\|(\d+)\}\}\)/g;

  const chromaRegex = /\*\s*\{\{csl\|([^|}]+)\|([^|}]+)\|chromas=true\}\}/g;

  let match;

  while ((match = skinRegex.exec(block)) !== null) {
    skins.push({
      champion: cleanWikiText(match[1]),
      skin: cleanWikiText(match[2]),
      price: cleanWikiText(match[3]),
    });
  }

  while ((match = chromaRegex.exec(block)) !== null) {
    chromas.push({
      champion: cleanWikiText(match[1]),
      skin: cleanWikiText(match[2]),
    });
  }

  return { skins, chromas };
}

function parseUpcoming(content) {
  const block = sectionBetween(content, "== Upcoming ==", "{{References}}");
  const lines = block.split("\n");

  const items = [];

  let category = "Upcoming";
  let title = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (shouldIgnoreLine(line)) continue;

    if (line.startsWith("== Upcoming ==")) continue;

    if (line.startsWith("===")) {
      category = cleanWikiText(line.replace(/=/g, ""));
      title = null;
      continue;
    }

    if (line.startsWith(";")) {
      title = cleanWikiText(line);
      continue;
    }

    if (line.startsWith(":")) {
      const text = cleanWikiText(line);
      if (!text) continue;

      items.push({
        category,
        title,
        level: 1,
        text,
      });

      continue;
    }

    if (line.startsWith("*")) {
      const level = line.match(/^\*+/)?.[0].length || 1;
      const text = cleanWikiText(line);

      if (!text) continue;

      items.push({
        category,
        title,
        level,
        text,
      });
    }
  }

  return items;
}

// ================= DIFF PARSING =================

function getAddedLines(oldText, newText) {
  const oldLines = new Set(
    oldText.split("\n").map(normalizeLine).filter(Boolean),
  );

  return newText
    .split("\n")
    .map(normalizeLine)
    .filter(Boolean)
    .filter((line) => !oldLines.has(line));
}

function parseDiffLines(addedLines) {
  const items = [];

  for (const rawLine of addedLines) {
    if (shouldIgnoreLine(rawLine)) continue;

    const text = cleanWikiText(rawLine);
    if (!text || text.length < 3) continue;

    const type = classifyDiffLine(rawLine, text);

    items.push({
      type,
      text,
      raw: rawLine,
    });
  }

  return items;
}

function classifyDiffLine(rawLine, text) {
  const raw = rawLine.toLowerCase();
  const t = text.toLowerCase();

  if (raw.includes("chromas=true")) return "chromas";
  if (raw.includes("{{csl|")) return "skins";

  if (
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

function formatUpcomingItem(item) {
  const bullet = item.level > 1 ? "  ◦" : "•";

  if (item.title) {
    return `${bullet} **${item.title}** — ${item.text}`;
  }

  return `${bullet} ${item.text}`;
}

function formatFullMessage(content, revision) {
  const current = parseCurrentCosmetics(content);
  const upcoming = parseUpcoming(content);

  const game = upcoming.filter((x) => x.category === "Game");
  const cosmetics = upcoming.filter((x) => x.category === "Cosmetics");
  const champions = upcoming.filter((x) => x.category === "Champion Roadmap");

  let msg = "";

  msg += `🟣 **VPBE Patch Notes Preview**\n`;
  msg += `🕒 ${revision.timestamp}\n`;
  msg += `🔗 ${VPBE_URL}\n`;
  msg += `🧪 Mode: FULL current page, no state\n\n`;

  msg += `🔥 **Current PBE Patch**\n\n`;

  if (current.skins.length) {
    msg += `🎨 **New Skins**\n`;
    for (const skin of current.skins) {
      msg += `• **${skin.skin} ${skin.champion}** — ${skin.price} RP\n`;
    }
    msg += "\n";
  }

  if (current.chromas.length) {
    msg += `🌈 **New Chromas**\n`;
    for (const chroma of current.chromas) {
      msg += `• **${chroma.skin} ${chroma.champion}**\n`;
    }
    msg += "\n";
  }

  if (game.length || cosmetics.length || champions.length) {
    msg += `🔮 **Upcoming / Roadmap**\n\n`;
  }

  if (game.length) {
    msg += `⚙️ **Game**\n`;
    for (const item of game) {
      msg += `${formatUpcomingItem(item)}\n`;
    }
    msg += "\n";
  }

  if (cosmetics.length) {
    msg += `🎁 **Upcoming Cosmetics**\n`;
    for (const item of cosmetics) {
      msg += `${formatUpcomingItem(item)}\n`;
    }
    msg += "\n";
  }

  if (champions.length) {
    msg += `🆕 **Champion Roadmap**\n`;
    for (const item of champions) {
      msg += `${formatUpcomingItem(item)}\n`;
    }
    msg += "\n";
  }

  return msg.trim();
}

function formatDiffMessage(items, newest, previous) {
  const skins = items.filter((x) => x.type === "skins");
  const chromas = items.filter((x) => x.type === "chromas");
  const cosmetics = items.filter((x) => x.type === "cosmetics");
  const champions = items.filter((x) => x.type === "champions");
  const buffs = items.filter((x) => x.type === "buffs");
  const nerfs = items.filter((x) => x.type === "nerfs");
  const systems = items.filter((x) => x.type === "systems");

  let msg = "";

  msg += `🟣 **VPBE Revision Diff Preview**\n`;
  msg += `🕒 ${newest.timestamp}\n`;
  msg += `🔗 ${VPBE_URL}\n`;
  msg += `🧪 Mode: DIFF, no state\n`;
  msg += `🧾 Revision: ${previous.id} → ${newest.id}\n\n`;

  if (!items.length) {
    msg += "No readable added lines found.";
    return msg;
  }

  if (skins.length) {
    msg += `🎨 **New Skins**\n`;
    for (const item of skins) msg += `• ${item.text}\n`;
    msg += "\n";
  }

  if (chromas.length) {
    msg += `🌈 **New Chromas**\n`;
    for (const item of chromas) msg += `• ${item.text}\n`;
    msg += "\n";
  }

  if (cosmetics.length) {
    msg += `🎁 **Other Cosmetics**\n`;
    for (const item of cosmetics) msg += `• ${item.text}\n`;
    msg += "\n";
  }

  if (champions.length) {
    msg += `🆕 **Champions / Roadmap**\n`;
    for (const item of champions) msg += `• ${item.text}\n`;
    msg += "\n";
  }

  if (buffs.length) {
    msg += `🟢 **Possible Buffs**\n`;
    for (const item of buffs) msg += `• ${item.text}\n`;
    msg += "\n";
  }

  if (nerfs.length) {
    msg += `🔴 **Possible Nerfs**\n`;
    for (const item of nerfs) msg += `• ${item.text}\n`;
    msg += "\n";
  }

  if (systems.length) {
    msg += `⚙️ **Systems / Other**\n`;
    for (const item of systems) msg += `• ${item.text}\n`;
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
      chunks.push(current.trim());
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
  console.log(`Checking VPBE. MODE = ${MODE}`);

  const revisions = await getRevisions();
  const newest = revisions[0];

  const state = loadState();

  // 🔥 פעם ראשונה
  if (!state.lastRevisionId) {
    console.log("Init state");

    saveState({
      lastRevisionId: newest.id,
    });

    return;
  }

  // 🔥 למצוא את ה־revision האחרון ששלחנו
  const lastIndex = revisions.findIndex((r) => r.id === state.lastRevisionId);

  if (lastIndex === -1) {
    console.log("Last revision not found, resetting state");

    saveState({
      lastRevisionId: newest.id,
    });

    return;
  }

  // 🔥 אין שינוי
  if (lastIndex === 0) {
    console.log("No changes");
    return;
  }

  // 🔥 יש שינויים — משווים בין הישן לחדש
  const previous = revisions[lastIndex];

  const addedLines = getAddedLines(previous.content, newest.content);
  const items = parseDiffLines(addedLines);

  console.log(`Previous revision: ${previous.id}`);
  console.log(`Newest revision: ${newest.id}`);
  console.log(`Raw added lines: ${addedLines.length}`);
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
  }

  // 🔥 חשוב — לעדכן state
  saveState({
    lastRevisionId: newest.id,
  });
}

main().catch(console.error);
