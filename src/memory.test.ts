import assert from "node:assert/strict";
import { resolveDates, dayKey } from "./memory.js";

// "Now" = Tue 17 Nov 2026, noon UTC
const now = Date.parse("2026-11-17T12:00:00Z");
const tz = "UTC";
assert.deepEqual(resolveDates("What did I ask you on 3 November?", now, tz), ["2026-11-03"]);
assert.deepEqual(resolveDates("Last Tuesday I asked about Postgres", now, tz), ["2026-11-10"]);
assert.deepEqual(resolveDates("On Monday we shortlisted 5 CRM tools", now, tz), ["2026-11-16"]);
assert.deepEqual(resolveDates("what's the weather like", now, tz), []);
assert.equal(dayKey(now, "Asia/Kolkata"), "2026-11-17");
console.log("ok");
