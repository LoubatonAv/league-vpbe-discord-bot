require("dotenv").config();

const fs = require("fs");
const path = require("path");

const STATE_FILE = path.join(__dirname, "essence-emporium-state.json");

const EMPORIUM_URL = "https://wiki.leagueoflegends.com/en-us/Essence_Emporium";

const EMPORIUM_API =
  "https://wiki.leagueoflegends.com/en-us/api.php?action=query&titles=Essence_Emporium&prop=revisions&rvprop=content&rvslots=main&format=json&origin=*";

const DISCORD_WEBHOOK_URL = process.env.ESSENCE_EMPORIUM_WEBHOOK_URL;

const SEND_TO_DISCORD = process.env.SEND_TO_DISCORD !== "false";

// ================= STATE =================

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return {
      status: "UNKNOWN",
      startDate: null,
      endDate: null,
      updatedAt: null,
    };
  }

  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {
      status: "UNKNOWN",
      startDate: null,
      endDate: null,
      updatedAt: null,
    };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ================= FETCH =================

async function fetchPage() {
  const res = await fetch(EMPORIUM_API, {
    headers: {
      "User-Agent": "Mozilla/5.0 Essence Emporium Tracker/1.0",
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`Emporium API failed: ${res.status}`);
  }

  const data = await res.json();
  const pageId = Object.keys(data.query.pages)[0];
  const revision = data.query.pages[pageId].revisions?.[0];

  if (!revision) {
    throw new Error("No Emporium wiki revision found");
  }

  return revision.slots.main["*"];
}

// ================= PARSE =================

function normalize(text = "") {
  return text.replace(/\s+/g, " ").trim();
}

function parseEmporium(html) {
  const text = normalize(
    html
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&"),
  );

  const match = text.match(
    /From\s+([A-Za-z]+\s+\d{1,2}(?:st|nd|rd|th)?)\s+to\s+([A-Za-z]+\s+\d{1,2}(?:st|nd|rd|th)?),?\s+(\d{4})/i,
  );

  if (!match) {
    return { found: false };
  }

  const [, startRaw, endRaw, year] = match;

  const cleanStart = startRaw.replace(/(st|nd|rd|th)/gi, "");
  const cleanEnd = endRaw.replace(/(st|nd|rd|th)/gi, "");

  const startDate = new Date(`${cleanStart}, ${year}`);
  const endDate = new Date(`${cleanEnd}, ${year} 23:59:59`);

  const now = new Date();

  let status = "UNKNOWN";

  if (now < startDate) {
    status = "UPCOMING";
  } else if (now >= startDate && now <= endDate) {
    status = "OPEN";
  } else {
    status = "ENDED";
  }

  return {
    found: true,
    status,
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
  };
}

// ================= DISCORD =================

function formatMessage(data) {
  return (
    `🟦 **Blue Essence Emporium Update**\n` +
    `📅 Status: ${data.status}\n\n` +
    `🟢 Start: ${new Date(data.startDate).toDateString()}\n` +
    `🔴 End: ${new Date(data.endDate).toDateString()}\n\n` +
    `🔗 <${EMPORIUM_URL}>`
  );
}

async function sendToDiscord(message) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log("No webhook found");
    return;
  }

  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content: message,
    }),
  });

  if (!res.ok) {
    console.log(await res.text());
    throw new Error(`Discord failed ${res.status}`);
  }
}

// ================= ERROR =================

async function sendErrorToDiscord(error) {
  const webhook = process.env.ERROR_WEBHOOK_URL;

  if (!webhook) return;

  try {
    await fetch(webhook, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content:
          `🚨 Essence Emporium Bot Error\n\n` +
          `${error.stack || error.message || error}`,
      }),
    });
  } catch (err) {
    console.error("Failed sending error webhook:", err);
  }
}

// ================= MAIN =================

async function main() {
  console.log("Checking Essence Emporium");

  const html = await fetchPage();

  const current = parseEmporium(html);

  console.log(current);

  if (!current.found) {
    throw new Error("Could not parse Essence Emporium dates");
  }

  const previous = loadState();

  const changed =
    previous.status !== current.status ||
    previous.startDate !== current.startDate ||
    previous.endDate !== current.endDate;

  if (!changed) {
    console.log("No changes detected");
    return;
  }

  console.log("Emporium changed");

  const message = formatMessage(current);

  console.log(message);

  if (SEND_TO_DISCORD) {
    await sendToDiscord(message);
    console.log("Discord alert sent");
  } else {
    console.log("Dry run only");
  }

  saveState({
    status: current.status,
    startDate: current.startDate,
    endDate: current.endDate,
    updatedAt: new Date().toISOString(),
  });
}

main().catch(async (err) => {
  console.error(err);

  await sendErrorToDiscord(err);

  process.exitCode = 1;
});
