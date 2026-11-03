// relay.mjs's own rules, without WAHA or Claude: whose messages are taken,
// the commands, and what Claude writes made fit for WhatsApp. Ids are made up.

import { test } from "node:test";
import assert from "node:assert/strict";
import { commandOf, newFromOwner, pieces, whatsappText } from "./relay.mjs";

const owners = new Set(["900000000001@lid", "15550001001@c.us"]);

test("the owner's new messages only, oldest first: not the server's own, not anyone else's, not ones taken", () => {
  const msgs = [
    { id: "m3", timestamp: 30, fromMe: false, participant: "900000000001@lid", body: "third" },
    { id: "m1", timestamp: 10, fromMe: false, participant: "15550001001@c.us", body: "first" },
    { id: "m2", timestamp: 20, fromMe: true, participant: "900000000001@lid", body: "Claude's answer" },
    { id: "m4", timestamp: 40, fromMe: false, participant: "900000000077@lid", body: "someone else" },
    { id: "m5", timestamp: 50, fromMe: false, participant: "900000000001@lid", body: "taken" },
  ];
  assert.deepEqual(newFromOwner(msgs, owners, new Set(["m5"])).map((m) => m.id), ["m1", "m3"]);
  assert.deepEqual(newFromOwner({ error: "x" }, owners, new Set()), []);
});

test("commands: /new and /stop, nothing else", () => {
  assert.equal(commandOf(" /NEW "), "new");
  assert.equal(commandOf("/stop"), "stop");
  assert.equal(commandOf("/new chat please"), null);
  assert.equal(commandOf("hello"), null);
});

test("Markdown as WhatsApp writes it: bold, headings, tables as lines, links, code left alone", () => {
  const md = "# Plan\n\n**Done**: two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n[repo](https://github.com/x/y)\n\n```\n**not bold**\n```";
  assert.equal(whatsappText(md), "*Plan*\n\n*Done*: two\n\na · b\n\n1 · 2\n\nrepo: https://github.com/x/y\n\n```\n**not bold**\n```");
});

test("a long answer cut at lines, every piece within the limit", () => {
  const long = Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
  const p = pieces(long, 1000);
  assert.ok(p.length > 1);
  assert.ok(p.every((x) => x.length <= 1000));
  assert.equal(p.join("\n"), long);
  assert.deepEqual(pieces("short"), ["short"]);
});
