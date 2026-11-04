// The chat record and handoff, settings, usage and limits, the router's
// fallbacks, team mode and Slack's messages: plain functions, fake runners.

import { test } from "node:test";
import assert from "node:assert/strict";
import { addTurn, approveLast, handoffFor, isApproval, markSeen, mergeState, splitState } from "./chatlog.mjs";
import { defaultSettings, parseAmount, pickProvider, settingsCommand, systemFor, withDefaults } from "./settings.mjs";
import { faultKind, faultsReport, limitState, record, spent, usageReport } from "./usage.mjs";
import { jsonIn, route, sensitiveByWords, teamMode } from "./router.mjs";
import { compare, parsePlan, split } from "./team.mjs";
import { fromSlackEvent } from "./slack.mjs";

const LABELS = { claude: "Claude", gpt: "GPT", grok: "Grok" };

test("T4: the state line comes off the answer and into the chat's task", () => {
  const { text, state } = splitState('Built the page.\n<state>{"goal":"landing page","done":["hero"],"left":["footer"],"files":["index.html"]}</state>\n');
  assert.equal(text, "Built the page.");
  const conv = {};
  mergeState(conv, state);
  mergeState(conv, { done: ["hero", "footer"], left: [], files: ["style.css"] });
  assert.deepEqual(conv.task, { goal: "landing page", done: ["hero", "footer"], left: [], files: ["index.html", "style.css"], approved: [] });
  assert.deepEqual(splitState("no state here"), { text: "no state here", state: null });
  assert.equal(splitState("x <state>not json</state>").state, null);
});

test("T4: a model taking over gets the whole record; one coming back gets what it missed", () => {
  const conv = { history: [], sessions: {} };
  addTurn(conv, "nabil", "make a landing page");
  addTurn(conv, "claude", "Plan: hero, footer.");
  conv.sessions.claude = "s-claude";
  markSeen(conv, "claude");
  assert.ok(isApproval("go"));
  assert.ok(!isApproval("go and also add a blog"));
  approveLast(conv);
  mergeState(conv, { goal: "landing page", done: ["hero"], left: ["footer"] });

  const taking = handoffFor(conv, "gpt", LABELS);
  assert.match(taking, /taking over this chat from Claude/);
  assert.match(taking, /Approved by Nabil/);
  assert.match(taking, /Plan: hero, footer\./);
  assert.match(taking, /Left:\n- footer/);

  addTurn(conv, "nabil", "now the footer");
  addTurn(conv, "gpt", "Footer done.");
  conv.sessions.gpt = "t-1";
  markSeen(conv, "gpt");
  const back = handoffFor(conv, "claude", LABELS);
  assert.match(back, /Since you last answered/);
  assert.match(back, /GPT: Footer done\./);
  assert.ok(!back.includes("make a landing page"));
  assert.equal(handoffFor(conv, "gpt", LABELS), "");
});

test("T3: default model, first match wins: chat, workflow, task type, user, everything", () => {
  const s = withDefaults({ defaults: { global: "claude", taskType: { research: "grok" }, workflow: {}, user: { u1: "gpt" } }, workflows: { site: { steps: ["a"], provider: "gpt" } } });
  assert.equal(pickProvider({ chat: "grok", workflow: "site", taskType: "research", user: "u1", settings: s }).provider, "grok");
  assert.equal(pickProvider({ workflow: "site", taskType: "research", settings: s }).provider, "gpt");
  assert.equal(pickProvider({ taskType: "research", user: "u1", settings: s }).provider, "grok");
  assert.equal(pickProvider({ taskType: "code", user: "u1", settings: s }).provider, "gpt");
  assert.equal(pickProvider({ taskType: "code", settings: s }).provider, "claude");
});

test("T5: settings change without code, and every worker's instructions follow them", () => {
  let s = defaultSettings();
  const apply = (name, arg) => {
    const r = settingsCommand(name, arg, s, { user: "u1" });
    if (r.next) s = r.next;
    return r.reply;
  };
  apply("language", "Arabic");
  apply("tone", "friendly");
  apply("autonomy", "ask-all");
  apply("instructions", "gpt always write tests");
  apply("guardrails", "add touching the invoices sheet");
  apply("memory", "add Nabil's brand color is #5e4db2");
  apply("workflows", "add site: research > plan > build > check");
  apply("default", "research grok");
  apply("default", "workflow site gpt");
  apply("limits", "gpt week 2m");
  apply("limits", "claude day $5");
  apply("limits", "pause grok");
  assert.equal(s.language, "Arabic");
  assert.equal(s.autonomy, "ask-all");
  assert.deepEqual(s.workflows.site, { steps: ["research", "plan", "build", "check"], provider: "gpt" });
  assert.equal(s.defaults.taskType.research, "grok");
  assert.deepEqual(s.limits.gpt.week, { tokens: 2000000 });
  assert.deepEqual(s.limits.claude.day, { usd: 5 });
  assert.deepEqual(s.paused, ["grok"]);
  const sys = systemFor(s, "gpt", "BASE");
  assert.match(sys, /in Arabic/);
  assert.match(sys, /friendly/);
  assert.match(sys, /always write tests/);
  assert.match(sys, /invoices sheet/);
  assert.match(sys, /#5e4db2/);
  assert.ok(!systemFor(s, "claude", "BASE").includes("always write tests"));
  assert.match(apply("memory", ""), /1\. Nabil's brand color/);
  apply("memory", "forget 1");
  assert.equal(s.memory.length, 0);
  assert.equal(settingsCommand("autonomy", "yolo", s).next, undefined);
  assert.deepEqual(parseAmount("$2.5"), { usd: 2.5 });
  assert.deepEqual(parseAmount("500k"), { tokens: 500000 });
  assert.equal(parseAmount("lots"), null);
});

test("T7: usage, faults, and the limits at 80% and 100%", () => {
  const log = [];
  const now = Date.now();
  record(log, { provider: "claude", ok: true, cost: 3, at: now - 1000 });
  record(log, { provider: "claude", ok: true, cost: 1.2, at: now - 2 * 86400000 });
  record(log, { provider: "gpt", ok: true, usage: { in: 900000, out: 50000 }, at: now - 1000 });
  record(log, { provider: "gpt", ok: false, error: "You've hit your usage limit", at: now - 500 });
  assert.deepEqual(spent(log, "claude", "day", now), { usd: 3, tokens: 0, runs: 1, faults: 0 });
  assert.equal(spent(log, "claude", "week", now).usd, 4.2);
  const s = withDefaults({ limits: { claude: { day: { usd: 3.5 } }, gpt: { week: { tokens: 900000 } } } });
  assert.equal(limitState(s, log, "claude", now).level, "warn");
  assert.equal(limitState(s, log, "gpt", now).level, "over");
  assert.equal(limitState(s, log, "grok", now).level, "ok");
  assert.equal(limitState({ ...s, paused: ["grok"] }, log, "grok", now).level, "paused");
  assert.equal(faultKind("You've hit your usage limit"), "limit reached");
  assert.equal(faultKind("GPT isn't signed in yet"), "signed out");
  assert.equal(faultKind("stopped (it took too long)"), "timed out");
  assert.match(usageReport(log, LABELS, s, now), /GPT: 950k · 950k · 950k · OVER week limit/);
  assert.match(faultsReport(log, LABELS), /GPT: limit reached/);
});

test("the router: Jev first, then Claude's JSON, then the rules", async () => {
  const jev = async () => ({ ok: true, json: async () => ({ answers: { worker: { choice: "grok" }, task_type: { choice: "research" }, effort: { score: 1 }, sensitive: { noul: 0.9 } } }) });
  assert.deepEqual(await route({ text: "news?", available: ["claude", "grok"], jevKey: "k", fetchImpl: jev, fallback: "claude" }), { provider: "grok", taskType: "research", effort: "medium", sensitive: true, by: "jev" });
  const down = async () => ({ ok: false, status: 503 });
  const r = await route({ text: "fix the bug", available: ["claude", "gpt"], jevKey: "k", fetchImpl: down, askClaude: async () => 'Sure: {"provider":"gpt","taskType":"code","effort":"high","sensitive":false}', fallback: "claude" });
  assert.deepEqual(r, { provider: "gpt", taskType: "code", effort: "high", sensitive: false, by: "claude" });
  const rules = await route({ text: "deploy it to prod", available: ["claude"], jevKey: null, askClaude: async () => "no json", fallback: "claude" });
  assert.equal(rules.by, "rules");
  assert.equal(rules.sensitive, true);
  assert.equal(sensitiveByWords("write a poem"), false);
  assert.deepEqual(jsonIn('x {"a":1} y'), { a: 1 });
  assert.equal(await teamMode({ task: "research the market and then build a page", jevKey: null }), "split");
  assert.equal(await teamMode({ task: "best name for the product?", jevKey: null }), "compare");
});

test("team compare: all at once, scored, merged by the central agent", async () => {
  const lines = [];
  const res = await compare({
    task: "name it",
    context: "",
    workers: ["claude", "gpt", "grok"],
    run: async (w) => (w === "grok" ? { failed: "limit" } : { text: `${w} says X` }),
    central: async (p) => ({ text: `merged from ${p.indexOf("GPT") < p.indexOf("Claude") ? "GPT first" : "Claude first"}` }),
    judge: async () => ({ claude: 2, gpt: 3.5 }),
    progress: (l) => lines.push(l),
    labels: LABELS,
  });
  assert.equal(res.text, "merged from GPT first");
  assert.ok(lines.some((l) => /Grok didn't finish/.test(l)));
});

test("team split: the central agent's parts run at once and are joined", async () => {
  assert.deepEqual(parsePlan('{"parts":[{"worker":"grok","part":"research"},{"worker":"nope","part":"build"}]}', ["claude", "grok"]), [
    { worker: "grok", part: "research" },
    { worker: "claude", part: "build" },
  ]);
  const ran = [];
  const res = await split({
    task: "research then build",
    context: "",
    workers: ["claude", "grok"],
    run: async (w, p) => (ran.push(w), { text: `${w}: ${p.split("Your part: ")[1]}` }),
    central: async (p) => (p.startsWith("Cut") ? { text: '{"parts":[{"worker":"grok","part":"research"},{"worker":"claude","part":"build"}]}' } : { text: "joined" }),
    progress: () => {},
    labels: LABELS,
  });
  assert.equal(res.text, "joined");
  assert.deepEqual(ran.sort(), ["claude", "grok"]);
  const one = await split({ task: "x", context: "", workers: ["claude", "grok"], run: async () => ({}), central: async () => ({ text: '{"parts":[{"worker":"grok","part":"all"}]}' }), progress: () => {}, labels: LABELS });
  assert.deepEqual(one, { fallback: "compare" });
});

test("Slack: the owner's messages in the channel only", () => {
  const opts = { channel: "C1", owners: new Set(["U1"]) };
  assert.deepEqual(fromSlackEvent({ type: "message", channel: "C1", user: "U1", text: "hi", ts: "1730000000.0001" }, opts), {
    id: "1730000000.0001",
    body: "hi",
    timestamp: 1730000000,
    via: "slack",
    from: "U1",
    ref: "1730000000.0001",
    thread: null,
  });
  assert.equal(fromSlackEvent({ type: "message", channel: "C1", user: "U2", text: "x", ts: "1" }, opts), null);
  assert.equal(fromSlackEvent({ type: "message", channel: "C1", user: "U1", bot_id: "B", text: "x", ts: "1" }, opts), null);
  assert.equal(fromSlackEvent({ type: "message", channel: "C1", user: "U1", text: "x", ts: "2", thread_ts: "1" }, opts).ref, "1");
});
