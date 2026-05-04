require("dotenv").config();

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

async function main() {
  if (!DISCORD_WEBHOOK_URL) {
    console.log("Missing DISCORD_WEBHOOK_URL");
    return;
  }

  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content: "✅ Discord webhook test works!",
    }),
  });

  console.log(res.status, res.statusText);
}

main();
