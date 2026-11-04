// The workers' command lines and how their output is read, from saved
// output: no CLI is run and nothing is sent anywhere.

import { test } from "node:test";
import assert from "node:assert/strict";
import { argsFor, footer, jevAsk, providerOf, readRoute, readerFor, routeQuestions } from "./agents.mjs";

const step = (name) => `step:${name}`;
const feedAll = (provider, events) => {
  const r = readerFor(provider, step);
  for (const e of events) r.feed(e);
  return r;
};

test("the words /use takes", () => {
  assert.equal(providerOf("Claude"), "claude");
  assert.equal(providerOf("codex"), "gpt");
  assert.equal(providerOf(" GPT "), "gpt");
  assert.equal(providerOf("grok"), "grok");
  assert.equal(providerOf("gemini"), null);
});

test("Claude's command line is the one the relay ran before", () => {
  const [args, stdin] = argsFor("claude", { conv: { model: "opus", effort: "high", session: "s1" }, plan: false, system: "SYS", cwd: "/w" });
  assert.equal(stdin, true);
  assert.deepEqual(args, ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions", "--append-system-prompt", "SYS", "--model", "opus", "--settings", '{"effortLevel":"high"}', "--resume", "s1"]);
  assert.equal(argsFor("claude", { conv: {}, plan: true, system: "S", cwd: "/w" })[0][5], "plan");
});

test("GPT runs codex exec, reads the prompt on stdin, resumes its own thread", () => {
  const [fresh, stdin] = argsFor("gpt", { conv: { effort: "max" }, plan: false, system: "S", cwd: "/w" });
  assert.equal(stdin, true);
  assert.deepEqual(fresh, ["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-c", 'model_reasoning_effort="xhigh"', "-"]);
  const [again] = argsFor("gpt", { conv: { session: "t-9", model: "gpt-5.5" }, plan: true, system: "S", cwd: "/w" });
  assert.deepEqual(again, ["exec", "resume", "--json", "--skip-git-repo-check", "-c", 'sandbox_mode="read-only"', "--model", "gpt-5.5", "t-9", "-"]);
});

test("Grok runs headless in the chat's folder, the prompt after -p, the instructions on a new session", () => {
  const [args, stdin] = argsFor("grok", { conv: { session: "g1", effort: "max" }, plan: false, system: "S", cwd: "/home/x/work" });
  assert.equal(stdin, false);
  assert.deepEqual(args, ["--output-format", "streaming-json", "--no-alt-screen", "--cwd", "/home/x/work", "--always-approve", "--reasoning-effort", "xhigh", "--resume", "g1", "-p"]);
  const [fresh] = argsFor("grok", { conv: {}, plan: true, system: "S", cwd: "/w" });
  assert.deepEqual(fresh, ["--output-format", "streaming-json", "--no-alt-screen", "--cwd", "/w", "--permission-mode", "plan", "--rules", "S", "-p"]);
});

test("Claude's answer, session, model, cost and steps", () => {
  const r = feedAll("claude", [
    { type: "system", subtype: "init", model: "claude-opus-5-5", session_id: "s1" },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: {} }] } },
    { type: "result", result: "Done.", is_error: false, total_cost_usd: 0.1234, usage: { input_tokens: 10, output_tokens: 5 }, session_id: "s1" },
  ]);
  assert.equal(r.step, "step:Bash");
  assert.deepEqual(r.result(), { text: "Done.", session: "s1", model: "claude-opus-5-5", cost: 0.1234, usage: { in: 10, out: 5 }, error: null });
  assert.equal(feedAll("claude", [{ type: "result", is_error: true, result: "Credit balance is too low" }]).result().error, "Credit balance is too low");
});

test("GPT's answer from codex's events, its thread, tokens and failures", () => {
  const r = feedAll("gpt", [
    { type: "thread.started", thread_id: "t-1" },
    { type: "item.started", item: { type: "command_execution", command: "npm test" } },
    { type: "item.completed", item: { type: "agent_message", text: "Tests pass." } },
    { type: "turn.completed", usage: { input_tokens: 12000, cached_input_tokens: 0, output_tokens: 300 } },
  ]);
  assert.equal(r.step, "Bash: npm test");
  assert.deepEqual(r.result(), { text: "Tests pass.", session: "t-1", model: null, cost: null, usage: { in: 12000, out: 300 }, error: null });
  assert.equal(feedAll("gpt", [{ type: "thread.started", thread_id: "t" }, { type: "turn.failed", error: { message: "usage limit reached" } }]).result().error, "usage limit reached");
});

test("Grok's answer, read loosely until real output is checked", () => {
  const r = feedAll("grok", [{ type: "session", session_id: "g-7", model: "grok-build" }, { type: "text_delta", delta: "Hel" }, { type: "text_delta", delta: "lo" }, { type: "tool_call", name: "bash" }]);
  assert.equal(r.step, "bash");
  assert.equal(r.result().text, "Hello");
  assert.equal(r.result().session, "g-7");
  assert.equal(feedAll("grok", [{ type: "text_delta", delta: "draft" }, { type: "result", result: "Final." }]).result().text, "Final.");
  assert.equal(feedAll("grok", [{ type: "error", message: "not logged in" }]).result().error, "not logged in");
});

test("every answer's last line: who, which model, effort, time, cost or tokens", () => {
  assert.equal(footer({ provider: "claude", model: "claude-opus-5-5", effort: "high", ms: 130000, cost: 0.4249 }), "_Claude · claude-opus-5-5 · effort high · 2m 10s · ~$0.42 API value_");
  assert.equal(footer({ provider: "gpt", model: null, ms: 9000, usage: { in: 12345, out: 800 } }), "_GPT · default model · 9s · 12k in / 800 out_");
});

test("Jev: the request it gets and the route read from its answers", async () => {
  let sent;
  const fake = async (url, init) => {
    sent = { url, init };
    return { ok: true, json: async () => ({ answers: { worker: { choice: "grok", confidence: 0.8 }, task_type: { choice: "research" }, effort: { score: 2.6 }, sensitive: { noul: 0.1 } } }) };
  };
  const q = routeQuestions(["claude", "grok"]);
  assert.deepEqual(Object.keys(q.worker.criteria), ["claude", "grok"]);
  const answers = await jevAsk({ key: "k", state: "what's trending on X about us?", questions: q, fetchImpl: fake });
  assert.equal(sent.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(sent.init.headers.Authorization, "Bearer k");
  assert.equal(JSON.parse(sent.init.body).model, "jev-latest");
  assert.deepEqual(readRoute(answers), { provider: "grok", taskType: "research", effort: "xhigh", sensitive: false, confidence: 0.8 });
  await assert.rejects(jevAsk({ key: "k", state: "x", questions: q, fetchImpl: async () => ({ ok: false, status: 401 }) }), /Jev: 401/);
});
