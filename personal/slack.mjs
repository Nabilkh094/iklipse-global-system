// Slack as a second way into the same chats: one channel, the owner only,
// through Socket Mode (the relay connects out to Slack; nothing on the server
// is opened to the internet). Needs a Slack app with a bot token (xoxb-) and
// an app-level token (xapp-, connections:write), both in root-only files.

const API = "https://slack.com/api";

/** A Slack message event as the relay's own message shape, or null when it isn't the owner's in the channel. */
export function fromSlackEvent(ev, { channel, owners }) {
  if (!ev || ev.type !== "message" || ev.subtype || ev.bot_id) return null;
  if (ev.channel !== channel || !owners.has(String(ev.user))) return null;
  return {
    id: String(ev.ts),
    body: String(ev.text ?? ""),
    timestamp: Math.floor(Number(ev.ts)),
    via: "slack",
    from: String(ev.user),
    ref: String(ev.thread_ts ?? ev.ts),
    thread: ev.thread_ts ? String(ev.thread_ts) : null,
  };
}

export function slackClient({ botToken, appToken, channel, owners, onMessage, log = console }) {
  const call = async (method, token, body) => {
    const r = await fetch(`${API}/${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`Slack ${method}: ${j.error ?? r.status}`);
    return j;
  };

  let stopped = false;
  const connect = async () => {
    while (!stopped) {
      try {
        const { url } = await call("apps.connections.open", appToken);
        await new Promise((closed) => {
          const ws = new WebSocket(url);
          ws.onmessage = (e) => {
            let msg;
            try {
              msg = JSON.parse(String(e.data));
            } catch {
              return;
            }
            if (msg.envelope_id) ws.send(JSON.stringify({ envelope_id: msg.envelope_id }));
            if (msg.type === "disconnect") ws.close();
            if (msg.type === "events_api") {
              const m = fromSlackEvent(msg.payload?.event, { channel, owners });
              if (m) Promise.resolve(onMessage(m)).catch((err) => log.error("slack message", err.message));
            }
          };
          ws.onclose = () => closed();
          ws.onerror = () => {};
        });
      } catch (e) {
        log.error("slack", e.message);
      }
      if (!stopped) await new Promise((r) => setTimeout(r, 5000));
    }
  };

  return {
    start: () => void connect(),
    stop: () => (stopped = true),
    /** Posted in the channel, in the thread of ref when given; its ts back. */
    say: async (text, ref) => (await call("chat.postMessage", botToken, { channel, text, ...(ref ? { thread_ts: ref } : {}), unfurl_links: false })).ts,
  };
}
