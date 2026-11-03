// The owner's own Claude, reached from one WhatsApp group.
//
// On the claude-vps server, next to WAHA: every 2 seconds it reads the group's
// newest messages from WAHA (on the server itself, nothing opened to the
// internet), takes the owner's only (anyone else in the group is ignored: it's
// their subscription, for them), hands each to Claude Code, the unmodified
// one, run as the claude-me user and signed in there by the owner themselves,
// and sends what Claude says back to the group. One conversation that goes on
// (--resume) until "/new"; "/stop" ends the one running. The bot (the
// whatsapp-bot function, PERSONAL_GROUP) stays out of this group.
//
// Runs as root only to start Claude as claude-me; the WAHA key comes from
// systemd (LoadCredential) and never reaches Claude.

import { execFileSync, spawn } from "node:child_process";
import { chownSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SEC = 1000;
const MIN = 60 * SEC;

/** WhatsApp's own formatting for what Claude writes in Markdown: *bold*, headings as bold lines, no tables. */
export function whatsappText(md) {
  const parts = String(md ?? "").split(/(```[\s\S]*?```)/g);
  return parts
    .map((p, i) =>
      i % 2
        ? p
        : p
            .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
            .replace(/\*\*(.+?)\*\*/g, "*$1*")
            .replace(/__(.+?)__/g, "_$1_")
            .replace(/^\s*\|?(\s*:?-{2,}:?\s*\|)+\s*:?-*:?\s*$/gm, "")
            .replace(/^\|(.+)\|$/gm, (_, row) => row.split("|").map((c) => c.trim()).join(" · "))
            .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1: $2"),
    )
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A long answer in pieces WhatsApp takes, cut at a line where it can. */
export function pieces(text, max = 3500) {
  const out = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * The owner's new messages, oldest first: not the server's own (fromMe), from
 * one of their ids only, newer than what was taken already.
 */
export function newFromOwner(messages, owners, seen) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && !m.fromMe && owners.has(String(m.participant ?? m.author ?? "")) && !seen.has(String(m.id)))
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
}

/** "/new" and "/stop", or null for a request. */
export function commandOf(text) {
  const t = String(text ?? "").trim().toLowerCase();
  return t === "/new" || t === "/stop" ? t.slice(1) : null;
}

const SYSTEM = [
  "Your owner reaches you from a WhatsApp group on their phone; every message is theirs.",
  "What you answer is sent back to them as WhatsApp messages: readable on a phone, short paragraphs, plain lists, no tables.",
  "Files they send are saved under ./inbox and named in their message.",
  "Their code and folders live on GitHub (gh is signed in as them); images and videos go to their Google Drive.",
].join(" ");

// ------------------------------------------------------------------ the service --

function main() {
  const conf = {
    waha: process.env.WAHA_URL || "http://127.0.0.1:3000",
    session: process.env.WAHA_SESSION || "default",
    group: process.env.GROUP || "",
    owners: new Set((process.env.OWNERS || "").split(",").map((s) => s.trim()).filter(Boolean)),
    user: process.env.CLAUDE_USER || "claude-me",
    claude: process.env.CLAUDE_BIN || "/usr/local/bin/claude",
    state: join(process.env.STATE_DIRECTORY || "/var/lib/claude-me-relay", "state.json"),
    maxRun: Number(process.env.MAX_RUN_MIN || 60) * MIN,
  };
  const key = readFileSync(join(process.env.CREDENTIALS_DIRECTORY || "/etc/claude-me", "waha.key"), "utf8").trim();
  if (!/@g\.us$/.test(conf.group) || !conf.owners.size || !key) {
    console.error("relay: GROUP, OWNERS and the WAHA key are needed");
    process.exit(1);
  }
  const uid = Number(execFileSync("id", ["-u", conf.user]).toString().trim());
  const gid = Number(execFileSync("id", ["-g", conf.user]).toString().trim());
  const home = `/home/${conf.user}`;
  const work = join(home, "work");
  const inbox = join(work, "inbox");

  /** What's kept between restarts: where reading got to, and Claude's conversation. */
  let st = { since: Math.floor(Date.now() / SEC), seen: [], session: null };
  try {
    st = { ...st, ...JSON.parse(readFileSync(conf.state, "utf8")) };
  } catch {}
  const save = () => {
    st.seen = st.seen.slice(-200);
    writeFileSync(`${conf.state}.new`, JSON.stringify(st));
    renameSync(`${conf.state}.new`, conf.state);
  };

  const waha = async (method, path, body) => {
    const r = await fetch(conf.waha + path, {
      method,
      headers: { "X-Api-Key": key, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30 * SEC),
    });
    if (!r.ok) throw new Error(`WAHA ${method} ${path.split("?")[0]}: ${r.status}`);
    return r;
  };
  const say = async (text, replyTo) => {
    for (const [i, p] of pieces(whatsappText(text)).entries()) {
      await waha("POST", "/api/sendText", { session: conf.session, chatId: conf.group, text: p, linkPreview: false, ...(i === 0 && replyTo ? { reply_to: replyTo } : {}) });
    }
  };

  /** A file they sent, saved where Claude works: its path there, or null. */
  const keep = async (m) => {
    const url = m.media?.url;
    if (!url) return null;
    const path = new URL(url).pathname + new URL(url).search;
    const r = await waha("GET", path);
    const name = String(m.media.filename || path.split("/").pop() || "file").replace(/[^\w.\-]+/g, "_").slice(-80);
    if (!existsSync(inbox)) {
      mkdirSync(inbox, { recursive: true });
      chownSync(inbox, uid, gid);
    }
    const file = join(inbox, `${m.timestamp}-${name}`);
    writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    chownSync(file, uid, gid);
    return `inbox/${file.slice(inbox.length + 1)}`;
  };

  let running = null;
  const queue = [];

  /** One request to Claude, in the conversation that's going on; its answer, or why there's none. */
  const ask = (text, resume) =>
    new Promise((resolve) => {
      const args = ["-p", "--output-format", "json", "--permission-mode", "bypassPermissions", "--append-system-prompt", SYSTEM, ...(resume ? ["--resume", resume] : [])];
      const child = spawn(conf.claude, args, {
        cwd: work,
        uid,
        gid,
        env: { HOME: home, USER: conf.user, LOGNAME: conf.user, LANG: "C.UTF-8", PATH: `${home}/.local/bin:/usr/local/bin:/usr/bin:/bin` },
        stdio: ["pipe", "pipe", "pipe"],
      });
      running = child;
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      const timer = setTimeout(() => child.kill("SIGTERM"), conf.maxRun);
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        running = null;
        let j = null;
        try {
          j = JSON.parse(out.trim().split("\n").pop() || "null");
        } catch {}
        if (j && typeof j.result === "string" && !j.is_error) return resolve({ text: j.result, session: j.session_id ?? resume });
        const why = (j?.result || err || out || "").trim().split("\n").slice(-3).join(" ").slice(0, 300);
        resolve({ failed: signal ? `stopped (${signal === "SIGTERM" ? "took too long or /stop" : signal})` : why || `ended with code ${code}`, session: j?.session_id ?? resume });
      });
      child.stdin.end(text);
    });

  const handle = async (m) => {
    let text = String(m.body ?? "").trim();
    if (m.hasMedia) {
      const full = await waha("GET", `/api/${conf.session}/chats/${encodeURIComponent(conf.group)}/messages?limit=20&downloadMedia=true`)
        .then((r) => r.json())
        .then((all) => all.find((x) => x.id === m.id));
      const saved = full ? await keep(full).catch((e) => (console.error("relay file", e.message), null)) : null;
      text += saved ? `\n[they sent a file, saved at ${saved}${full.media?.mimetype ? ` (${full.media.mimetype})` : ""}]` : "\n[they sent a file that couldn't be saved]";
    }
    if (m.replyTo?.body) text = `[replying to: "${String(m.replyTo.body).slice(0, 500)}"]\n${text}`;
    if (!text) return;
    const slow = setTimeout(() => say("⏳ شغال عليه…", m.id).catch(() => {}), 45 * SEC);
    let r = await ask(text, st.session);
    // A conversation Claude no longer has: a new one.
    if (r.failed && st.session && /no conversation found|session/i.test(r.failed)) r = await ask(text, null);
    clearTimeout(slow);
    st.session = r.session ?? st.session;
    save();
    await say(r.failed ? `❌ مخلصش: ${r.failed}` : r.text || "(no answer)", m.id);
  };

  let draining = false;
  const work1 = async () => {
    if (draining) return;
    draining = true;
    while (queue.length) {
      const m = queue.shift();
      try {
        await handle(m);
      } catch (e) {
        console.error("relay", e.message);
        await say(`❌ حصلت مشكلة: ${e.message}`, m.id).catch(() => {});
      }
    }
    draining = false;
  };

  const poll = async () => {
    try {
      const r = await waha("GET", `/api/${conf.session}/chats/${encodeURIComponent(conf.group)}/messages?limit=20&downloadMedia=false`);
      const seen = new Set(st.seen);
      const fresh = newFromOwner(await r.json(), conf.owners, seen).filter((m) => (m.timestamp ?? 0) >= st.since);
      if (!fresh.length) return;
      for (const m of fresh) st.seen.push(String(m.id));
      st.since = Math.max(st.since, ...fresh.map((m) => m.timestamp ?? 0));
      save();
      for (const m of fresh) {
        const c = commandOf(m.body);
        if (c === "stop") {
          queue.length = 0;
          if (running) running.kill("SIGTERM");
          else await say("مفيش حاجة شغالة.", m.id);
        } else if (c === "new") {
          st.session = null;
          save();
          await say("✅ محادثة جديدة.", m.id);
        } else {
          queue.push(m);
          void work1();
        }
      }
    } catch (e) {
      console.error("relay poll", e.message);
    }
  };

  save();
  console.log(JSON.stringify({ ev: "relay.start", group: conf.group, owners: conf.owners.size }));
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    await poll();
    busy = false;
  }, 2 * SEC);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
