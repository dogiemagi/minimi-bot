import type { Source } from "./memory.js";

export interface SearchArgs {
  queries: string[];
  recency?: "day" | "week" | "month" | "year";
  since?: string; // YYYY-MM-DD
  topic?: "general" | "news";
}

export const SEARCH_TOOL = {
  name: "web_search",
  description:
    "Search the live web. Pass 1-4 DISTINCT queries in ONE call; they run in parallel. " +
    "Use `since` (YYYY-MM-DD) when checking what changed after a known date. Results carry publication dates when available.",
  input_schema: {
    type: "object" as const,
    properties: {
      queries: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 4, description: "Distinct search queries, each a different angle (e.g. one per product)." },
      recency: { type: "string", enum: ["day", "week", "month", "year"], description: "Only results from this window. Omit for no restriction." },
      since: { type: "string", description: "Only results published on/after this date, YYYY-MM-DD. Overrides recency." },
      topic: { type: "string", enum: ["general", "news"], description: "'news' for announcements/launches/events." },
    },
    required: ["queries"],
  },
};

const cache = new Map<string, { at: number; v: unknown }>();
const TTL = 10 * 60_000;

async function one(q: string, a: SearchArgs, signal?: AbortSignal) {
  const key = JSON.stringify([q, a.recency, a.since, a.topic]);
  const c = cache.get(key);
  if (c && Date.now() - c.at < TTL) return c.v as any[];
  const body: Record<string, unknown> = {
    query: q, max_results: 5, search_depth: "basic", topic: a.topic ?? "general",
  };
  if (a.since && /^\d{4}-\d{2}-\d{2}$/.test(a.since)) body.start_date = a.since;
  else if (a.recency) body.time_range = a.recency;
  const r = await fetch("https://api.tavily.com/search", {
    method: "POST", signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`search ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const v = ((await r.json()) as any).results ?? [];
  cache.set(key, { at: Date.now(), v });
  return v as any[];
}

export async function runSearch(a: SearchArgs, signal?: AbortSignal): Promise<{ text: string; sources: Source[] }> {
  const queries = (a.queries ?? []).slice(0, 4);
  const settled = await Promise.allSettled(queries.map((q) => one(q, a, signal)));
  const seen = new Set<string>();
  const sources: Source[] = [];
  const blocks = settled.map((s, i) => {
    if (s.status === "rejected") return `### "${queries[i]}"\nSEARCH FAILED: ${s.reason?.message ?? s.reason}`;
    const items = s.value.filter((x: any) => x.url && !seen.has(x.url)).map((x: any) => {
      seen.add(x.url);
      const date = x.published_date ? String(x.published_date).slice(0, 10) : undefined;
      sources.push({ title: x.title, url: x.url, date });
      return `- ${x.title} <${x.url}>${date ? ` [published ${date}]` : " [no date]"}\n  ${String(x.content ?? "").replace(/\s+/g, " ").slice(0, 600)}`;
    });
    return `### "${queries[i]}"\n${items.join("\n") || "(no results)"}`;
  });
  return { text: blocks.join("\n\n"), sources };
}
