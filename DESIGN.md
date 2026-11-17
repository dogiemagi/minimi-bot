# DESIGN

## The problem, as I read it
The example prompts ("what did I ask on 3 November?", "last Tuesday I asked about Postgres hosting, has pricing changed?") are not really search problems. They are **time and memory** problems that happen to end in a search. A good agent must (1) know exactly what *today* is, (2) know exactly what it said *then*, and (3) search for what changed *between*. Most chat agents fail at 1 and 2 and hide it with confident prose.

## How it works
`npm run dev` → Express + SSE → `agent.ts` loop → Anthropic (tool use) + Tavily (search).

1. **Clock injected every turn**, in the user's timezone (sent by the browser). The model never guesses the date.
2. **Memory is a store plus deterministic recall, not a tool.** Every turn (text, queries, sources, timestamp) is appended to a per-user JSON file. Before the model call, `recall()` runs:
   - parses date expressions in the message with chrono-node ("3 November", "last Tuesday", "on Monday") → exact local days, never in the future;
   - pulls every exchange from those days, with absolute timestamps, "N days ago", the answer I gave, and the sources used;
   - if a date resolves but nothing is stored, injects an explicit `NONE STORED` marker plus the nearest days that exist;
   - BM25 over past exchanges for topical references ("Postgres hosting") with a score threshold;
   - a one-line digest of recent sessions.
   The result is passed in a `<memory>` block. Zero extra round-trips, zero extra LLM calls, and the model can only "remember" what is literally in the block.
3. **One tool, `web_search`**, takes 1–4 queries that run in parallel, plus `since` / `recency` / `topic`. "Changed since X" becomes a date-filtered search, so results are post-baseline by construction. Results carry publication dates; undated results are flagged. Identical searches are cached for 10 minutes.
4. **Loop**: stream tokens immediately; at most 4 rounds, the final one forced to answer (`tool_choice: none`) so it can never end in a dangling tool call. Typical queries take one search round. The UI shows what is being searched while it runs. System prompt and tool schema use prompt caching; the volatile clock/memory block sits after the cached prefix.
5. **"Has X changed?" protocol** (in the system prompt): baseline claims from memory → date-filtered verification per item → per item "then → now → change", headline first, and "no evidence of change found" rather than "no change" when a search comes back empty.

## Why this way
- **Latency**: recall is local code (microseconds), searches are parallel, answers stream, one model call in the common case. No planner/critic/rewriter chain.
- **Correctness**: the failure modes that matter are fabricated memories and stale facts. Both are attacked structurally (NONE STORED marker, `since` filter, dated sources), not just by asking nicely.
- **Few moving parts**: JSON file store, two API keys, no database or vector service to run.

## Considered and rejected
- **Memory as a second tool** (`recall(query)`): costs a full model round-trip on exactly the queries where speed is felt, and lets the model skip it. Deterministic pre-fetch is faster and more reliable.
- **Vector embeddings for recall**: another key/service and latency; date resolution covers the dominant case and BM25 covers topical. Embeddings are the first thing I'd add for fuzzy references.
- **Anthropic's built-in server-side web search**: simplest, but no `since` filter, no control over parallel fan-out or caching, and opaque results I can't store as sources for later baselining.
- **Planner → searcher → writer multi-agent pipeline**: slower, more places to be wrong, no measurable gain on these questions.
- **LLM-extracted "memory facts" after every turn**: extra cost per turn and lossy; storing the answer and its sources verbatim keeps the baseline exact.

## Known limits / next week
- Per-user JSON file, in-process cache: fine for a demo, not multi-instance. → SQLite/Postgres.
- Recall is only as good as chrono's parsing; "end of last quarter" style ranges need a range resolver.
- Snippet-level evidence only; add a `fetch_page` step (rejected here by the one-tool rule) or Tavily extract for pricing pages, since prices live in tables snippets mangle.
- A **snapshot store**: save structured claims (product, price, plan, date) when answering, so "changed since" becomes a real diff rather than prose-vs-prose.
- Eval harness: a fixed set of time-travel prompts with seeded memory, scored on date accuracy, fabricated-memory rate, and time-to-first-token.
- Identity is a browser-generated id; real auth would replace it.
