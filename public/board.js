/* 队列看板页：两个队列同屏，操作后整体刷新。 */
(function () {
  'use strict';
  const { api, toast, renderNav } = window.UI;
  const { STATUS } = window.ChainRules;

  const mainEl = document.getElementById('list-main');
  const pendingEl = document.getElementById('list-pending');
  const statsEl = document.getElementById('stats');

  const EMPTY = {
    main: '<div class="empty">暂无在途/待送检样本，去「登记钻孔」建样。</div>',
    pending: '<div class="empty">待处理队列为空。</div>'
  };

  const DONE_MESSAGE = {
    transport: '运输核验已记录',
    receive: '实验室接收结论已记录',
    recheck: '处置复检已记录',
    correct: '更正已保存'
  };

  function renderStats(samples) {
    const count = (status) => samples.filter((s) => s.status === status).length;
    const items = [
      { label: '在途', value: count(STATUS.INTRANSIT), tone: STATUS.INTRANSIT },
      { label: '送检清单', value: count(STATUS.SUBMITTED), tone: STATUS.SUBMITTED },
      { label: '待处理', value: count(STATUS.PENDING), tone: STATUS.PENDING },
      { label: '已接收', value: count(STATUS.RECEIVED), tone: STATUS.RECEIVED }
    ];
    statsEl.innerHTML = items.map((i) =>
      `<div class="stat stat-${i.tone}"><span>${i.label}</span><strong>${i.value}</strong></div>`
    ).join('');
  }

  function renderQueue(el, samples, empty) {
    el._samples = samples;
    el.innerHTML = samples.length ? samples.map(window.Cards.renderCard).join('') : empty;
  }

  async function load() {
    const [{ samples }, pendingData] = await Promise.all([
      api('/api/samples?queue=main'),
      api('/api/samples?queue=pending')
    ]);
    renderStats([...samples, ...pendingData.samples]);
    document.getElementById('count-main').textContent = samples.length;
    document.getElementById('count-pending').textContent = pendingData.samples.length;
    renderQueue(mainEl, samples, EMPTY.main);
    renderQueue(pendingEl, pendingData.samples, EMPTY.pending);
  }

  mainEl._samples = [];
  pendingEl._samples = [];
  window.Cards.bindCards(document, async (kind) => {
    await load();
    toast(DONE_MESSAGE[kind] || '已更新');
  });

  renderNav('/');
  load().catch((err) => toast(err.message, 'error'));
})();
