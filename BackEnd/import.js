import { MongoClient } from "mongodb";
import fs from "fs";
import csv from "csv-parser";
import dotenv from "dotenv";

dotenv.config();
console.log("[import] start…");

const client = new MongoClient(process.env.MONGODB_URI);
const db = client.db("ChatGPT_Evaluation");

// 将 F 列的字母 -> 对应的选项文本（B~E列）
function letterToText(row, keys, letter) {
  const L = (letter || "").toString().trim().toUpperCase();
  const optionMap = {
    A: row[keys[1]], // B列
    B: row[keys[2]], // C列
    C: row[keys[3]], // D列
    D: row[keys[4]]  // E列
  };
  return (optionMap[L] || "").toString().trim();
}

async function importCSV(filePath, collectionName, domainName) {
  const docs = [];

  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (row) => {
        const keys = Object.keys(row);      // [Q, A, B, C, D, Letter]
        const question = (row[keys[0]] || "").toString().trim();
        const letter = (row[keys[5]] || "").toString().trim(); // 第6列：正确答案字母
        const expectedText = letterToText(row, keys, letter);

        if (question && expectedText) {
          docs.push({
            question,
            expected_answer: expectedText,   // ✅ 写入选项文本，而非字母
            chatgpt_response: "",            // 先留空，后续评测时再写
            domain: domainName
          });
        }
      })
      .on("end", () => resolve())
      .on("error", (e) => reject(e));
  });

  await client.connect();
  const coll = db.collection(collectionName);
  const result = await coll.insertMany(docs);
  console.log(`✅ Imported ${result.insertedCount} docs into ${collectionName}`);
}

(async () => {
  await importCSV("./prehistory_test.csv", "History", "History");
  await importCSV("./sociology_test.csv", "Social_Science", "Social_Science");
  await importCSV("./computer_security_test.csv", "Computer_Security", "Computer_Security");
  await client.close();
  console.log("🎉 done.");
})();
