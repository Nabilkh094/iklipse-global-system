// The whole relay, end to end, on the server but apart from the real one:
// a fake WAHA on a local port, fake claude / codex / grok that answer at once
// in each CLI's JSON, its own state folder and its own worker home. Nothing
// reaches WhatsApp, a model or the running relay.
//
//   sudo node personal/e2e.server.mjs        (as root, on the server; needs the claude-me user)

import { spawn, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const T = "/tmp/relay-e2e";
rmSync(T, { recursive: true, force: true });
for (const d of ["bin", "state", "creds", "home/.codex", "home/.grok", "home/.claude", "home/work"]) mkdirSync(join(T, d), { recursive: true });
for (const f of ["home/.codex/auth.json", "home/.grok/auth.json", "home/.claude/.credentials.json"]) writeFileSync(join(T, f), "{}");
writeFileSync(join(T, "creds/waha.key"), "test-key");
writeFileSync(join(T, "jev.key"), "");
execFileSync("chown", ["-R", "claude-me:", join(T, "home")]);
chmodSync(T, 0o755);

// Each fake answers with what it was asked (its first 120 chars, and whether it was handed the chat).
const fake = (name, body) => {
  const p = join(T, "bin", name);
  writeFileSync(p, `#!/usr/bin/env node\nconst args = process.argv.slice(2);\nlet input = "";\nprocess.stdin.on("data", (d) => (input += d));\nprocess.stdin.on("end", () => {\n  const prompt = input || args[args.length - 1] || "";\n  const said = (who) => who + " got: " + (/taking over this chat/.test(prompt) ? "[HANDOFF] " : "") + (/Since you last answered/.test(prompt) ? "[CATCH-UP] " : "") + (args.includes("plan") || args.includes("read-only") || /read-only/.test(args.join(" ")) ? "[PLAN] " : "") + prompt.split("[Now the new request:]").pop().replace(/\\s+/g, " ").trim().slice(0, 120);\n  const state = '\\n<state>{"goal":"test goal","done":["step ' + Date.now() % 1000 + '"],"left":["more"],"files":["a.txt"]}</state>';\n${body}\n});\n`);
  chmodSync(p, 0o755);
};
fake("claude", `  console.log(JSON.stringify({ type: "system", subtype: "init", model: args.includes("haiku") ? "claude-haiku" : "claude-opus-5-5", session_id: "cl-1" }));
  if (/Answer with JSON only:\\n\\{"provider"/.test(prompt)) { console.log(JSON.stringify({ type: "result", result: '{"provider":"grok","taskType":"research","effort":"low","sensitive":false}', is_error: false, total_cost_usd: 0.001, session_id: "cl-q" })); return; }
  if (/^Cut this request/.test(prompt)) { console.log(JSON.stringify({ type: "result", result: '{"parts":[{"worker":"gpt","part":"part A"},{"worker":"grok","part":"part B"}]}', is_error: false, total_cost_usd: 0.01, session_id: "cl-c" })); return; }
  if (/^(Several models answered|These parts)/.test(prompt)) { console.log(JSON.stringify({ type: "result", result: "CENTRAL MERGED: " + (prompt.match(/--- (\\w+)/g) || []).join(" "), is_error: false, total_cost_usd: 0.02, session_id: "cl-m" })); return; }
  console.log(JSON.stringify({ type: "result", result: said("claude") + state, is_error: false, total_cost_usd: 0.05, usage: { input_tokens: 100, output_tokens: 20 }, session_id: "cl-1" }));`);
fake("codex", `  console.log(JSON.stringify({ type: "thread.started", thread_id: "gpt-1" }));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: said("gpt") + state } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5000, output_tokens: 300 } }));`);
fake("grok", `  console.log(JSON.stringify({ type: "session", session_id: "grok-1", model: "grok-build" }));
  console.log(JSON.stringify({ type: "result", result: said("grok") + state, usage: { input_tokens: 4000, output_tokens: 200 } }));`);

// The fake WAHA: the group's messages come from \`inbox\`; what the relay sends lands in \`outbox\`.
const inbox = [];
const outbox = [];
let n = 0;
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (req.method === "GET" && /\/messages/.test(req.url)) return res.end(JSON.stringify(inbox.slice(-20)));
    if (req.method === "POST" && req.url === "/api/sendText") {
      const j = JSON.parse(body);
      outbox.push(j.text);
      return res.end(JSON.stringify({ id: `true_g@g.us_OUT${++n}_x@lid` }));
    }
    res.end("{}");
  });
});
await new Promise((r) => server.listen(39123, "127.0.0.1", r));

const relay = spawn(process.execPath, [join(here, "relay.mjs")], {
  env: {
    PATH: process.env.PATH,
    WAHA_URL: "http://127.0.0.1:39123",
    GROUP: "123@g.us",
    OWNERS: "999@lid",
    CLAUDE_USER: "claude-me",
    WORKER_HOME: join(T, "home"),
    CLAUDE_BIN: join(T, "bin/claude"),
    CODEX_BIN: join(T, "bin/codex"),
    GROK_BIN: join(T, "bin/grok"),
    JEV_KEY_FILE: join(T, "jev.key"),
    STATE_DIRECTORY: join(T, "state"),
    CREDENTIALS_DIRECTORY: join(T, "creds"),
  },
  stdio: ["ignore", "inherit", "inherit"],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ts = Math.floor(Date.now() / 1000) + 5;
/** Nabil sends one message; what the relay says back within the wait. */
const send = async (body, wait = 5000) => {
  const before = outbox.length;
  inbox.push({ id: `in${++n}`, timestamp: ++ts, fromMe: false, participant: "999@lid", body });
  const until = Date.now() + wait;
  while (Date.now() < until) {
    await sleep(300);
    if (outbox.length > before && Date.now() > until - wait + 2500) break;
  }
  const got = outbox.slice(before);
  console.log(`\n>>> ${body}\n${got.map((g) => `<<< ${g}`).join("\n") || "<<< (nothing)"}`);
  return got.join("\n");
};

const checks = [];
const expect = (name, ok) => checks.push([name, ok]);
await sleep(2500);
try {
  expect("default worker answers, footer shows it", /claude got: make a landing page[\s\S]*_Claude · claude-opus-5-5/.test(await send("make a landing page")));
  expect("state line hidden", !outbox.some((o) => /<state>/.test(o)));
  expect("/use gpt keeps the chat", /now uses GPT\. It takes over with this chat's history/.test(await send("/use gpt")));
  expect("GPT gets the handoff", /gpt got: \[HANDOFF\] now the footer[\s\S]*_GPT · default model/.test(await send("now the footer")));
  expect("back to Claude: only what it missed", /claude got: \[CATCH-UP\] and the colors/.test((await send("/use claude"), await send("and the colors"))));
  expect("/task keeps state", /Goal: test goal[\s\S]*Files: a\.txt/.test(await send("/task")));
  expect("guardrails: a plan first", /claude got: \[PLAN\] deploy it to production[\s\S]*touches the guardrails/.test(await send("deploy it to production")));
  expect("go: approved and run", /claude got: go/.test(await send("go")) && /Approved:/.test(await send("/task")));
  expect("settings + undo", /Replies in Arabic/.test(await send("/language Arabic")) && /Took back the last change to language/.test(await send("/undo")));
  expect("auto picks (Haiku without Jev)", /grok got:[\s\S]*picked by: auto \(claude: research/.test((await send("/auto"), await send("what's new on X today?"))));
  expect("dry runs nothing", /would take it[\s\S]*nothing was run/.test(await send("/dry fix the login bug")));
  expect("team compare merged by central", /CENTRAL MERGED[\s\S]*Team \(compare\)/.test(await send("/team compare best product name", 9000)));
  expect("team split", /Team \(split\), 2 parts[\s\S]*CENTRAL MERGED/.test(await send("/team split research and then build", 9000)));
  await send("/limits gpt day 1k");
  expect("limit holds GPT", /GPT is over its day limit[\s\S]*\/force/.test((await send("/use gpt"), await send("one more"))));
  expect("force runs it", /gpt got:/.test(await send("/force")));
  expect("usage and faults", /\*Usage\*[\s\S]*GPT:.*OVER day limit/.test(await send("/usage")) && /No faults|Last faults/.test(await send("/faults")));
  expect("logins", /✅ Claude[\s\S]*✅ GPT[\s\S]*✅ Grok[\s\S]*⏳ Jev/.test(await send("/logins")));
} finally {
  relay.kill();
  server.close();
}
console.log("\n" + checks.map(([n, ok]) => `${ok ? "PASS" : "FAIL"} ${n}`).join("\n"));
const failed = checks.filter(([, ok]) => !ok).length;
console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
rmSync(T, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
