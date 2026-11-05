// Scheduled tasks (schedules.ts, 0139): when each comes next, in its zone,
// and each due one run once, as its owner, privately. Names are made up.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeDb } from "./test/fake-db.ts";
import { nextRun, runSchedules, sayRule } from "./schedules.ts";

const ENV: Record<string, string> = { BRAIN_URL: "https://brain.example.com", BRAIN_SECRET: "b".repeat(40), BRAIN_ENABLED: "on" };
(globalThis as unknown as { Deno: { env: { get: (k: string) => string | undefined } } }).Deno.env.get = (k: string) => ENV[k];

const cairo = (s: string) => Date.parse(`${s}+02:00`);

test("every day at 09:00 Cairo: today if it's still before, else tomorrow", () => {
  const rule = { every: "day" as const, days: [], at: "09:00", on_date: null, zone: "Africa/Cairo" };
  assert.equal(nextRun(rule, cairo("2026-11-05T08:00:00")), cairo("2026-11-05T09:00:00"));
  assert.equal(nextRun(rule, cairo("2026-11-05T09:00:00")), cairo("2026-11-06T09:00:00"));
});

test("working days are Sunday to Thursday", () => {
  const rule = { every: "weekdays" as const, days: [], at: "10:00", on_date: null, zone: "Africa/Cairo" };
  // Thursday 5 Nov 2026 after 10: the next is Sunday 8 Nov.
  assert.equal(nextRun(rule, cairo("2026-11-05T11:00:00")), cairo("2026-11-08T10:00:00"));
});

test("some days of the week, of the month, and once", () => {
  const sun = { every: "week" as const, days: [0], at: "10:00", on_date: null, zone: "Africa/Cairo" };
  assert.equal(nextRun(sun, cairo("2026-11-05T11:00:00")), cairo("2026-11-08T10:00:00"));
  const first = { every: "month" as const, days: [1], at: "08:30", on_date: null, zone: "Africa/Cairo" };
  assert.equal(nextRun(first, cairo("2026-11-05T11:00:00")), cairo("2026-12-01T08:30:00"));
  const once = { every: "once" as const, days: [], at: "15:00", on_date: "2026-11-10", zone: "Africa/Cairo" };
  assert.equal(nextRun(once, cairo("2026-11-05T11:00:00")), cairo("2026-11-10T15:00:00"));
  assert.equal(nextRun(once, cairo("2026-11-11T11:00:00")), null);
  assert.equal(nextRun({ ...sun, at: "25:00" }), null);
  assert.match(sayRule(sun), /every Sun at 10:00/);
});

test("a due one runs once, as its owner, privately; the next time is set", async () => {
  const now = cairo("2026-11-08T10:00:30");
  const tables = {
    brain_settings: [{ id: 1, phase: 2, stopped: false, owner_phones: ["201000000001"], owner_users: ["u-super"], super_admin: "u-super" }],
    profile: [{ id: "u-admin", display_name: "Sameh", username: "sameh", role: "admin", is_active: true }],
    wa_member: [{ phone: "201000000002", user_id: "u-admin", created_at: "2026-01-01" }],
    brain_schedule: [{ id: "s1", user_id: "u-admin", text: "Send me the open alerts.", every: "week", days: [0], at: "10:00", on_date: null, zone: "Africa/Cairo", enabled: true, next_at: new Date(cairo("2026-11-08T10:00:00")).toISOString(), runs: 0 }],
  };
  const { db, tables: t } = fakeDb(tables);
  const sent: Record<string, unknown>[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_u: string, init: RequestInit) => (sent.push(JSON.parse(String(init.body))), new Response("{}"))) as unknown as typeof fetch;
  try {
    assert.equal(await runSchedules(db, Date.now() + 30_000, now), 1);
  } finally {
    globalThis.fetch = realFetch;
  }
  const run = t.brain_run![0]!;
  assert.equal(run.asker, "u-admin");
  assert.equal(run.reply_chat, "201000000002@c.us");
  assert.match(String(run.message_id), /^schedule:s1:/);
  assert.match(String(sent[0]!.text), /Send me the open alerts\./);
  assert.equal(t.brain_schedule![0]!.next_at, new Date(cairo("2026-11-15T10:00:00")).toISOString());
  // Run again in the same minute: nothing (it was claimed).
  assert.equal(await runSchedules(db, Date.now() + 30_000, now), 0);
});
