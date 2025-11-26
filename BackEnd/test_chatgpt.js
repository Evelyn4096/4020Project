import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function testGemini() {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const prompt = "Tell me a short motivational quote.";

    const result = await model.generateContent(prompt);
    const response = result.response;
    const text = await response.text();

    console.log("✅ Gemini Response:");
    console.log(text);
  } catch (err) {
    console.error("❌ Gemini API Error:", err.message);
  }
}

testGemini();