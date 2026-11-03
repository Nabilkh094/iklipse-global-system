// The bot remembering across chats (timeline.ts, daynotes.ts, brain.ts
// closeStale, search.ts termsOf, 0134), with the database in memory and
// Claude stubbed: mentions read as names, someone's last hours from every
// chat, the team's hidden-number ids learned from the groups, the words a
// search looks for, the day's notes, and brain runs left behind closed with
// why. Names and numbers are made up.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fakeDb } from "./test/fake-db.ts";
import { linkTeamLids, mentionNamer, timelineOf } from "./timeline.ts";
import { writeDayNotes } from "./daynotes.ts";
import { closeStale } from "./brain.ts";
import { termsOf } from "./search.ts";
import type { Person, Settings, Team } from "./kit.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const MIN = 60_000;
const at = (ago: number) => new Date(Date.now() - ago).toISOString();
const sara: Person = { id: "u-sara", name: "Sara", username: "sara", active: true, admin: true };
const omar: Person = { id: "u-omar", name: "Omar", username: "omar", active: true, admin: false };
const team = {
  people: new Map([["u-sara", sara], ["u-omar", omar]]),
  byPhone: new Map([["15550001001", sara]]),
  byLid: new Map([["900000000002@lid", omar]]),
  others: new Set<string>(),
} as unknown as Team;
const lidPhone = new Map([["900000000001@lid", "15550001001"], ["900000000009@lid", "15550009009"]]);

test("mentions read as names: by the number a group gave with the id, by a linked id, the bot as itself", () => {
  const name = mentionNamer(team, lidPhone, "15550000000");
  assert.equal(name("@900000000001 set a reminder for @900000000002"), "@Sara set a reminder for @Omar");
  assert.equal(name("@15550000000 can you?"), "@iklipse can you?");
  // Someone not on the team: their number when a group gave it, else the id as it was.
  assert.equal(name("ask @900000000009 and @900000000077"), "ask @+15550009009 and @900000000077");
});

test("someone's last 48 hours from every chat: theirs, mentions of them, the bot's replies, their private chat; older ones and the skipped chat left out", async () => {
  const f = fakeDb({
    wa_message: [
      { id: "m1", chat_id: "g1@g.us", phone: "15550001001", sender_name: "Sara", from_bot: false, text: "Remind me tomorrow about the Acme logo", sent_at: at(60 * MIN), wa_group: { name: "Bot alerts" } },
      { id: "m2", chat_id: "g1@g.us", phone: null, sender_id: "800000000001@lid", sender_name: "Sameh", from_bot: false, text: "@900000000001 please check the invoice", sent_at: at(50 * MIN), wa_group: { name: "Bot alerts" } },
      { id: "m3", chat_id: "g1@g.us", phone: "15550000000", sender_name: null, from_bot: true, text: "Who should get the reminder?", quoted_id: "m1", sent_at: at(59 * MIN), wa_group: { name: "Bot alerts" } },
      { id: "m4", chat_id: "g2@g.us", phone: "15550001001", sender_name: "Sara", from_bot: false, text: "Three days ago", sent_at: at(72 * 60 * MIN), wa_group: { name: "Acme" } },
      { id: "m5", chat_id: "g3@g.us", phone: "15550005005", sender_name: "Nour", from_bot: false, text: "Nothing about her", sent_at: at(30 * MIN), wa_group: { name: "Other" } },
    ],
    wa_dm: [
      { chat_id: "15550001001@c.us", from_bot: false, text: "It's me, link it", sent_at: at(40 * MIN) },
      { chat_id: "15550001001@c.us", from_bot: true, text: "Linked.", sent_at: at(39 * MIN) },
    ],
  });
  const name = mentionNamer(team, lidPhone, "15550000000");
  const lines = await timelineOf(f.db, { phones: ["15550001001"], lids: ["900000000001@lid"] }, name);
  assert.equal(lines.length, 5);
  assert.match(lines[0]!, /Bot alerts, Sara: Remind me tomorrow about the Acme logo$/);
  assert.match(lines[1]!, /Bot alerts, BOT \(you\): Who should get the reminder\?$/);
  assert.match(lines[2]!, /Bot alerts, Sameh: @Sara please check the invoice$/);
  assert.match(lines[3]!, /private chat, THEM: It's me, link it$/);
  assert.match(lines[4]!, /private chat, BOT \(you\): Linked\.$/);
  // The private chat shown on its own isn't repeated.
  const skipped = await timelineOf(f.db, { phones: ["15550001001"], lids: [] }, name, { skip: "15550001001@c.us" });
  assert.ok(skipped.every((l) => !l.includes("private chat")));
  // Nobody to look for: nothing, and nothing asked.
  assert.deepEqual(await timelineOf(f.db, { phones: [], lids: [] }, name), []);
});

test("the team's hidden-number ids learned from a group's numbers; a link already made stays", async () => {
  const f = fakeDb({
    wa_member: [{ phone: "15550001001", user_id: "u-sara" }, { phone: "15550002002", user_id: "u-omar" }],
    wa_member_lid: [{ lid: "900000000002@lid", user_id: "u-someone-else" }],
  });
  const n = await linkTeamLids(f.db, [
    { phone: "15550001001", lid: "900000000001@lid" },
    { phone: "15550002002", lid: "900000000002@lid" },
    { phone: "15550009009", lid: "900000000009@lid" },
    { phone: "15550001001", lid: null },
    { phone: null, lid: "900000000003@lid" },
  ]);
  assert.equal(n, 2);
  assert.deepEqual(
    f.tables.wa_member_lid!.map((r) => [r.lid, r.user_id]),
    [["900000000002@lid", "u-someone-else"], ["900000000001@lid", "u-sara"]],
  );
});

test("the words a search looks for: Arabic with and without its starts, the other ways given, common words left out", () => {
  const t = termsOf(["الفيديو خلص ولا ايه", "video ready, مونتاج"]);
  for (const w of ["الفيديو", "فيديو", "والفيديو", "بالفيديو", "خلص", "video", "ready", "مونتاج", "المونتاج"]) assert.ok(t.includes(w), w);
  assert.ok(!t.includes("ايه"));
  // One form of each letter, as the database keeps them.
  assert.ok(termsOf(["الإيميلات"]).includes("ايميلات"));
  assert.ok(termsOf(["the", "a"]).length === 0);
});

test("day notes: each busy chat of the days before, once; quiet chats and ones already noted skipped", async () => {
  const yesterday = new Date(Date.now() - 24 * 60 * MIN);
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(yesterday);
  const noon = new Date(`${ymd}T10:00:00Z`).getTime();
  const msg = (chat: string, i: number) => ({ chat_id: chat, sender_name: "Sara", from_bot: false, text: `line ${i} @900000000002`, sent_at: new Date(noon + i * MIN).toISOString() });
  const f = fakeDb({
    wa_message: [...[1, 2, 3].map((i) => msg("busy@g.us", i)), ...[1, 2].map((i) => msg("quiet@g.us", i)), ...[1, 2, 3].map((i) => msg("done@g.us", i))],
    wa_dm: [],
    wa_group: [{ chat_id: "busy@g.us", name: "Acme | iklipse" }],
    bot_day_note: [{ id: `done@g.us:${ymd}`, chat_id: "done@g.us", day: ymd, place: "x", text: "- old" }],
  });
  const asked: string[] = [];
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    asked.push(JSON.parse(String(init.body)).messages[0].content);
    return new Response(JSON.stringify({ content: [{ type: "tool_use", name: "day_note", input: { text: "- Sara sent three lines" } }], usage: {} }), { status: 200 });
  }) as unknown as typeof fetch;
  const s = { model: "claude-haiku-5-5", bot_phone: "15550000000" } as unknown as Settings;
  assert.equal(await writeDayNotes(f.db, s, team, Date.now() + 120_000), 1);
  const note = f.tables.bot_day_note!.find((n) => n.chat_id === "busy@g.us")!;
  assert.deepEqual([note.id, note.day, note.place, note.said, note.text], [`busy@g.us:${ymd}`, ymd, "Acme | iklipse", 3, "- Sara sent three lines"]);
  assert.equal(asked.length, 1);
  assert.match(asked[0]!, /Sara: line 1 @Omar/);
});

test("brain runs left behind: closed with why after 30 minutes; the one who asked told, unless a client or over a day old", async () => {
  const f = fakeDb({
    brain_run: [
      { id: "r1", status: "running", chat_id: "15550001001@c.us", reply_chat: "15550001001@c.us", message_id: "w1", request: "Build the weekly report for the Acme group", tier: "owner", created_at: at(45 * MIN) },
      { id: "r2", status: "queued", chat_id: "g1@g.us", reply_chat: "g1@g.us", message_id: "w2", request: "2pm sunday", tier: "admin", created_at: at(40 * MIN) },
      { id: "r3", status: "running", chat_id: "15550003003@c.us", reply_chat: "15550003003@c.us", message_id: "w3", request: "price?", tier: "client", created_at: at(40 * MIN) },
      { id: "r4", status: "running", chat_id: "15550001001@c.us", reply_chat: "15550001001@c.us", message_id: "w4", request: "old", tier: "owner", created_at: at(10 * 24 * 60 * MIN) },
      { id: "r5", status: "running", chat_id: "15550001001@c.us", reply_chat: "15550001001@c.us", message_id: "w5", request: "still going", tier: "owner", created_at: at(5 * MIN) },
    ],
  });
  const sent: [string, string, string | null | undefined][] = [];
  const n = await closeStale(f.db, async (c, t, q) => (sent.push([c, t, q]), "id"));
  assert.equal(n, 4);
  const st = Object.fromEntries(f.tables.brain_run!.map((r) => [r.id, [r.status, r.error ?? null]]));
  assert.deepEqual(st.r1, ["failed", "Never finished: the brain stopped while working on it (a restart or a crash)."]);
  assert.deepEqual(st.r2, ["failed", "Never finished: the brain never started it (it was down or restarting)."]);
  assert.equal(st.r3![0], "failed");
  assert.equal(st.r4![0], "failed");
  assert.deepEqual(st.r5, ["running", null]);
  assert.deepEqual(sent, [
    ["15550001001@c.us", 'Not finished: "Build the weekly report for the Acme group". The brain stopped while working on it (a restart or a crash). Send it again.', "w1"],
    ["g1@g.us", 'Not finished: "2pm sunday". The brain never started it (it was down or restarting). Send it again.', "w2"],
  ]);
});
