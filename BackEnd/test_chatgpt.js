import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

// Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// MongoDB
const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db("newChatGPT_Evaluation");

const domainCollections = {
  Computer_Security: db.collection("Computer_Security"),
  History: db.collection("History"),
  Social_Science: db.collection("Social_Science"),
};

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ====== 随机挑选 1 条，你也可以改成 20 条 ======
function pick1(arr) {
  return arr.sort(() => Math.random() - 0.5).slice(0, 1);
  // 前 20 条：return arr.slice(0, 20);
}

async function testGemini() {
  console.log("=== Gemini Evaluation Started ===");

  const perRequestDelay = 6000; // 6 秒，每分钟 10 条以内（安全）

  for (const [domain, col] of Object.entries(domainCollections)) {
    const docs = await col.find().toArray();
    const selected = pick1(docs);

    console.log(`\n📘 Domain: ${domain}`);
    console.log(`➡️ Selected ${selected.length} question(s)`);

    for (let q of selected) {
      const prompt = `
Answer a multiple-choice question. Choices:

A: ${q.choices.A}
B: ${q.choices.B}
C: ${q.choices.C}
D: ${q.choices.D}

Question: ${q.question}

RULES:
- Reply with ONLY one letter (A/B/C/D)
- No explanation
      `.trim();

      try {
        const start = Date.now();

        // ⭐ Streaming API
        const stream = await model.generateContentStream(prompt);

        let fullText = "";
        for await (const chunk of stream.stream) {
          fullText += chunk.text();
        }

        const ms = Date.now() - start;

        console.log(`\n——————————————`);
        console.log(`📝 Question: ${q.question}`);
        console.log(`🤖 Gemini Answer: ${fullText}`);
        console.log(`⏱️ Time: ${ms} ms`);

      } catch (err) {
        console.error("❌ Gemini Error:", err.message);
      }

      await sleep(perRequestDelay);
    }
  }

  console.log("\n=== Evaluation Finished ===");
}

testGemini();
