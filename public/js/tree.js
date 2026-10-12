import { api, paths } from './api.js';
import { h, clear, route, formatNumber, groupConnections } from './ui.js';

const treeEl = document.getElementById('tree');
const filterEl = document.getElementById('tree-filter');

const cache = new Map(); // api url -> Promise
const expanded = loadSet('pa-tree');
// Nodes that start open (connection groups) remember being closed instead.
const collapsed = loadSet('pa-tree-collapsed');

function loadSet(name) {
  try { return new Set(JSON.parse(localStorage.getItem(name) || '[]')); } catch { return new Set(); }
}
function saveExpanded() {
  try {
    localStorage.setItem('pa-tree', JSON.stringify([...expanded].slice(-300)));
    localStorage.setItem('pa-tree-collapsed', JSON.stringify([...collapsed].slice(-100)));
  } catch { /* ignore */ }
}
const isOpen = (key, defaultOpen) => (defaultOpen ? !collapsed.has(key) : expanded.has(key));
function setOpen(key, open, defaultOpen) {
  const set = defaultOpen ? collapsed : expanded;
  if (open === !defaultOpen) set.add(key); else set.delete(key);
  saveExpanded();
}

function load(url) {
  if (!cache.has(url)) cache.set(url, api.get(url).catch(err => { cache.delete(url); throw err; }));
  return cache.get(url);
}

export function invalidateTree() {
  cache.clear();
}

const ICONS = { db: '🛢', schema: '📁', table: '▦', view: '👁', matview: '◫', sequence: '#', foreign: '⇄', function: 'ƒ', procedure: 'ƒ' };
const GROUPS = [['table', 'Tables'], ['view', 'Views'], ['matview', 'Materialized views'], ['foreign', 'Foreign tables'], ['sequence', 'Sequences']];

let currentCtx = {};

// defaultOpen: starts expanded until the user collapses it. cls: extra class for the node.
function node({ key, icon, label, meta, href, active, title, loadChildren, dim, defaultOpen, cls }) {
  const children = h('div', { class: 'tree-children' });
  const toggle = h('span', { class: 'tree-toggle' }, loadChildren ? '▸' : '');
  const row = h(href ? 'a' : 'div', {
    class: 'tree-row' + (active ? ' active' : ''), href, title: title || label,
    style: dim ? { opacity: 0.6 } : undefined,
  }, toggle, icon !== undefined ? h('span', { class: 'tree-icon' }, icon) : null, h('span', { class: 'tree-label' }, label),
  meta !== undefined ? h('span', { class: 'tree-meta' }, meta) : null);

  const el = h('div', { class: 'tree-node' + (cls ? ' ' + cls : '') }, row, children);
  const open = async () => {
    el.classList.add('open');
    clear(children, h('div', { class: 'tree-loading' }, 'loading…'));
    try {
      clear(children, await loadChildren());
    } catch (err) {
      clear(children, h('div', { class: 'tree-empty' }, err.message));
    }
  };
  const close = () => { el.classList.remove('open'); clear(children); };
  if (loadChildren) {
    toggle.addEventListener('click', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      const next = !isOpen(key, defaultOpen);
      setOpen(key, next, defaultOpen);
      if (next) open(); else close();
    });
    // Clicking a link label navigates and also expands; a plain header row toggles.
    row.addEventListener('click', () => {
      if (!href && isOpen(key, defaultOpen)) { setOpen(key, false, defaultOpen); close(); return; }
      if (!isOpen(key, defaultOpen)) { setOpen(key, true, defaultOpen); open(); }
    });
    if (isOpen(key, defaultOpen)) open();
  }
  return el;
}

async function databases(id) {
  const dbs = await load(paths.conn(id) + '/databases');
  if (!dbs.length) return h('div', { class: 'tree-empty' }, 'no databases');
  return dbs.filter(d => d.can_connect).map(d => node({
    key: `db:${id}/${d.name}`,
    icon: ICONS.db,
    label: d.name,
    href: route('c', id, d.name),
    active: currentCtx.db === d.name && !currentCtx.schema,
    loadChildren: () => schemas(id, d.name),
  }));
}

async function schemas(id, db) {
  const list = await load(paths.db(id, db) + '/schemas');
  return list.map(s => node({
    key: `s:${id}/${db}/${s.name}`,
    icon: ICONS.schema,
    label: s.name,
    meta: s.tables || undefined,
    dim: s.system,
    href: route('c', id, db, s.name),
    active: currentCtx.db === db && currentCtx.schema === s.name && !currentCtx.table,
    loadChildren: () => objects(id, db, s.name),
  }));
}

async function objects(id, db, schema) {
  const { relations, functions } = await load(paths.schema(id, db, schema) + '/objects');
  const q = filterEl.value.trim().toLowerCase();
  const match = name => !q || name.toLowerCase().includes(q);
  const out = [];
  for (const [kind, title] of GROUPS) {
    const items = relations.filter(r => r.kind === kind && match(r.name));
    if (!items.length) continue;
    out.push(h('div', { class: 'tree-group' }, `${title} (${items.length})`));
    for (const r of items) {
      const isRel = kind !== 'sequence';
      out.push(node({
        icon: ICONS[kind],
        label: r.name,
        meta: kind === 'table' && r.estimate > 0 ? '~' + formatNumber(r.estimate) : undefined,
        title: r.comment ? `${r.name} — ${r.comment}` : r.name,
        href: isRel ? route('c', id, db, schema, r.name) : undefined,
        active: currentCtx.db === db && currentCtx.schema === schema && currentCtx.table === r.name,
      }));
    }
  }
  const funcs = functions.filter(f => match(f.name));
  if (funcs.length) {
    out.push(node({
      key: `f:${id}/${db}/${schema}`,
      icon: ICONS.function,
      label: `Functions (${funcs.length})`,
      loadChildren: async () => funcs.map(f => node({
        icon: ICONS[f.kind], label: `${f.name}(${f.args})`,
        href: route('c', id, db, schema) + `?tab=sql&fn=${encodeURIComponent(f.name)}`,
      })),
    }));
  }
  return out.length ? out : h('div', { class: 'tree-empty' }, q ? 'no matches' : 'empty');
}

function connection(c) {
  return node({
    key: `c:${c.id}`, cls: 'tree-conn',
    icon: h('span', { class: 'conn-dot', style: { background: c.color || 'var(--accent)' } }),
    label: c.name,
    title: `${c.name}\n${c.uri}`,
    href: route('c', c.id),
    active: currentCtx.id === c.id && !currentCtx.db,
    loadChildren: () => databases(c.id),
  });
}

// Root of the tree: connection groups, each holding its connections, which expand into databases.
export async function renderTree(ctx) {
  currentCtx = ctx;
  // The current connection, database and schema are always expanded.
  if (ctx.id) expanded.add(`c:${ctx.id}`);
  if (ctx.db) expanded.add(`db:${ctx.id}/${ctx.db}`);
  if (ctx.schema) expanded.add(`s:${ctx.id}/${ctx.db}/${ctx.schema}`);
  saveExpanded();

  const conns = await api.get('/connections').catch(() => []);
  if (!conns.length) {
    clear(treeEl, h('div', { class: 'tree-empty' }, 'Add a connection to begin'));
    return;
  }
  // The filter matches connection names; open connections stay visible so it can match their tables.
  const q = filterEl.value.trim().toLowerCase();
  const visible = c => !q || c.name.toLowerCase().includes(q) || expanded.has(`c:${c.id}`);
  const groups = groupConnections(conns)
    .map(([g, list]) => [g, list.filter(visible)])
    .filter(([, list]) => list.length);

  const scroll = treeEl.scrollTop;
  clear(treeEl, groups.length
    ? groups.map(([g, list]) => {
      const key = `g:${g}`;
      // Keep the current connection's group open, and every group open while filtering.
      if (q || list.some(c => c.id === ctx.id)) collapsed.delete(key);
      return node({
        key, cls: 'tree-conn-group', defaultOpen: true,
        label: g, meta: list.length,
        loadChildren: async () => list.map(connection),
      });
    })
    : h('div', { class: 'tree-empty' }, 'No matching connections'));
  treeEl.scrollTop = scroll;
}
