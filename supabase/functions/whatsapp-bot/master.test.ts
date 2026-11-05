// The master channel (master.ts): signed with its own secret, every task as
// the one super admin whatever the request says, the master's own asks
// reading only, and what the bot says kept for the master, never sent on
// WhatsApp. Names and numbers are made up.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeDb } from "./test/fake-db.ts";
import { masterApi, masterOut, MASTER_CHAT } from "./master.ts";
import { ownerChats, signature, type BrainSettings } from "./brain.ts";

const MASTER = "m".repeat(40);
const BRAIN = "b".repeat(40);
const ENV: Record<string, string> = { BRAIN_URL: "https://brain.example.com", BRAIN_SECRET: BRAIN, BRAIN_ENABLED: "on", MASTER_SECRET: MASTER };
(globalThis as unknown as { Deno: { env: { get: (k: string) => string | undefined } } }).Deno.env.get = (k: string) => ENV[k];
const get = (k: string) => ENV[k] ?? "";
const TASK = "44444444-4444-4444-8444-444444444444";

function world() {
  return {
    brain_settings: [{ id: 1, phase: 0, stopped: false, owner_phones: ["201000000001"], owner_users: ["u-super"], super_admin: "u-super", model_owner: "claude-opus-5-5", model_member: "claude-sonnet-5-5", model_fast: "claude-haiku-5-5", max_turns: 40, member_turns: 12, run_minutes: 15, run_cost_usd: 5, day_cost_usd: 40 }],
    profile: [
      { id: "u-super", display_name: "Nabil", username: "nabil", role: "admin", is_active: true },
      { id: "u-admin", display_name: "Sameh", username: "sameh", role: "admin", is_active: true },
    ],
    wa_member: [{ phone: "201000000001", user_id: "u-super" }],
    master_reply: [] as Record<string, unknown>[],
  };
}

async function req(op: string, payload: unknown, secret = MASTER) {
  const body = JSON.stringify(payload);
  return new Request(`https://x.supabase.co/functions/v1/whatsapp-bot/master/${op}`, { method: "POST", body, headers: { "x-master-signature": await signature(secret, "master", body) } });
}

function brainFetch() {
  const sent: Record<string, unknown>[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { f, sent };
}

test("unsigned, or signed with the brain's secret: refused", async () => {
  const { db } = fakeDb(world());
  const words = async () => false;
  assert.equal((await masterApi(new Request("https://x/master/task", { method: "POST", body: "{}" }), "task", db, { words }, get)).status, 403);
  assert.equal((await masterApi(await req("task", { task_id: TASK, text: "hi" }, BRAIN), "task", db, { words }, get)).status, 403);
  // Not set up (no MASTER_SECRET): not there at all.
  assert.equal((await masterApi(await req("task", {}), "task", db, { words }, () => "")).status, 404);
});

test("a task goes to the brain as the super admin, whoever the request names", async () => {
  // message_id is unique in the database: the same task twice is refused there (23505).
  const holder: { tables?: Record<string, Record<string, unknown>[]> } = {};
  const { db, tables } = fakeDb(world(), {
    fail: (c) => (c.table === "brain_run" && c.op === "insert" && (holder.tables?.brain_run ?? []).some((r) => r.message_id === (c.values as { message_id?: string }).message_id) ? { message: "duplicate", code: "23505" } : null),
  });
  holder.tables = tables;
  const { f, sent } = brainFetch();
  const r = await masterApi(await req("task", { task_id: TASK, text: "Tell Acme the files are ready.", sender: "u-admin", asker: "u-admin" }), "task", db, { words: async () => false, fetch: f }, get);
  const out = (await r.json()) as Record<string, unknown>;
  assert.equal(out.ok, true);
  const run = tables.brain_run![0]!;
  assert.equal(run.asker, "u-super");
  assert.equal(run.tier, "owner");
  assert.equal(run.chat_id, MASTER_CHAT);
  assert.equal(run.reply_chat, MASTER_CHAT);
  assert.equal(run.via, "master");
  assert.equal(run.message_id, `master:${TASK}`);
  assert.equal((sent[0]!.sender as { id: string }).id, "u-super");
  // The same task again: one task.
  const again = (await (await masterApi(await req("task", { task_id: TASK, text: "Tell Acme the files are ready." }), "task", db, { words: async () => false, fetch: f }, get)).json()) as Record<string, unknown>;
  assert.equal(again.ok, true);
  assert.equal(tables.brain_run!.length, 1);
});

test("the master asking by itself: the run is reading only", async () => {
  const { db, tables } = fakeDb(world());
  const { f } = brainFetch();
  await masterApi(await req("task", { task_id: TASK, text: "Who's working today?", auto: true }), "task", db, { words: async () => false, fetch: f }, get);
  assert.equal(tables.brain_run![0]!.via, "master-auto");
});

test("what the bot says to the master is kept, by task, and read back in order", async () => {
  const { db, tables } = fakeDb(world());
  await masterOut(db, "Sent to Acme: files ready.", `master:${TASK}`);
  await masterOut(db, "OK needed (code 4821)\nWhat: deploy", null);
  await masterOut(db, "Brain spent 80% today.", null);
  // The database numbers them (bigserial).
  tables.master_reply!.forEach((r, i) => (r.seq = i + 1));
  const r = (await (await masterApi(await req("poll", { after: 0 }), "poll", db, { words: async () => false }, get)).json()) as { replies: { task_id: string | null; kind: string }[] };
  assert.deepEqual(r.replies.map((x) => [x.task_id, x.kind]), [
    [TASK, "reply"],
    [null, "approval"],
    [null, "notice"],
  ]);
});

test("the super admin's own words go to the OKs as from their number", async () => {
  const { db } = fakeDb(world());
  const seen: { id: string; text: string; phone: string | null }[] = [];
  const r = (await (await masterApi(await req("words", { id: "word-1", text: "yes 4821" }), "words", db, { words: async (o) => (seen.push(o), true) }, get)).json()) as Record<string, unknown>;
  assert.equal(r.handled, true);
  assert.deepEqual(seen, [{ id: "master-words:word-1", text: "yes 4821", phone: "201000000001" }]);
});

test("with the master channel on, what was for the super admin's private chat goes to the master group", () => {
  const s = { owner_phones: ["201000000001"] } as BrainSettings;
  assert.deepEqual(ownerChats(s), [MASTER_CHAT]);
  ENV.MASTER_SECRET = "";
  assert.deepEqual(ownerChats(s), ["201000000001@c.us"]);
  ENV.MASTER_SECRET = MASTER;
});
