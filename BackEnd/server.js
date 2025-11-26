/**
 * ============================================================
 * ChatGPT Evaluation Backend (Express + WebSocket + MongoDB)
 * Course Project – Interactive Website + AI Evaluation
 * Implemented Requirements:
 *   ✔ Client-side middleware example: /api/add?a=2&b=3
 *   ✔ WebSocket real-time status updates
 *   ✔ ChatGPT evaluation pipeline
 *   ✔ MongoDB storage for 3 domains
 *   ✔ /api/analysis endpoint for Chart.js visualization
 *   ✔ Clean, well-organized backend for demonstration
 * ============================================================
 */

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import { WebSocketServer } from "ws";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

/* ============================================================
 * 1. Example Middleware Route (Assignment MUST-HAVE)
 * ============================================================
 */

// middleware - validate query parameters
function validateAdd(req, res, next) {
  const a = Number(req.query.a);
  const b = Number(req.query.b);

  if (isNaN(a) || isNaN(b)) {
    return res.status(400).json({ error: "a and b must be valid numbers" });
  }
  next();
}

// GET /api/add?a=2&b=3 → { result: 5 }
app.get("/api/add", validateAdd, (req, res) => {
  const a = Number(req.query.a);
  const b = Number(req.query.b);
  res.json({ result: a + b });
});

/* ============================================================
 * 2. MongoDB Setup
 * ============================================================
 */

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db("newChatGPT_Evaluation");

// Collections for 3 domains
const domainCollections = {
  Computer_Security: db.collection("Computer_Security"),
  History: db.collection("History"),
  Social_Science: db.collection("Social_Science"),
};

/* ============================================================
 * 3. Helper: Extract A/B/C/D letter from GPT output
 * ============================================================
 */
function extractLetter(text) {
  const m = text.trim().toUpperCase().match(/[ABCD]/);
  return m ? m[0] : "";
}

/* ============================================================
 * 4. OpenAI Setup
 * ============================================================
 */

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ============================================================
 * 5. WebSocket Setup (Real-Time Evaluation Updates)
 * ============================================================
 */

const wss = new WebSocketServer({ noServer: true });
const clients = new Set();

wss.on("connection", ws => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
});

// broadcast results to all connected clients
function broadcast(msg) {
  for (let c of clients) {
    c.send(JSON.stringify(msg));
  }
}

/* ============================================================
 * 6. ChatGPT Evaluation Logic
 * Endpoint: POST /api/evaluations/start
 * ============================================================
 */

app.post("/api/evaluations/start", async (req, res) => {
  // respond immediately (frontend can see "started")
  res.json({ status: "Evaluation started" });

  // evaluate domain by domain
  for (const [domain, col] of Object.entries(domainCollections)) {
    const docs = await col.find().toArray();
    console.log(`Evaluating domain: ${domain} (${docs.length} questions)`);

    for (let q of docs) {
      const start = Date.now();

      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: `
You are answering a multiple-choice question. Choices:

A: ${q.choices.A}
B: ${q.choices.B}
C: ${q.choices.C}
D: ${q.choices.D}

Question: ${q.question}

IMPORTANT:
- Only answer with ONE letter: A, B, C, or D.
- No explanation.
            `,
          },
        ],
      });

      const end = Date.now();
      const responseTime = end - start;

      const rawAnswer = completion.choices[0].message.content;
      const letter = extractLetter(rawAnswer);

      // update MongoDB
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

      // send real-time WS update
      broadcast({
        domain,
        question: q.question,
        answer: letter,
        responseTime,
      });
    }
  }

  // notify frontend evaluation is fully completed
  broadcast({ status: "done" });
});

/* ============================================================
 * 7. Analysis Endpoint (For Chart.js Graphs)
 * ============================================================
 */

app.get("/api/analysis", async (req, res) => {
  const results = [];

  for (const [domain, col] of Object.entries(domainCollections)) {
    const docs = await col.find().toArray();
    if (!docs.length) continue;

    // compute accuracy
    const correct = docs.filter(d =>
      d.chatgpt_response &&
      d.expected_answer &&
      d.chatgpt_response.trim().toUpperCase() ===
        d.expected_answer.trim().toUpperCase()
    ).length;

    const accuracy = correct / docs.length;

    // compute avg response time
    const avgResponseTime =
      docs.reduce((sum, d) => sum + (d.responseTime || 0), 0) /
      docs.length;

    results.push({
      domain,
      count: docs.length,
      accuracy,
      avgResponseTime,
    });
  }

  res.json(results);
});

/* ============================================================
 * 8. Start Server + WebSocket Upgrade
 * ============================================================
 */

const server = app.listen(3000, () =>
  console.log("Server running on http://localhost:3000")
);

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit("connection", ws, req);
  });
});
