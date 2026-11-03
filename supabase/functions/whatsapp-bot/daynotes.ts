// The bot's day notes (0134): after midnight, Claude writes what happened in
// each chat the day before (a group, or someone's private chat with the bot):
// what was asked, decided, promised (who, what, by when), delivered, and
// what's still open. They're kept and searched like what was said
// (search.ts, "notes"), so the brain remembers weeks back in a few lines
// instead of reading every message again. A few chats a run.

import { cairoOffset, claude, str, TZ, type ClaudeTool, type Db, type Settings, type Team } from "./kit.ts";
import { lidPhones, mentionNamer } from "./timeline.ts";

/** A chat needs this many messages in a day for a note. */
const MIN_SAID = 3;
/** Days back a missing note is still written. */
const DAYS_BACK = 3;

const day = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(t));
const clock = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
/** When a Cairo day starts (the offset at noon is the day's). */
const startOf = (d: string) => new Date(`${d}T00:00:00${cairoOffset(new Date(`${d}T12:00:00Z`))}`).toISOString();
const oneLine = (t: string, n: number) => t.replace(/\s+/g, " ").trim().slice(0, n);

const TOOL: ClaudeTool = {
  name: "day_note",
  description: "The day's notes of this chat.",
  input_schema: {
    type: "object",
    properties: { text: { type: "string", description: "3 to 12 short lines, each starting with \"- \", in English." } },
    required: ["text"],
  },
};

const SYSTEM = `You write the day's notes of one WhatsApp chat of iklipse (a creative and marketing agency in Cairo), so its assistant remembers what happened without reading every message again. The messages are in English, Arabic, Egyptian Arabic or Franco-Arabic; the notes are in English. BOT is the assistant.
Give the notes through the day_note tool, once:
- What was asked, decided, promised (who, what, by when), sent or delivered, and what's still open or waiting on whom. Names as the messages give them; times with "Cairo".
- Only what the messages say. Never guess, never judge anyone.
- Skip small talk, greetings and thanks. Never keep passwords, card or bank details.
- 3 to 12 short lines, the most useful first.`;

interface Said {
  chat_id: string;
  sender_name: string | null;
  from_bot: boolean;
  text: string | null;
  sent_at: string;
}

/** The chats with enough said on a Cairo day, and how much. */
async function busyChats(db: Db, d: string): Promise<Map<string, { n: number; dm: boolean }>> {
  const from = startOf(d);
  const to = startOf(day(Date.parse(from) + 36 * 60 * 60_000));
  const [g, p] = await Promise.all([
    db.from("wa_message").select("chat_id").gte("sent_at", from).lt("sent_at", to).not("text", "is", null).limit(5000),
    db.from("wa_dm").select("chat_id").gte("sent_at", from).lt("sent_at", to).not("text", "is", null).limit(5000),
  ]);
  const out = new Map<string, { n: number; dm: boolean }>();
  for (const [rows, dm] of [[g.data, false], [p.data, true]] as const) {
    for (const r of (rows ?? []) as { chat_id: string }[]) out.set(r.chat_id, { n: (out.get(r.chat_id)?.n ?? 0) + 1, dm });
  }
  for (const [k, v] of out) if (v.n < MIN_SAID) out.delete(k);
  return out;
}

/** Notes for the last days' busy chats that have none yet, a few a run. How many were written. */
export async function writeDayNotes(db: Db, s: Settings, t: Team, deadline: number, limit = 3): Promise<number> {
  const now = Date.now();
  const days = Array.from({ length: DAYS_BACK }, (_, i) => day(now - (i + 1) * 24 * 60 * 60_000));
  let done = 0;
  let name: ((x: string) => string) | null = null;
  for (const d of days) {
    const busy = await busyChats(db, d);
    if (!busy.size) continue;
    const ids = [...busy.keys()].map((c) => `${c}:${d}`);
    const { data: have, error } = await db.from("bot_day_note").select("id").in("id", ids);
    // Before 0134 runs: nowhere to keep them.
    if (error) return done;
    const kept = new Set(((have ?? []) as { id: string }[]).map((h) => h.id));
    for (const [chat, { dm }] of busy) {
      if (done >= limit || Date.now() > deadline - 30_000) return done;
      if (kept.has(`${chat}:${d}`)) continue;
      name ??= mentionNamer(t, await lidPhones(db), s.bot_phone);
      try {
        if (await noteOne(db, s, chat, d, dm, name)) done++;
      } catch (e) {
        console.error("day note", chat, d, (e as Error).message);
      }
    }
  }
  return done;
}

/** One chat's notes for one day. */
async function noteOne(db: Db, s: Settings, chat: string, d: string, dm: boolean, name: (x: string) => string): Promise<boolean> {
  const from = startOf(d);
  const to = startOf(day(Date.parse(from) + 36 * 60 * 60_000));
  const [{ data: rows }, { data: g }] = await Promise.all([
    dm
      ? db.from("wa_dm").select("chat_id, sender_name, from_bot, text, sent_at").eq("chat_id", chat).gte("sent_at", from).lt("sent_at", to).order("sent_at").limit(250)
      : db.from("wa_message").select("chat_id, sender_name, from_bot, text, sent_at").eq("chat_id", chat).gte("sent_at", from).lt("sent_at", to).order("sent_at").limit(250),
    dm ? Promise.resolve({ data: null }) : db.from("wa_group").select("name").eq("chat_id", chat).maybeSingle(),
  ]);
  const said = ((rows ?? []) as Said[]).filter((m) => str(m.text));
  if (said.length < MIN_SAID) return false;
  const them = said.find((m) => !m.from_bot && m.sender_name)?.sender_name;
  const place = dm ? `the private chat with ${them ?? "someone"}` : str((g as { name?: string } | null)?.name) || "a group";
  const user = [
    `The chat: ${place}. The day: ${d} (Cairo).`,
    "",
    ...said.map((m) => `[${clock.format(new Date(m.sent_at))}] ${m.from_bot ? "BOT" : (m.sender_name ?? "someone")}: ${oneLine(name(m.text!), 700)}`),
  ].join("\n");
  const r = (await claude(s, { name: "notes.day", role: "fast" }, SYSTEM, user, TOOL, 900)) as { text?: unknown } | null;
  const text = str(r?.text).trim().slice(0, 3000);
  if (!text) throw new Error("Claude gave no notes");
  const { error } = await db.from("bot_day_note").upsert({ id: `${chat}:${d}`, chat_id: chat, day: d, place, said: said.length, text }, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw new Error(error.message);
  return true;
}
