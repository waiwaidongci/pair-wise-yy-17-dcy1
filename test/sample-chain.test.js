const test = require('node:test');
const assert = require('node:assert/strict');
const chain = require('../lib/sample-chain');

const { STATUS } = chain;

function baseInput(over = {}) {
  return {
    borehole: 'ZK-01',
    horizon: 'L2 钙华层',
    depth: 3.4,
    sealedAt: '2026-09-26T09:20',
    sealNo: 'FB-3301',
    weight: 486,
    registrar: '沈宁',
    ...over
  };
}

function register(db, over = {}) {
  return chain.registerSample(db, baseInput(over)).sample;
}

function code(sample) {
  return sample.sampleCode;
}

test('登记成功，状态为已登记', () => {
  const db = { samples: [] };
  const { sample, duplicated } = chain.registerSample(db, baseInput());
  assert.equal(duplicated, false);
  assert.equal(sample.status, STATUS.REGISTERED);
  assert.equal(sample.sampleCode, 'S-2026-001');
  assert.equal(sample.activeReceipt, null);
});

test('登记缺字段返回 400', () => {
  const db = { samples: [] };
  assert.throws(() => chain.registerSample(db, baseInput({ borehole: '' })), /钻孔/);
  assert.throws(() => chain.registerSample(db, baseInput({ depth: '' })), /深度/);
  assert.throws(() => chain.registerSample(db, baseInput({ sealedAt: '' })), /封存时间/);
  assert.throws(() => chain.registerSample(db, baseInput({ sealNo: '' })), /封条号/);
});

test('同钻孔同层位重复建样返回已有样单；不同层位可建', () => {
  const db = { samples: [] };
  const first = register(db);
  const dup = chain.registerSample(db, baseInput({ depth: 9, sealNo: 'X' }));
  assert.equal(dup.duplicated, true);
  assert.equal(dup.sample.id, first.id);
  assert.equal(db.samples.length, 1);

  const other = chain.registerSample(db, baseInput({ horizon: 'L3 粉砂层', sealNo: 'FB-3302' }));
  assert.equal(other.duplicated, false);
  assert.equal(db.samples.length, 2);
});

test('已接收（闭环）后，同层位允许重新建样', () => {
  const db = { samples: [] };
  const first = register(db);
  chain.dispatchSample(db, first.id, { transportTemp: 5, carrier: '罗岩' });
  chain.receiveSample(db, first.id, { receiver: '贺征', receivedSealNo: 'FB-3301', receivedWeight: 486 });
  const again = chain.registerSample(db, baseInput({ sealNo: 'FB-9999' }));
  assert.equal(again.duplicated, false);
});

test('发运：温度超过8℃转待处理，不进送检清单', () => {
  const db = { samples: [] };
  const s = register(db);
  const r = chain.dispatchSample(db, s.id, { transportTemp: 8.4, sealBroken: false, carrier: '罗岩' });
  assert.equal(r.held, true);
  assert.equal(s.status, STATUS.PENDING);
  assert.ok(s.failReasons.includes('运输温度超过8℃'));
  const board = chain.buildBoard(db);
  assert.equal(board.queues[0].items.length, 0); // 送检清单
  assert.equal(board.queues[1].items.length, 1); // 待处理
});

test('发运：封条破损转待处理', () => {
  const db = { samples: [] };
  const s = register(db);
  chain.dispatchSample(db, s.id, { transportTemp: 6, sealBroken: true, carrier: '罗岩' });
  assert.equal(s.status, STATUS.PENDING);
  assert.ok(s.failReasons.includes('封条破损'));
});

test('发运：重量缺失转待处理（登记时未填且发运仍缺）', () => {
  const db = { samples: [] };
  const s = register(db, { weight: '' });
  chain.dispatchSample(db, s.id, { transportTemp: 6, sealBroken: false, weight: '', carrier: '罗岩' });
  assert.equal(s.status, STATUS.PENDING);
  assert.ok(s.failReasons.includes('重量缺失'));
});

test('发运核对通过进入在途/送检清单', () => {
  const db = { samples: [] };
  const s = register(db);
  const r = chain.dispatchSample(db, s.id, { transportTemp: 8, sealBroken: false, carrier: '罗岩' });
  assert.equal(r.held, false);
  assert.equal(s.status, STATUS.IN_TRANSIT);
  assert.equal(chain.buildBoard(db).queues[0].items[0].id, s.id);
});

test('同层位另一条在途时，本单卡住不进送检清单（防线）', () => {
  const db = { samples: [] };
  const a = register(db, { sealNo: 'FB-1' });
  chain.dispatchSample(db, a.id, { transportTemp: 5, carrier: '罗岩' });
  // 绕过登记直接放入同层位的第二条已登记样单（模拟脏数据/并发残留）
  const b = register(db, { borehole: 'OTHER', sealNo: 'FB-2' });
  b.borehole = a.borehole;
  b.horizon = a.horizon;
  const r = chain.dispatchSample(db, b.id, { transportTemp: 5, carrier: '罗岩' });
  assert.equal(r.held, true);
  assert.equal(r.blocked, true);
  assert.match(b.failReasons[0], /仍在途/);
});

test('待处理样本整改后可重新发运', () => {
  const db = { samples: [] };
  const s = register(db);
  chain.dispatchSample(db, s.id, { transportTemp: 9, carrier: '罗岩' });
  assert.equal(s.status, STATUS.PENDING);
  chain.dispatchSample(db, s.id, { transportTemp: 6, carrier: '罗岩' });
  assert.equal(s.status, STATUS.IN_TRANSIT);
  assert.deepEqual(s.failReasons, []);
});

test('接收：登记人或运输人不得核对', () => {
  const db = { samples: [] };
  const s = register(db);
  chain.dispatchSample(db, s.id, { transportTemp: 5, carrier: '罗岩' });
  assert.throws(
    () => chain.receiveSample(db, s.id, { receiver: '沈宁', receivedSealNo: 'FB-3301', receivedWeight: 486 }),
    /另一人/
  );
  assert.throws(
    () => chain.receiveSample(db, s.id, { receiver: '罗岩', receivedSealNo: 'FB-3301', receivedWeight: 486 }),
    /另一人/
  );
});

test('接收：封条号不符 -> 不合格 -> 待处理', () => {
  const db = { samples: [] };
  const s = register(db);
  chain.dispatchSample(db, s.id, { transportTemp: 5, carrier: '罗岩' });
  const r = chain.receiveSample(db, s.id, { receiver: '贺征', receivedSealNo: 'FB-7777', receivedWeight: 486 });
  assert.equal(r.passed, false);
  assert.equal(s.status, STATUS.PENDING);
  assert.equal(s.activeReceipt.conclusion, '不合格');
  assert.equal(s.activeReceipt.sealMatch, false);
});

test('接收：重量不符 -> 不合格 -> 待处理', () => {
  const db = { samples: [] };
  const s = register(db);
  chain.dispatchSample(db, s.id, { transportTemp: 5, carrier: '罗岩' });
  chain.receiveSample(db, s.id, { receiver: '贺征', receivedSealNo: 'FB-3301', receivedWeight: 470 });
  assert.equal(s.status, STATUS.PENDING);
  assert.equal(s.activeReceipt.weightMatch, false);
});

test('接收：封条号与重量均相符 -> 合格归档', () => {
  const db = { samples: [] };
  const s = register(db);
  chain.dispatchSample(db, s.id, { transportTemp: 5, carrier: '罗岩' });
  const r = chain.receiveSample(db, s.id, { receiver: '贺征', receivedSealNo: 'FB-3301', receivedWeight: 486 });
  assert.equal(r.passed, true);
  assert.equal(s.status, STATUS.RECEIVED);
  assert.equal(s.activeReceipt.conclusion, '合格');
  assert.equal(s.activeReceipt.valid, true);
});

test('深度更正：原结论失效，进入待重核，旧档可查', () => {
  const db = { samples: [] };
  const s = register(db);
  chain.dispatchSample(db, s.id, { transportTemp: 5, carrier: '罗岩' });
  chain.receiveSample(db, s.id, { receiver: '贺征', receivedSealNo: 'FB-3301', receivedWeight: 486 });

  const r = chain.correctSample(db, s.id, { depth: 3.45, sealedAt: '2026-09-26T09:20' });
  assert.ok(r.changes.some((line) => line.includes('深度')));
  assert.equal(s.status, STATUS.RECHECK);
  assert.equal(s.activeReceipt, null);
  assert.equal(s.archive.length, 1);
  assert.equal(s.archive[0].valid, false);
  assert.match(s.archive[0].supersedeReason, /关键字段更正/);
  assert.equal(s.depth, 3.45);

  // 待重核出现在送检清单
  const board = chain.buildBoard(db);
  assert.equal(board.queues[0].items[0].id, s.id);
});

test('封存时间更正后可由另一人重新核对，旧档保留且可再次合格', () => {
  const db = { samples: [] };
  const s = register(db);
  chain.dispatchSample(db, s.id, { transportTemp: 5, carrier: '罗岩' });
  chain.receiveSample(db, s.id, { receiver: '贺征', receivedSealNo: 'FB-3301', receivedWeight: 486 });
  chain.correctSample(db, s.id, { depth: 3.4, sealedAt: '2026-09-26T10:00' });
  const r2 = chain.receiveSample(db, s.id, { receiver: '周知', receivedSealNo: 'FB-3301', receivedWeight: 486 });
  assert.equal(r2.passed, true);
  assert.equal(s.status, STATUS.RECEIVED);
  assert.equal(s.activeReceipt.revision, 2);
  assert.equal(s.archive.length, 1, '旧档仍保留一份');
  assert.equal(s.archive[0].revision, 1);
});

test('无变化的更正是无效操作', () => {
  const db = { samples: [] };
  const s = register(db);
  chain.dispatchSample(db, s.id, { transportTemp: 5, carrier: '罗岩' });
  chain.receiveSample(db, s.id, { receiver: '贺征', receivedSealNo: 'FB-3301', receivedWeight: 486 });
  assert.throws(
    () => chain.correctSample(db, s.id, { depth: 3.4, sealedAt: '2026-09-26T09:20' }),
    /未变化/
  );
});

test('在途/待重核以外的状态不能接收，非已接收不能更正', () => {
  const db = { samples: [] };
  const s = register(db);
  assert.throws(
    () => chain.receiveSample(db, s.id, { receiver: '贺征', receivedSealNo: 'FB-3301', receivedWeight: 486 }),
    /不能接收/
  );
  assert.throws(() => chain.correctSample(db, s.id, { depth: 4, sealedAt: '2026-09-26T09:20' }), /不能更正/);
});
