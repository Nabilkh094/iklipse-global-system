// The workers the relay can hand a request to, each through its own official
// CLI and its own login on the server (no API keys for them, no tokens copied
// around), plus Jev, which never writes: it only decides.
//
// Each worker is three things: how its CLI is started, how its output (one
// JSON event per line) is read, and how its login is seen on disk. Everything
// here is plain functions so the tests can feed saved output to them.

import { existsSync } from "node:fs";
import { join } from "node:path";

/** The workers, as Nabil names them in /use. */
export const PROVIDERS = {
  claude: { label: "Claude", login: (home) => existsSync(join(home, ".claude", ".credentials.json")), signIn: "claude (then /login)" },
  gpt: { label: "GPT", login: (home) => existsSync(join(home, ".codex", "auth.json")), signIn: "codex login --device-auth" },
  grok: { label: "Grok", login: (home) => existsSync(join(home, ".grok", "auth.json")), signIn: "grok login" },
};

/** The provider a /use word means, or null. */
export function providerOf(word) {
  const w = String(word ?? "").trim().toLowerCase();
  if (w === "claude" || w === "anthropic") return "claude";
  if (w === "gpt" || w === "codex" || w === "openai" || w === "chatgpt") return "gpt";
  if (w === "grok" || w === "xai") return "grok";
  return null;
}

/** Codex's reasoning levels for the relay's effort names. */
const CODEX_EFFORT = { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh" };

/**
 * The command line for one request: [args, promptOnStdin].
 * conv: {model, effort, session}; plan: plan only, change nothing.
 */
export function argsFor(provider, { conv, plan, system, cwd }) {
  if (provider === "claude") {
    return [
      [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        plan ? "plan" : "bypassPermissions",
        "--append-system-prompt",
        system,
        ...(conv.model ? ["--model", conv.model] : []),
        ...(conv.effort ? ["--settings", JSON.stringify({ effortLevel: conv.effort })] : []),
        ...(conv.session ? ["--resume", conv.session] : []),
      ],
      true,
    ];
  }
  if (provider === "gpt") {
    // `codex exec resume` has its own options (codex-cli 0.166): no --sandbox there, so read-only goes through -c.
    const opts = [
      "--json",
      "--skip-git-repo-check",
      ...(plan ? ["-c", 'sandbox_mode="read-only"'] : ["--dangerously-bypass-approvals-and-sandbox"]),
      ...(conv.model ? ["--model", conv.model] : []),
      ...(conv.effort ? ["-c", `model_reasoning_effort="${CODEX_EFFORT[conv.effort] ?? conv.effort}"`] : []),
    ];
    // "-": the prompt comes on stdin.
    return [conv.session ? ["exec", "resume", ...opts, conv.session, "-"] : ["exec", ...opts, "-"], true];
  }
  if (provider === "grok") {
    // grok 1.0.70: -p single turn, --permission-mode, --reasoning-effort, --rules (appended to its system prompt).
    return [
      [
        "--output-format",
        "streaming-json",
        "--no-alt-screen",
        "--cwd",
        cwd,
        ...(plan ? ["--permission-mode", "plan"] : ["--always-approve"]),
        ...(conv.model ? ["--model", conv.model] : []),
        ...(conv.effort ? ["--reasoning-effort", conv.effort === "max" ? "xhigh" : conv.effort] : []),
        ...(conv.session ? ["--resume", conv.session] : ["--rules", system]),
        "-p",
      ],
      // Grok takes the prompt after -p, not on stdin.
      false,
    ];
  }
  throw new Error(`unknown provider ${provider}`);
}

/** Codex's tool steps in a few words, like stepOf does for Claude's. */
function codexStep(item) {
  const cut = (s, n = 70) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  switch (item?.type) {
    case "command_execution":
      return `Bash: ${cut(item.command)}`;
    case "file_change":
      return `Edit: ${cut((item.changes ?? []).map((c) => String(c.path ?? "").split("/").pop()).join(", "), 60)}`;
    case "mcp_tool_call":
      return `${item.server ?? "tool"}: ${item.tool ?? ""}`.trim();
    case "web_search":
      return `WebSearch: ${cut(item.query)}`;
    default:
      return null;
  }
}

/**
 * A reader for one run's output, fed one parsed JSON event at a time.
 * stepOf: how a Claude tool call is put in words.
 * result(): {text, session, model, cost, usage, error}; step: the latest step.
 */
export function readerFor(provider, stepOf) {
  const r = { text: null, session: null, model: null, cost: null, usage: null, error: null, step: null, parts: [] };
  const feed = {
    claude(ev) {
      if (ev.session_id) r.session = ev.session_id;
      if (ev.type === "system" && ev.model) r.model = ev.model;
      if (ev.type === "assistant") {
        for (const c of ev.message?.content ?? []) if (c.type === "tool_use") r.step = stepOf(c.name, c.input);
      }
      if (ev.type === "result") {
        if (typeof ev.total_cost_usd === "number") r.cost = ev.total_cost_usd;
        if (ev.usage) r.usage = { in: ev.usage.input_tokens ?? 0, out: ev.usage.output_tokens ?? 0 };
        if (!r.model && ev.modelUsage) r.model = Object.keys(ev.modelUsage)[0] ?? null;
        if (ev.is_error || typeof ev.result !== "string") r.error = String(ev.result ?? ev.subtype ?? "failed");
        else r.text = ev.result;
      }
    },
    gpt(ev) {
      if (ev.type === "thread.started" && ev.thread_id) r.session = ev.thread_id;
      if (ev.type === "item.started" || ev.type === "item.completed") {
        const s = codexStep(ev.item);
        if (s) r.step = s;
        if (ev.type === "item.completed" && ev.item?.type === "agent_message" && ev.item.text) r.parts.push(ev.item.text);
      }
      if (ev.type === "turn.completed" && ev.usage) r.usage = { in: ev.usage.input_tokens ?? 0, out: ev.usage.output_tokens ?? 0 };
      if (ev.type === "turn.failed") r.error = String(ev.error?.message ?? "failed");
      if (ev.type === "error") r.error = String(ev.message ?? "failed");
    },
    // grok 1.0.70, checked on a real run: {"type":"text","data":"…"} pieces of
    // the answer, {"type":"usage"}, then {"type":"end","sessionId","stopReason",
    // "usage","modelUsage":{"<model>":{…}}}; "available_commands" lists tools.
    // Tool and error events weren't in that run: read them loosely.
    grok(ev) {
      const type = String(ev.type ?? "");
      if (type === "text" && typeof ev.data === "string") r.parts.push(ev.data);
      if (type === "end") {
        if (ev.sessionId) r.session = String(ev.sessionId);
        const models = Object.keys(ev.modelUsage ?? {});
        if (models.length) r.model = models[0];
        if (ev.usage) r.usage = { in: ev.usage.input_tokens ?? 0, out: ev.usage.output_tokens ?? 0 };
        if (ev.stopReason && !/end_turn|stop|max_turns/.test(ev.stopReason) && !r.parts.length) r.error = String(ev.stopReason);
      }
      if (/tool/i.test(type) && type !== "available_commands") {
        const name = ev.name ?? ev.tool ?? ev.data?.name ?? ev.data?.tool ?? ev.toolName;
        if (name) r.step = String(name);
      }
      if (type === "error") r.error = String(ev.message ?? ev.data?.message ?? ev.data ?? ev.error ?? "failed");
    },
  }[provider];
  return {
    feed: (ev) => ev && typeof ev === "object" && feed(ev),
    get step() {
      return r.step;
    },
    get session() {
      return r.session;
    },
    result() {
      const joiner = provider === "gpt" ? "\n\n" : "";
      const text = r.text ?? (r.parts.length ? r.parts.join(joiner).trim() : null);
      return { text, session: r.session, model: r.model, cost: r.cost, usage: r.usage, error: text ? null : r.error };
    },
  };
}


/** The last line of every answer: who answered, with what, how long, what it cost. */
// Every worker runs on a subscription: no cost or usage under the answers (/usage has it when asked).
export function footer({ provider, model, effort, ms }) {
  const secs = Math.round(ms / 1000);
  const time = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
  return `_${[PROVIDERS[provider]?.label ?? provider, model || "default model", effort ? `effort ${effort}` : null, time].filter(Boolean).join(" · ")}_`;
}

// ------------------------------------------------------------------------ Jev --

/** Jev: one call, several typed questions about one state. */
export async function jevAsk({ key, state, questions, model = "jev-latest", fetchImpl = fetch, timeoutMs = 5000 }) {
  const r = await fetchImpl("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ state, model, questions }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`Jev: ${r.status}`);
  return (await r.json()).answers ?? {};
}

const TASK_TYPES = {
  code: "Writing, fixing or reviewing code, apps, websites, servers",
  research: "Finding and comparing information, news, the web, X/Twitter",
  writing: "Writing or editing text: posts, emails, documents, scripts",
  data: "Numbers, sheets, files, analysis",
  other: "Anything else",
};
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** The questions Jev answers to route one request among the signed-in workers. */
export function routeQuestions(available) {
  const strengths = {
    claude: "Claude: careful long coding and agent work, tools, writing",
    gpt: "GPT: coding and reasoning, fast plans and fixes",
    grok: "Grok: research, current events and X/Twitter, quick answers",
  };
  return {
    worker: { type: "choice", instructions: "Which worker should do this request", criteria: Object.fromEntries(available.map((p) => [p, strengths[p]])) },
    task_type: { type: "choice", instructions: "What kind of task this is", criteria: TASK_TYPES },
    effort: { type: "score", instructions: "How much thinking the request needs", criteria: EFFORTS },
    sensitive: { type: "noul", instructions: "The request would deploy, merge, delete, spend money or send something to people outside this chat" },
  };
}

/** Jev's answers as a route: {provider, taskType, effort, sensitive, confidence}. */
export function readRoute(answers) {
  const level = Math.max(0, Math.min(EFFORTS.length - 1, Math.round(Number(answers.effort?.score ?? 1))));
  return {
    provider: answers.worker?.choice ?? null,
    taskType: answers.task_type?.choice ?? "other",
    effort: EFFORTS[level],
    sensitive: Number(answers.sensitive?.noul ?? 0) >= 0.5,
    confidence: answers.worker?.confidence ?? null,
  };
}
