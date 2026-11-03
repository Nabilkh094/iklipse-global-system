// What happened with one person across every chat lately, for the brain: what
// they wrote in the groups, what others wrote about them (a mention), what the
// bot said back, and their private chat with the bot. Each chat has its own
// conversation with the brain, so without this a question asked in a group
// and answered privately starts from nothing. Mentions come as names, not as
// WhatsApp's hidden-number ids. Information only.

import { cairoStamp, str, type Db, type Team } from "./kit.ts";

const HOUR = 60 * 60_000;
const one = (t: unknown, n: number) => str(t).replace(/\s+/g, " ").trim().slice(0, n);

/** A hidden-number id ("1234@lid") -> the number WhatsApp gave with it in a group. */
export async function lidPhones(db: Db): Promise<Map<string, string>> {
  const { data } = await db.from("wa_participant").select("lid, phone").not("lid", "is", null).not("phone", "is", null);
  const out = new Map<string, string>();
  for (const p of (data ?? []) as { lid: string; phone: string }[]) out.set(p.lid, p.phone);
  return out;
}

/**
 * "@1234..." (WhatsApp writes most mentions with the hidden-number id) as the
 * person's name: "@Sara". The bot is "@iklipse"; someone unknown keeps their
 * number when one is known, else the id as it was.
 */
export function mentionNamer(t: Pick<Team, "byPhone" | "byLid">, lidPhone: Map<string, string>, botPhone: string | null | undefined) {
  return (text: string) =>
    str(text).replace(/@(\d{8,15})\b/g, (all, d: string) => {
      const phone = lidPhone.get(`${d}@lid`) ?? d;
      if (botPhone && phone === botPhone) return "@iklipse";
      const who = t.byPhone.get(phone) ?? t.byLid.get(`${d}@lid`);
      if (who) return `@${who.name}`;
      return phone !== d ? `@+${phone}` : all;
    });
}

/** Who the timeline is about: their numbers and hidden-number ids, and their private chats with the bot. */
export interface Someone {
  phones: string[];
  lids: string[];
}

interface Line {
  at: number;
  text: string;
}

/**
 * Their last hours everywhere, oldest first, one line each: "[Mon 3 Nov,
 * 13:00] Bot alerts, Sameh: @Abdelrahman set a reminder ...". Their own
 * messages, messages that mention them, the bot's replies to them, and their
 * private chat with the bot. skip: a chat the caller shows on its own.
 */
export async function timelineOf(db: Db, who: Someone, name: (t: string) => string, o: { hours?: number; limit?: number; skip?: string | null } = {}): Promise<string[]> {
  const since = new Date(Date.now() - (o.hours ?? 48) * HOUR).toISOString();
  const limit = o.limit ?? 60;
  const phones = [...new Set(who.phones.map((p) => p.replace(/\D/g, "")).filter(Boolean))];
  const lids = [...new Set(who.lids.filter((l) => l.endsWith("@lid")))];
  if (!phones.length && !lids.length) return [];
  const ids = [...phones, ...lids.map((l) => l.slice(0, -4))];
  const theirs = [...phones.map((p) => `phone.eq.${p}`), ...lids.map((l) => `sender_id.eq."${l}"`)];
  const named = ids.map((d) => `text.ilike.*@${d}*`);
  const dms = [...phones.map((p) => `${p}@c.us`), ...lids];
  const cols = "id, chat_id, sender_name, from_bot, text, quoted_id, sent_at, wa_group(name)";

  const [mine, about, priv] = await Promise.all([
    db.from("wa_message").select(cols).or(theirs.join(",")).gte("sent_at", since).order("sent_at", { ascending: false }).limit(limit),
    db.from("wa_message").select(cols).or(named.join(",")).gte("sent_at", since).order("sent_at", { ascending: false }).limit(limit),
    db.from("wa_dm").select("chat_id, from_bot, text, sent_at").in("chat_id", dms).gte("sent_at", since).order("sent_at", { ascending: false }).limit(limit),
  ]);
  type Msg = { id: string; chat_id: string; sender_name: string | null; from_bot: boolean; text: string | null; quoted_id: string | null; sent_at: string; wa_group: { name: string | null } | null };
  const group = [...((mine.data ?? []) as unknown as Msg[]), ...((about.data ?? []) as unknown as Msg[])];
  // The bot's replies to what they wrote.
  const theirIds = ((mine.data ?? []) as unknown as Msg[]).map((m) => m.id);
  const { data: replies } = theirIds.length
    ? await db.from("wa_message").select(cols).eq("from_bot", true).in("quoted_id", theirIds.slice(0, 100)).gte("sent_at", since)
    : { data: [] };
  group.push(...((replies ?? []) as unknown as Msg[]));

  const seen = new Set<string>();
  const lines: Line[] = [];
  for (const m of group) {
    if (seen.has(m.id) || m.chat_id === o.skip || !str(m.text)) continue;
    seen.add(m.id);
    const where = m.wa_group?.name ?? "a group";
    const by = m.from_bot ? "BOT (you)" : (m.sender_name ?? "someone");
    lines.push({ at: Date.parse(m.sent_at), text: `[${cairoStamp.format(new Date(m.sent_at))}] ${where}, ${by}: ${one(name(m.text!), 400)}` });
  }
  for (const m of (priv.data ?? []) as { chat_id: string; from_bot: boolean; text: string | null; sent_at: string }[]) {
    if (m.chat_id === o.skip || !str(m.text)) continue;
    lines.push({ at: Date.parse(m.sent_at), text: `[${cairoStamp.format(new Date(m.sent_at))}] private chat, ${m.from_bot ? "BOT (you)" : "THEM"}: ${one(name(m.text!), 400)}` });
  }
  return lines
    .sort((a, b) => a.at - b.at)
    .slice(-limit)
    .map((l) => l.text);
}

/**
 * A team member's hidden-number ids, learned from the groups: WhatsApp gives a
 * group's people with both their number and their id, and the number is the
 * one linked to them in Alerts > Groups (wa_member, never the member card they
 * edit themselves). A link already made is never changed.
 */
export async function linkTeamLids(db: Db, parts: { phone: string | null; lid: string | null }[]): Promise<number> {
  const pairs = parts.filter((p): p is { phone: string; lid: string } => !!p.phone && /^\d{6,20}@lid$/.test(p.lid ?? ""));
  if (!pairs.length) return 0;
  const { data } = await db.from("wa_member").select("phone, user_id").in("phone", [...new Set(pairs.map((p) => p.phone))]);
  const user = new Map(((data ?? []) as { phone: string; user_id: string }[]).map((w) => [w.phone, w.user_id]));
  const rows = [...new Map(pairs.filter((p) => user.has(p.phone)).map((p) => [p.lid, { lid: p.lid, user_id: user.get(p.phone)! }])).values()];
  if (!rows.length) return 0;
  const { error } = await db.from("wa_member_lid").upsert(rows, { onConflict: "lid", ignoreDuplicates: true });
  if (error) console.error("lid link", error.message);
  return error ? 0 : rows.length;
}
