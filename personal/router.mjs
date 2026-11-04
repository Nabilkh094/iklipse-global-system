// The quick decisions: which worker takes a request, how hard it thinks,
// whether it's sensitive, how good each team answer is, whether to compare or
// split. Jev answers them when it has its key; otherwise Claude (Haiku) is
// asked the same, as JSON; if that fails too, plain rules decide.

import { jevAsk, readRoute, routeQuestions } from "./agents.mjs";

const TASK_TYPES = ["code", "research", "writing", "data", "other"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** Words that make a request sensitive, for when neither Jev nor Claude can say. */
const SENSITIVE = /\b(deploy|publish|release|merge|force[- ]?push|delete|remove|drop|wipe|rm -rf|pay|buy|purchase|charge|transfer|send (an? )?(email|message)|email (him|her|them|the)|dns|billing|production|prod)\b/i;

export const sensitiveByWords = (text) => SENSITIVE.test(String(text ?? ""));

/** A JSON object out of a model's answer, or null. */
export function jsonIn(text) {
  const s = String(text ?? "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

/** A route that only uses what's allowed. */
function clean(r, available, fallback) {
  return {
    provider: available.includes(r?.provider) ? r.provider : fallback,
    taskType: TASK_TYPES.includes(r?.taskType) ? r.taskType : "other",
    effort: EFFORTS.includes(r?.effort) ? r.effort : "medium",
    sensitive: Boolean(r?.sensitive),
  };
}

/**
 * Route one request among the available workers.
 * jevKey: the key or null. askClaude(prompt) -> text (Haiku). fallback: the worker when nothing decides.
 */
export async function route({ text, available, jevKey, askClaude, fallback, fetchImpl }) {
  const state = String(text ?? "").slice(0, 20000);
  if (jevKey) {
    try {
      const r = readRoute(await jevAsk({ key: jevKey, state, questions: routeQuestions(available), fetchImpl }));
      return { ...clean(r, available, fallback), by: "jev" };
    } catch (e) {
      console.error("router jev", e.message);
    }
  }
  if (askClaude) {
    try {
      const j = jsonIn(
        await askClaude(
          [
            "Route this request. Answer with JSON only:",
            `{"provider": one of ${JSON.stringify(available)}, "taskType": one of ${JSON.stringify(TASK_TYPES)}, "effort": one of ${JSON.stringify(EFFORTS)}, "sensitive": true if it would deploy, merge, delete, spend money, send something outside the chat or change settings}`,
            "claude: careful long coding, agent work and writing. gpt: coding and reasoning, quick plans and fixes. grok: research, current events and X/Twitter.",
            `Request: ${state.slice(0, 4000)}`,
          ].join("\n"),
        ),
      );
      if (j) return { ...clean(j, available, fallback), sensitive: Boolean(j.sensitive) || sensitiveByWords(text), by: "claude" };
    } catch (e) {
      console.error("router claude", e.message);
    }
  }
  return { ...clean({ provider: fallback }, available, fallback), sensitive: sensitiveByWords(text), by: "rules" };
}

/** Is it sensitive? Jev's yes/no, else the words. */
export async function isSensitive({ text, guardrails, jevKey, fetchImpl }) {
  if (jevKey) {
    try {
      const a = await jevAsk({
        key: jevKey,
        state: String(text ?? "").slice(0, 20000),
        questions: { sensitive: { type: "noul", instructions: `The request would do any of: ${guardrails.join("; ")}` } },
        fetchImpl,
      });
      return Number(a.sensitive?.noul ?? 0) >= 0.5;
    } catch (e) {
      console.error("router guard", e.message);
    }
  }
  return sensitiveByWords(text);
}

/** Scores 0..4 for each team answer (Jev), or null when Jev can't. */
export async function judge({ task, answers, jevKey, fetchImpl }) {
  if (!jevKey || answers.length < 2) return null;
  try {
    const state = JSON.stringify({ task: String(task).slice(0, 6000), answers: answers.map((a) => ({ worker: a.provider, answer: String(a.text).slice(0, 6000) })) });
    const questions = Object.fromEntries(
      answers.map((a) => [
        `score_${a.provider}`,
        { type: "score", instructions: `How well the ${a.provider} answer does the task: correct, complete, useful`, criteria: ["Wrong or useless", "Weak", "OK", "Good", "Excellent"] },
      ]),
    );
    const r = await jevAsk({ key: jevKey, state, questions, fetchImpl });
    return Object.fromEntries(answers.map((a) => [a.provider, Number(r[`score_${a.provider}`]?.score ?? 2)]));
  } catch (e) {
    console.error("router judge", e.message);
    return null;
  }
}

/** Compare or split, for /team without a word: Jev, else the request's own words. */
export async function teamMode({ task, jevKey, fetchImpl }) {
  if (jevKey) {
    try {
      const r = await jevAsk({
        key: jevKey,
        state: String(task).slice(0, 20000),
        questions: {
          mode: {
            type: "choice",
            instructions: "How a team of models should take this request",
            criteria: { compare: "One answer is wanted; several models answering the same and picking the best helps", split: "It has clearly separate parts that different models can do at once" },
          },
        },
        fetchImpl,
      });
      if (r.mode?.choice === "split" || r.mode?.choice === "compare") return r.mode.choice;
    } catch (e) {
      console.error("router mode", e.message);
    }
  }
  return /\b(and then|parts?|steps?|each|both|1\.|- )/i.test(String(task)) ? "split" : "compare";
}
