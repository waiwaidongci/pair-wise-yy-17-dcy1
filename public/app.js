const state = {
  config: null,
  db: {},
  board: null,
  activeTab: ''
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fmtDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1800);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || '请求失败');
  }
  if (res.status === 204) return null;
  return res.json();
}

function valueByPath(source, pathName) {
  return pathName.split('.').reduce((value, key) => value?.[key], source);
}

function displayField(item, field) {
  const value = item[field.name] ?? '';
  if (field.type === 'select' && field.options) return value || field.options[0];
  return value;
}

function collectionLabel(collection) {
  return state.config.collections[collection]?.label || collection;
}

function relationLabel(relation, id) {
  const item = state.db[relation.collection]?.find((entry) => entry.id === id);
  if (!item) return '未关联';
  return relation.labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
}

function optionList(items, labelFields) {
  return items.map((item) => {
    const label = labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
    return `<option value="${item.id}">${escapeHtml(label)}</option>`;
  }).join('');
}

function formField(field) {
  const required = field.required ? 'required' : '';
  const value = field.default ? `value="${escapeHtml(field.default)}"` : '';
  if (field.type === 'textarea') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<textarea name="${field.name}" ${required}></textarea></label>`;
  }
  if (field.type === 'select') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${field.options.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}</select></label>`;
  }
  if (field.type === 'relation') {
    const items = state.db[field.collection] || [];
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${optionList(items, field.labelFields)}</select></label>`;
  }
  return `<label class="${field.wide ? 'wide' : ''}">${field.label}<input type="${field.type || 'text'}" name="${field.name}" ${value} ${required}></label>`;
}

function pill(value, tone = '') {
  return `<span class="pill ${tone}">${escapeHtml(value || '-')}</span>`;
}

function toneFor(value) {
  return state.config.tones?.[value] || '';
}

function historyHtml(item) {
  const history = item.history || [];
  if (!history.length) return '';
  return `<div class="history">${history.slice(0, 5).map((entry) => `
    <div class="history-item"><span>${fmtDate(entry.at)}</span><span>${escapeHtml(entry.action)}${entry.note ? '：' + escapeHtml(entry.note) : ''}</span></div>
  `).join('')}</div>`;
}

function values(form, view) {
  const payload = Object.fromEntries(new FormData(form).entries());
  for (const field of view.fields) {
    if (field.type === 'number') payload[field.name] = Number(payload[field.name] || 0);
  }
  return { ...view.defaults, ...payload };
}

function renderTabs() {
  $('#tabs').innerHTML = state.config.views.map((view, index) => `
    <button class="tab${index === 0 ? ' active' : ''}" data-tab="${view.id}">${escapeHtml(view.label)}</button>
  `).join('');
  state.activeTab = state.config.views[0].id;
}

function setTab(tabId) {
  state.activeTab = tabId;
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabId));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === tabId));
}

function renderStats() {
  return `<div class="stats">${state.config.stats.map((stat) => {
    const items = state.db[stat.collection] || [];
    const value = stat.filter ? items.filter((item) => item[stat.filter.field] === stat.filter.value).length : items.length;
    return `<div class="stat"><span>${escapeHtml(stat.label)}</span><strong>${value}</strong></div>`;
  }).join('')}</div>`;
}

function renderCard(item, collection, view) {
  const title = view.titleFields.map((field) => item[field]).filter(Boolean).join(' / ') || item.id;
  const statusValue = item[view.statusField];
  const relation = view.relation ? `<div class="meta">${escapeHtml(relationLabel(view.relation, item[view.relation.localKey]))}</div>` : '';
  const details = (view.detailFields || []).map((field) => {
    const raw = item[field.name];
    const value = field.type === 'relation' ? relationLabel(field, raw) : raw;
    return `<div>${escapeHtml(field.label)}<br><strong>${escapeHtml(value || '-')}</strong></div>`;
  }).join('');
  const summary = (view.summaryFields || []).map((field) => item[field]).filter(Boolean).join(' · ');
  const actions = state.config.actions
    .filter((action) => action.collection === collection)
    .map((action) => `<button class="${action.danger ? 'danger' : 'ghost'}" data-action="${action.id}" data-id="${item.id}">${escapeHtml(action.label)}</button>`)
    .join('');
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(title)}</h3>${statusValue ? pill(statusValue, toneFor(statusValue)) : ''}</div>
    ${relation}
    ${summary ? `<p>${escapeHtml(summary)}</p>` : ''}
    ${details ? `<div class="detail">${details}</div>` : ''}
    ${actions ? `<div class="actions">${actions}</div>` : ''}
    ${historyHtml(item)}
  </article>`;
}

function renderList(view) {
  const collection = view.collection;
  const query = $(`#search-${view.id}`)?.value.trim() || '';
  const status = $(`#status-${view.id}`)?.value || '';
  let items = [...(state.db[collection] || [])];
  if (query) {
    items = items.filter((item) => view.searchFields.some((field) => String(item[field] || '').includes(query)));
  }
  if (status) {
    items = items.filter((item) => item[view.statusField] === status);
  }
  return items.length ? items.map((item) => renderCard(item, collection, view)).join('') : `<div class="empty">暂无${escapeHtml(collectionLabel(collection))}</div>`;
}

function renderDashboardView(view) {
  const source = view.focus;
  let items = [...(state.db[source.collection] || [])];
  if (source.field) items = items.filter((item) => source.values.includes(item[source.field]));
  items = items.slice(0, source.limit || 8);
  const cardView = state.config.views.find((entry) => entry.collection === source.collection) || source;
  return `<section class="view active" id="${view.id}">
    ${renderStats()}
    <div class="panel"><h2>${escapeHtml(view.focusTitle)}</h2><div class="list">${items.length ? items.map((item) => renderCard(item, source.collection, cardView)).join('') : '<div class="empty">暂无重点事项</div>'}</div></div>
  </section>`;
}

function renderCrudView(view) {
  const statusOptions = view.statusOptions || [];
  return `<section class="view" id="${view.id}">
    <div class="grid">
      <form class="panel" data-create="${view.collection}" data-view="${view.id}">
        <h2>${escapeHtml(view.formTitle)}</h2>
        <div class="form-grid">${view.fields.map(formField).join('')}</div>
        <div class="actions"><button>${escapeHtml(view.submitLabel || '保存')}</button></div>
      </form>
      <div class="panel">
        <h2>${escapeHtml(view.listTitle)}</h2>
        <div class="toolbar">
          <input id="search-${view.id}" placeholder="${escapeHtml(view.searchPlaceholder || '搜索')}">
          <select id="status-${view.id}">
            <option value="">全部状态</option>
            ${statusOptions.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}
          </select>
        </div>
        <div class="list" id="list-${view.id}">${renderList(view)}</div>
      </div>
    </div>
  </section>`;
}

function renderSampleChain() {
  const board = state.board;
  if (!board) return '<section class="view" id="samples"><div class="empty">队列加载中…</div></section>';
  const findQueue = (id) => board.queues.find((queue) => queue.id === id);
  return `<section class="view" id="samples">
    ${renderSampleRegisterForm()}
    <div class="board">
      <div class="board-queue queue-key">
        <div class="queue-head"><h2>送检清单</h2>${queueCount(findQueue('submission'))}</div>
        <p class="queue-hint">在途且冷链、封条、重量全部通过；由“另一人”实验室接收核对</p>
        <div class="list">${(findQueue('submission').items || []).map(renderSampleCard).join('') || emptyTip('暂无可送检样本')}</div>
      </div>
      <div class="board-queue queue-key queue-bad">
        <div class="queue-head"><h2>待处理</h2>${queueCount(findQueue('pending'))}</div>
        <p class="queue-hint">温度超过8℃ / 封条破损 / 重量缺失 / 核对不合格，不进送检清单</p>
        <div class="list">${(findQueue('pending').items || []).map(renderSampleCard).join('') || emptyTip('暂无待处理样本')}</div>
      </div>
      <div class="board-queue">
        <div class="queue-head"><h2>待发运（已登记）</h2>${queueCount(findQueue('ready'))}</div>
        <div class="list">${(findQueue('ready').items || []).map(renderSampleCard).join('') || emptyTip('暂无已登记样本')}</div>
      </div>
      <div class="board-queue">
        <div class="queue-head"><h2>已接收 / 已归档</h2>${queueCount(findQueue('archived'))}</div>
        <p class="queue-hint">深度或封存时间更正后回到送检清单，旧结论在下方旧档可查</p>
        <div class="list">${(findQueue('archived').items || []).map(renderSampleCard).join('') || emptyTip('暂无已归档样本')}</div>
      </div>
    </div>
  </section>`;
}

function queueCount(queue) {
  const n = (queue?.items || []).length;
  return `<span class="queue-count">${n}</span>`;
}

function emptyTip(text) {
  return `<div class="empty">${escapeHtml(text)}</div>`;
}

function localDateTimeValue(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (num) => String(num).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function nowLocalInput() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function renderSampleRegisterForm() {
  return `<form class="panel register-form" data-chain="register">
    <h2>登记样本 <span class="form-hint">同钻孔同层位只准一条在途样本，重复登记将返回已有样单</span></h2>
    <div class="form-grid">
      <label>钻孔编号<input name="borehole" required placeholder="如 ZK-01"></label>
      <label>层位<input name="horizon" required placeholder="如 L2 钙华层"></label>
      <label>深度（米）<input name="depth" type="number" step="0.01" required></label>
      <label>封存时间<input name="sealedAt" type="datetime-local" step="60" value="${nowLocalInput()}" required></label>
      <label>封条号<input name="sealNo" required placeholder="如 FB-3301"></label>
      <label>封存重量（g，可后补）<input name="weight" type="number" step="0.1"></label>
      <label>登记人<input name="registrar" required placeholder="现场登记，须与接收人不同"></label>
    </div>
    <div class="actions"><button>登记建样</button></div>
  </form>`;
}

function renderSampleCard(sample) {
  const weightText = sample.weight === null || sample.weight === undefined ? '缺失' : `${sample.weight}g`;
  const tempText = sample.transportTemp === null || sample.transportTemp === undefined ? '-' : `${sample.transportTemp}℃`;
  const failHtml = sample.failReasons?.length
    ? `<div class="fail-note">${sample.failReasons.map((reason) => `• ${escapeHtml(reason)}`).join('<br>')}</div>`
    : '';
  return `<article class="card sample-card">
    <div class="card-head">
      <h3>${escapeHtml(sample.sampleCode)}</h3>
      ${pill(sample.status, toneFor(sample.status))}
    </div>
    <div class="sample-fields">
      <div><span>钻孔</span><strong>${escapeHtml(sample.borehole)}</strong></div>
      <div><span>层位</span><strong>${escapeHtml(sample.horizon)}</strong></div>
      <div><span>深度</span><strong>${escapeHtml(sample.depth)}m</strong></div>
      <div><span>封存时间</span><strong>${escapeHtml(sample.sealedAt.replace('T', ' '))}</strong></div>
      <div><span>封条号</span><strong>${escapeHtml(sample.sealNo)}</strong></div>
      <div><span>重量</span><strong>${weightText}</strong></div>
      <div><span>运输温度</span><strong>${tempText}</strong></div>
      <div><span>登记人 / 运输人</span><strong>${escapeHtml([sample.registrar, sample.carrier].filter(Boolean).join(' / ') || '-')}</strong></div>
    </div>
    ${failHtml}
    ${sample.activeReceipt ? renderActiveReceipt(sample) : ''}
    ${renderSampleArchive(sample)}
    ${renderSampleActions(sample)}
    ${historyHtml(sample)}
  </article>`;
}

function renderActiveReceipt(sample) {
  const r = sample.activeReceipt;
  return `<div class="receipt">
    <div class="receipt-head">接收结论 ${pill(r.conclusion, toneFor(r.conclusion))}</div>
    <div class="sample-fields">
      <div><span>核对人</span><strong>${escapeHtml(r.receiver)}</strong></div>
      <div><span>封条核对</span><strong>${r.sealMatch ? '相符' : '不符'}</strong></div>
      <div><span>重量核对</span><strong>${r.weightMatch ? '相符' : '不符'}</strong></div>
      <div><span>核对时间</span><strong>${fmtDate(r.at)}</strong></div>
    </div>
  </div>`;
}

function renderSampleArchive(sample) {
  const archive = sample.archive || [];
  if (!archive.length) return '';
  return `<div class="archive"><div class="archive-title">旧档（${archive.length}份，已失效仅备查）</div>${archive.map((r) => `
    <div class="archive-item">
      <span>${fmtDate(r.at)} · ${escapeHtml(r.receiver)} · ${escapeHtml(r.conclusion)} · 第${r.revision || 1}轮${r.supersededAt ? ` · ${fmtDate(r.supersededAt)} 失效` : ''}</span>
      ${r.supersedeReason ? `<small>${escapeHtml(r.supersedeReason)}</small>` : ''}
      <small>${escapeHtml(r.note || '')}</small>
    </div>`).join('')}
  </div>`;
}

function renderSampleActions(sample) {
  if (sample.status === '已登记' || sample.status === '待处理') {
    return `<form class="mini-form" data-chain="dispatch" data-id="${sample.id}">
      <div class="mini-title">${sample.status === '待处理' ? '整改后重新发运核对' : '发运核对'}（温度&gt;8℃ / 封条破损 / 重量缺失 → 待处理）</div>
      <div class="mini-grid">
        <label>运输温度℃<input name="transportTemp" type="number" step="0.1" value="${sample.transportTemp ?? ''}" required></label>
        <label>封条状态<select name="sealBroken">${['完好', '破损'].map((label, i) => `<option value="${i}"${sample.sealBroken && i === 1 ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
        <label>实测重量g<input name="weight" type="number" step="0.1" value="${sample.weight ?? ''}"></label>
        <label>运输人<input name="carrier" value="${escapeHtml(sample.carrier || '')}" placeholder="须与接收人不同" required></label>
      </div>
      <div class="actions"><button class="ghost">${sample.status === '待处理' ? '重新核对发运' : '核对发运'}</button></div>
    </form>`;
  }
  if (sample.status === '在途' || sample.status === '待重核') {
    return `<form class="mini-form" data-chain="receive" data-id="${sample.id}">
      ${sample.status === '待重核' ? '<div class="recheck-banner">关键字段已更正，原结论失效，请由另一人重新核对后重排</div>' : ''}
      <div class="mini-title">实验室接收核对（须由登记人/运输人之外的另一人填写）</div>
      <div class="mini-grid">
        <label>封条号核对<input name="receivedSealNo" placeholder="原封条号 ${escapeHtml(sample.sealNo)}" required></label>
        <label>重量核对g<input name="receivedWeight" type="number" step="0.1" placeholder="登记 ${sample.weight ?? '-'}g" required></label>
        <label>接收核对人<input name="receiver" placeholder="不得为 ${escapeHtml([sample.registrar, sample.carrier].filter(Boolean).join('、'))}" required></label>
      </div>
      <div class="actions"><button class="ghost">提交接收结论</button></div>
    </form>`;
  }
  return `<form class="mini-form" data-chain="correct" data-id="${sample.id}">
    <div class="mini-title">深度 / 封存时间更正（提交后原结论失效并重排送检，旧档保留）</div>
    <div class="mini-grid">
      <label>更正深度（米）<input name="depth" type="number" step="0.01" value="${escapeHtml(sample.depth)}" required></label>
      <label>更正封存时间<input name="sealedAt" type="datetime-local" step="60" value="${localDateTimeValue(sample.sealedAt)}" required></label>
    </div>
    <div class="actions"><button class="ghost">更正并重排</button></div>
  </form>`;
}

function render() {
  $('#title').textContent = state.config.title;
  document.title = state.config.title;
  $('#lede').textContent = state.config.lede;
  $('#main').innerHTML = state.config.views.map((view) => {
    if (view.type === 'sample-chain') return renderSampleChain();
    return view.type === 'dashboard' ? renderDashboardView(view) : renderCrudView(view);
  }).join('');
  setTab(state.activeTab || state.config.views[0].id);
}

async function load() {
  const [db, board] = await Promise.all([api('/api/db'), api('/api/sample/board')]);
  state.db = db;
  state.board = board;
  render();
}

document.addEventListener('click', async (event) => {
  const tab = event.target.closest('.tab');
  const action = event.target.closest('[data-action]');
  if (tab) setTab(tab.dataset.tab);
  if (action) {
    try {
      await api(`/api/action/${action.dataset.action}/${action.dataset.id}`, { method: 'POST' });
      await load();
      toast('已更新');
    } catch (error) {
      toast(error.message);
    }
  }
});

document.addEventListener('input', (event) => {
  const view = state.config.views.find((entry) => entry.id && (event.target.id === `search-${entry.id}` || event.target.id === `status-${entry.id}`));
  if (view) $(`#list-${view.id}`).innerHTML = renderList(view);
});

document.addEventListener('submit', async (event) => {
  const chainForm = event.target.closest('[data-chain]');
  if (chainForm) return handleChainSubmit(event, chainForm);
  const form = event.target.closest('[data-create]');
  if (!form) return;
  event.preventDefault();
  const view = state.config.views.find((entry) => entry.id === form.dataset.view);
  await api(`/api/${form.dataset.create}`, { method: 'POST', body: JSON.stringify(values(form, view)) });
  form.reset();
  await load();
  toast('已保存');
});

async function handleChainSubmit(event, form) {
  event.preventDefault();
  const action = form.dataset.chain;
  const id = form.dataset.id;
  const payload = Object.fromEntries(new FormData(form).entries());
  if (payload.sealedAt) payload.sealedAt = new Date(payload.sealedAt).toISOString();
  if (payload.depth !== undefined) payload.depth = Number(payload.depth);
  if (payload.transportTemp !== undefined) payload.transportTemp = Number(payload.transportTemp);
  if (payload.receivedWeight !== undefined) payload.receivedWeight = Number(payload.receivedWeight);
  if (payload.weight !== undefined && payload.weight !== '') payload.weight = Number(payload.weight);
  if (payload.weight === '') delete payload.weight;
  if (payload.sealBroken !== undefined) payload.sealBroken = payload.sealBroken === '1';
  const routes = {
    register: '/api/sample/register',
    dispatch: `/api/sample/${id}/dispatch`,
    receive: `/api/sample/${id}/receive`,
    correct: `/api/sample/${id}/correct`
  };
  try {
    const result = await api(routes[action], { method: 'POST', body: JSON.stringify(payload) });
    await load();
    toast(result.message || '已更新');
  } catch (error) {
    toast(error.message);
  }
}

$('#refreshBtn').addEventListener('click', () => load().then(() => toast('已刷新')));

async function boot() {
  state.config = await api('/api/config');
  renderTabs();
  await load();
}

boot().catch((error) => toast(error.message));
