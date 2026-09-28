// 判定层：沉积层样本链的全部规则都集中在这里，不读写文件、不接触 HTTP。
// 状态：已登记 -> 在途 -> 已接收(合格/不合格)，异常与更正走 待处理 / 待重核。
const STATUS = {
  REGISTERED: '已登记',
  IN_TRANSIT: '在途',
  PENDING: '待处理',
  RECHECK: '待重核',
  RECEIVED: '已接收'
};

// 未闭环：仍占用“同钻孔同层位唯一在途样单”名额。
const OPEN_STATUSES = [STATUS.REGISTERED, STATUS.IN_TRANSIT, STATUS.PENDING, STATUS.RECHECK];

const FAIL = {
  TEMP: '运输温度超过8℃',
  SEAL: '封条破损',
  WEIGHT: '重量缺失'
};

const CONCLUSION = {
  PASS: '合格',
  FAIL: '不合格'
};

const KEY_FIELDS = ['depth', 'sealedAt'];

function fail(statusCode, error) {
  const err = new Error(error);
  err.statusCode = statusCode;
  return err;
}

function now() {
  return new Date().toISOString();
}

function stamp(action, note) {
  return { at: now(), action, note: note || '' };
}

function keyOf(sample) {
  return `${sample.borehole}||${sample.horizon}`;
}

function queueOf(sample) {
  if (sample.status === STATUS.PENDING) return 'pending';
  if ([STATUS.IN_TRANSIT, STATUS.RECHECK].includes(sample.status)) return 'submission';
  if (sample.status === STATUS.REGISTERED) return 'ready';
  return 'archived';
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function toNumber(value) {
  if (isBlank(value)) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : NaN;
}

function makeSampleCode(existing) {
  const year = new Date().getFullYear();
  const count = existing.length + 1;
  return `S-${year}-${String(count).padStart(3, '0')}`;
}

function findOpenByKey(samples, borehole, horizon, excludeId) {
  return samples.find((sample) =>
    OPEN_STATUSES.includes(sample.status) &&
    sample.borehole === borehole &&
    sample.horizon === horizon &&
    sample.id !== excludeId
  );
}

function touch(sample) {
  sample.updatedAt = now();
  return sample;
}

// 1) 登记钻孔、层位、深度、封存时间（封条号、登记人同登）。
//    同钻孔同层位只准一条在途（未闭环）样本，重复建样返回已有样单。
function registerSample(db, input) {
  const samples = db.samples || [];
  const borehole = String(input.borehole || '').trim();
  const horizon = String(input.horizon || '').trim();
  const depth = toNumber(input.depth);
  const sealedAt = String(input.sealedAt || '').trim();
  const sealNo = String(input.sealNo || '').trim();
  const registrar = String(input.registrar || '').trim();

  if (!borehole) throw fail(400, '请填写钻孔编号');
  if (!horizon) throw fail(400, '请填写层位');
  if (depth === null || Number.isNaN(depth)) throw fail(400, '请填写有效深度（米）');
  if (!sealedAt) throw fail(400, '请填写封存时间');
  if (!sealNo) throw fail(400, '请填写封条号');
  if (!registrar) throw fail(400, '请填写登记人');

  const dup = findOpenByKey(samples, borehole, horizon);
  if (dup) {
    return { sample: dup, duplicated: true };
  }

  const ts = now();
  const sample = {
    id: `sample-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    sampleCode: makeSampleCode(samples),
    borehole,
    horizon,
    depth,
    sealedAt,
    sealNo,
    weight: isBlank(input.weight) ? null : Number(input.weight),
    carrier: '',
    registrar,
    transportTemp: null,
    sealBroken: false,
    failReasons: [],
    status: STATUS.REGISTERED,
    activeReceipt: null,
    archive: [],
    createdAt: ts,
    updatedAt: ts,
    history: [stamp('登记', `${borehole} / ${horizon}，深度${depth}m`)]
  };
  samples.push(sample);
  db.samples = samples;
  return { sample, duplicated: false };
}

// 2) 发运核对：温度>8℃、封条破损或重量缺失 -> 待处理，不能进送检清单。
function dispatchSample(db, id, input) {
  const sample = (db.samples || []).find((entry) => entry.id === id);
  if (!sample) throw fail(404, '样本不存在');
  if (![STATUS.REGISTERED, STATUS.PENDING].includes(sample.status)) {
    throw fail(409, `当前状态「${sample.status}」不能发运`);
  }

  const temp = toNumber(input.transportTemp);
  if (temp === null || Number.isNaN(temp)) throw fail(400, '请填写运输温度');
  const sealBroken = Boolean(input.sealBroken);
  const weight = toNumber(input.weight ?? sample.weight);
  const carrier = String(input.carrier || '').trim();
  if (!carrier) throw fail(400, '请填写运输人');

  const reasons = [];
  if (temp > 8) reasons.push(FAIL.TEMP);
  if (sealBroken) reasons.push(FAIL.SEAL);
  if (weight === null || Number.isNaN(weight)) reasons.push(FAIL.WEIGHT);

  sample.transportTemp = temp;
  sample.sealBroken = sealBroken;
  sample.weight = weight === null || Number.isNaN(weight) ? null : weight;
  sample.carrier = carrier;
  touch(sample);

  if (reasons.length) {
    sample.status = STATUS.PENDING;
    sample.failReasons = reasons;
    sample.history.unshift(stamp('转待处理', reasons.join('；')));
    return { sample, held: true };
  }

  const blocker = findOpenByKey(db.samples, sample.borehole, sample.horizon, sample.id);
  if (blocker) {
    // 同层位已有另一条在途（含待重核），本单不得进入送检清单。
    sample.status = STATUS.PENDING;
    sample.failReasons = [`同层位样单 ${blocker.sampleCode} 仍在途（${blocker.status}）`];
    sample.history.unshift(stamp('转待处理', sample.failReasons[0]));
    return { sample, held: true, blocked: true };
  }

  sample.status = STATUS.IN_TRANSIT;
  sample.failReasons = [];
  if (sample.activeReceipt && sample.activeReceipt.conclusion === CONCLUSION.FAIL) {
    sample.archive.unshift({ ...sample.activeReceipt, valid: false });
    sample.activeReceipt = null;
  }
  sample.history.unshift(stamp('发运', `${carrier} 运输，冷链 ${temp}℃`));
  return { sample, held: false };
}

// 3) 实验室接收：另一人核对封条号与重量并记结论。
function receiveSample(db, id, input) {
  const sample = (db.samples || []).find((entry) => entry.id === id);
  if (!sample) throw fail(404, '样本不存在');
  if (![STATUS.IN_TRANSIT, STATUS.RECHECK].includes(sample.status)) {
    throw fail(409, `当前状态「${sample.status}」不能接收核对`);
  }

  const receiver = String(input.receiver || '').trim();
  if (!receiver) throw fail(400, '请填写接收核对人');
  const others = [sample.registrar, sample.carrier].filter(Boolean);
  if (others.includes(receiver)) {
    throw fail(409, `接收核对人必须是登记人/运输人之外的另一人（${others.join('、')}）`);
  }

  const receivedSealNo = String(input.receivedSealNo || '').trim();
  const receivedWeight = toNumber(input.receivedWeight);
  if (!receivedSealNo) throw fail(400, '请填写核对封条号');
  if (receivedWeight === null || Number.isNaN(receivedWeight)) throw fail(400, '请填写核对重量');

  const tolerance = 0;
  const sealMatch = receivedSealNo === sample.sealNo;
  const weightMatch = sample.weight !== null && Math.abs(receivedWeight - Number(sample.weight)) <= tolerance;
  const conclusion = sealMatch && weightMatch ? CONCLUSION.PASS : CONCLUSION.FAIL;
  const checks = [
    `封条号${sealMatch ? '相符' : '不符'}（${receivedSealNo} / ${sample.sealNo}）`,
    `重量${weightMatch ? '相符' : '不符'}（${receivedWeight}g / ${sample.weight ?? '-'}g）`
  ];

  const lastRevision = Math.max(
    sample.activeReceipt?.revision || 0,
    ...(sample.archive || []).map((entry) => entry.revision || 0)
  );
  const receipt = {
    at: now(),
    receiver,
    receivedSealNo,
    receivedWeight,
    sealMatch,
    weightMatch,
    conclusion,
    revision: lastRevision + 1,
    valid: true,
    note: checks.join('；')
  };

  if (sample.activeReceipt) {
    sample.archive.unshift({ ...sample.activeReceipt, valid: false });
  }
  sample.activeReceipt = receipt;
  touch(sample);

  if (conclusion === CONCLUSION.PASS) {
    sample.status = STATUS.RECEIVED;
    sample.failReasons = [];
    sample.history.unshift(stamp('实验室接收合格', `${receiver} 核对，${checks.join('；')}`));
    return { sample, passed: true };
  }

  sample.status = STATUS.PENDING;
  sample.failReasons = [`实验室核对不合格：${checks.join('；')}`];
  sample.history.unshift(stamp('实验室接收不合格，转待处理', checks.join('；')));
  return { sample, passed: false };
}

// 4) 深度或封存时间更正：原结论失效，重排送检；旧结论归档可查。
function correctSample(db, id, input) {
  const sample = (db.samples || []).find((entry) => entry.id === id);
  if (!sample) throw fail(404, '样本不存在');
  if (![STATUS.RECEIVED, STATUS.RECHECK].includes(sample.status)) {
    throw fail(409, `当前状态「${sample.status}」不能更正深度/封存时间`);
  }

  const depth = toNumber(input.depth);
  const sealedAt = String(input.sealedAt || '').trim();
  if (depth === null || Number.isNaN(depth)) throw fail(400, '请填写有效深度（米）');
  if (!sealedAt) throw fail(400, '请填写封存时间');
  if (depth === sample.depth && sealedAt === sample.sealedAt) {
    throw fail(409, '深度与封存时间均未变化');
  }

  const changes = [];
  if (depth !== sample.depth) changes.push(`深度 ${sample.depth}m → ${depth}m`);
  if (sealedAt !== sample.sealedAt) changes.push(`封存时间 ${sample.sealedAt} → ${sealedAt}`);

  if (sample.activeReceipt) {
    sample.archive.unshift({
      ...sample.activeReceipt,
      valid: false,
      supersededAt: now(),
      supersedeReason: '关键字段更正：' + changes.join('；')
    });
    sample.activeReceipt = null;
  }

  sample.depth = depth;
  sample.sealedAt = sealedAt;
  sample.status = STATUS.RECHECK;
  sample.failReasons = [];
  touch(sample);
  sample.history.unshift(stamp('关键字段更正，原结论失效重排', changes.join('；')));
  return { sample, changes };
}

// 视图层取数：两个队列（送检清单、待处理）外加已登记、已归档，均可见。
function buildBoard(db) {
  const sortByUpdated = (a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  const buckets = { submission: [], pending: [], ready: [], archived: [] };
  for (const sample of (db.samples || [])) {
    buckets[queueOf(sample)].push(sample);
  }
  Object.values(buckets).forEach((list) => list.sort(sortByUpdated));
  return {
    queues: [
      { id: 'submission', label: '送检清单', status: STATUS.IN_TRANSIT, items: buckets.submission },
      { id: 'pending', label: '待处理', status: STATUS.PENDING, items: buckets.pending },
      { id: 'ready', label: '待发运', status: STATUS.REGISTERED, items: buckets.ready },
      { id: 'archived', label: '已接收 / 已归档', status: STATUS.RECEIVED, items: buckets.archived }
    ]
  };
}

module.exports = {
  STATUS,
  OPEN_STATUSES,
  CONCLUSION,
  KEY_FIELDS,
  registerSample,
  dispatchSample,
  receiveSample,
  correctSample,
  buildBoard
};
