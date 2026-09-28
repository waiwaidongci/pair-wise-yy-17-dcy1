const express = require('express');
const path = require('path');

const app = express();
const config = require('./project.config');
const { readDb, writeDb } = require('./lib/store');
const chain = require('./lib/sample-chain');

const PORT = process.env.PORT || config.port || 3900;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function stamp(action, note) {
  return {
    at: new Date().toISOString(),
    action,
    note: note || ''
  };
}

function sortNewest(a, b) {
  return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
}

app.get('/api/config', (req, res) => {
  res.json(config);
});

app.get('/api/db', async (req, res, next) => {
  try {
    const db = await readDb();
    for (const key of Object.keys(db)) {
      if (Array.isArray(db[key])) db[key].sort(sortNewest);
    }
    res.json(db);
  } catch (error) {
    next(error);
  }
});

app.post('/api/:collection', async (req, res, next) => {
  try {
    const { collection } = req.params;
    if (collection === 'samples') {
      return res.status(405).json({ error: '样本请走 /api/sample/register 登记接口' });
    }
    const db = await readDb();
    if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
    const now = new Date().toISOString();
    const item = {
      id: `${collection}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
      ...req.body,
      createdAt: now,
      updatedAt: now,
      history: [stamp('创建', req.body.note || req.body.memo || '')]
    };
    db[collection].push(item);
    await writeDb(db);
    res.status(201).json(item);
  } catch (error) {
    next(error);
  }
});

app.patch('/api/:collection/:id', async (req, res, next) => {
  try {
    const { collection } = req.params;
    if (collection === 'samples') {
      return res.status(405).json({ error: '样本更正请走 /api/sample/:id/correct 接口' });
    }
    const db = await readDb();
    if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
    const item = db[collection].find((entry) => entry.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'not found' });
    const historyAction = req.body.historyAction;
    delete req.body.historyAction;
    Object.assign(item, req.body, { updatedAt: new Date().toISOString() });
    item.history = item.history || [];
    if (historyAction || req.body.note || req.body.memo || req.body.status) {
      item.history.unshift(stamp(historyAction || req.body.status || '更新', req.body.note || req.body.memo || ''));
    }
    await writeDb(db);
    res.json(item);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/:collection/:id', async (req, res, next) => {
  try {
    const { collection } = req.params;
    if (collection === 'samples') {
      return res.status(405).json({ error: '样本原档不可删除' });
    }
    const db = await readDb();
    if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
    const before = db[collection].length;
    db[collection] = db[collection].filter((entry) => entry.id !== req.params.id);
    if (db[collection].length === before) return res.status(404).json({ error: 'not found' });
    await writeDb(db);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post('/api/action/:actionId/:id', async (req, res, next) => {
  try {
    const db = await readDb();
    const action = config.actions.find((entry) => entry.id === req.params.actionId);
    if (!action) return res.status(404).json({ error: 'unknown action' });
    if (action.collection === 'samples') return res.status(405).json({ error: '样本请走专用流转接口' });
    const item = db[action.collection]?.find((entry) => entry.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'not found' });
    const result = runAction(db, action, item);
    if (result.error) return res.status(409).json({ error: result.error });
    await writeDb(db);
    res.json(result.item);
  } catch (error) {
    next(error);
  }
});

// ---- 沉积层样本链：判定全部委托 lib/sample-chain，这里只做 HTTP 装配 ----

async function withChain(handler) {
  const db = await readDb();
  const result = handler(db);
  await writeDb(db);
  return result;
}

app.get('/api/sample/board', async (req, res, next) => {
  try {
    const db = await readDb();
    res.json(chain.buildBoard(db));
  } catch (error) {
    next(error);
  }
});

app.post('/api/sample/register', async (req, res, next) => {
  try {
    const { sample, duplicated } = await withChain((db) => chain.registerSample(db, req.body || {}));
    if (duplicated) {
      return res.status(200).json({ sample, duplicated, message: `同层位已有未闭环样单 ${sample.sampleCode}，已返回原样单` });
    }
    res.status(201).json({ sample, duplicated: false, message: '样本已登记' });
  } catch (error) {
    next(error);
  }
});

app.post('/api/sample/:id/dispatch', async (req, res, next) => {
  try {
    const result = await withChain((db) => chain.dispatchSample(db, req.params.id, req.body || {}));
    res.json({
      ...result,
      message: result.held ? '未通过核对，已转待处理（不进送检清单）' : '发运核对通过，已进入送检清单'
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/sample/:id/receive', async (req, res, next) => {
  try {
    const result = await withChain((db) => chain.receiveSample(db, req.params.id, req.body || {}));
    res.json({ ...result, message: result.passed ? '核对合格，已接收归档' : '核对不合格，已转待处理' });
  } catch (error) {
    next(error);
  }
});

app.post('/api/sample/:id/correct', async (req, res, next) => {
  try {
    const result = await withChain((db) => chain.correctSample(db, req.params.id, req.body || {}));
    res.json({ ...result, message: '已更正，原接收结论失效并重排送检（旧档可查）' });
  } catch (error) {
    next(error);
  }
});

function getValue(source, pathName) {
  return pathName.split('.').reduce((value, key) => value?.[key], source);
}

function setValue(target, pathName, value) {
  const keys = pathName.split('.');
  let cursor = target;
  while (keys.length > 1) {
    const key = keys.shift();
    cursor[key] = cursor[key] || {};
    cursor = cursor[key];
  }
  cursor[keys[0]] = value;
}

function findRelated(db, relation, item) {
  return db[relation.collection]?.find((entry) => entry.id === item[relation.localKey]);
}

function runAction(db, action, item) {
  const related = action.relation ? findRelated(db, action.relation, item) : null;
  const context = { item, related };
  const levelRank = { '低': 1, '中': 2, '高': 3 };
  for (const guard of action.guards || []) {
    const left = getValue(context, guard.left);
    const right = guard.rightPath ? getValue(context, guard.rightPath) : guard.right;
    if (guard.op === 'missing' && left) continue;
    if (guard.op === 'missing' && !left) return { error: guard.message };
    if (guard.op === 'eq' && left !== right) return { error: guard.message };
    if (guard.op === 'neq' && left === right) return { error: guard.message };
    if (guard.op === 'gte' && Number(left) < Number(right)) return { error: guard.message };
    if (guard.op === 'levelGte' && (levelRank[left] || 0) < (levelRank[right] || 0)) return { error: guard.message };
    if (guard.op === 'notIn' && guard.values.includes(left)) return { error: guard.message };
  }
  for (const patch of action.patches || []) {
    const target = patch.target === 'related' ? related : item;
    if (!target) continue;
    const next = patch.valuePath ? getValue(context, patch.valuePath) : patch.value;
    setValue(target, patch.field, next);
    target.updatedAt = new Date().toISOString();
    target.history = target.history || [];
    target.history.unshift(stamp(action.label, action.note || '状态流转'));
  }
  for (const delta of action.deltas || []) {
    const target = delta.target === 'related' ? related : item;
    if (!target) continue;
    const sourceAmount = delta.amountPath ? Number(getValue(context, delta.amountPath)) : 1;
    const multiplier = delta.amount === undefined ? 1 : Number(delta.amount);
    const amount = sourceAmount * multiplier;
    const current = Number(getValue({ target }, `target.${delta.field}`) || 0);
    setValue(target, delta.field, current + amount);
    target.updatedAt = new Date().toISOString();
    target.history = target.history || [];
    target.history.unshift(stamp(action.label, action.note || '数量调整'));
  }
  return { item };
}

app.use((error, req, res, next) => {
  const status = error.statusCode || 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: error.message || '服务器错误' });
});

app.listen(PORT, () => {
  console.log(`${config.title} running at http://localhost:${PORT}`);
});
