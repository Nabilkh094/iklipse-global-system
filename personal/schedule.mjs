// Nabil's own scheduled requests in his group (/schedule): a worker does them
// at their time, on his subscriptions, and the answer comes to him here. For
// him only: anything whose result is for the team goes to the company bot as
// a scheduled task there (/bot "every Sunday at 10 ..."), on its API key.

const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The wall clock in a zone at a moment: { date: "YYYY-MM-DD", dow, hm: "HH:MM" }. */
function wall(zone, ms) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, dow: NAMES.indexOf(p.weekday), hm: `${p.hour}:${p.minute}` };
}

/** The moment a day and time there is (the zone's offset that day). */
function at(zone, date, hm) {
  const guess = Date.parse(`${date}T${hm}:00Z`);
  const w = wall(zone, guess);
  const off = Date.parse(`${w.date}T${w.hm}:00Z`) - guess;
  return guess - off;
}

/** The next time after `after`: every day, working days (Sun to Thu) or some weekdays, at HH:MM. */
export function nextAt(s, after = Date.now()) {
  if (!/^\d{2}:\d{2}$/.test(s.at)) return null;
  for (let i = 0; i < 8; i++) {
    const w = wall(s.zone, after + i * 86_400_000);
    const ok = s.days === "day" || (s.days === "weekdays" && w.dow <= 4) || (Array.isArray(s.days) && s.days.includes(w.dow));
    if (!ok) continue;
    const t = at(s.zone, w.date, s.at);
    if (t > after) return t;
  }
  return null;
}

/**
 * "/schedule every day 09:00 summarize my mail", "/schedule weekdays 08:30 ...",
 * "/schedule sun,wed 10:00 ...", "/schedule list", "/schedule off 2".
 */
export function parseSchedule(arg) {
  const a = String(arg ?? "").trim();
  if (!a || /^list$/i.test(a)) return { op: "list" };
  const off = /^(off|stop|remove)\s+(\d+)$/i.exec(a);
  if (off) return { op: "off", n: Number(off[2]) };
  const m = /^(?:every\s+)?(day|daily|weekdays|working days|[a-z]{3}(?:\s*,\s*[a-z]{3})*)\s+(\d{1,2}):(\d{2})\s+([\s\S]+)$/i.exec(a);
  if (!m) return { op: "help" };
  const d = m[1].toLowerCase();
  let days;
  if (d === "day" || d === "daily") days = "day";
  else if (d === "weekdays" || d === "working days") days = "weekdays";
  else {
    days = d.split(",").map((x) => DAYS[x.trim()]);
    if (days.some((x) => x === undefined)) return { op: "help" };
  }
  const h = Number(m[2]);
  const min = Number(m[3]);
  if (h > 23 || min > 59) return { op: "help" };
  return { op: "add", days, at: `${String(h).padStart(2, "0")}:${m[3]}`, text: m[4].trim() };
}

/** "every day at 09:00", "Sun, Wed at 10:00". */
export function sayDays(s) {
  const d = s.days === "day" ? "every day" : s.days === "weekdays" ? "working days (Sun to Thu)" : s.days.map((x) => NAMES[x]).join(", ");
  return `${d} at ${s.at}`;
}
