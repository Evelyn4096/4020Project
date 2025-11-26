import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import { WebSocketServer } from "ws";
import { GoogleGenerativeAI } from "@google/generative-ai";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

//middleware
app.get("/api/add", (req, res) => {
  const a = Number(req.query.a);
  const b = Number(req.query.b);
  if (isNaN(a) || isNaN(b)) {
    return res.status(400).json({ error: "Invalid numbers" });
  }
  res.json({ result: a + b });
});

/* ======================================
 * GLOBAL EVALUATION CONTROL FLAGS
 * ====================================== */
let evaluationPaused = false;
let evaluationStopped = false;
let isRunning = false;

/* =======================
 * MongoDB Setup
 * ======================= */
const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db("newChatGPT_Evaluation");

const domainCollections = {
  Computer_Security: db.collection("Computer_Security"),
  History: db.collection("History"),
  Social_Science: db.collection("Social_Science"),
};

/* ======================================
 * Reset / Pause / Resume — MUST appear
 * AFTER domainCollections declaration
 * ====================================== */

// Pause
app.post("/api/evaluations/pause", (req, res) => {
  evaluationPaused = true;
  res.json({ status: "paused" });
});

// Resume
app.post("/api/evaluations/resume", (req, res) => {
  evaluationPaused = false;
  res.json({ status: "resumed" });
});

// Reset = stop evaluation + signal front-end to clear log
app.post("/api/evaluations/reset", async (req, res) => {
  evaluationStopped = true;
  evaluationPaused = false;
  isRunning = false;

  // 通知前端清空 log
  broadcast({ status: "reset" });

  res.json({ status: "reset-complete" });
});
/* =======================
 * Gemini Setup
 * ======================= */
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

function extractLetter(text) {
  const m = text.trim().toUpperCase().match(/\b[A-D]\b/);
  return m ? m[0] : "";
}

/* =======================
 * WebSocket Setup
 * ======================= */
const wss = new WebSocketServer({ noServer: true });
const clients = new Set();

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
});

function broadcast(msg) {
  for (let c of clients) {
    c.send(JSON.stringify(msg));
  }
}

/* ======================================
 * Start Evaluation
 * ====================================== */
app.post("/api/evaluations/start", async (req, res) => {
  if (isRunning) return res.json({ status: "already-running" });

  isRunning = true;
  evaluationStopped = false;

  res.json({ status: "Evaluation started" });

  for (const [domain, col] of Object.entries(domainCollections)) {
    const docs = await col.find().toArray();

    for (let q of docs) {
      if (evaluationStopped) {
        broadcast({ status: "stopped" });
        isRunning = false;
        return;
      }

      while (evaluationPaused) {
        await new Promise((r) => setTimeout(r, 300));
      }

      // Ask Gemini
      const prompt = `
A: ${q.choices.A}
B: ${q.choices.B}
C: ${q.choices.C}
D: ${q.choices.D}

Question: ${q.question}

Answer with exactly one letter (A-D). No explanation.
`.trim();

      const start = Date.now();

      let rawAnswer = "";
      try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        rawAnswer = await response.text();
      } catch (e) {
        rawAnswer = "(error)";
      }

      const end = Date.now();
      const responseTime = end - start;
      const letter = extractLetter(rawAnswer);

      await col.updateOne(
        { _id: q._id },
        {
          $set: {
            chatgpt_response: letter,
            raw_gpt_text: rawAnswer,
            responseTime,
            evaluatedAt: new Date(),
          },
        }
      );

      broadcast({
        domain,
        question: q.question,
        answer: letter,
        responseTime,
      });
    }
  }

  broadcast({ status: "done" });
  isRunning = false;
});

/* ======================================
 * Quick Evaluation (50 per domain)
 * ====================================== */
app.post("/api/evaluations/quick", async (req, res) => {
  if (isRunning) return res.json({ status: "already-running" });

  isRunning = true;
  evaluationStopped = false;

  res.json({ status: "Quick Evaluation started" });

  for (const [domain, col] of Object.entries(domainCollections)) {
    // Pick random 50 documents
    const docs = await col.aggregate([{ $sample: { size: 50 } }]).toArray();

    broadcast({ status: "domain-start", domain, count: docs.length });

    for (let q of docs) {
      if (evaluationStopped) {
        broadcast({ status: "stopped" });
        isRunning = false;
        return;
      }

      while (evaluationPaused) {
        await new Promise((r) => setTimeout(r, 250));
      }

      // Ask Gemini
      const prompt = `
A: ${q.choices.A}
B: ${q.choices.B}
C: ${q.choices.C}
D: ${q.choices.D}

Question: ${q.question}

Answer with exactly one letter (A-D). No explanation.
      `.trim();

      const start = Date.now();

      let rawAnswer = "";
      try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        rawAnswer = await response.text();
      } catch (e) {
        rawAnswer = "(error)";
      }

      const end = Date.now();
      const responseTime = end - start;
      const letter = extractLetter(rawAnswer);

      // Update database
      await col.updateOne(
        { _id: q._id },
        {
          $set: {
            chatgpt_response: letter,
            raw_gpt_text: rawAnswer,
            responseTime,
            evaluatedAt: new Date(),
          },
        }
      );

      broadcast({
        domain,
        question: q.question,
        answer: letter,
        responseTime,
      });
    }
  }

  broadcast({ status: "quick-done" });
  isRunning = false;
});


/* =======================
 * Analysis Endpoint
 * ======================= */
app.get("/api/analysis", async (req, res) => {
  const results = [];

  for (const [domain, col] of Object.entries(domainCollections)) {
    const docs = await col.find().toArray();
    if (!docs.length) continue;

    const correct = docs.filter(
      (d) =>
        d.chatgpt_response &&
        d.expected_answer &&
        d.chatgpt_response.toUpperCase() === d.expected_answer.toUpperCase()
    ).length;

    results.push({
      domain,
      count: docs.length,
      accuracy: correct / docs.length,
      avgResponseTime:
        docs.reduce((s, d) => s + (d.responseTime || 0), 0) / docs.length,
    });
  }

  res.json(results);
});

/* =======================
 * Start Server
 * ======================= */
const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Server running on port ${PORT}`)
);

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});
