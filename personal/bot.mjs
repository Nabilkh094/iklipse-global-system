// The company bot (iklipse's whatsapp-bot function, master.ts there), driven
// from Nabil's group: the bot does each task exactly as if Nabil had written
// to it privately, and what it says comes back here. Nabil's subscriptions
// never answer anyone else: the bot works for the company on its own API key;
// this is only the channel between them.
//
// Signed with the master key (a root-only file, never handed to a worker):
// HMAC-SHA256 over "master.<seconds>.<body>", as brain.ts signature().
// Every few seconds the relay reads what the bot said since (poll); a task is
// over when its run is (done, failed, stopped, timeout, budget).
//
// Tasks go one after another (in order: the next only once the last is over)
// or together. A task the master sends by itself (auto) only reads on the bot's
// side; anything that acts waits for Nabil's go here first.

import { createHmac, randomUUID } from "node:crypto";

const FINAL = new Set(["done", "failed", "stopped", "timeout", "budget", "fallback"]);

/** The x-master-signature header for a body. */
export function masterSignature(secret, body, now = Date.now()) {
  const t = Math.floor(now / 1000);
  return `t=${t},v1=${createHmac("sha256", secret).update(`master.${t}.${body}`).digest("hex")}`;
}

/**
 * Lines of a /bot request: "1. ...", "2) ...", "- ..." each its own task;
 * anything else is one task. "together" first: all at once, else in order.
 */
export function parseBotRequest(arg) {
  let text = String(arg ?? "").trim();
  let together = false;
  const m = /^(together|parallel|مع بعض)\s*[:\n]?\s*/i.exec(text);
  if (m) {
    together = true;
    text = text.slice(m[0].length);
  }
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const listed = lines.filter((l) => /^(\d+[.)]|[-•*])\s+/.test(l));
  const tasks = listed.length >= 2 && listed.length === lines.length ? listed.map((l) => l.replace(/^(\d+[.)]|[-•*])\s+/, "")) : text ? [text] : [];
  return { tasks, together };
}

/** The tools that actually ran and worked, from the bot's own log (not its words). */
export function doneSteps(steps = []) {
  return [...new Set(steps.filter((s) => s.outcome === "ok" && !String(s.tool).startsWith("_")).map((s) => s.tool))];
}

/** What Nabil reads once a task is over: the bot's words, else what its log shows. */
export function resultText(t) {
  const said = t.replies.map((r) => r.text.trim()).filter(Boolean);
  const did = doneSteps(t.steps);
  if (t.state === "done") return said.length ? said.join("\n\n") : did.length ? `Done: ${did.join(", ")}.` : "Done.";
  const why = t.error || t.state;
  return [`❌ Not finished (${why}).`, ...said].join("\n\n");
}

/** Nabil's own OK or no for the bot ("yes 4821", "no", "نعم 4821", "لا"). */
export const isOwnerWord = (text) => /^\s*(yes|ok|no|نعم|ايوه|أيوه|لا)(\s+\d{4})?\s*$/i.test(String(text ?? ""));

/**
 * The channel. post: (op, payload) => JSON (signed fetch; given for tests).
 * onApproval / onNotice: what the bot says that isn't a task's answer.
 */
export function botChannel({ url, secret, fetchImpl = fetch, post, onApproval = () => {}, onNotice = () => {}, log = console, now = () => Date.now(), timeoutMs = 20 * 60_000 }) {
  const call =
    post ??
    (async (op, payload) => {
      const body = JSON.stringify(payload);
      const r = await fetchImpl(`${url}/master/${op}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-master-signature": masterSignature(secret, body, now()) },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 403) throw new Error("the bot refused the master key");
      if (r.status === 404) throw new Error("the bot's master channel isn't set up (MASTER_SECRET)");
      return j;
    });
  /** task id -> { text, auto, state, replies, steps, error, at, done(resolve) } */
  const tasks = new Map();
  let after = 0;

  /** One task, sent now; resolves with it once it's over. */
  const send = async (text, { auto = false, quoted = null } = {}) => {
    const id = randomUUID();
    const t = { id, text, auto, state: "sending", replies: [], steps: [], error: null, at: now() };
    tasks.set(id, t);
    const over = new Promise((res) => (t.done = res));
    try {
      const r = await call("task", { task_id: id, text, auto, ...(quoted ? { quoted } : {}) });
      if (!r.ok) {
        t.state = "failed";
        t.error = r.error || "the bot didn't take it";
        t.done(t);
      } else t.state = "sent";
    } catch (e) {
      t.state = "failed";
      t.error = e.message;
      t.done(t);
    }
    return await over;
  };

  /** In order (each after the last is over) or together; resolves with all of them. */
  const run = async (texts, { together = false, auto = false, each = () => {} } = {}) => {
    if (together) return await Promise.all(texts.map((x) => send(x, { auto }).then((t) => (each(t), t))));
    const out = [];
    for (const x of texts) {
      const t = await send(x, { auto });
      each(t);
      out.push(t);
      // One failed: the rest wait for Nabil (they may depend on it).
      if (t.state !== "done") break;
    }
    return out;
  };

  /** What the bot said since, and how the open tasks are doing. */
  const tick = async () => {
    const open = [...tasks.values()].filter((t) => !FINAL.has(t.state) && t.state !== "sending");
    const r = await call("poll", { after, tasks: open.map((t) => t.id) });
    if (!r.ok) throw new Error(r.error || "poll failed");
    for (const x of r.replies ?? []) {
      after = Math.max(after, Number(x.seq) || 0);
      const t = x.task_id ? tasks.get(x.task_id) : null;
      if (t && x.kind === "reply") t.replies.push(x);
      else if (x.kind === "approval") await onApproval(x);
      else if (!t) await onNotice(x);
    }
    for (const s of r.tasks ?? []) {
      const t = tasks.get(s.task_id);
      if (!t) continue;
      t.state = s.state;
      t.error = s.error ?? null;
      t.steps = s.steps ?? [];
      if (FINAL.has(t.state)) {
        tasks.delete(t.id);
        t.done(t);
      }
    }
    // A task the bot never picked up: over, said plainly.
    for (const t of open) {
      if (tasks.has(t.id) && now() - t.at > timeoutMs) {
        tasks.delete(t.id);
        t.state = "timeout";
        t.error = "no answer from the bot";
        t.done(t);
      }
    }
  };

  return {
    send,
    run,
    tick,
    /** Nabil's own words for the bot: an OK, a no, stop, start. handled: the bot took them. */
    words: async (text) => (await call("words", { id: randomUUID(), text })).handled === true,
    open: () => [...tasks.values()],
    get after() {
      return after;
    },
    set after(v) {
      after = Number(v) || 0;
    },
  };
}
