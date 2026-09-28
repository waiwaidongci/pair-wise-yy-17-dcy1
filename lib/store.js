const fs = require('fs/promises');
const path = require('path');

// 存储层：只负责 data/db.json 的读写，不含任何业务判定。
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'db.json');

async function readDb() {
  const raw = await fs.readFile(DB_FILE, 'utf8');
  return JSON.parse(raw);
}

async function writeDb(db) {
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2) + '\n');
}

module.exports = { DB_FILE, readDb, writeDb };
