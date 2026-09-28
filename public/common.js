/* 页面公共工具：请求、转义、时间格式化、导航。不含判定规则。 */
(function () {
  'use strict';

  const NAV = [
    { href: '/', label: '队列看板' },
    { href: '/register.html', label: '登记钻孔' },
    { href: '/archive.html', label: '接收与旧档' }
  ];

  function escapeHtml(value) {
    return String(value == null || value === '' ? '' : value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function fmtDate(value) {
    if (!value) return '-';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString('zh-CN', { hour12: false });
  }

  // <input type="datetime-local"> 需要本地时区的 YYYY-MM-DDTHH:mm
  function toLocalInput(iso) {
    const d = new Date(iso || Date.now());
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  let toastTimer = null;
  function toast(message, kind) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.className = `toast show ${kind === 'error' ? 'error' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
    let body = null;
    try { body = await res.json(); } catch (_) { /* 204 */ }
    if (!res.ok) throw new Error((body && body.error) || `请求失败（${res.status}）`);
    return body;
  }

  function renderNav(activePath) {
    const el = document.getElementById('mainnav');
    if (!el) return;
    el.innerHTML = NAV.map((item) =>
      `<a class="navlink${item.href === activePath ? ' active' : ''}" href="${item.href}">${escapeHtml(item.label)}</a>`
    ).join('');
  }

  function reasonText(key) {
    return (window.ChainRules && window.ChainRules.REASONS[key]) || key;
  }

  function statusPill(status) {
    const label = ChainRules.STATUS_LABEL[status] || status;
    return `<span class="pill pill-${escapeHtml(status)}">${escapeHtml(label)}</span>`;
  }

  window.UI = { escapeHtml, fmtDate, toLocalInput, toast, api, renderNav, reasonText, statusPill, NAV };
})();
