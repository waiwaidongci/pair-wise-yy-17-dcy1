/* 登记页：提交建样；命中「同层位在途」时展示返回的已有样单，不新建。 */
(function () {
  'use strict';
  const { api, toast, escapeHtml, fmtDate, statusPill, renderNav, toLocalInput } = window.UI;

  const form = document.getElementById('registerForm');
  const resultEl = document.getElementById('result');

  form.sealedAt.value = toLocalInput(new Date().toISOString());

  function resultCard(payload) {
    const s = payload.sample;
    const banner = payload.duplicate
      ? `<div class="dup-banner">该钻孔同层位已有一条在途样本，未重复建样，以下为已有样单：</div>`
      : `<div class="ok-banner">登记成功，样单已进入「在途」队列：</div>`;
    resultEl.innerHTML = `${banner}
      <article class="sample-card status-${escapeHtml(s.status)}">
        <div class="card-head"><h3>${escapeHtml(s.code)}</h3>${statusPill(s.status)}</div>
        <div class="kv-grid">
          <div class="kv"><span>钻孔</span><strong>${escapeHtml(s.borehole)}</strong></div>
          <div class="kv"><span>层位</span><strong>${escapeHtml(s.horizon)}</strong></div>
          <div class="kv"><span>深度</span><strong>${s.depthM == null ? '<em>缺失</em>' : Number(s.depthM) + ' m'}</strong></div>
          <div class="kv"><span>重量</span><strong>${s.weightG == null ? '<em>缺失</em>' : Number(s.weightG) + ' g'}</strong></div>
          <div class="kv"><span>封条号</span><strong>${escapeHtml(s.sealNo)}</strong></div>
          <div class="kv"><span>封存时间</span><strong>${escapeHtml(fmtDate(s.sealedAt))}</strong></div>
          <div class="kv"><span>登记/封存人</span><strong>${escapeHtml(s.registrar)}</strong></div>
        </div>
        <p class="note"><a href="/">前往队列看板 →</a></p>
      </article>`;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    data.depthM = data.depthM === '' ? undefined : Number(data.depthM);
    data.weightG = data.weightG === '' || data.weightG == null ? null : Number(data.weightG);
    try {
      const payload = await api('/api/samples', { method: 'POST', body: JSON.stringify(data) });
      resultCard(payload);
      if (payload.duplicate) toast('同层位已有在途样本，已返回已有样单', 'error');
      else {
        toast('登记成功');
        form.reset();
        form.sealedAt.value = toLocalInput(new Date().toISOString());
      }
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  renderNav('/register.html');
})();
