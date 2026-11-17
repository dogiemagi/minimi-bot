import fs from "node:fs";
import path from "node:path";
import * as chrono from "chrono-node";

export interface Source { title: string; url: string; date?: string }
export interface Turn {
  id: string;
  sessionId: string;
  ts: number; // epoch ms
  role: "user" | "assistant";
  text: string;
  queries?: string[];
  sources?: Source[];
}

const DIR = path.resolve("data");
const cache = new Map<string, Turn[]>();

const safeId = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "anon";

function load(userId: string): Turn[] {
  const id = safeId(userId);
  let t = cache.get(id);
  if (!t) {
    try { t = JSON.parse(fs.readFileSync(path.join(DIR, id + ".json"), "utf8")); }
    catch { t = []; }
    cache.set(id, t!);
  }
  return t!;
}

export function append(userId: string, turn: Turn) {
  const turns = load(userId);
  turns.push(turn);
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, safeId(userId) + ".json");
  fs.writeFileSync(file + ".tmp", JSON.stringify(turns));
  fs.renameSync(file + ".tmp", file);
}

export const sessionTurns = (userId: string, sid: string) =>
  load(userId).filter((t) => t.sessionId === sid);

export function listSessions(userId: string) {
  const m = new Map<string, { id: string; title: string; ts: number }>();
  for (const t of load(userId)) {
    if (t.role === "user" && !m.has(t.sessionId)) m.set(t.sessionId, { id: t.sessionId, title: t.text.slice(0, 60), ts: t.ts });
  }
  return [...m.values()].sort((a, b) => b.ts - a.ts);
}

// ---------- time helpers ----------
export const dayKey = (ts: number, tz: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(ts);

export const fmtTime = (ts: number, tz: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(ts);

const daysAgo = (ts: number, now: number, tz: string) => {
  const a = Date.parse(dayKey(now, tz)), b = Date.parse(dayKey(ts, tz));
  const d = Math.round((a - b) / 86400000);
  return d === 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
};

/** Resolve date expressions ("3 November", "last Tuesday", "on Monday") to local day keys. Never in the future. */
export function resolveDates(text: string, now: number, tz: string): string[] {
  const out = new Set<string>();
  let results: chrono.ParsedResult[] = [];
  try { results = chrono.parse(text, { instant: new Date(now), timezone: tz }); } catch { return []; }
  for (const r of results) {
    const s = r.start;
    if (!s.isCertain("day") && !s.isCertain("weekday")) continue;
    // Build a UTC-noon date from the calendar parts (which are in `tz`), step back if in the future.
    let y = s.get("year")!, mo = s.get("month")!, d = s.get("day")!;
    let dt = new Date(Date.UTC(y, mo - 1, d, 12));
    const today = Date.parse(dayKey(now, tz));
    if (dt.getTime() > today) {
      dt = !s.isCertain("year") && s.isCertain("month") && s.isCertain("day") && !s.isCertain("weekday")
        ? new Date(Date.UTC(y - 1, mo - 1, d, 12))
        : new Date(dt.getTime() - 7 * 86400000);
    }
    if (dt.getTime() > today) continue;
    out.add(dt.toISOString().slice(0, 10));
  }
  return [...out];
}

// ---------- tiny BM25 over past turns ----------
const STOP = new Set("the a an and or of to in on for with is are was were be it this that i you we they my our your what when where how did do does has have had since about me ask asked tell any anything changed change still correct answer today yesterday last week month ago earlier before".split(" "));
const tok = (s: string) => (s.toLowerCase().match(/[a-z0-9][a-z0-9+#.-]*/g) ?? []).filter((w) => w.length > 1 && !STOP.has(w));

function bm25(docs: string[][], q: string[]): number[] {
  const N = docs.length || 1, avg = docs.reduce((a, d) => a + d.length, 0) / N || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
  return docs.map((d) => {
    const tf = new Map<string, number>();
    for (const w of d) tf.set(w, (tf.get(w) ?? 0) + 1);
    let s = 0;
    for (const w of new Set(q)) {
      const f = tf.get(w); if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5));
      s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.length / avg));
    }
    return s;
  });
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

function renderPair(u: Turn, a: Turn | undefined, now: number, tz: string) {
  let s = `[${fmtTime(u.ts, tz)} (${daysAgo(u.ts, now, tz)}) · session ${u.sessionId.slice(0, 6)}]\nUSER: ${clip(u.text, 500)}`;
  if (a) {
    s += `\nYOU ANSWERED: ${clip(a.text, 900)}`;
    const src = (a.sources ?? []).slice(0, 4).map((x) => `${x.title} <${x.url}>${x.date ? " (" + x.date + ")" : ""}`);
    if (src.length) s += `\nSOURCES USED: ${src.join("; ")}`;
  }
  return s;
}

/**
 * Deterministic recall, run BEFORE the model call (no tool round-trip):
 *  1. explicit dates in the message -> every exchange from those days
 *  2. BM25 over past exchanges for topical references ("Postgres hosting")
 *  3. one-line digest of recent sessions
 */
export function recall(userId: string, message: string, now: number, tz: string, currentSid: string): string {
  const all = load(userId);
  const pairs: { u: Turn; a?: Turn }[] = [];
  for (let i = 0; i < all.length; i++) {
    if (all[i].role !== "user") continue;
    const a = all[i + 1]?.role === "assistant" && all[i + 1].sessionId === all[i].sessionId ? all[i + 1] : undefined;
    pairs.push({ u: all[i], a });
  }
  const past = pairs.filter((p) => p.u.sessionId !== currentSid);
  const parts: string[] = [];
  const seen = new Set<string>();

  const dates = resolveDates(message, now, tz);
  for (const dk of dates) {
    const hit = pairs.filter((p) => dayKey(p.u.ts, tz) === dk && p.u.sessionId !== currentSid);
    if (hit.length) {
      parts.push(`## Conversations on ${dk}\n` + hit.slice(0, 8).map((p) => { seen.add(p.u.id); return renderPair(p.u, p.a, now, tz); }).join("\n\n"));
    } else {
      const days = [...new Set(past.map((p) => dayKey(p.u.ts, tz)))].sort();
      parts.push(`## Conversations on ${dk}\nNONE STORED. You have no record of any conversation on that day. Days with records: ${days.slice(-10).join(", ") || "(none at all)"}.`);
    }
  }

  const q = tok(message);
  if (q.length && past.length) {
    const scores = bm25(past.map((p) => tok(p.u.text + " " + (p.a?.text ?? ""))), q);
    const top = past.map((p, i) => ({ p, s: scores[i] })).filter((x) => x.s > 1.5 && !seen.has(x.p.u.id))
      .sort((a, b) => b.s - a.s).slice(0, 3);
    if (top.length) parts.push(`## Possibly related earlier exchanges\n` + top.map((x) => renderPair(x.p.u, x.p.a, now, tz)).join("\n\n"));
  }

  const sess = listSessions(userId).filter((s) => s.id !== currentSid).slice(0, 8);
  if (sess.length) parts.push(`## Recent sessions (digest)\n` + sess.map((s) => `- ${fmtTime(s.ts, tz)}: "${s.title}"`).join("\n"));

  return parts.length ? parts.join("\n\n") : "No earlier conversations are stored for this user.";
}
