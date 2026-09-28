/* 样本卡片与操作表单（运输核验 / 实验室接收 / 处置复检 / 字段更正）。看板页与旧档页复用。 */
(function () {
  'use strict';
  const { escapeHtml, fmtDate, reasonText, statusPill } = window.UI;
  const { STATUS, REASONS } = window.ChainRules;

  function field(label, value) {
    return `<div class="kv"><span>${escapeHtml(label)}</span><strong>${value}</strong></div>`;
  }

  function reasonBadges(keys) {
    if (!keys || !keys.length) return '';
    return `<div class="badges">${keys.map((k) => `<b class="badge">${escapeHtml(reasonText(k))}</b>`).join('')}</div>`;
  }

  function historyHtml(history) {
    if (!history || !history.length) return '';
    return `<details class="history"><summary>链上记录 ${history.length} 条</summary>` +
      [...history].reverse().map((h) => `
        <div class="history-item">
          <time>${escapeHtml(fmtDate(h.at))}</time>
          <div><strong>${escapeHtml(h.action)}</strong>${h.operator ? ` · ${escapeHtml(h.operator)}` : ''}${h.note ? `<p>${escapeHtml(h.note)}</p>` : ''}</div>
        </div>`).join('') +
      `</details>`;
  }

  function actionButtons(sample) {
    const buttons = [];
    if (sample.status === STATUS.INTRANSIT) {
      buttons.push(`<button class="btn primary" data-act="transport" data-id="${sample.id}">运输核验</button>`);
    }
    if (sample.status === STATUS.SUBMITTED) {
      buttons.push(`<button class="btn primary" data-act="receive" data-id="${sample.id}">实验室接收</button>`);
    }
    if (sample.status === STATUS.PENDING) {
      buttons.push(`<button class="btn warn" data-act="recheck" data-id="${sample.id}">处置复检</button>`);
    }
    buttons.push(`<button class="btn ghost" data-act="correct" data-id="${sample.id}">更正深度/封存时间</button>`);
    return `<div class="card-actions">${buttons.join('')}</div>`;
  }

  function renderCard(sample) {
    const qc = sample.lastQc;
    const qcLine = qc
      ? field('运输核验',
          `${qc.passed ? '通过' : '判异'} · 最高温 ${qc.maxTemp ?? '-'}℃ · ${qc.sealIntact ? '封条完好' : '封条破损'} · ${escapeHtml(qc.checker || '-')}`)
      : field('运输核验', '未核验');
    return `<article class="sample-card status-${escapeHtml(sample.status)}" data-id="${sample.id}">
      <div class="card-head">
        <h3>${escapeHtml(sample.code)}</h3>
        ${statusPill(sample.status)}
      </div>
      ${reasonBadges(qc && qc.passed === false ? qc.reasons : [])}
      <div class="kv-grid">
        ${field('钻孔', escapeHtml(sample.borehole))}
        ${field('层位', escapeHtml(sample.horizon))}
        ${field('深度', sample.depthM == null ? '<em>缺失</em>' : `${Number(sample.depthM)} m`)}
        ${field('重量', sample.weightG == null ? '<em>缺失</em>' : `${Number(sample.weightG)} g`)}
        ${field('封条号', escapeHtml(sample.sealNo))}
        ${field('封存时间', escapeHtml(fmtDate(sample.sealedAt)))}
        ${field('登记/封存人', escapeHtml(sample.registrar))}
        ${qcLine}
      </div>
      ${sample.note ? `<p class="note">${escapeHtml(sample.note)}</p>` : ''}
      ${actionButtons(sample)}
      ${historyHtml(sample.history)}
    </article>`;
  }

  /* ---------- 操作表单（内联展开在卡片下方）---------- */

  function transportForm(sample) {
    return `<form class="inline-form" data-form="transport" data-id="${sample.id}">
      <h4>运输核验（到库后记录冷链与封条）</h4>
      <div class="form-row">
        <label>运输最高温 ℃<input name="maxTemp" type="number" step="0.1" required placeholder="如 6.8"></label>
        <label>封条状态
          <select name="sealIntact" required>
            <option value="true">完好</option>
            <option value="false">破损</option>
          </select>
        </label>
        <label>核验人<input name="checker" required placeholder="须不同于接收人"></label>
      </div>
      <p class="form-hint">最高温超过 8℃、封条破损或登记重量缺失，任一项命中即转「待处理」，不进送检清单。</p>
      <div class="form-actions"><button class="btn primary">提交核验</button><button type="button" class="btn ghost" data-cancel>取消</button></div>
    </form>`;
  }

  function receiveForm(sample) {
    const checker = sample.lastQc && sample.lastQc.checker;
    return `<form class="inline-form" data-form="receive" data-id="${sample.id}">
      <h4>实验室接收（由另一人核对封条号与重量并记结论）</h4>
      <div class="form-row">
        <label>接收人<input name="receiver" required placeholder="不能是 ${escapeHtml(sample.registrar)}${checker ? ' 或 ' + escapeHtml(checker) : ''}"></label>
        <label>现场封条号<input name="sealNoObserved" required value="${escapeHtml(sample.sealNo)}" placeholder="逐字符核对"></label>
        <label>现场复称重量 g<input name="weightObservedG" type="number" step="0.1" required value="${sample.weightG == null ? '' : Number(sample.weightG)}"></label>
      </div>
      <div class="form-row">
        <label>结论
          <select name="conclusion" required>
            <option value="accepted">合格接收</option>
            <option value="rejected">不合格（退回待处理）</option>
          </select>
        </label>
        <label class="grow">结论说明 / 不合格原因<input name="note" placeholder="判不合格时必填"></label>
      </div>
      <p class="form-hint">封条号或重量不符（容差 ±${window.ChainRules.WEIGHT_TOLERANCE_G}g）时不能判合格，系统将退回待处理并留档本次结论。</p>
      <div class="form-actions"><button class="btn primary">提交接收</button><button type="button" class="btn ghost" data-cancel>取消</button></div>
    </form>`;
  }

  function recheckForm(sample) {
    const reasons = (sample.lastQc && sample.lastQc.reasons) || [];
    const needTemp = reasons.includes('TEMP_EXCEEDED');
    const needSeal = reasons.includes('SEAL_BROKEN') || reasons.includes('SEAL_MISMATCH');
    const needWeight = reasons.includes('WEIGHT_MISSING') || reasons.includes('WEIGHT_MISMATCH');
    return `<form class="inline-form" data-form="recheck" data-id="${sample.id}">
      <h4>待处理处置复检</h4>
      <p class="form-hint">待解缺陷：${reasons.map((k) => escapeHtml(REASONS[k])).join('、') || '复检确认'}</p>
      <div class="form-row">
        <label>处置方式
          <select name="action" required>
            <option value="ok">冷链恢复，继续送检</option>
            <option value="resealed">重新封样（更换封条）</option>
            <option value="replaced">样本替换/重新取样</option>
          </select>
        </label>
        ${needTemp ? `<label>当前/复测温度 ℃<input name="maxTemp" type="number" step="0.1" placeholder="须 ≤ 8"></label>` : ''}
        ${needSeal ? `<label>新封条号<input name="newSealNo" placeholder="重新封样必填"></label>` : ''}
        ${needWeight ? `<label>重新称重 g<input name="newWeightG" type="number" step="0.1" placeholder="补称后重量"></label>` : ''}
        <label class="grow">封条现状
          <select name="sealIntact" required>
            <option value="true">已完好</option>
            <option value="false">仍破损</option>
          </select>
        </label>
      </div>
      <div class="form-row">
        <label>处置人<input name="operator" required></label>
        <label class="grow">处置说明（留痕）<input name="note" required placeholder="缺陷如何解除，或为何继续隔离"></label>
      </div>
      <p class="form-hint">缺陷全部解除才会重新进入送检清单；仍有未解除项则继续留在待处理队列。</p>
      <div class="form-actions"><button class="btn warn">提交复检</button><button type="button" class="btn ghost" data-cancel>取消</button></div>
    </form>`;
  }

  function correctForm(sample) {
    return `<form class="inline-form" data-form="correct" data-id="${sample.id}">
      <h4>更正深度 / 封存时间</h4>
      <div class="form-row">
        <label>更正后深度 m<input name="depthM" type="number" step="0.01" value="${sample.depthM == null ? '' : Number(sample.depthM)}"></label>
        <label>更正后封存时间<input name="sealedAt" type="datetime-local" step="60" value="${window.UI.toLocalInput(sample.sealedAt)}"></label>
        <label>更正操作人<input name="operator" required></label>
      </div>
      <div class="form-row">
        <label class="grow">更正原因（随旧结论归档）<input name="reason" required placeholder="如：核对钻孔柱状图发现深度少记 0.2m"></label>
      </div>
      ${sample.status === STATUS.RECEIVED
        ? '<p class="form-hint warn-hint">该样本已有接收结论：保存后原结论立即作废（旧档可查），样本重排回送检清单，须由另一人重新核对接收。</p>'
        : '<p class="form-hint">仅深度或封存时间发生变化时可保存。</p>'}
      <div class="form-actions"><button class="btn primary">保存更正</button><button type="button" class="btn ghost" data-cancel>取消</button></div>
    </form>`;
  }

  const FORMS = { transport: transportForm, receive: receiveForm, recheck: recheckForm, correct: correctForm };

  function openForm(card, kind, sample) {
    closeForms(card);
    card.insertAdjacentHTML('beforeend', FORMS[kind](sample));
  }

  function closeForms(scope) {
    (scope || document).querySelectorAll('.inline-form').forEach((f) => f.remove());
  }

  /**
   * 绑定卡片内所有操作按钮与表单提交。onDone 为任一操作成功后的回调（用于刷新）。
   */
  function bindCards(root, onDone) {
    root.addEventListener('click', (event) => {
      if (event.target.closest('[data-cancel]')) {
        closeForms(event.target.closest('.sample-card'));
        return;
      }
      const btn = event.target.closest('[data-act]');
      if (!btn) return;
      const card = btn.closest('.sample-card');
      const sample = root._samples && root._samples.find((s) => s.id === btn.dataset.id);
      if (!sample) return;
      openForm(card, btn.dataset.act, sample);
    });

    root.addEventListener('submit', async (event) => {
      const form = event.target.closest('.inline-form');
      if (!form || !root.contains(form)) return;
      event.preventDefault();
      const id = form.dataset.id;
      const kind = form.dataset.form;
      const data = Object.fromEntries(new FormData(form).entries());
      try {
        if (kind === 'transport') {
          await window.UI.api(`/api/samples/${id}/transport`, { method: 'POST', body: JSON.stringify({ ...data, sealIntact: form.sealIntact.value === 'true' }) });
        } else if (kind === 'receive') {
          await window.UI.api(`/api/samples/${id}/receive`, {
            method: 'POST',
            body: JSON.stringify({ ...data, weightObservedG: data.weightObservedG === '' ? null : Number(data.weightObservedG) })
          });
        } else if (kind === 'recheck') {
          await window.UI.api(`/api/samples/${id}/recheck`, {
            method: 'POST',
            body: JSON.stringify({
              ...data,
              sealIntact: form.sealIntact ? form.sealIntact.value === 'true' : true,
              maxTemp: data.maxTemp === '' || data.maxTemp == null ? null : Number(data.maxTemp),
              newWeightG: data.newWeightG === '' || data.newWeightG == null ? null : Number(data.newWeightG)
            })
          });
        } else if (kind === 'correct') {
          await window.UI.api(`/api/samples/${id}/correction`, {
            method: 'PATCH',
            body: JSON.stringify({
              depthM: data.depthM === '' ? undefined : Number(data.depthM),
              sealedAt: data.sealedAt || undefined,
              operator: data.operator,
              reason: data.reason
            })
          });
        }
        await onDone(kind);
      } catch (error) {
        window.UI.toast(error.message, 'error');
      }
    });
  }

  window.Cards = { renderCard, bindCards, closeForms };
})();
