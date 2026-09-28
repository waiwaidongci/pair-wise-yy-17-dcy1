/* 旧档页：已接收样本 + 全部接收结论（含更正后作废的旧档）。 */
(function () {
  'use strict';
  const { api, toast, escapeHtml, fmtDate, renderNav, reasonText } = window.UI;

  const listEl = document.getElementById('receivedList');
  const rowsEl = document.getElementById('receiptRows');
  const sampleSearch = document.getElementById('sampleSearch');
  const receiptSearch = document.getElementById('receiptSearch');
  const receiptFilter = document.getElementById('receiptFilter');

  let samples = [];
  let receipts = [];

  function weightCell(r) {
    if (r.weightExpectedG == null) return '<em>登记重量缺失</em>';
    const diff = r.weightDiffG == null ? '-' : `${Number(r.weightDiffG) > 0 ? '+' : ''}${Number(r.weightDiffG)}g`;
    const ok = !r.discrepancies.includes('WEIGHT_MISMATCH');
    return `<span class="${ok ? 'match-ok' : 'match-bad'}">${ok ? '✓' : '✗'} ${Number(r.weightObservedG)}g / 期望 ${Number(r.weightExpectedG)}g（差 ${diff}）</span>`;
  }

  function sealCell(r) {
    const ok = !r.discrepancies.includes('SEAL_MISMATCH');
    return `<span class="${ok ? 'match-ok' : 'match-bad'}">${ok ? '✓' : '✗'} ${escapeHtml(r.sealNoObserved)}</span>`;
  }

  function renderReceipts() {
    const q = receiptSearch.value.trim();
    const voidMode = receiptFilter.value;
    let list = [...receipts];
    if (voidMode === 'true') list = list.filter((r) => r.void);
    if (voidMode === 'false') list = list.filter((r) => !r.void);
    if (q) {
      list = list.filter((r) => r.sampleCode.includes(q) || (r.receiver || '').includes(q) || (r.note || '').includes(q));
    }
    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (!list.length) {
      rowsEl.innerHTML = '<tr><td colspan="7" class="empty">暂无符合条件的结论记录</td></tr>';
      return;
    }
    rowsEl.innerHTML = list.map((r) => {
      const conclusion = r.conclusion === 'accepted'
        ? '<span class="pill pill-accepted">合格接收</span>'
        : '<span class="pill pill-rejected">不合格</span>';
      const state = r.void
        ? `<span class="pill pill-void">已作废</span>${r.voidReason ? `<p class="void-reason">${escapeHtml(fmtDate(r.voidedAt))} · ${escapeHtml(r.voidReason)}</p>` : ''}`
        : '<span class="pill pill-current">现行有效</span>';
      return `<tr class="${r.void ? 'row-void' : ''}">
        <td>${escapeHtml(fmtDate(r.createdAt))}</td>
        <td>${escapeHtml(r.sampleCode)}</td>
        <td>${escapeHtml(r.receiver)}</td>
        <td>${sealCell(r)}</td>
        <td>${weightCell(r)}</td>
        <td>${conclusion}${r.note ? `<p class="void-reason">${escapeHtml(r.note)}</p>` : ''}</td>
        <td>${state}</td>
      </tr>`;
    }).join('');
  }

  function renderSamples() {
    const q = sampleSearch.value.trim();
    let list = samples.filter((s) => s.status === 'received');
    if (q) {
      list = list.filter((s) =>
        [s.code, s.borehole, s.horizon, s.registrar, s.receiptId].some((v) => String(v || '').includes(q))
      );
    }
    listEl._samples = list;
    listEl.innerHTML = list.length
      ? list.map(window.Cards.renderCard).join('')
      : '<div class="empty">暂无已接收样本。</div>';
  }

  async function load() {
    const [smpData, rcpData] = await Promise.all([
      api('/api/samples?queue=received'),
      api('/api/receipts')
    ]);
    samples = smpData.samples;
    receipts = rcpData.receipts;
    renderSamples();
    renderReceipts();
  }

  window.Cards.bindCards(document, async (kind) => {
    await load();
    if (kind === 'correct') toast('更正已保存：原结论已作废，样本回到看板送检队列等待重新接收');
    else toast('已更新');
  });

  [sampleSearch].forEach((el) => el.addEventListener('input', renderSamples));
  [receiptSearch, receiptFilter].forEach((el) => el.addEventListener('input', renderReceipts));

  renderNav('/archive.html');
  load().catch((err) => toast(err.message, 'error'));
})();
