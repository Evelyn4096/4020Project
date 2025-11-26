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


/* =======================
 * 1. Example Middleware
 * ======================= */
function validateAdd(req, res, next) {
  const a = Number(req.query.a);
  const b = Number(req.query.b);
  if (isNaN(a) || isNaN(b)) {
    return res.status(400).json({ error: "a and b must be valid numbers" });
  }
  next();
}

app.get("/api/add", validateAdd, (req, res) => {
  const a = Number(req.query.a);
  const b = Number(req.query.b);
  res.json({ result: a + b });
});

/* =======================
 * 2. MongoDB Setup
 * ======================= */
const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db("newChatGPT_Evaluation");

const domainCollections = {
  Computer_Security: db.collection("Computer_Security"),
  History: db.collection("History"),
  Social_Science: db.collection("Social_Science"),
};

/* =======================
 * 3. Gemini Setup
 * ======================= */
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

/* =======================
 * 4. Extract A/B/C/D
 * ======================= */
function extractLetter(text) {
  const m = text.trim().toUpperCase().match(/\b[A-D]\b/);
  return m ? m[0] : "";
}

/* =======================
 * 5. WebSocket
 * ======================= */
const wss = new WebSocketServer({ noServer: true });
const clients = new Set();

wss.on("connection", ws => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
});

function broadcast(msg) {
  for (let c of clients) {
    c.send(JSON.stringify(msg));
  }
}

/* ==============================
 * 6. Evaluation (Gemini only)
 * ============================== */
app.post("/api/evaluations/start", async (req, res) => {
  res.json({ status: "Evaluation started" });

  for (const [domain, col] of Object.entries(domainCollections)) {
    const docs = await col.find().toArray();
    console.log(`Evaluating domain: ${domain} (${docs.length} questions)`);

    for (let q of docs) {
      const prompt = `
You are answering a multiple-choice question. Choices:

A: ${q.choices.A}
B: ${q.choices.B}
C: ${q.choices.C}
D: ${q.choices.D}

Question: ${q.question}

IMPORTANT:
- Only answer with ONE letter: A, B, C, or D.
- No explanation.
      `.trim();

      const start = Date.now();

      let rawAnswer = "";
      try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        rawAnswer = await response.text();
      } catch (err) {
        console.error("Gemini API Error:", err);
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
});

/* =======================
 * 7. Analysis Endpoint
 * ======================= */
app.get("/api/analysis", async (req, res) => {
  const results = [];

  for (const [domain, col] of Object.entries(domainCollections)) {
    const docs = await col.find().toArray();
    if (!docs.length) continue;

    const correct = docs.filter(d =>
      d.chatgpt_response &&
      d.expected_answer &&
      d.chatgpt_response.trim().toUpperCase() ===
        d.expected_answer.trim().toUpperCase()
    ).length;

    const accuracy = correct / docs.length;

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

/* =======================
 * 8. Start Server
 * ======================= */
const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, "0.0.0.0",() =>
  console.log(`🚀 Server running on port ${PORT}`)
);

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy(); // ❗ 必须丢弃非 WS 请求
  }
});