// Slack as a second way into the same chats, through the iklipse Slack app
// that the system already has (Alerts > Slack): one channel for the agents,
// the owner's messages only. That app sends its events to the whatsapp-bot
// function, so the relay doesn't take them over: it reads the channel itself
// every few seconds (conversations.history) and answers in it (chat.postMessage),
// with the same bot token, kept in a root-only file. The app needs the
// chat:write scope for the answers. The agents channel stays off in Alerts.

const API = "https://slack.com/api";

/** A Slack message as the relay's own message shape, or null when it isn't the owner's in the channel. */
export function fromSlackEvent(ev, { channel, owners }) {
  if (!ev || ev.type !== "message" || ev.subtype || ev.bot_id) return null;
  if (ev.channel !== channel || !owners.has(String(ev.user))) return null;
  return {
    id: String(ev.ts),
    body: String(ev.text ?? ""),
    timestamp: Math.floor(Number(ev.ts)),
    via: "slack",
    from: String(ev.user),
    ref: null,
    thread: null,
  };
}

/**
 * Reads the channel every `everyMs` and hands each new owner message to onMessage, oldest first.
 * Starts from now: nothing older is taken.
 */
export function slackPoller({ botToken, channel, owners, onMessage, log = console, everyMs = 3000, fetchImpl = fetch, now = () => Date.now() }) {
  let oldest = (now() / 1000).toFixed(6);
  let timer = null;
  let busy = false;
  const call = async (method, params, body) => {
    const r = await fetchImpl(`${API}/${method}${params ? `?${new URLSearchParams(params)}` : ""}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${botToken}`, ...(body ? { "Content-Type": "application/json; charset=utf-8" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`Slack ${method}: ${j.error ?? r.status}${j.needed ? ` (needs ${j.needed})` : ""}`);
    return j;
  };
  /** One read: the new messages since the last one. */
  const tick = async () => {
    const j = await call("conversations.history", { channel, oldest, inclusive: "false", limit: "50" });
    const msgs = (j.messages ?? []).slice().sort((a, b) => Number(a.ts) - Number(b.ts));
    for (const msg of msgs) {
      if (Number(msg.ts) > Number(oldest)) oldest = String(msg.ts);
      const m = fromSlackEvent({ ...msg, type: msg.type ?? "message", channel }, { channel, owners });
      if (m) await onMessage(m);
    }
  };
  return {
    tick,
    start() {
      timer = setInterval(async () => {
        if (busy) return;
        busy = true;
        try {
          await tick();
        } catch (e) {
          log.error("slack", e.message);
        }
        busy = false;
      }, everyMs);
    },
    stop: () => clearInterval(timer),
    /** Posted in the channel; its ts back. */
    say: async (text) => (await call("chat.postMessage", null, { channel, text, unfurl_links: false })).ts,
  };
}
