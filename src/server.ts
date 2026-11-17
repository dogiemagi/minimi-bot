import "dotenv/config";
import express from "express";
import { chat } from "./agent.js";
import { listSessions, sessionTurns } from "./memory.js";

for (const k of ["ANTHROPIC_API_KEY", "TAVILY_API_KEY"]) {
  if (!process.env[k]) { console.error(`Missing ${k}. Copy .env.example to .env and fill it in.`); process.exit(1); }
}

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use(express.static("public"));

app.get("/api/sessions", (req, res) => res.json(listSessions(String(req.query.userId ?? ""))));
app.get("/api/history", (req, res) => res.json(sessionTurns(String(req.query.userId ?? ""), String(req.query.sessionId ?? ""))));

app.post("/api/chat", async (req, res) => {
  const { userId, sessionId, message, tz } = req.body ?? {};
  if (!userId || !sessionId || typeof message !== "string" || !message.trim()) return res.status(400).json({ error: "bad request" });
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ac.abort(); });
  const emit = (e: object) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  try {
    await chat({ userId, sessionId, message: message.trim().slice(0, 8000), tz: tz || "UTC", emit, signal: ac.signal });
    emit({ type: "done" });
  } catch (e: any) {
    if (!ac.signal.aborted) { console.error(e); emit({ type: "error", message: e?.message ?? "failed" }); }
  }
  res.end();
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`http://localhost:${port}`));
