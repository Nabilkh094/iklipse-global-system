// The company bot channel (bot.mjs): signing, tasks in order or together,
// answers matched to their task, OKs apart, and what Nabil reads built from
// the bot's words or, without them, its own log.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { botChannel, doneSteps, isOwnerWord, masterSignature, parseBotRequest, resultText } from "./bot.mjs";
import { nextAt, parseSchedule, sayDays } from "./schedule.mjs";

test("the signature is the bot's: HMAC over master.<seconds>.<body>", () => {
  const sig = masterSignature("s".repeat(40), '{"a":1}', 1_700_000_000_000);
  const v = createHmac("sha256", "s".repeat(40)).update('master.1700000000.{"a":1}').digest("hex");
  assert.equal(sig, `t=1700000000,v1=${v}`);
});

test("a /bot request: one task, a numbered list in order, or together", () => {
  assert.deepEqual(parseBotRequest("Tell Sara the files are late"), { tasks: ["Tell Sara the files are late"], together: false });
  assert.deepEqual(parseBotRequest("1. Remind Ali at 5\n2. Post the report in Team"), { tasks: ["Remind Ali at 5", "Post the report in Team"], together: false });
  assert.deepEqual(parseBotRequest("together\n- Who's off today?\n- Open alerts?"), { tasks: ["Who's off today?", "Open alerts?"], together: true });
  // A sentence with one list line inside stays one task.
  assert.equal(parseBotRequest("Send this:\n1. hello").tasks.length, 1);
});

test("only Nabil's own short OK words count, not a sentence with yes in it", () => {
  for (const w of ["yes 4821", "no", "نعم 1234", "لا", "OK 1111"]) assert.ok(isOwnerWord(w), w);
  for (const w of ["yes do it and also deploy", "approve 4821 please", ""]) assert.ok(!isOwnerWord(w), w);
});

/** A fake bot: takes tasks, says what it's told, ends them on the next poll. */
function fakeBot() {
  const seen = { tasks: [], words: [] };
  let seq = 0;
  const replies = [];
  const states = new Map();
  const post = async (op, p) => {
    if (op === "task") {
      seen.tasks.push(p);
      states.set(p.task_id, "running");
      return { ok: true, state: "sent" };
    }
    if (op === "words") {
      seen.words.push(p.text);
      return { ok: true, handled: true };
    }
    const out = { ok: true, replies: replies.filter((r) => r.seq > p.after), tasks: [] };
    for (const id of p.tasks) {
      const s = states.get(id);
      if (s === "running") {
        states.set(id, "done");
        out.tasks.push({ task_id: id, state: "running", steps: [] });
      } else out.tasks.push({ task_id: id, state: s, error: null, steps: [{ tool: "message_client", outcome: "ok" }] });
    }
    return out;
  };
  return { post, seen, say: (task_id, kind, text) => replies.push({ seq: ++seq, task_id, kind, text }), states };
}

test("in order: the second task is sent only once the first is over", async () => {
  const f = fakeBot();
  const ch = botChannel({ post: f.post });
  const done = ch.run(["first", "second"]);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(f.seen.tasks.map((t) => t.text), ["first"]);
  f.say(f.seen.tasks[0].task_id, "reply", "First done.");
  await ch.tick();
  await ch.tick();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(f.seen.tasks.map((t) => t.text), ["first", "second"]);
  await ch.tick();
  await ch.tick();
  const out = await done;
  assert.equal(out.length, 2);
  assert.equal(resultText(out[0]), "First done.");
  // No words from the bot: what its log shows it did.
  assert.equal(resultText(out[1]), "Done: message_client.");
});

test("together: all sent at once", async () => {
  const f = fakeBot();
  const ch = botChannel({ post: f.post });
  const done = ch.run(["a", "b", "c"], { together: true });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(f.seen.tasks.length, 3);
  await ch.tick();
  await ch.tick();
  assert.equal((await done).length, 3);
});

test("the master's own asks are reading only (auto), and OKs and notices go apart", async () => {
  const f = fakeBot();
  const oks = [];
  const notes = [];
  const ch = botChannel({ post: f.post, onApproval: (x) => oks.push(x.text), onNotice: (x) => notes.push(x.text) });
  const t = ch.send("Who's working today?", { auto: true });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(f.seen.tasks[0].auto, true);
  f.say(null, "approval", "OK needed (code 4821)");
  f.say(null, "notice", "Spent 80% today.");
  await ch.tick();
  await ch.tick();
  await t;
  assert.deepEqual(oks, ["OK needed (code 4821)"]);
  assert.deepEqual(notes, ["Spent 80% today."]);
  assert.equal(ch.after, 2);
  assert.equal(await ch.words("yes 4821"), true);
  assert.deepEqual(f.seen.words, ["yes 4821"]);
});

test("the bot down or refusing: the task is over, said plainly, nothing invented", async () => {
  const ch = botChannel({ post: async () => ({ ok: false, error: "The brain isn't on." }) });
  const t = await ch.send("Tell Acme");
  assert.equal(t.state, "failed");
  assert.match(resultText(t), /Not finished \(The brain isn't on\.\)/);
  const thrown = botChannel({ post: async () => { throw new Error("network down"); } });
  assert.equal((await thrown.send("x")).state, "failed");
});

test("a task the bot never picks up times out", async () => {
  let clock = 0;
  const f = fakeBot();
  const ch = botChannel({ post: async (op, p) => (op === "poll" ? { ok: true, replies: [], tasks: [] } : f.post(op, p)), now: () => clock, timeoutMs: 1000 });
  const t = ch.send("x");
  await new Promise((r) => setTimeout(r, 5));
  clock = 5000;
  await ch.tick();
  assert.equal((await t).state, "timeout");
});

test("/schedule: every day, working days, some weekdays; Cairo time", () => {
  assert.deepEqual(parseSchedule("every day 9:00 summarize my mail"), { op: "add", days: "day", at: "09:00", text: "summarize my mail" });
  assert.deepEqual(parseSchedule("sun,wed 10:30 plan the week"), { op: "add", days: [0, 3], at: "10:30", text: "plan the week" });
  assert.equal(parseSchedule("weekdays 08:00 news").days, "weekdays");
  assert.deepEqual(parseSchedule("off 2"), { op: "off", n: 2 });
  assert.equal(parseSchedule("someday 10:00 x").op, "help");
  assert.equal(parseSchedule("day 25:00 x").op, "help");
  const cairo = (x) => Date.parse(`${x}+02:00`);
  const s = { days: "weekdays", at: "10:00", zone: "Africa/Cairo" };
  // Thursday 5 Nov 2026, after 10: Sunday 8 Nov at 10.
  assert.equal(nextAt(s, cairo("2026-11-05T11:00:00")), cairo("2026-11-08T10:00:00"));
  assert.equal(nextAt({ ...s, days: "day" }, cairo("2026-11-05T09:00:00")), cairo("2026-11-05T10:00:00"));
  assert.equal(sayDays({ days: [0, 3], at: "10:30" }), "Sun, Wed at 10:30");
});

test("done steps: only tools that worked, not the bot's own plumbing", () => {
  assert.deepEqual(doneSteps([{ tool: "set_reminder", outcome: "ok" }, { tool: "_reply", outcome: "ok" }, { tool: "post_in_group", outcome: "refused" }]), ["set_reminder"]);
});
