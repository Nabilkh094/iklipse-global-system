// Permissions (0137): what someone may have the bot do is their skills from
// the function, not their tier; the tools they don't have aren't shown at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedToolsFor, builtinsFor, devRun, hiddenToolsFor, toolVerdict } from "../src/policy.js";
import { runInstructions, runNotes, type Incoming, type Start } from "../src/prompt.js";

test("a member given message_client may use it; nothing else they weren't given", () => {
  const skills = ["talk", "find", "message_client"];
  const t = allowedToolsFor("member", false, skills);
  assert.ok(t.includes("mcp__iklipse__message_client"));
  assert.ok(t.includes("mcp__iklipse__find"));
  assert.ok(!t.includes("mcp__iklipse__search"));
  assert.ok(!t.includes("mcp__iklipse__set_reminder"));
  assert.equal(toolVerdict("mcp__iklipse__message_client", "member", false, false, skills).ok, true);
  const no = toolVerdict("mcp__iklipse__set_reminder", "member", false, false, skills);
  assert.equal(no.ok, false);
  assert.match(no.ok ? "" : no.why, /permission/);
});

test("an admin with a skill taken away loses it, though admins have it by default", () => {
  const skills = ["talk", "find", "search", "overview"];
  assert.ok(allowedToolsFor("admin", false).includes("mcp__iklipse__post_in_group"));
  assert.ok(!allowedToolsFor("admin", false, skills).includes("mcp__iklipse__post_in_group"));
  assert.equal(toolVerdict("mcp__iklipse__post_in_group", "admin", false, false, skills).ok, false);
});

test("tools they don't have are hidden, not only refused", () => {
  const skills = ["talk", "find"];
  const hidden = hiddenToolsFor("member", false, skills);
  assert.ok(hidden.includes("mcp__iklipse__message_client"));
  assert.ok(hidden.includes("mcp__iklipse__deploy"));
  assert.ok(!hidden.includes("mcp__iklipse__find"));
});

test("files and the shell: dev, privately only", () => {
  assert.ok(builtinsFor("member", true, ["dev"]).includes("Bash"));
  assert.ok(!builtinsFor("member", false, ["dev"]).includes("Bash"));
  assert.ok(!builtinsFor("admin", true, ["find", "deploy"]).includes("Bash"));
  // The system's own tools privately with any of them; never in a group.
  assert.equal(devRun("member", true, ["merge_pr"]), true);
  assert.equal(devRun("admin", false, ["dev", "merge_pr"]), false);
  assert.ok(allowedToolsFor("member", true, ["merge_pr"]).includes("mcp__iklipse__merge_pr"));
  assert.ok(!allowedToolsFor("member", true, ["merge_pr"]).includes("Bash"));
});

test("a client given a team tool by their number gets it; a blocked one would never get here", () => {
  const t = allowedToolsFor("client", false, ["talk", "order_update", "free_times"]);
  assert.ok(t.includes("mcp__iklipse__free_times"));
  assert.ok(!t.includes("mcp__iklipse__client_meeting"));
});

test("permissions: the super admin's tool, never anyone else's by tier", () => {
  assert.ok(allowedToolsFor("owner", false).includes("mcp__iklipse__permissions"));
  assert.ok(!allowedToolsFor("admin", false).includes("mcp__iklipse__permissions"));
});

test("before 0137 (no skills), the tiers as before", () => {
  assert.deepEqual(allowedToolsFor("member", false, null), allowedToolsFor("member", false));
  assert.deepEqual(allowedToolsFor("admin", true, undefined), allowedToolsFor("admin", true));
});

const start = (over: Partial<Start> = {}): Start => ({
  asker: { id: "u1", name: "Sara", tier: "member", admin: false, zone: "Africa/Cairo" },
  stopped: false,
  model: "m",
  model_fast: "f",
  max_turns: 10,
  run_minutes: 5,
  run_cost_usd: 1,
  spent_today: 0,
  day_cost_usd: 10,
  over_cap: false,
  now: "Thu 5 Nov 2026 10:00",
  where: { private: true },
  taught: null,
  guide: null,
  approvals: [],
  ...over,
});
const msg: Incoming = { run_id: "r", message_id: "m", chat_id: "201000000000@c.us", reply_chat: "201000000000@c.us", sender: { id: "u1", name: "Sara", tier: "member" }, text: "hi" };

test("their permissions and the super admin's rules go with every message, not in the fixed instructions", () => {
  const s = start({ skills: ["talk", "find", "message_client"], rules: "Never promise a delivery date." });
  const notes = runNotes(s, "");
  assert.match(notes, /Their permissions now \(only these\): find, message_client\./);
  assert.match(notes, /Never promise a delivery date/);
  const fixed = runInstructions(s, msg);
  assert.doesNotMatch(fixed, /message_client/);
  assert.match(fixed, /permissions/);
  // The super admin: no list (everything).
  assert.doesNotMatch(runNotes(start({ asker: { ...s.asker, tier: "owner" }, skills: ["talk", "find"] }), ""), /Their permissions now/);
});
