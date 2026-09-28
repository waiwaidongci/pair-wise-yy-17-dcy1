/**
 * 样本链判定规则层（纯函数，无存储、无 DOM 依赖）
 * 服务端（Node）与页面（浏览器）共用同一份规则，避免两处口径不一致。
 * UMD：Node 下 module.exports，浏览器下挂 window.ChainRules。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChainRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STATUS = Object.freeze({
    INTRANSIT: 'intransit', // 在途：已登记，尚未完成运输核验
    SUBMITTED: 'submitted', // 送检清单中：运输核验合格，待实验室接收
    PENDING: 'pending',     // 待处理：运输/复检判异，隔离处置
    RECEIVED: 'received'    // 已接收：实验室已核对并出具结论
  });

  // 在途口径：链条尚未闭合的样本，同钻孔同层位只允许一条
  const OPEN_STATUSES = Object.freeze([STATUS.INTRANSIT, STATUS.SUBMITTED, STATUS.PENDING]);

  const TEMP_LIMIT_C = 8;            // 冷链阈值：超过 8℃ 判异（恰好 8℃ 放行）
  const WEIGHT_TOLERANCE_G = 0.5;    // 实验室复称允许误差 ±0.5g

  // 判异原因 / 核对不符项
  const REASONS = Object.freeze({
    TEMP_EXCEEDED: '运输超温（>8℃）',
    SEAL_BROKEN: '封条破损',
    WEIGHT_MISSING: '重量缺失',
    SEAL_MISMATCH: '封条号不符',
    WEIGHT_MISMATCH: '重量不符'
  });

  const STATUS_LABEL = Object.freeze({
    intransit: '在途',
    submitted: '送检中',
    pending: '待处理',
    received: '已接收'
  });

  // 规则校验失败码 -> 面向操作人员的提示
  const ERROR_LABEL = Object.freeze({
    FIELD_REQUIRED: '必填项不完整',
    BAD_NUMBER: '数值格式不正确',
    BAD_TIME: '封存时间格式不正确',
    SAMPLE_NOT_FOUND: '样单不存在',
    NOT_INTRANSIT: '仅在途样本可做运输核验',
    NOT_PENDING: '仅待处理样本可做处置复检',
    NOT_SUBMITTED: '样本不在送检清单，不能接收',
    RECEIVER_REQUIRED: '请填写接收人',
    RECEIVER_SAME_AS_REGISTRAR: '须由登记/封存人之外的另一人核对接收',
    RECEIVER_SAME_AS_CHECKER: '接收人不能与运输核验人为同一人',
    SEAL_OBSERVED_REQUIRED: '请填写现场核对的封条号',
    WEIGHT_OBSERVED_REQUIRED: '请填写现场复称重量',
    CONCLUSION_REQUIRED: '请记录接收结论',
    REJECTION_NOTE_REQUIRED: '判不合格须填写不合格说明',
    ACCEPT_WITH_DISCREPANCY: '封条号或重量核对不符，不能判合格',
    OPERATOR_REQUIRED: '请填写更正操作人',
    REASON_REQUIRED: '请填写更正原因（留档可查）',
    NO_CORRECTION: '深度或封存时间未发生变化'
  });

  function norm(value) {
    return String(value == null ? '' : value).trim();
  }

  function horizonKey(borehole, horizon) {
    return `${norm(borehole)}||${norm(horizon)}`;
  }

  function hasWeight(weight) {
    const n = Number(weight);
    return Number.isFinite(n) && n > 0;
  }

  /** 同钻孔同层位是否已有在途（未闭合）样本：有则返回已有样单，无则 null */
  function findOpenByHorizon(samples, borehole, horizon) {
    const key = horizonKey(borehole, horizon);
    return (samples || []).find(
      (sample) => OPEN_STATUSES.includes(sample.status) && horizonKey(sample.borehole, sample.horizon) === key
    ) || null;
  }

  /**
   * 运输核验判定：
   * 运输最高温超过 8℃、封条破损、重量缺失，任一命中即不合格，转待处理。
   */
  function evaluateTransport(sample, reading) {
    const reasons = [];
    const maxTemp = Number(reading && reading.maxTemp);
    if (Number.isFinite(maxTemp) && maxTemp > TEMP_LIMIT_C) reasons.push('TEMP_EXCEEDED');
    if (reading && reading.sealIntact === false) reasons.push('SEAL_BROKEN');
    if (!hasWeight(sample && sample.weightG)) reasons.push('WEIGHT_MISSING');
    return { passed: reasons.length === 0, reasons };
  }

  /** 实验室接收前的人员回避校验（另一人核对） */
  function receiveChecks(sample, input, lastChecker) {
    const errors = [];
    if (!sample || sample.status !== STATUS.SUBMITTED) errors.push('NOT_SUBMITTED');
    const receiver = norm(input && input.receiver);
    if (!receiver) errors.push('RECEIVER_REQUIRED');
    if (receiver && receiver === norm(sample && sample.registrar)) errors.push('RECEIVER_SAME_AS_REGISTRAR');
    if (receiver && lastChecker && receiver === norm(lastChecker)) errors.push('RECEIVER_SAME_AS_CHECKER');
    if (!norm(input && input.sealNoObserved)) errors.push('SEAL_OBSERVED_REQUIRED');
    if (!hasWeight(input && input.weightObservedG)) errors.push('WEIGHT_OBSERVED_REQUIRED');
    if (!norm(input && input.conclusion)) errors.push('CONCLUSION_REQUIRED');
    return errors;
  }

  /** 封条号与重量逐项核对 */
  function evaluateReceipt(sample, input) {
    const sealMatch = norm(input.sealNoObserved) !== '' && norm(input.sealNoObserved) === norm(sample.sealNo);
    const observed = Number(input.weightObservedG);
    const expected = Number(sample.weightG);
    const weightDiff = hasWeight(observed) && hasWeight(expected) ? Math.abs(observed - expected) : null;
    const weightMatch = weightDiff !== null && weightDiff <= WEIGHT_TOLERANCE_G;
    const discrepancies = [];
    if (!sealMatch) discrepancies.push('SEAL_MISMATCH');
    if (!weightMatch) discrepancies.push('WEIGHT_MISMATCH');
    return { sealMatch, weightMatch, weightDiff, matched: sealMatch && weightMatch, discrepancies };
  }

  /** 核对不符时禁止判合格；判不合格必须有说明 */
  function conclusionErrors(evaluation, input) {
    const errors = [];
    if (input.conclusion === 'accepted' && !evaluation.matched) errors.push('ACCEPT_WITH_DISCREPANCY');
    if (input.conclusion === 'rejected' && !norm(input.note)) errors.push('REJECTION_NOTE_REQUIRED');
    return errors;
  }

  /** 找出本次更正真正变动的关键字段（深度 / 封存时间） */
  function correctionChanges(sample, patch) {
    const changed = [];
    if (patch.depthM !== undefined && Number(patch.depthM) !== Number(sample.depthM)) changed.push('depthM');
    const nextTime = patch.sealedAt ? new Date(patch.sealedAt).getTime() : null;
    if (patch.sealedAt !== undefined && Number.isFinite(nextTime) && nextTime !== new Date(sample.sealedAt).getTime()) {
      changed.push('sealedAt');
    }
    return changed;
  }

  /** 队列归属：主队列（在途/送检）或待处理队列；已接收不在两个队列中 */
  function queueOf(status) {
    if (status === STATUS.PENDING) return 'pending';
    if (status === STATUS.INTRANSIT || status === STATUS.SUBMITTED) return 'main';
    return 'archived';
  }

  return {
    STATUS,
    OPEN_STATUSES,
    TEMP_LIMIT_C,
    WEIGHT_TOLERANCE_G,
    REASONS,
    STATUS_LABEL,
    ERROR_LABEL,
    norm,
    horizonKey,
    hasWeight,
    findOpenByHorizon,
    evaluateTransport,
    receiveChecks,
    evaluateReceipt,
    conclusionErrors,
    correctionChanges,
    queueOf
  };
});
