/**
 * 样本链 HTTP 层：解析请求 -> 调判定层（lib/rules）-> 经存储层（lib/storage）落盘。
 * 页面在 public/，判定与存储均不放在页面里。
 */
const express = require('express');
const path = require('path');

const rules = require('./lib/rules');
const store = require('./lib/storage');

const app = express();
const PORT = process.env.PORT || 3912;

app.use(express.json({ limit: '2mb' }));
app.use('/lib/rules.js', express.static(path.join(__dirname, 'lib', 'rules.js')));
app.use(express.static(path.join(__dirname, 'public')));

const { STATUS, ERROR_LABEL, REASONS } = rules;

function fail(res, code, detail) {
  return res.status(400).json({
    error: ERROR_LABEL[code] || code,
    code,
    detail: detail || ''
  });
}

function pushHistory(sample, action, operator, note) {
  sample.history = sample.history || [];
  sample.history.push({ at: store.nowIso(), action, operator: rules.norm(operator) || '', note: note || '' });
}

function sortNewest(list) {
  return list.sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
}

function summarizeTransport(evaluation) {
  return evaluation.reasons.map((key) => REASONS[key]).join('；');
}

/* ---------- 读：两个队列 + 已接收 ---------- */

app.get('/api/samples', async (req, res) => {
  const db = await store.snapshot();
  const queue = req.query.queue; // main | pending | received
  let samples = db.samples;
  if (queue === 'main') samples = samples.filter((s) => [STATUS.INTRANSIT, STATUS.SUBMITTED].includes(s.status));
  if (queue === 'pending') samples = samples.filter((s) => s.status === STATUS.PENDING);
  if (queue === 'received') samples = samples.filter((s) => s.status === STATUS.RECEIVED);
  res.json({ samples: sortNewest([...samples]), receipts: sortNewest([...db.receipts]) });
});

/* ---------- 登记建样：同钻孔同层位只准一条在途，重复返回已有样单 ---------- */

app.post('/api/samples', async (req, res) => {
  const b = req.body || {};
  const borehole = rules.norm(b.borehole);
  const horizon = rules.norm(b.horizon);
  const depthM = Number(b.depthM);
  const weightG = b.weightG === '' || b.weightG == null ? null : Number(b.weightG);
  const registrar = rules.norm(b.registrar);
  const sealNo = rules.norm(b.sealNo);
  const sealedAt = b.sealedAt ? new Date(b.sealedAt).toISOString() : store.nowIso();

  if (!borehole || !horizon || !registrar || !sealNo) return fail(res, 'FIELD_REQUIRED', '钻孔、层位、封条号、登记人必填');
  if (!Number.isFinite(depthM) || depthM < 0) return fail(res, 'BAD_NUMBER', '深度须为非负数字');
  if (weightG !== null && (!Number.isFinite(weightG) || weightG <= 0)) return fail(res, 'BAD_NUMBER', '重量须为正数');
  if (Number.isNaN(new Date(sealedAt).getTime())) return fail(res, 'BAD_TIME');

  const result = await store.mutate((db) => {
    const existing = rules.findOpenByHorizon(db.samples, borehole, horizon);
    if (existing) {
      // 重复建样不新建，返回已有样单
      return { duplicate: true, sample: existing };
    }
    const now = store.nowIso();
    const seq = String(db.samples.length + 1).padStart(3, '0');
    const sample = {
      id: store.makeId('smp'),
      code: `${borehole}-${horizon}-${seq}`,
      borehole,
      horizon,
      depthM,
      weightG,
      sealNo,
      sealedAt,
      registrar,
      status: STATUS.INTRANSIT,
      createdAt: now,
      updatedAt: now,
      lastQc: null,
      receiptId: null,
      note: rules.norm(b.note),
      history: []
    };
    pushHistory(sample, '登记封样', registrar, `钻孔 ${borehole} / 层位 ${horizon} / 深度 ${depthM}m，封条 ${sealNo}`);
    db.samples.push(sample);
    return { duplicate: false, sample };
  });

  res.status(result.duplicate ? 200 : 201).json({ duplicate: result.duplicate, sample: result.sample });
});

/* ---------- 运输核验：>8℃ / 封条破损 / 重量缺失 -> 待处理，不进送检清单 ---------- */

app.post('/api/samples/:id/transport', async (req, res) => {
  const { id } = req.params;
  const b = req.body || {};
  const maxTemp = Number(b.maxTemp);
  if (!Number.isFinite(maxTemp)) return fail(res, 'BAD_NUMBER', '请填写运输最高温');
  const sealIntact = b.sealIntact === true || b.sealIntact === 'true';
  const checker = rules.norm(b.checker);
  if (!checker) return fail(res, 'FIELD_REQUIRED', '请填写核验人');

  const sample = await store.mutate((db) => {
    const target = db.samples.find((s) => s.id === id);
    if (!target) throw Object.assign(new Error('SAMPLE_NOT_FOUND'), { code: 'SAMPLE_NOT_FOUND' });
    if (target.status !== STATUS.INTRANSIT) throw Object.assign(new Error('NOT_INTRANSIT'), { code: 'NOT_INTRANSIT' });

    const reading = { maxTemp, sealIntact };
    const evaluation = rules.evaluateTransport(target, reading);
    target.lastQc = { at: store.nowIso(), checker, maxTemp, sealIntact, passed: evaluation.passed, reasons: evaluation.reasons };
    target.status = evaluation.passed ? STATUS.SUBMITTED : STATUS.PENDING;
    target.updatedAt = store.nowIso();
    pushHistory(
      target,
      '运输核验',
      checker,
      evaluation.passed
        ? `最高温 ${maxTemp}℃、封条完好，进入送检清单`
        : `判异：${summarizeTransport(evaluation)}，转待处理`
    );
    return target;
  }).catch((err) => {
    if (err.code) return err;
    throw err;
  });
  if (sample instanceof Error) return fail(res, sample.code);
  res.json(sample);
});

/* ---------- 待处理处置复检：缺陷解除 -> 重新进送检清单，否则留待处理 ---------- */

app.post('/api/samples/:id/recheck', async (req, res) => {
  const { id } = req.params;
  const b = req.body || {};
  const operator = rules.norm(b.operator);
  const action = rules.norm(b.action); // resealed / replaced / ok
  const note = rules.norm(b.note);
  const maxTemp = b.maxTemp === '' || b.maxTemp == null ? null : Number(b.maxTemp);
  const sealIntact = b.sealIntact === true || b.sealIntact === 'true';
  const newSealNo = rules.norm(b.newSealNo);
  const newWeightG = b.newWeightG === '' || b.newWeightG == null ? null : Number(b.newWeightG);
  if (!operator) return fail(res, 'FIELD_REQUIRED', '请填写处置人');
  if (!action) return fail(res, 'FIELD_REQUIRED', '请选择处置方式');
  if (!note) return fail(res, 'FIELD_REQUIRED', '请填写处置说明');
  if (maxTemp !== null && !Number.isFinite(maxTemp)) return fail(res, 'BAD_NUMBER', '复检温度格式不正确');
  if (newWeightG !== null && (!Number.isFinite(newWeightG) || newWeightG <= 0)) return fail(res, 'BAD_NUMBER', '补称重量须为正数');

  const sample = await store.mutate((db) => {
    const target = db.samples.find((s) => s.id === id);
    if (!target) throw Object.assign(new Error('SAMPLE_NOT_FOUND'), { code: 'SAMPLE_NOT_FOUND' });
    if (target.status !== STATUS.PENDING) throw Object.assign(new Error('NOT_PENDING'), { code: 'NOT_PENDING' });

    const oldReasons = new Set((target.lastQc && target.lastQc.reasons) || []);
    const remaining = [];
    // 超温：复检需有不高于 8℃ 的当前温度才算解除
    if (oldReasons.has('TEMP_EXCEEDED') && !(Number.isFinite(maxTemp) && maxTemp <= rules.TEMP_LIMIT_C)) {
      remaining.push('TEMP_EXCEEDED');
    }
    // 封条破损：需确认完好；换封条还须登记新封条号
    const sealFixed = sealIntact && (action !== 'resealed' || !!newSealNo);
    if (oldReasons.has('SEAL_BROKEN') && !sealFixed) remaining.push('SEAL_BROKEN');
    // 封条号不符（实验室判异退回）：须重新封样并登记新封条号
    if (oldReasons.has('SEAL_MISMATCH') && !(sealIntact && !!newSealNo)) remaining.push('SEAL_MISMATCH');
    // 重量缺失：需补称正重量；重量不符：需重新称重建立链上重量
    const nextWeight = newWeightG !== null ? newWeightG : target.weightG;
    if ((oldReasons.has('WEIGHT_MISSING') || oldReasons.has('WEIGHT_MISMATCH')) && !rules.hasWeight(nextWeight)) {
      if (oldReasons.has('WEIGHT_MISSING')) remaining.push('WEIGHT_MISSING');
      if (oldReasons.has('WEIGHT_MISMATCH')) remaining.push('WEIGHT_MISMATCH');
    }

    if (!remaining.length) {
      if (newSealNo && newSealNo !== target.sealNo) target.sealNo = newSealNo;
      if (rules.hasWeight(nextWeight)) target.weightG = nextWeight;
      target.status = STATUS.SUBMITTED;
      target.lastQc = {
        ...(target.lastQc || {}),
        at: store.nowIso(),
        checker: operator,
        maxTemp: Number.isFinite(maxTemp) ? maxTemp : (target.lastQc && target.lastQc.maxTemp),
        sealIntact: true,
        passed: true,
        reasons: [],
        recheck: true
      };
      pushHistory(target, '处置复检', operator, `缺陷已解除（${note}），重新进入送检清单`);
    } else {
      target.lastQc = { ...(target.lastQc || {}), at: store.nowIso(), recheck: true };
      pushHistory(target, '处置复检', operator, `仍存在：${remaining.map((k) => REASONS[k]).join('；')}（${note}），留待处理`);
    }
    target.updatedAt = store.nowIso();
    return target;
  }).catch((err) => {
    if (err.code) return err;
    throw err;
  });
  if (sample instanceof Error) return fail(res, sample.code);
  res.json(sample);
});

/* ---------- 实验室接收：另一人核对封条号与重量并记结论 ---------- */

app.post('/api/samples/:id/receive', async (req, res) => {
  const { id } = req.params;
  const b = req.body || {};
  const input = {
    receiver: rules.norm(b.receiver),
    sealNoObserved: rules.norm(b.sealNoObserved),
    weightObservedG: b.weightObservedG === '' || b.weightObservedG == null ? null : Number(b.weightObservedG),
    conclusion: rules.norm(b.conclusion), // accepted | rejected
    note: rules.norm(b.note)
  };
  if (input.conclusion && input.conclusion !== 'accepted' && input.conclusion !== 'rejected') {
    return fail(res, 'CONCLUSION_REQUIRED');
  }

  const out = await store.mutate((db) => {
    const target = db.samples.find((s) => s.id === id);
    if (!target) throw Object.assign(new Error('SAMPLE_NOT_FOUND'), { code: 'SAMPLE_NOT_FOUND' });

    const lastChecker = target.lastQc && target.lastQc.checker;
    const errs = rules.receiveChecks(target, input, lastChecker);
    if (errs.length) throw Object.assign(new Error(errs[0]), { code: errs[0] });

    const evaluation = rules.evaluateReceipt(target, input);
    const moreErrs = rules.conclusionErrors(evaluation, input);
    if (moreErrs.length) throw Object.assign(new Error(moreErrs[0]), { code: moreErrs[0] });

    const accepted = input.conclusion === 'accepted';
    const receipt = {
      id: store.makeId('rcp'),
      sampleId: target.id,
      sampleCode: target.code,
      receiver: input.receiver,
      sealNoExpected: target.sealNo,
      sealNoObserved: input.sealNoObserved,
      weightExpectedG: target.weightG,
      weightObservedG: Number(input.weightObservedG),
      weightDiffG: evaluation.weightDiff === null ? null : Number(evaluation.weightDiff.toFixed(2)),
      conclusion: input.conclusion,
      discrepancies: evaluation.discrepancies,
      note: input.note,
      void: false,
      createdAt: store.nowIso()
    };
    db.receipts.push(receipt);

    if (accepted) {
      target.status = STATUS.RECEIVED;
      target.receiptId = receipt.id;
      pushHistory(target, '实验室接收', input.receiver, '封条号、重量核对一致，结论：接收');
    } else {
      // 结论不合格：仍留档为一次接收结论，样本退回待处理
      target.status = STATUS.PENDING;
      target.lastQc = {
        ...(target.lastQc || {}),
        at: store.nowIso(),
        passed: false,
        reasons: evaluation.discrepancies,
        rejectedByLab: true
      };
      pushHistory(
        target,
        '实验室接收',
        input.receiver,
        `结论：不合格（${evaluation.discrepancies.map((k) => REASONS[k]).join('、') || '人工判定'}）${input.note ? '：' + input.note : ''}，转待处理`
      );
    }
    target.updatedAt = store.nowIso();
    return { sample: target, receipt };
  }).catch((err) => {
    if (err.code) return { errCode: err.code };
    throw err;
  });
  if (out.errCode) return fail(res, out.errCode);
  res.status(201).json(out);
});

/* ---------- 更正深度/封存时间：原结论作废，重排回送检清单，旧档可查 ---------- */

app.patch('/api/samples/:id/correction', async (req, res) => {
  const { id } = req.params;
  const b = req.body || {};
  const operator = rules.norm(b.operator);
  const reason = rules.norm(b.reason);
  const patch = {};
  if (b.depthM !== undefined && b.depthM !== '') patch.depthM = Number(b.depthM);
  if (b.sealedAt) patch.sealedAt = new Date(b.sealedAt).toISOString();
  if (!operator) return fail(res, 'OPERATOR_REQUIRED');
  if (!reason) return fail(res, 'REASON_REQUIRED');
  if (patch.depthM !== undefined && (!Number.isFinite(patch.depthM) || patch.depthM < 0)) {
    return fail(res, 'BAD_NUMBER', '深度须为非负数字');
  }
  if (patch.sealedAt && Number.isNaN(new Date(patch.sealedAt).getTime())) return fail(res, 'BAD_TIME');

  const out = await store.mutate((db) => {
    const target = db.samples.find((s) => s.id === id);
    if (!target) throw Object.assign(new Error('SAMPLE_NOT_FOUND'), { code: 'SAMPLE_NOT_FOUND' });

    const changes = rules.correctionChanges(target, patch);
    if (!changes.length) throw Object.assign(new Error('NO_CORRECTION'), { code: 'NO_CORRECTION' });

    const labelMap = { depthM: `深度 → ${patch.depthM ?? target.depthM}m`, sealedAt: `封存时间 → ${(patch.sealedAt || target.sealedAt).replace('.000Z', 'Z')}` };
    const wasReceived = target.status === STATUS.RECEIVED;
    const voidedReceipts = [];

    if (wasReceived) {
      // 原接收结论作废（旧档保留 void=true），样本重排回送检清单等待另一人重新核对
      for (const receipt of db.receipts.filter((r) => r.sampleId === target.id && !r.void)) {
        receipt.void = true;
        receipt.voidedAt = store.nowIso();
        receipt.voidReason = reason;
        voidedReceipts.push(receipt.id);
      }
      target.receiptId = null;
      target.status = STATUS.SUBMITTED;
    }
    if (patch.depthM !== undefined) target.depthM = patch.depthM;
    if (patch.sealedAt) target.sealedAt = patch.sealedAt;
    target.updatedAt = store.nowIso();
    pushHistory(
      target,
      '关键字段更正',
      operator,
      `${changes.map((c) => labelMap[c]).join('；')}；原因：${reason}${wasReceived ? '；原接收结论已作废，重新进入送检清单' : ''}`
    );
    return { sample: target, voidedReceipts };
  }).catch((err) => {
    if (err.code) return { errCode: err.code };
    throw err;
  });
  if (out.errCode) return fail(res, out.errCode);
  res.json(out);
});

/* ---------- 旧档：全部接收结论（含已作废）---------- */

app.get('/api/receipts', async (req, res) => {
  const db = await store.snapshot();
  let receipts = [...db.receipts];
  if (req.query.void === 'true') receipts = receipts.filter((r) => r.void);
  if (req.query.void === 'false') receipts = receipts.filter((r) => !r.void);
  if (req.query.sampleId) receipts = receipts.filter((r) => r.sampleId === req.query.sampleId);
  res.json({ receipts: sortNewest(receipts) });
});

app.use((err, req, res, next) => {
  res.status(500).json({ error: '服务器内部错误', detail: err.message });
});

app.listen(PORT, () => {
  console.log(`沉积层样本链系统 running at http://localhost:${PORT}`);
});
