import { MongoClient } from "mongodb";
import fs from "fs";
import csv from "csv-parser";
import dotenv from "dotenv";

dotenv.config();
console.log("[import] start…");

const client = new MongoClient(process.env.MONGODB_URI);
const db = client.db("newChatGPT_Evaluation");

// 将 CSV 导入对应 collection
async function importCSV(filePath, collectionName, domainName) {
  const docs = [];

  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (row) => {
        const keys = Object.keys(row);   
        // 假设 CSV 列顺序为：
        // Q | A | B | C | D | Letter
        const question = (row[keys[0]] || "").trim();
        const A = (row[keys[1]] || "").trim();
        const B = (row[keys[2]] || "").trim();
        const C = (row[keys[3]] || "").trim();
        const D = (row[keys[4]] || "").trim();
        const letter = (row[keys[5]] || "").trim().toUpperCase(); // A/B/C/D

        if (!question || !letter) return;

        docs.push({
          question,
          choices: {
            A,
            B,
            C,
            D
          },
          expected_answer: letter,  // ❗只存字母
          chatgpt_response: "",
          domain: domainName,
        });
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
