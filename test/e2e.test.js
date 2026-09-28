/**
 * 样本链规则端到端测试：启动真实 HTTP 服务 + 临时数据文件，按业务流程走一遍。
 * 运行：npm test
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-db-'));
const dbFile = path.join(tmpDir, 'db.json');
fs.writeFileSync(dbFile, JSON.stringify({ samples: [], receipts: [] }));

const PORT = 43190 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), CHAIN_DB_FILE: dbFile },
  stdio: ['ignore', 'pipe', 'inherit']
});

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

async function call(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

let sA, sB, sC;
const sampleBody = (over) => ({
  borehole: 'ZK-T', horizon: 'L1', depthM: 1.5, weightG: 500,
  sealNo: 'F-1', sealedAt: '2026-09-28T01:00', registrar: '甲', ...over
});

async function main() {
  // 等服务起来
  for (let i = 0; i < 40; i++) {
    try { await fetch(BASE + '/api/samples'); break; } catch (_) { await new Promise((r) => setTimeout(r, 100)); }
  }

  await test('登记建样成功，状态为在途', async () => {
    const { status, json } = await call('POST', '/api/samples', sampleBody({}));
    assert.equal(status, 201);
    assert.equal(json.duplicate, false);
    assert.equal(json.sample.status, 'intransit');
    assert.ok(json.sample.code.includes('ZK-T-L1'));
    sA = json.sample;
  });

  await test('同钻孔同层位重复建样：返回已有样单，不新建', async () => {
    const { status, json } = await call('POST', '/api/samples', sampleBody({ depthM: 1.9, sealNo: 'F-2' }));
    assert.equal(status, 200);
    assert.equal(json.duplicate, true);
    assert.equal(json.sample.id, sA.id);
    const { json: db } = await call('GET', '/api/samples');
    assert.equal(db.samples.length, 1);
  });

  await test('不同层位可以再建一条在途', async () => {
    const { status, json } = await call('POST', '/api/samples', sampleBody({ horizon: 'L2', sealNo: 'F-2' }));
    assert.equal(status, 201);
    sB = json.sample;
  });

  await test('必填缺失被拒绝', async () => {
    const { status } = await call('POST', '/api/samples', { borehole: 'X' });
    assert.equal(status, 400);
  });

  await test('运输核验合格 -> 进送检清单', async () => {
    const { status, json } = await call('POST', `/api/samples/${sA.id}/transport`,
      { maxTemp: 6.5, sealIntact: true, checker: '乙' });
    assert.equal(status, 200);
    assert.equal(json.status, 'submitted');
    sA = json;
  });

  await test('恰好 8℃ 不判超温，超过才判异', async () => {
    const rules = require('../lib/rules');
    const smp = { weightG: 1 };
    assert.equal(rules.evaluateTransport(smp, { maxTemp: 8, sealIntact: true }).passed, true);
    assert.deepEqual(rules.evaluateTransport(smp, { maxTemp: 8.1, sealIntact: true }).reasons, ['TEMP_EXCEEDED']);
  });

  await test('超温 + 封条破损 -> 转待处理，不进送检清单', async () => {
    const { status, json } = await call('POST', `/api/samples/${sB.id}/transport`,
      { maxTemp: 9.2, sealIntact: false, checker: '乙' });
    assert.equal(status, 200);
    assert.equal(json.status, 'pending');
    assert.deepEqual(json.lastQc.reasons, ['TEMP_EXCEEDED', 'SEAL_BROKEN']);
    sB = json;
    const { json: mainQ } = await call('GET', '/api/samples?queue=main');
    assert.ok(!mainQ.samples.find((s) => s.id === sB.id));
    const { json: pendQ } = await call('GET', '/api/samples?queue=pending');
    assert.ok(pendQ.samples.find((s) => s.id === sB.id));
  });

  await test('在途样必须先核验，已送检样不能重复核验', async () => {
    const { status } = await call('POST', `/api/samples/${sA.id}/transport`,
      { maxTemp: 5, sealIntact: true, checker: '乙' });
    assert.equal(status, 400);
  });

  await test('重量缺失登记 -> 核验时转待处理', async () => {
    const { json: created } = await call('POST', '/api/samples',
      sampleBody({ horizon: 'L9', sealNo: 'F-9', weightG: null }));
    sC = created.sample;
    const { json } = await call('POST', `/api/samples/${sC.id}/transport`,
      { maxTemp: 4, sealIntact: true, checker: '乙' });
    assert.equal(json.status, 'pending');
    assert.deepEqual(json.lastQc.reasons, ['WEIGHT_MISSING']);
    sC = json;
  });

  await test('复检时缺陷未解除 -> 仍待处理', async () => {
    const { status, json } = await call('POST', `/api/samples/${sB.id}/recheck`,
      { action: 'ok', sealIntact: false, maxTemp: 9.5, operator: '乙', note: '冷链尚未恢复' });
    assert.equal(status, 200);
    assert.equal(json.status, 'pending');
  });

  await test('复检缺陷全部解除 -> 重新进送检清单（新封条号生效）', async () => {
    const { status, json } = await call('POST', `/api/samples/${sB.id}/recheck`,
      { action: 'resealed', sealIntact: true, maxTemp: 6, newSealNo: 'F-2R', operator: '乙', note: '冷链恢复并重新封样' });
    assert.equal(status, 200);
    assert.equal(json.status, 'submitted');
    assert.equal(json.sealNo, 'F-2R');
    sB = json;
  });

  await test('重量缺失复检补称后进送检清单', async () => {
    const { json } = await call('POST', `/api/samples/${sC.id}/recheck`,
      { action: 'replaced', sealIntact: true, newWeightG: 480, operator: '乙', note: '现场补称' });
    assert.equal(json.status, 'submitted');
    assert.equal(json.weightG, 480);
    sC = json;
  });

  await test('接收人不能是登记人本人', async () => {
    const { status, json } = await call('POST', `/api/samples/${sA.id}/receive`, {
      receiver: '甲', sealNoObserved: 'F-1', weightObservedG: 500, conclusion: 'accepted'
    });
    assert.equal(status, 400);
    assert.equal(json.code, 'RECEIVER_SAME_AS_REGISTRAR');
  });

  await test('接收人不能是运输核验人', async () => {
    const { status, json } = await call('POST', `/api/samples/${sA.id}/receive`, {
      receiver: '乙', sealNoObserved: 'F-1', weightObservedG: 500, conclusion: 'accepted'
    });
    assert.equal(status, 400);
    assert.equal(json.code, 'RECEIVER_SAME_AS_CHECKER');
  });

  await test('封条号不符不能判合格', async () => {
    const { status, json } = await call('POST', `/api/samples/${sA.id}/receive`, {
      receiver: '丙', sealNoObserved: 'F-WRONG', weightObservedG: 500, conclusion: 'accepted'
    });
    assert.equal(status, 400);
    assert.equal(json.code, 'ACCEPT_WITH_DISCREPANCY');
  });

  await test('重量超差 ±0.5g 不能判合格', async () => {
    const rules = require('../lib/rules');
    const ev = rules.evaluateReceipt({ sealNo: 'F-1', weightG: 500 },
      { sealNoObserved: 'F-1', weightObservedG: 500.6 });
    assert.equal(ev.weightMatch, false);
    const evEdge = rules.evaluateReceipt({ sealNo: 'F-1', weightG: 500 },
      { sealNoObserved: 'F-1', weightObservedG: 500.5 });
    assert.equal(evEdge.weightMatch, true);
  });

  await test('另一人核对一致 -> 合格接收，结论留档', async () => {
    const { status, json } = await call('POST', `/api/samples/${sA.id}/receive`, {
      receiver: '丙', sealNoObserved: 'F-1', weightObservedG: 500.2, conclusion: 'accepted', note: ''
    });
    assert.equal(status, 201);
    assert.equal(json.sample.status, 'received');
    assert.equal(json.receipt.void, false);
    sA = json.sample;
  });

  await test('核对不符可判不合格 -> 退回待处理，结论仍留档', async () => {
    const { status, json } = await call('POST', `/api/samples/${sB.id}/receive`, {
      receiver: '丙', sealNoObserved: 'F-DIFF', weightObservedG: 500, conclusion: 'rejected', note: '封条号与链上不符'
    });
    assert.equal(status, 201);
    assert.equal(json.sample.status, 'pending');
    assert.deepEqual(json.receipt.discrepancies, ['SEAL_MISMATCH']);
    sB = json.sample;
  });

  await test('更正深度/封存时间 -> 原结论作废，重排回送检清单，旧档可查', async () => {
    const { status, json } = await call('PATCH', `/api/samples/${sA.id}/correction`, {
      depthM: 1.7, sealedAt: '2026-09-28T00:50', operator: '丁', reason: '柱状图复核'
    });
    assert.equal(status, 200);
    assert.equal(json.sample.status, 'submitted');
    assert.equal(json.voidedReceipts.length, 1);
    assert.equal(json.sample.depthM, 1.7);
    const { json: receipts } = await call('GET', '/api/receipts?void=true');
    assert.ok(receipts.receipts.some((r) => r.id === json.voidedReceipts[0] && r.void && r.voidReason === '柱状图复核'));
    sA = json.sample;
  });

  await test('没有实际变化的更正被拒绝', async () => {
    const { status } = await call('PATCH', `/api/samples/${sA.id}/correction`, {
      depthM: 1.7, sealedAt: '2026-09-28T00:50', operator: '丁', reason: '再点一次'
    });
    assert.equal(status, 400);
  });

  await test('作废重排后仍受人员回避约束：登记人本人不能接收', async () => {
    const { status, json } = await call('POST', `/api/samples/${sA.id}/receive`, {
      receiver: '甲', sealNoObserved: 'F-1', weightObservedG: 500.2, conclusion: 'accepted'
    });
    assert.equal(status, 400);
    assert.equal(json.code, 'RECEIVER_SAME_AS_REGISTRAR');
  });

  await test('更正重排后另一人可重新接收', async () => {
    const { status, json } = await call('POST', `/api/samples/${sA.id}/receive`, {
      receiver: '丁', sealNoObserved: 'F-1', weightObservedG: 500.2, conclusion: 'accepted', note: '更正后重新核对'
    });
    assert.equal(status, 201);
    assert.equal(json.sample.status, 'received');
    // 新结论有效，旧结论仍作废留档
    const { json: all } = await call('GET', '/api/receipts');
    const forA = all.receipts.filter((r) => r.sampleId === sA.id);
    assert.equal(forA.filter((r) => !r.void).length, 1);
    assert.equal(forA.filter((r) => r.void).length, 1);
  });

  await test('已接收样本同层位不再占在途名额，可登记下一件', async () => {
    const { status } = await call('POST', '/api/samples', sampleBody({ sealNo: 'F-3' }));
    assert.equal(status, 201);
  });
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} 通过`);
    server.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(failed.length ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    server.kill();
    process.exit(1);
  });
