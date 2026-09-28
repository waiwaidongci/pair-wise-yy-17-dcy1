/**
 * 存储层：只管 data/db.json 的读写，不包含任何样本链判定。
 * 通过进程内互斥链保证多个 HTTP 请求之间写不串。
 */
const fs = require('fs/promises');
const path = require('path');

const DB_FILE = process.env.CHAIN_DB_FILE
  ? path.resolve(process.env.CHAIN_DB_FILE)
  : path.join(__dirname, '..', 'data', 'db.json');

let chain = Promise.resolve();

function serialize(task) {
  const run = chain.then(task, task);
  // 无论成败都释放锁，避免一次写坏后整个服务卡死
  chain = run.then(() => undefined, () => undefined);
  return run;
}

async function readDb() {
  const raw = await fs.readFile(DB_FILE, 'utf8');
  const db = JSON.parse(raw);
  db.samples = db.samples || [];
  db.receipts = db.receipts || [];
  return db;
}

async function writeDb(db) {
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2) + '\n');
}

/** 读取快照（不排序，由调用方决定排序） */
async function snapshot() {
  return serialize(readDb);
}

/**
 * 变更事务：mutator(db) 返回结果；对 db 内对象的修改会被落盘。
 * mutator 抛错则不落盘并向外抛出。
 */
async function mutate(mutator) {
  return serialize(async () => {
    const db = await readDb();
    const result = await mutator(db);
    await writeDb(db);
    return result;
  });
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}

module.exports = { DB_FILE, snapshot, mutate, nowIso, makeId };
