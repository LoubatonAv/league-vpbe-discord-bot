require("dotenv").config();

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { chromium } = require("playwright");

const FORCE_SEND = process.env.FORCE_SEND === "true";
const STATE_FILE = path.join(__dirname, "skin-newest-state.json");
const DEBUG_JSON_FILE = path.join(__dirname, "debug-loldb-skins.json");
const DEBUG_HTML_FILE = path.join(__dirname, "debug-loldb-skins.html");
const DEBUG_SCREENSHOT_FILE = path.join(__dirname, "debug-loldb-skins.png");

const SKINS_URL = "https://loldb.info/skins";

const DISCORD_WEBHOOK_URL =
  process.env.SKIN_NEWEST_WEBHOOK_URL ||
  process.env.SKIN_SALE_WEBHOOK_URL ||
  process.env.DISCORD_WEBHOOK_URL;

const ERROR_WEBHOOK_URL = process.env.ERROR_WEBHOOK_URL;
const SEND_TO_DISCORD = process.env.SEND_TO_DISCORD !== "false";

const UPCOMING_LIMIT = Number(process.env.SKIN_NEWEST_UPCOMING_LIMIT || 10);
const SCAN_LIMIT = Number(process.env.SKIN_NEWEST_SCAN_LIMIT || 30);

// ================= STATE =================

function getDefaultState() {
  return {
    hash: null,
    skins: [],
    updatedAt: null,
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

// ================= HELPERS =================

function normalizeText(text = "") {
  return String(text)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function createHash(payload) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

function normalizeSkinUrl(url = "") {
  if (!url) return SKINS_URL;

  try {
    const parsed = new URL(url, SKINS_URL);
    return parsed.origin + parsed.pathname;
  } catch {
    return url;
  }
}

function getSkinKey(skin) {
  if (skin.href) return skin.href.toLowerCase();
  return `${skin.name}|${skin.champion || "Unknown"}`.toLowerCase();
}

function dedupeSkins(skins = []) {
  const map = new Map();

  for (const skin of skins) {
    const key = getSkinKey(skin);

    if (!map.has(key)) {
      map.set(key, skin);
    }
  }

  return [...map.values()];
}

function getDiff(oldSkins = [], newSkins = []) {
  const oldMap = new Map(oldSkins.map((skin) => [getSkinKey(skin), skin]));
  const newMap = new Map(newSkins.map((skin) => [getSkinKey(skin), skin]));

  const added = [];

  for (const [key, skin] of newMap) {
    if (!oldMap.has(key)) {
      added.push(skin);
    }
  }

  return { added };
}

function skinForHash(skin) {
  return {
    name: skin.name,
    champion: skin.champion,
    price: skin.price,
    href: skin.href,
    isPbe: skin.isPbe,
  };
}

function cleanLine(line = "") {
  return normalizeText(line)
    .replace(/^new$/i, "")
    .replace(/^sale$/i, "")
    .trim();
}

function isNoiseLine(line = "") {
  const value = normalizeText(line).toLowerCase();

  if (!value) return true;

  const noise = [
    "skins",
    "skin",
    "all skins",
    "legacy",
    "regular",
    "epic",
    "legendary",
    "mythic",
    "ultimate",
    "exalted",
    "transcendent",
    "chromas",
    "skin lines",
    "longest skin wait",
    "homepage",
    "champions",
    "shop",
    "tools",
    "cosmetics",
    "global search",
    "weekly giveaways",
    "advertisement",
    "remove ads",
    "loldb",
    "league of legends",
    "not affiliated with riot games",
  ];

  if (noise.includes(value)) return true;
  if (/^explore\s+\d+/i.test(value)) return true;
  if (/^\d+$/.test(value)) return true;

  return false;
}

function titleCaseSlugPart(part) {
  const lower = part.toLowerCase();

  const special = {
    kda: "K/DA",
    drx: "DRX",
    t1: "T1",
    skt: "SKT",
    ig: "IG",
    project: "PROJECT:",
    psyops: "PsyOps",
  };

  if (special[lower]) return special[lower];

  return part.charAt(0).toUpperCase() + part.slice(1);
}

function slugToSkinName(href = "") {
  try {
    const parsed = new URL(href, SKINS_URL);
    const slug = parsed.pathname.replace("/skins/", "").replace(/\/$/, "");

    if (!slug || slug.includes("/")) return "";

    return slug.split("-").map(titleCaseSlugPart).join(" ");
  } catch {
    return "";
  }
}

function extractChampionFromName(name = "") {
  const clean = normalizeText(name);

  const knownChampionSuffixes = [
    "Aatrox",
    "Ahri",
    "Akali",
    "Akshan",
    "Alistar",
    "Ambessa",
    "Amumu",
    "Anivia",
    "Annie",
    "Aphelios",
    "Ashe",
    "Aurelion Sol",
    "Aurora",
    "Azir",
    "Bard",
    "Bel'Veth",
    "Blitzcrank",
    "Brand",
    "Braum",
    "Briar",
    "Caitlyn",
    "Camille",
    "Cassiopeia",
    "Cho'Gath",
    "Corki",
    "Darius",
    "Diana",
    "Dr. Mundo",
    "Draven",
    "Ekko",
    "Elise",
    "Evelynn",
    "Ezreal",
    "Fiddlesticks",
    "Fiora",
    "Fizz",
    "Galio",
    "Gangplank",
    "Garen",
    "Gnar",
    "Gragas",
    "Graves",
    "Gwen",
    "Hecarim",
    "Heimerdinger",
    "Hwei",
    "Illaoi",
    "Irelia",
    "Ivern",
    "Janna",
    "Jarvan IV",
    "Jax",
    "Jayce",
    "Jhin",
    "Jinx",
    "K'Sante",
    "Kai'Sa",
    "Kalista",
    "Karma",
    "Karthus",
    "Kassadin",
    "Katarina",
    "Kayle",
    "Kayn",
    "Kennen",
    "Kha'Zix",
    "Kindred",
    "Kled",
    "Kog'Maw",
    "LeBlanc",
    "Lee Sin",
    "Leona",
    "Lillia",
    "Lissandra",
    "Lucian",
    "Lulu",
    "Lux",
    "Malphite",
    "Malzahar",
    "Maokai",
    "Master Yi",
    "Mel",
    "Milio",
    "Miss Fortune",
    "Mordekaiser",
    "Morgana",
    "Naafiri",
    "Nami",
    "Nasus",
    "Nautilus",
    "Neeko",
    "Nidalee",
    "Nilah",
    "Nocturne",
    "Nunu & Willump",
    "Olaf",
    "Orianna",
    "Ornn",
    "Pantheon",
    "Poppy",
    "Pyke",
    "Qiyana",
    "Quinn",
    "Rakan",
    "Rammus",
    "Rek'Sai",
    "Rell",
    "Renata Glasc",
    "Renekton",
    "Rengar",
    "Riven",
    "Rumble",
    "Ryze",
    "Samira",
    "Sejuani",
    "Senna",
    "Seraphine",
    "Sett",
    "Shaco",
    "Shen",
    "Shyvana",
    "Singed",
    "Sion",
    "Sivir",
    "Skarner",
    "Smolder",
    "Sona",
    "Soraka",
    "Swain",
    "Sylas",
    "Syndra",
    "Tahm Kench",
    "Taliyah",
    "Talon",
    "Taric",
    "Teemo",
    "Thresh",
    "Tristana",
    "Trundle",
    "Tryndamere",
    "Twisted Fate",
    "Twitch",
    "Udyr",
    "Urgot",
    "Varus",
    "Vayne",
    "Veigar",
    "Vel'Koz",
    "Vex",
    "Vi",
    "Viego",
    "Viktor",
    "Vladimir",
    "Volibear",
    "Warwick",
    "Wukong",
    "Xayah",
    "Xerath",
    "Xin Zhao",
    "Yasuo",
    "Yone",
    "Yorick",
    "Yuumi",
    "Zac",
    "Zed",
    "Zeri",
    "Ziggs",
    "Zilean",
    "Zoe",
    "Zyra",
  ];

  const found = knownChampionSuffixes.find((champion) =>
    clean.toLowerCase().endsWith(` ${champion.toLowerCase()}`),
  );

  if (found) return found;

  if (/ command line yi$/i.test(clean)) return "Master Yi";
  if (/choncc kench$/i.test(clean)) return "Tahm Kench";

  return "Unknown";
}

function parsePriceFromText(text = "") {
  const normalized = normalizeText(text);

  if (/\bN\/A\b/i.test(normalized)) return "N/A";

  const rpMatch = normalized.match(/(\d{2,5})\s*RP/i);
  if (rpMatch) return Number(rpMatch[1]);

  const barePriceMatch = normalized.match(
    /(?:^|\s)(390|520|750|975|1350|1820|2775|3250)(?:\s|$)/,
  );

  if (barePriceMatch) return Number(barePriceMatch[1]);

  return null;
}

function isValidSkinHref(href = "") {
  if (!href) return false;

  try {
    const parsed = new URL(href, SKINS_URL);
    const pathname = parsed.pathname;

    if (!pathname.startsWith("/skins/")) return false;
    if (pathname === "/skins" || pathname === "/skins/") return false;

    if (pathname.includes("/rarity/")) return false;
    if (pathname.includes("/champion/")) return false;
    if (pathname.includes("/skin-line/")) return false;
    if (pathname.includes("/release-date/")) return false;

    const slug = pathname.replace("/skins/", "").replace(/\/$/, "");

    if (!slug) return false;
    if (slug.includes("/")) return false;

    const badSlugs = new Set([
      "legacy",
      "regular",
      "epic",
      "legendary",
      "mythic",
      "ultimate",
      "exalted",
      "transcendent",
      "chromas",
      "all",
    ]);

    if (badSlugs.has(slug.toLowerCase())) return false;

    return true;
  } catch {
    return false;
  }
}

function buildSkinFromCard(card) {
  const href = normalizeSkinUrl(card.href || "");

  if (!isValidSkinHref(href)) return null;

  const lines = [...(card.lines || []), card.imgAlt || ""]
    .map(cleanLine)
    .filter((line) => line && !isNoiseLine(line));

  const uniqueLines = [...new Set(lines)];

  const fullText = normalizeText(
    [card.text || "", card.imgAlt || "", uniqueLines.join(" ")].join(" "),
  );

  const slugName = slugToSkinName(href);

  const nameCandidate = uniqueLines.find((line) => {
    if (/^\d+\s*RP$/i.test(line)) return false;
    if (/^N\/A$/i.test(line)) return false;
    if (/^(390|520|750|975|1350|1820|2775|3250)$/i.test(line)) return false;

    return line.length >= 3 && line.length <= 90;
  });

  let name = normalizeText(nameCandidate || slugName);

  if (!name || name.length < 3) return null;

  name = name.replace(/^Project /, "PROJECT: ");

  const champion = extractChampionFromName(name);
  const price = parsePriceFromText(fullText);
  const image = card.imgSrc || null;
  const isPbe = Boolean(image && image.includes("/pbe/"));

  return {
    name,
    champion,
    price,
    href,
    image,
    isPbe,
    source: "LoLDB",
  };
}

function isUpcomingSkin(skin) {
  return skin.isPbe === true;
}

function buildTrackedSkins(allSkins = []) {
  const upcomingSkins = allSkins
    .filter(isUpcomingSkin)
    .slice(0, UPCOMING_LIMIT);

  return upcomingSkins;
}

// ================= SCRAPE =================

async function fetchNewestSkins() {
  const browser = await chromium.launch({
    headless: true,
  });

  const page = await browser.newPage({
    viewport: {
      width: 1440,
      height: 1800,
    },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  try {
    await page.goto(SKINS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    await page.waitForTimeout(6000);

    const html = await page.content();

    const rawCards = await page.evaluate((scanLimit) => {
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

      function isRealSkinUrl(href) {
        if (!href) return false;

        try {
          const url = new URL(href);
          const pathname = url.pathname;

          if (!pathname.startsWith("/skins/")) return false;
          if (pathname === "/skins" || pathname === "/skins/") return false;

          if (pathname.includes("/rarity/")) return false;
          if (pathname.includes("/champion/")) return false;
          if (pathname.includes("/skin-line/")) return false;
          if (pathname.includes("/release-date/")) return false;

          const slug = pathname.replace("/skins/", "").replace(/\/$/, "");

          if (!slug) return false;
          if (slug.includes("/")) return false;

          return true;
        } catch {
          return false;
        }
      }

      function bestContainerFor(anchor) {
        const candidates = [
          anchor,
          anchor.closest("article"),
          anchor.closest("li"),
          anchor.closest("[role='listitem']"),
          anchor.parentElement,
          anchor.parentElement?.parentElement,
          anchor.parentElement?.parentElement?.parentElement,
        ].filter(Boolean);

        let best = anchor;

        for (const el of candidates) {
          const rect = el.getBoundingClientRect();
          const text = textOf(el);

          if (rect.width < 80 || rect.height < 40) continue;
          if (rect.height > 500) continue;
          if (!text) continue;

          if (text.length >= textOf(best).length && text.length <= 350) {
            best = el;
          }
        }

        return best;
      }

      const anchors = Array.from(
        document.querySelectorAll("a[href*='/skins/']"),
      )
        .filter((anchor) => isRealSkinUrl(anchor.href))
        .slice(0, scanLimit);

      const cards = [];

      for (const anchor of anchors) {
        const container = bestContainerFor(anchor);
        const img =
          container.querySelector("img") || anchor.querySelector("img");

        const imgSrc =
          img?.currentSrc || img?.src || img?.getAttribute("src") || "";

        const imgAlt =
          img?.alt ||
          img?.getAttribute("alt") ||
          img?.getAttribute("title") ||
          "";

        cards.push({
          text: textOf(container),
          lines: linesOf(container),
          href: anchor.href || "",
          imgSrc,
          imgAlt,
          className: container.className ? String(container.className) : "",
        });
      }

      return cards;
    }, SCAN_LIMIT);

    console.log("Raw LoLDB cards:", rawCards.length);
    console.log(
      "First raw LoLDB cards:",
      JSON.stringify(rawCards.slice(0, 12), null, 2),
    );

    if (process.env.DEBUG_LOLDB_SKINS === "true") {
      fs.writeFileSync(DEBUG_JSON_FILE, JSON.stringify(rawCards, null, 2));
      fs.writeFileSync(DEBUG_HTML_FILE, html);

      await page.screenshot({
        path: DEBUG_SCREENSHOT_FILE,
        fullPage: true,
      });
    }

    const allSkins = dedupeSkins(
      rawCards.map(buildSkinFromCard).filter(Boolean),
    );
    const skins = buildTrackedSkins(allSkins);

    console.log("Parsed LoLDB skins:", allSkins.length);
    console.log("Upcoming tracked skins:", skins.length);
    console.log(
      "Tracked skin preview:",
      JSON.stringify(skins.slice(0, 20), null, 2),
    );

    return {
      skins,
      allSkins,
      rawCardsCount: rawCards.length,
    };
  } finally {
    await browser.close();
  }
}

// ================= FORMAT =================

function formatPrice(price) {
  if (price === "N/A") return "N/A";
  if (typeof price === "number") return `${price} RP`;
  return "Unknown price";
}

function formatSkinLine(skin) {
  const tags = [];

  if (skin.price === "N/A") tags.push("N/A");
  if (skin.isPbe) tags.push("PBE");

  const tagText = tags.length ? ` — ${tags.join(" / ")}` : "";

  const champion =
    skin.champion && skin.champion !== "Unknown" ? ` — ${skin.champion}` : "";

  return `• ${skin.name}${champion} — ${formatPrice(skin.price)}${tagText}`;
}

function formatDiscordMessage({ added, skins }) {
  let msg = "";

  msg += `✨ **Upcoming League Skins Detected**\n`;
  msg += `🔗 <${SKINS_URL}>\n\n`;

  if (added.length) {
    msg += `🟢 **New Since Last Check**\n`;
    for (const skin of added) {
      msg += `${formatSkinLine(skin)}\n`;
    }

    return msg.trim();
  }

  msg += `📌 **Current Upcoming Watchlist**\n`;
  for (const skin of skins) {
    msg += `${formatSkinLine(skin)}\n`;
  }

  return msg.trim();
}

// ================= DISCORD =================

async function sendToDiscord(message) {
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
            text: "LoLDB Upcoming Skin Tracker",
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

// ================= MAIN =================

async function main() {
  console.log("Checking upcoming League skins from LoLDB");
  console.log(`SEND_TO_DISCORD = ${SEND_TO_DISCORD}`);
  console.log(`STATE_FILE = ${STATE_FILE}`);
  console.log(`SKINS_URL = ${SKINS_URL}`);
  console.log(`UPCOMING_LIMIT = ${UPCOMING_LIMIT}`);
  console.log(`SCAN_LIMIT = ${SCAN_LIMIT}`);

  const result = await fetchNewestSkins();
  const skins = result.skins;

  console.log(`Raw cards found: ${result.rawCardsCount}`);
  console.log(`Upcoming skins parsed: ${skins.length}`);

  if (skins.length < 1) {
    throw new Error(
      "No upcoming skins parsed from LoLDB. Run with DEBUG_LOLDB_SKINS=true and check debug files in check/skin-newest/.",
    );
  }

  for (const skin of skins) {
    console.log(formatSkinLine(skin));
    console.log(`  href: ${skin.href}`);
    console.log(`  image: ${skin.image}`);
  }

  const newHash = createHash({
    skins: skins.map(skinForHash),
  });

  const state = loadState();

  if (!state.hash) {
    console.log("Initializing upcoming skin state");

    saveState({
      hash: newHash,
      skins,
      updatedAt: new Date().toISOString(),
    });

    return;
  }

  if (state.hash === newHash && !FORCE_SEND) {
    console.log("No upcoming skin changes");
    return;
  }

  const diff = FORCE_SEND ? { added: skins } : getDiff(state.skins, skins);

  if (diff.added.length === 0 && !FORCE_SEND) {
    console.log(
      "Upcoming skin list changed, but no new upcoming skins were detected.",
    );
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
    skins,
  });

  console.log("\n=== DISCORD MESSAGE PREVIEW ===\n");
  console.log(message);
  console.log("\n===============================\n");

  if (SEND_TO_DISCORD) {
    await sendToDiscord(message);
    console.log("Sent upcoming skin update to Discord");
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
