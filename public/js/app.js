import { api, paths } from './api.js';
import { h, clear, route, errorBox, spinner } from './ui.js';
import { renderTree, invalidateTree } from './tree.js';
import * as home from './pages/home.js';
import * as server from './pages/server.js';
import * as database from './pages/database.js';
import * as schema from './pages/schema.js';
import * as browse from './pages/browse.js';
import * as structure from './pages/structure.js';
import * as insert from './pages/insert.js';
import * as operations from './pages/operations.js';
import * as sql from './pages/sql.js';
import * as io from './pages/io.js';
import * as erd from './pages/erd.js';

const content = document.getElementById('content');
const tabsEl = document.getElementById('tabs');
const crumbsEl = document.getElementById('breadcrumbs');

// Tabs per level: [key, label, module, optional render-function name]
const TABS = {
  server: [['databases', 'Databases', server], ['sql', 'SQL', sql], ['history', 'History', server, 'renderHistory']],
  database: [['schemas', 'Schemas', database], ['sql', 'SQL', sql], ['export', 'Export', io, 'renderExport'], ['import', 'Import', io, 'renderImport'], ['erd', 'ERD', erd]],
  schema: [['tables', 'Tables', schema], ['sql', 'SQL', sql], ['create', 'Create table', schema, 'renderCreate'],
    ['export', 'Export', io, 'renderExport'], ['import', 'Import', io, 'renderImport'], ['erd', 'ERD', erd]],
  table: [['browse', 'Browse', browse], ['structure', 'Structure', structure], ['sql', 'SQL', sql], ['insert', 'Insert', insert],
    ['export', 'Export', io, 'renderExport'], ['import', 'Import', io, 'renderImport'], ['operations', 'Operations', operations]],
};
const VIEW_TABS = new Set(['browse', 'structure', 'sql', 'export', 'operations']);

const infoCache = new Map();
export async function connInfo(id) {
  if (!infoCache.has(id)) infoCache.set(id, api.get(paths.conn(id) + '/info').catch(err => { infoCache.delete(id); throw err; }));
  return infoCache.get(id);
}

export function parseHash() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(query);
  if (parts[0] !== 'c') return { level: 'home', params };
  const [, id, db, schemaName, table] = parts;
  const level = table ? 'table' : schemaName ? 'schema' : db ? 'database' : 'server';
  return { level, id, db, schema: schemaName, table, tab: params.get('tab'), params };
}

export function link(ctx, overrides = {}) {
  const c = { ...ctx, ...overrides };
  const base = route('c', c.id, c.db, c.schema, c.table);
  return c.tab ? `${base}?tab=${encodeURIComponent(c.tab)}` : base;
}

export function go(ctx, overrides) {
  location.hash = link(ctx, overrides);
}

// Re-renders the current page and reloads the tree (after DDL changes).
// Pass { rerender: false } when a navigation follows anyway.
export function refresh({ tree = true, rerender = true } = {}) {
  if (tree) invalidateTree();
  if (rerender) render();
}

function renderCrumbs(ctx, info) {
  const items = [h('a', { href: '#/' }, 'Connections')];
  const add = (kind, label, href) => items.push(h('span', { class: 'sep' }, '›'), h('a', { href }, h('span', { class: 'kind' }, kind), label));
  if (ctx.id) add('server', info?.name || '…', link({ id: ctx.id }));
  if (ctx.db) add('db', ctx.db, link({ id: ctx.id, db: ctx.db }));
  if (ctx.schema) add('schema', ctx.schema, link({ id: ctx.id, db: ctx.db, schema: ctx.schema }));
  if (ctx.table) add(ctx.kindLabel || 'table', ctx.table, link({ id: ctx.id, db: ctx.db, schema: ctx.schema, table: ctx.table }));
  clear(crumbsEl, items);
}

let renderSeq = 0;

async function render() {
  const seq = ++renderSeq;
  const ctx = parseHash();
  // ?popup=1: a bare editor window opened from the ERD (no sidebar or tabs).
  const popup = ctx.params.get('popup') === '1';
  document.body.classList.toggle('popup', popup);
  document.title = popup ? `SQL · ${ctx.db || 'PostAdmin'}` : 'PostAdmin';

  if (ctx.level === 'home') {
    renderCrumbs(ctx);
    clear(tabsEl);
    renderTree(ctx);
    return home.render(ctx, clear(content));
  }

  clear(content, spinner());
  let info;
  try {
    info = await connInfo(ctx.id);
  } catch (err) {
    if (seq !== renderSeq) return;
    renderCrumbs(ctx);
    clear(tabsEl);
    renderTree(ctx);
    return clear(content, errorBox(err), h('a', { class: 'btn', href: '#/' }, '← Back to connections'));
  }
  if (seq !== renderSeq) return;
  ctx.info = info;
  ctx.db = ctx.db || undefined;

  if (ctx.level === 'table') {
    try {
      ctx.structure = await api.get(paths.table(ctx.id, ctx.db, ctx.schema, ctx.table) + '/structure');
    } catch (err) {
      if (seq !== renderSeq) return;
      renderCrumbs(ctx, info);
      renderTree(ctx);
      return clear(content, errorBox(err));
    }
    if (seq !== renderSeq) return;
    const rk = ctx.structure.relkind;
    ctx.isView = rk === 'v' || rk === 'm';
    ctx.kindLabel = { v: 'view', m: 'matview', f: 'foreign' }[rk] || 'table';
  }

  let tabs = TABS[ctx.level];
  if (ctx.isView) tabs = tabs.filter(t => VIEW_TABS.has(t[0]));
  const active = tabs.find(t => t[0] === ctx.tab) || tabs[0];
  ctx.tab = active[0];

  renderCrumbs(ctx, info);
  renderTree(ctx);
  clear(tabsEl, tabs.map(([key, label]) =>
    h('a', { href: link(ctx, { tab: key === tabs[0][0] ? undefined : key }), class: key === ctx.tab ? 'active' : '' }, label)));

  const [, , mod, fn = 'render'] = active;
  try {
    await mod[fn](ctx, clear(content));
  } catch (err) {
    if (seq === renderSeq) clear(content, errorBox(err));
  }
}

// --- chrome ---------------------------------------------------------------

document.getElementById('conn-add').addEventListener('click', () => home.newConnection());
const filterInput = document.getElementById('tree-filter');
// "/" focuses the sidebar filter, Escape clears it.
document.addEventListener('keydown', ev => {
  if (ev.key !== '/' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const t = ev.target;
  if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest?.('.CodeMirror')) return;
  ev.preventDefault();
  filterInput.focus();
  filterInput.select();
});
filterInput.addEventListener('keydown', ev => {
  if (ev.key === 'Escape' && filterInput.value) { filterInput.value = ''; renderTree(parseHash()); }
});
document.getElementById('tree-refresh').addEventListener('click', () => { infoCache.clear(); refresh(); });
filterInput.addEventListener('input', () => renderTree(parseHash()));

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('pa-theme', theme); } catch { /* storage unavailable */ }
}
document.getElementById('theme-toggle').addEventListener('click', () =>
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
let savedTheme = null;
try { savedTheme = localStorage.getItem('pa-theme'); } catch { /* storage unavailable */ }
applyTheme(savedTheme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

// Sidebar resizing
const sidebar = document.getElementById('sidebar');
const resizer = document.getElementById('resizer');
try { const w = localStorage.getItem('pa-sidebar'); if (w) sidebar.style.width = w; } catch { /* ignore */ }
resizer.addEventListener('mousedown', ev => {
  ev.preventDefault();
  resizer.classList.add('active');
  const move = e => { sidebar.style.width = Math.min(600, Math.max(180, e.clientX)) + 'px'; };
  const up = () => {
    resizer.classList.remove('active');
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    try { localStorage.setItem('pa-sidebar', sidebar.style.width); } catch { /* ignore */ }
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
});

export function forgetConnection(id) {
  infoCache.delete(id);
  invalidateTree();
}

api.get('/version').then(({ version }) => {
  document.getElementById('app-version').textContent = `v${version}`;
}).catch(() => {});

// Update banner: shown once per new version until dismissed.
api.get('/update').then(u => {
  if (!u.available) return;
  let dismissed;
  try { dismissed = localStorage.getItem('pa-update-dismissed'); } catch { /* storage unavailable */ }
  if (dismissed === u.latest) return;
  const banner = document.getElementById('update-banner');
  banner.append(
    h('span', null, h('strong', null, `PostAdmin ${u.latest} is available`), ` (you have ${u.current}).`),
    h('a', { class: 'btn btn-primary', href: u.downloadUrl, target: '_blank', rel: 'noopener' }, 'Download'),
    h('a', { href: u.releaseUrl, target: '_blank', rel: 'noopener' }, "What's new"),
    h('button', {
      class: 'icon-btn', title: 'Dismiss', onclick: () => {
        banner.hidden = true;
        try { localStorage.setItem('pa-update-dismissed', u.latest); } catch { /* storage unavailable */ }
      },
    }, '×'),
  );
  banner.hidden = false;
}).catch(() => {});

window.addEventListener('hashchange', render);
render();
