// What every run used and cost, the faults, and the spend limits checked
// against them. Day and week are the last 24 hours and the last 7 days.

const HOUR = 3600 * 1000;
export const PERIODS = { day: 24 * HOUR, week: 7 * 24 * HOUR, month: 30 * 24 * HOUR };
const KEEP = 5000;

/** One run, kept: {at, provider, ok, cost, tokens, error, kind}. */
export function record(log, { provider, ok, cost, usage, error, at = Date.now() }) {
  log.push({
    at,
    provider,
    ok: Boolean(ok),
    cost: typeof cost === "number" ? cost : null,
    tokens: usage ? (usage.in ?? 0) + (usage.out ?? 0) : null,
    ...(ok ? {} : { error: String(error ?? "").slice(0, 300), kind: faultKind(error) }),
  });
  if (log.length > KEEP) log.splice(0, log.length - KEEP);
}

/** What kind of fault a failure is, from what the CLI or API said. */
export function faultKind(error) {
  const e = String(error ?? "").toLowerCase();
  if (/not signed in|isn.t signed in|sign in|not logged in|log ?in|unauthori[sz]ed|401|auth|expired|credential/.test(e)) return "signed out";
  if (/limit|quota|429|rate|credit|balance|too many/.test(e)) return "limit reached";
  if (/too long|timed? ?out|timeout|sigterm/.test(e)) return "timed out";
  if (/installed|enoent|not found/.test(e)) return "not installed";
  if (/5\d\d|unavailable|overloaded|econn|network|fetch failed|down/.test(e)) return "down";
  if (/\/stop|stopped/.test(e)) return "stopped";
  return "error";
}

/** Dollars, tokens, runs and faults for one provider over a period. */
export function spent(log, provider, period, now = Date.now()) {
  const from = now - PERIODS[period];
  const out = { usd: 0, tokens: 0, runs: 0, faults: 0 };
  for (const r of log) {
    if (r.provider !== provider || r.at < from) continue;
    out.runs++;
    if (!r.ok) out.faults++;
    if (r.cost) out.usd += r.cost;
    if (r.tokens) out.tokens += r.tokens;
  }
  return out;
}

/** How far a limit is used, 0..1+. */
const used = (amount, s) => (amount.usd != null ? (amount.usd > 0 ? s.usd / amount.usd : 1) : amount.tokens > 0 ? s.tokens / amount.tokens : 1);

/**
 * A provider against its limits: {level: "ok" | "warn" | "over" | "paused", period, share}.
 * warn from 80%, over at 100%.
 */
export function limitState(settings, log, provider, now = Date.now()) {
  if (settings.paused?.includes(provider)) return { level: "paused" };
  let worst = { level: "ok", share: 0 };
  for (const period of ["day", "week"]) {
    const amount = settings.limits?.[provider]?.[period];
    if (!amount) continue;
    const share = used(amount, spent(log, provider, period, now));
    if (share > worst.share) worst = { level: share >= 1 ? "over" : share >= 0.8 ? "warn" : "ok", period, share };
  }
  return worst;
}

const money = (n) => `$${n.toFixed(2)}`;
const toks = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

/** /usage: each provider for the day, the week and the month. */
export function usageReport(log, labels, settings, now = Date.now()) {
  const lines = ["*Usage* (last 24h · 7 days · 30 days)"];
  for (const [p, label] of Object.entries(labels)) {
    const cells = ["day", "week", "month"].map((period) => {
      const s = spent(log, p, period, now);
      return s.runs ? `${s.usd ? money(s.usd) : ""}${s.usd && s.tokens ? " / " : ""}${s.tokens ? toks(s.tokens) : ""}${!s.usd && !s.tokens ? `${s.runs} runs` : ""}` : "-";
    });
    const lim = limitState(settings, log, p, now);
    const flag = lim.level === "paused" ? " · PAUSED" : lim.level === "over" ? ` · OVER ${lim.period} limit` : lim.level === "warn" ? ` · ${Math.round(lim.share * 100)}% of ${lim.period} limit` : "";
    lines.push(`${label}: ${cells.join(" · ")}${flag}`);
  }
  lines.push("", "Claude: what the runs would cost on the API (nothing is charged on the subscription, but it is what uses up its limits). GPT, Grok: tokens.");
  return lines.join("\n");
}

/** /faults: the last ones, newest first. */
export function faultsReport(log, labels, n = 10) {
  const f = log.filter((r) => !r.ok && r.kind !== "stopped").slice(-n).reverse();
  if (!f.length) return "No faults.";
  return ["*Last faults*", ...f.map((r) => `${new Date(r.at).toISOString().slice(5, 16).replace("T", " ")} ${labels[r.provider] ?? r.provider}: ${r.kind}${r.error ? ` (${r.error.slice(0, 120)})` : ""}`)].join("\n");
}
