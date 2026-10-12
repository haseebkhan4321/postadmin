// Tiny DOM builder: h('div', {class: 'x', onclick: fn}, 'text', childNode, [more]).
// Text is always inserted as text nodes, so database values can never inject HTML.
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') continue; // set after children so <select> options exist
      else if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  appendAll(el, children);
  if (attrs && attrs.value !== undefined && attrs.value !== null) el.value = attrs.value;
  return el;
}

export function append(el, ...children) {
  return appendAll(el, children);
}

function appendAll(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) appendAll(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  appendAll(el, children);
  return el;
}

export function toast(message, type = 'ok', ms = 3500) {
  const el = h('div', { class: `toast ${type}` }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), type === 'error' ? ms * 2 : ms);
}

export function errorBox(err) {
  return h('div', { class: 'alert error' },
    h('strong', null, err.code ? `ERROR ${err.code}: ` : 'Error: '), err.message,
    err.detail ? h('div', null, 'Detail: ', err.detail) : null,
    err.hint ? h('div', null, 'Hint: ', err.hint) : null,
    err.sql ? h('pre', null, err.sql) : null);
}

export function spinner(text = 'Loading…') {
  return h('div', { class: 'spinner' }, text);
}

// Returns a promise resolving to the clicked button's value (or null when dismissed).
export function modal({ title, body, buttons = [{ label: 'Close', value: null }] }) {
  return new Promise(resolve => {
    const close = value => { backdrop.remove(); document.removeEventListener('keydown', onKey); resolve(value); };
    const onKey = ev => { if (ev.key === 'Escape') close(null); };
    const footer = h('footer', null, buttons.map(b =>
      h('button', {
        class: b.class,
        onclick: async () => {
          if (b.action) {
            const ok = await b.action();
            if (ok === false) return;
          }
          close(b.value);
        },
      }, b.label)));
    const backdrop = h('div', { class: 'modal-backdrop', onmousedown: ev => { if (ev.target === backdrop) close(null); } },
      h('div', { class: 'modal' }, h('header', null, title), h('div', { class: 'body' }, body), footer));
    document.addEventListener('keydown', onKey);
    document.body.append(backdrop);
    backdrop.querySelector('input, textarea, select')?.focus();
  });
}

export async function confirmSql(title, sql, { danger = false, label = 'Run' } = {}) {
  const result = await modal({
    title,
    body: [h('div', null, 'The following SQL will be executed:'), h('pre', { class: 'sql-preview' }, sql)],
    buttons: [
      { label: 'Cancel', value: false },
      { label, value: true, class: danger ? 'danger' : 'primary' },
    ],
  });
  return result === true;
}

export function formatBytes(n) {
  if (n === null || n === undefined) return '';
  n = Number(n);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i && n < 10 ? 1 : 0)} ${units[i]}`;
}

export function formatNumber(n) {
  return n === null || n === undefined ? '' : Number(n).toLocaleString();
}

// Hash routes: #/c/<id>/<db>/<schema>/<table>/<tab>
export function route(...parts) {
  return '#/' + parts.filter(p => p !== undefined && p !== null).map(encodeURIComponent).join('/');
}

export function download(url) {
  const a = h('a', { href: url, download: '' });
  document.body.append(a);
  a.click();
  a.remove();
}

// POSTs JSON and saves the response as a file; errors show as a toast instead of navigating away.
export async function postDownload(url, body) {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error);
    }
    const name = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'export';
    const href = URL.createObjectURL(await res.blob());
    const a = h('a', { href, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10000);
  } catch (err) {
    toast(err.message, 'error');
  }
}

const NUMERIC_TYPES = /^(smallint|integer|bigint|numeric|real|double precision|decimal|money|oid)/;
export const isNumericType = t => NUMERIC_TYPES.test(t || '');

// Connections without a group belong to this built-in group; it always exists and cannot be deleted.
export const DEFAULT_GROUP = 'Local';

// Splits saved connections into [groupName, conns] pairs: Local first, then named groups alphabetically.
export function groupConnections(conns) {
  const groups = new Map([[DEFAULT_GROUP, []]]);
  for (const c of conns) {
    const g = c.group || DEFAULT_GROUP;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  }
  return [...groups].sort(([a], [b]) => (b === DEFAULT_GROUP) - (a === DEFAULT_GROUP) || a.localeCompare(b, undefined, { sensitivity: 'base' }));
}
