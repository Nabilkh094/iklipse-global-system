// A chat's own record, kept by the relay and not by any one worker: what was
// said and by whom, the task's state, what Nabil approved. It is what lets a
// chat move from one model to another, any time, without losing anything.

const TURN_MAX = 6000;
const HISTORY_MAX = 80;

/** The task-state line every worker ends its answer with (taken off before Nabil sees it). */
export const STATE_RULE =
  'End every answer with one last line, exactly: <state>{"goal":"…","done":["…"],"left":["…"],"files":["…"]}</state> ' +
  "describing this chat's task so far (short items). It is read by the system and removed before the owner sees your answer.";

/** The answer without its trailing <state> line, and that state (or null). */
export function splitState(text) {
  const s = String(text ?? "");
  const m = /<state>([\s\S]*?)<\/state>\s*$/.exec(s);
  if (!m) return { text: s.trim(), state: null };
  let state = null;
  try {
    state = JSON.parse(m[1]);
  } catch {}
  return { text: s.slice(0, m.index).trim(), state: state && typeof state === "object" ? state : null };
}

/** One more turn in the chat: who ("nabil", or the worker's provider) and what. */
export function addTurn(conv, who, text) {
  conv.history ??= [];
  conv.history.push({ who, text: String(text ?? "").slice(0, TURN_MAX), at: Date.now() });
  if (conv.history.length > HISTORY_MAX) {
    const drop = conv.history.length - HISTORY_MAX;
    conv.history.splice(0, drop);
    for (const p of Object.keys(conv.seenBy ?? {})) conv.seenBy[p] = Math.max(0, conv.seenBy[p] - drop);
  }
}

const list = (x) => (Array.isArray(x) ? x.map((i) => String(i).slice(0, 300)).filter(Boolean).slice(0, 30) : []);

/** A worker's state line folded into the chat's task. */
export function mergeState(conv, state) {
  if (!state) return;
  conv.task ??= { goal: "", done: [], left: [], files: [], approved: [] };
  if (state.goal) conv.task.goal = String(state.goal).slice(0, 500);
  if (Array.isArray(state.done)) conv.task.done = list(state.done);
  if (Array.isArray(state.left)) conv.task.left = list(state.left);
  if (Array.isArray(state.files)) conv.task.files = [...new Set([...(conv.task.files ?? []), ...list(state.files)])].slice(-40);
}

/** Nabil saying yes to what was just proposed. */
export function isApproval(text) {
  return /^\s*(go|yes|yep|ok(ay)?|approved?|do it|go ahead|confirm(ed)?|proceed)\b[\s.!]*$/i.test(String(text ?? ""));
}

/** The last answer marked approved, so no model after it drops it. */
export function approveLast(conv, by = "Nabil") {
  const last = [...(conv.history ?? [])].reverse().find((t) => t.who !== "nabil");
  if (!last) return null;
  conv.task ??= { goal: "", done: [], left: [], files: [], approved: [] };
  const item = `${by} approved (${new Date().toISOString().slice(0, 16).replace("T", " ")}): ${last.text.slice(0, 400)}`;
  conv.task.approved = [...(conv.task.approved ?? []), item].slice(-20);
  return item;
}

const whoName = (who, labels) => (who === "nabil" ? "Nabil" : labels[who] ?? who);

/**
 * What a worker must be told before the new request, given what it already
 * has: nothing when it saw everything; the turns it missed when it still has
 * its session; the whole record (instructions aside) when it starts fresh.
 * Call it before the new request is added to the history.
 */
export function handoffFor(conv, provider, labels) {
  const history = conv.history ?? [];
  const seen = conv.seenBy?.[provider];
  const hasSession = Boolean(conv.sessions?.[provider]);
  const line = (t, n) => `${whoName(t.who, labels)}: ${n ? t.text.slice(0, n) : t.text}`;
  if (hasSession && seen != null) {
    const missed = history.slice(seen);
    if (!missed.length) return "";
    return ["[Since you last answered in this chat, other models went on with it:]", ...missed.map((t) => line(t, 3000)), "[Now the new request:]"].join("\n\n");
  }
  const task = conv.task ?? {};
  const before = [...history].reverse().find((t) => t.who !== "nabil" && t.who !== provider)?.who;
  if (!history.length && !task.goal) return "";
  const recent = history.slice(-12);
  const older = history.slice(0, -12).slice(-30);
  const parts = [`[You are taking over this chat${before ? ` from ${whoName(before, labels)}` : ""}. Keep going from where it is; don't start over. Say in your first line that you took over.]`];
  if (task.goal) parts.push(`Goal: ${task.goal}`);
  if (task.approved?.length) parts.push(`Approved by Nabil (keep to these):\n- ${task.approved.join("\n- ")}`);
  if (task.done?.length) parts.push(`Done:\n- ${task.done.join("\n- ")}`);
  if (task.left?.length) parts.push(`Left:\n- ${task.left.join("\n- ")}`);
  if (task.files?.length) parts.push(`Files touched: ${task.files.join(", ")}`);
  if (older.length) parts.push(`Earlier in the chat (short):\n${older.map((t) => line(t, 160)).join("\n")}`);
  if (recent.length) parts.push(`The latest turns:\n\n${recent.map((t) => line(t, 1500)).join("\n\n")}`);
  parts.push("[Now the new request:]");
  return parts.join("\n\n");
}

/** After a worker answered: it has seen everything up to here. */
export function markSeen(conv, provider) {
  conv.seenBy ??= {};
  conv.seenBy[provider] = (conv.history ?? []).length;
}
