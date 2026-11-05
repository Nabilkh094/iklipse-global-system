#!/usr/bin/env node
// iklipse-bot: a worker's way to the company bot, through the relay (bot.mjs).
//   iklipse-bot ask "question"   reading only; prints the bot's answer
//   iklipse-bot do "request"     asks Nabil for his go in the group first
// The relay gives each worker IKLIPSE_BOT (its address on this server),
// IKLIPSE_BOT_TOKEN and IKLIPSE_BOT_RUN; the master key never leaves the relay.
// Installed as /usr/local/bin/iklipse-bot.

const [op, ...rest] = process.argv.slice(2);
const text = rest.join(" ").trim();
const url = process.env.IKLIPSE_BOT;
const token = process.env.IKLIPSE_BOT_TOKEN;
if (!["ask", "do"].includes(op) || !text) {
  console.error('iklipse-bot ask "question" | iklipse-bot do "request"');
  process.exit(2);
}
if (!url || !token) {
  console.error("The company bot isn't connected here.");
  process.exit(1);
}
try {
  const r = await fetch(`${url}/${op}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ text, run: process.env.IKLIPSE_BOT_RUN ?? "" }),
    signal: AbortSignal.timeout(25 * 60_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error(j.error || `The relay answered ${r.status}.`);
    process.exit(1);
  }
  console.log(j.answer ?? "");
  process.exit(j.ok ? 0 : 1);
} catch (e) {
  console.error(`The company bot didn't answer: ${e.message}`);
  process.exit(1);
}
