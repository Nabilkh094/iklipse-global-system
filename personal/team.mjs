// Team mode: several workers on one request, the Central Agent in charge.
//   compare: the same request to each worker at once; Jev scores the answers;
//            the Central Agent merges them into one, starting from the best.
//   split:   the Central Agent cuts the request into parts and names a worker
//            for each; the parts run at once; the Central Agent joins and checks.
// The runners are passed in, so this is the same in the relay and the tests.

import { jsonIn } from "./router.mjs";

const cut = (s, n) => String(s ?? "").slice(0, n);

/** The Central Agent's plan for a split: [{worker, part}], only known workers, at most 4 parts. */
export function parsePlan(text, workers) {
  const j = jsonIn(text);
  const parts = Array.isArray(j?.parts) ? j.parts : Array.isArray(j) ? j : [];
  return parts
    .map((p) => ({ worker: workers.includes(p?.worker) ? p.worker : workers[0], part: cut(p?.part ?? p?.task, 4000).trim() }))
    .filter((p) => p.part)
    .slice(0, 4);
}

/**
 * run(worker, prompt) -> {text} | {failed}; central(prompt) -> {text} | {failed};
 * progress(line) tells the group; judge(answers) -> {worker: score} | null.
 */
export async function compare({ task, context, workers, run, central, judge, progress, labels }) {
  progress(`👥 Team (compare): ${workers.map((w) => labels[w]).join(", ")} on the same request.`);
  const results = await Promise.all(workers.map(async (w) => ({ provider: w, ...(await run(w, `${context}${task}`)) })));
  const ok = results.filter((r) => r.text);
  const failed = results.filter((r) => !r.text);
  for (const f of failed) progress(`⚠️ ${labels[f.provider]} didn't finish: ${cut(f.failed, 200)}`);
  if (!ok.length) return { failed: "no worker finished", results };
  if (ok.length === 1) return { text: ok[0].text, results, scores: null };
  const scores = await judge(ok);
  const order = scores ? [...ok].sort((a, b) => (scores[b.provider] ?? 0) - (scores[a.provider] ?? 0)) : ok;
  const merged = await central(
    [
      "Several models answered the same request. Write the one best answer for Nabil: start from the strongest, take what the others got right, drop what's wrong. Don't mention the comparison unless the answers disagree on something that matters; then say so in one line.",
      `Request: ${cut(task, 8000)}`,
      ...order.map((r) => `--- ${labels[r.provider]}${scores ? ` (score ${scores[r.provider].toFixed(1)}/4)` : ""} ---\n${cut(r.text, 12000)}`),
    ].join("\n\n"),
  );
  if (!merged.text) return { text: order[0].text, results, scores, note: `the Central Agent failed (${cut(merged.failed, 120)}), so this is ${labels[order[0].provider]}'s answer` };
  return { text: merged.text, results, scores };
}

export async function split({ task, context, workers, run, central, progress, labels }) {
  const planned = await central(
    [
      `Cut this request into 2 to 4 parts that can be done at the same time, each by one of these workers: ${workers.join(", ")}.`,
      "claude: careful long coding, agent work, writing. gpt: coding and reasoning, quick fixes. grok: research, current events, X/Twitter.",
      'Answer with JSON only: {"parts":[{"worker":"…","part":"what this worker must do, complete on its own"}]}',
      `Request: ${cut(task, 8000)}`,
    ].join("\n\n"),
  );
  const parts = parsePlan(planned.text, workers);
  if (parts.length < 2) return { fallback: "compare" };
  progress(`👥 Team (split), ${parts.length} parts:\n${parts.map((p, i) => `${i + 1}. ${labels[p.worker]}: ${cut(p.part, 120)}`).join("\n")}`);
  const results = await Promise.all(
    parts.map(async (p, i) => ({ ...p, n: i + 1, ...(await run(p.worker, `${context}You are doing part ${i + 1} of ${parts.length} of a bigger request.\nWhole request: ${cut(task, 4000)}\nYour part: ${p.part}`)) })),
  );
  for (const r of results.filter((x) => !x.text)) progress(`⚠️ Part ${r.n} (${labels[r.worker]}) didn't finish: ${cut(r.failed, 200)}`);
  if (!results.some((r) => r.text)) return { failed: "no part finished", results };
  const joined = await central(
    [
      "These parts of one request were done by different models. Join them into one answer for Nabil and check it: fix contradictions, fill small gaps, and say plainly if a part is missing or failed.",
      `Request: ${cut(task, 8000)}`,
      ...results.map((r) => `--- Part ${r.n} (${labels[r.worker]}): ${cut(r.part, 300)} ---\n${r.text ? cut(r.text, 12000) : `FAILED: ${cut(r.failed, 300)}`}`),
    ].join("\n\n"),
  );
  if (!joined.text) return { text: results.map((r) => `*Part ${r.n} (${labels[r.worker]})*\n${r.text ?? `failed: ${r.failed}`}`).join("\n\n"), results, note: "the Central Agent failed to join them, so here are the parts" };
  return { text: joined.text, results };
}
