import express from "express";
import cors from "cors";
import { MongoClient } from "mongodb";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// --- MongoDB ---
const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db("newChatGPT_Evaluation");

// 三个 domain 的 collection
const domainCollections = {
  Computer_Security: db.collection("Computer_Security"),
  History: db.collection("History"),
  Social_Science: db.collection("Social_Science"),
};

// --- Analysis (accuracy + response time) ---
app.get("/api/analysis", async (req, res) => {
  const results = [];

  for (const [domain, col] of Object.entries(domainCollections)) {
    const docs = await col.find().toArray();
    if (docs.length === 0) continue;

    // Accuracy
    let correct = 0;
    for (let d of docs) {
      if (
        d.chatgpt_response &&
        d.expected_answer &&
        d.chatgpt_response.trim().toLowerCase() ===
          d.expected_answer.trim().toLowerCase()
      ) {
        correct++;
      }
    }
    const accuracy = correct / docs.length;

    // Average response time
    const avgTime =
      docs.reduce((sum, d) => sum + (d.responseTime || 0), 0) /
      docs.length;

    results.push({
      domain,
      count: docs.length,
      accuracy,
      avgResponseTime: avgTime,
    });
  }

  res.json(results);
});

// --- OpenAI ---
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// --- WebSocket ---
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

// --- validator ---
function validateQuery(req, res, next) {
  if (!req.body.question) {
    return res.status(400).json({ error: "Question field required." });
  }
  next();
}

// --- ROUTES ---

// 获取全部 domain 的题目
app.get("/api/questions", async (req, res) => {
  const results = [];
  for (const [domain, col] of Object.entries(domainCollections)) {
    const docs = await col.find().toArray();
    results.push({ domain, questions: docs });
  }
  res.json(results);
});

// （选用）新增题目 → 默认加到 Computer_Security 中
app.post("/api/questions", validateQuery, async (req, res) => {
  const col = domainCollections.Computer_Security;
  const insert = await col.insertOne({
    question: req.body.question,
    expected_answer: req.body.expected_answer || "",
    chatgpt_response: "",
    createdAt: new Date(),
  });

  res.json({ success: true, id: insert.insertedId });
});

// --- 主功能：一次跑所有 domain ---
app.post("/api/evaluations/start", async (req, res) => {
  res.json({ status: "Evaluation started" });

  for (const [domain, col] of Object.entries(domainCollections)) {
    const questions = await col.find().toArray();
    console.log(`Evaluating domain: ${domain} (${questions.length} questions)`);

    for (let q of questions) {
      const start = Date.now();

      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: q.question }],
      });

      const end = Date.now();
      const ms = end - start;

      await col.updateOne(
        { _id: q._id },
        {
          $set: {
            chatgpt_response:
              response.choices[0].message.content,
            responseTime: ms,
            evaluatedAt: new Date(),
          },
        }
      );

      broadcast({
        domain,
        question: q.question,
        responseTime: ms,
      });
    }
  }

  broadcast({ done: true });
});

// --- 获取结果 ---
app.get("/api/results", async (req, res) => {
  const results = [];
  for (const [domain, col] of Object.entries(domainCollections)) {
    const docs = await col.find().toArray();
    results.push({ domain, items: docs });
  }
  res.json(results);
});

// --- WebSocket upgrade ---
const server = app.listen(3000, () =>
  console.log("Server running on http://localhost:3000")
);

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});
