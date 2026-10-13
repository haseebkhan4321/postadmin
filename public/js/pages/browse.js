import { api, paths } from '../api.js';
import { h, append, clear, toast, modal, errorBox, spinner, formatNumber, isNumericType, download } from '../ui.js';
import { go } from '../app.js';
import { rowForm } from './rowform.js';
import { displayColumns } from './common.js';

const CTID = '__ctid';
const DISPLAY_MAX = 200;
const state = new Map(); // per-table view state, kept for the session

function stateFor(ctx) {
  const key = `${ctx.id}/${ctx.db}/${ctx.schema}/${ctx.table}`;
  if (!state.has(key)) state.set(key, { page: 1, size: 50, sort: null, dir: 'asc', filter: '' });
  return state.get(key);
}

export async function render(ctx, el) {
  const st = stateFor(ctx);
  const base = paths.table(ctx.id, ctx.db, ctx.schema, ctx.table);
  const filterInput = h('input', {
    value: st.filter, placeholder: 'WHERE …  e.g.  status = \'active\' AND id > 100', class: 'mono',
    style: { flex: '1', minWidth: '260px' },
    onkeydown: ev => { if (ev.key === 'Enter') { st.filter = filterInput.value.trim(); st.page = 1; load(); } },
  });
  const sizeSelect = h('select', {
    value: String(st.size),
    onchange: () => { st.size = Number(sizeSelect.value); st.page = 1; load(); },
  }, [25, 50, 100, 250, 500, 1000].map(n => h('option', { value: String(n) }, `${n} rows`)));

  const pagerTop = h('div', { class: 'pager' });
  const pagerBottom = h('div', { class: 'pager' });
  const gridHost = h('div');
  // The generated SELECT is hidden behind a toggle; the choice is remembered across tables.
  let showSql = false;
  try { showSql = localStorage.getItem('pa-browse-sql') === '1'; } catch { /* storage unavailable */ }
  const sqlInfo = h('div', { class: 'muted small mono sql-info', hidden: !showSql });
  const sqlToggle = h('button', {
    class: 'icon-btn sql-toggle' + (showSql ? ' active' : ''), title: 'Show the SQL query',
    onclick: () => {
      showSql = !showSql;
      sqlInfo.hidden = !showSql;
      sqlToggle.classList.toggle('active', showSql);
      sqlToggle.title = showSql ? 'Hide the SQL query' : 'Show the SQL query';
      try { localStorage.setItem('pa-browse-sql', showSql ? '1' : '0'); } catch { /* storage unavailable */ }
    },
  }, 'SQL');
  if (showSql) sqlToggle.title = 'Hide the SQL query';
  const bulk = h('div', { class: 'toolbar', style: { marginTop: '8px' } });

  append(el,
    h('div', { class: 'toolbar' },
      h('strong', null, 'WHERE'), filterInput,
      h('button', { class: 'primary', onclick: () => { st.filter = filterInput.value.trim(); st.page = 1; load(); } }, 'Filter'),
      st.filter ? h('button', { onclick: () => { st.filter = ''; filterInput.value = ''; st.page = 1; load(); } }, 'Clear') : null,
      sizeSelect,
      h('button', { title: 'Reload', onclick: () => load() }, '↻')),
    h('div', { class: 'toolbar' }, pagerTop, h('span', { class: 'spacer' }), sqlToggle),
    sqlInfo,
    gridHost,
    h('div', { class: 'toolbar', style: { marginTop: '8px' } }, pagerBottom),
    bulk);

  let data;

  async function load() {
    clear(gridHost, spinner());
    const q = new URLSearchParams({ page: st.page, size: st.size, filter: st.filter });
    if (st.sort) { q.set('sort', st.sort); q.set('dir', st.dir); }
    try {
      data = await api.get(`${base}/rows?${q}`);
    } catch (err) {
      clear(gridHost, errorBox(err));
      clear(pagerTop); clear(pagerBottom); clear(bulk); clear(sqlInfo);
      return;
    }
    const pages = Math.max(1, Math.ceil(data.total / st.size));
    if (st.page > pages && data.total > 0) { st.page = pages; return load(); }
    sqlInfo.textContent = data.sql;
    drawPager(pagerTop, pages);
    drawPager(pagerBottom, pages);
    drawGrid();
  }

  function drawPager(host, pages) {
    const pageInput = h('input', {
      type: 'number', min: 1, max: pages, value: String(st.page),
      onchange: () => { st.page = Math.min(pages, Math.max(1, Number(pageInput.value) || 1)); load(); },
    });
    const goto = p => () => { st.page = p; load(); };
    const from = data.total ? (st.page - 1) * st.size + 1 : 0;
    const to = Math.min(data.total, st.page * st.size);
    clear(host,
      h('button', { disabled: st.page <= 1, onclick: goto(1) }, '«'),
      h('button', { disabled: st.page <= 1, onclick: goto(st.page - 1) }, '‹'),
      'Page', pageInput, `of ${formatNumber(pages)}`,
      h('button', { disabled: st.page >= pages, onclick: goto(st.page + 1) }, '›'),
      h('button', { disabled: st.page >= pages, onclick: goto(pages) }, '»'),
      h('span', { class: 'muted' }, `Rows ${formatNumber(from)}–${formatNumber(to)} of ${data.exact ? '' : '~'}${formatNumber(data.total)}`));
  }

  function keyOf(row) {
    if (data.keyMode === 'ctid') return { [CTID]: row[CTID] };
    return Object.fromEntries(data.structure.primaryKey.map(c => [c, row[c]]));
  }

  function drawGrid() {
    const { structure, rows, editable } = data;
    const cols = displayColumns(structure);
    const selected = new Set();

    if (!rows.length) {
      clear(gridHost, h('div', { class: 'card empty' }, st.filter ? 'No rows match the filter.' : 'This table is empty.'));
      clear(bulk);
      return;
    }

    const sortHeader = c => {
      const active = st.sort === c.name;
      return h('th', {
        class: 'sortable',
        title: `${c.type}${c.comment ? ' — ' + c.comment : ''}\nClick to sort`,
        onclick: () => {
          if (!active) { st.sort = c.name; st.dir = 'asc'; }
          else if (st.dir === 'asc') st.dir = 'desc';
          else st.sort = null;
          load();
        },
      }, c.name, structure.primaryKey.includes(c.name) ? h('span', { class: 'badge pk', style: { marginLeft: '4px' } }, 'PK') : null,
      active ? (st.dir === 'asc' ? ' ▲' : ' ▼') : '', h('span', { class: 'type' }, c.type));
    };

    const deleteBtn = h('button', { class: 'danger', disabled: true, onclick: () => deleteRows([...selected]) }, 'Delete selected');
    const updateBulk = () => {
      deleteBtn.disabled = !selected.size;
      deleteBtn.textContent = selected.size ? `Delete selected (${selected.size})` : 'Delete selected';
    };
    const allBox = h('input', {
      type: 'checkbox',
      onchange: () => gridHost.querySelectorAll('input.rowsel').forEach(cb => {
        cb.checked = allBox.checked;
        cb.dispatchEvent(new Event('change'));
      }),
    });

    const tbody = h('tbody', null, rows.map((row, i) => {
      const tr = h('tr');
      const cb = h('input', {
        type: 'checkbox', class: 'rowsel',
        onchange: () => { cb.checked ? selected.add(row) : selected.delete(row); tr.classList.toggle('selected', cb.checked); updateBulk(); },
      });
      append(tr,
        editable ? h('td', { class: 'actions' }, cb,
          h('button', { class: 'link-btn', title: 'Edit row', onclick: () => editRow(row) }, '✎'),
          h('button', { class: 'link-btn', title: 'Copy into insert form', onclick: () => copyRow(row) }, '⧉'),
          h('button', { class: 'link-btn danger', title: 'Delete row', onclick: () => deleteRows([row]) }, '✕'))
          : h('td', { class: 'rownum' }, (st.page - 1) * st.size + i + 1),
        cols.map(c => cell(row, c, editable)));
      return tr;
    }));

    clear(gridHost, h('div', { class: 'table-wrap', style: { maxHeight: 'calc(100vh - 290px)' } },
      h('table', { class: 'grid' },
        h('thead', null, h('tr', null, h('th', { class: 'actions' }, editable ? allBox : '#'), cols.map(sortHeader))),
        tbody)));

    clear(bulk, editable ? [
      h('span', { class: 'muted' }, 'Double-click a cell to edit it. Enter saves, Shift+Enter adds a new line, Esc cancels.'),
      h('span', { class: 'spacer' }),
      data.keyMode === 'ctid' ? h('span', { class: 'badge' }, 'no primary key — rows identified by ctid') : null,
      deleteBtn,
    ] : h('span', { class: 'muted' }, 'Read-only: this is a view.'),
    h('button', { onclick: () => download(`/api${paths.db(ctx.id, ctx.db)}/export?schema=${encodeURIComponent(ctx.schema)}&tables=${encodeURIComponent(ctx.table)}&format=csv`) }, 'Export CSV'));
  }

  function displayCell(td, value, column) {
    td.className = '';
    if (value === null) {
      td.textContent = 'NULL';
      td.classList.add('null');
    } else {
      td.textContent = value.length > DISPLAY_MAX ? value.slice(0, DISPLAY_MAX) + '…' : value;
      td.title = value.length > DISPLAY_MAX ? value.slice(0, 2000) : '';
      if (isNumericType(column.type)) td.classList.add('num');
    }
  }

  function cell(row, column, editable) {
    const td = h('td');
    displayCell(td, row[column.name], column);
    if (!editable || column.generated === 's') return td;
    td.classList.add('editable');
    td.addEventListener('dblclick', () => startEdit(td, row, column));
    return td;
  }

  function startEdit(td, row, column) {
    if (td.querySelector('textarea')) return;
    const original = row[column.name];
    const ta = h('textarea', { value: original ?? '', rows: Math.min(8, Math.max(1, String(original ?? '').split('\n').length)) });
    const nullBtn = column.nullable
      ? h('button', { class: 'link-btn small', title: 'Set NULL', onmousedown: ev => { ev.preventDefault(); commit(null); } }, 'set NULL')
      : null;
    let done = false;
    td.replaceChildren(ta, nullBtn ?? '');
    td.className = 'editing';
    ta.focus();
    ta.select();

    const cancel = () => { done = true; displayCell(td, row[column.name], column); td.classList.add('editable'); };
    async function commit(value) {
      if (done) return;
      done = true;
      if (value === original) return cancel();
      td.classList.add('dirty');
      try {
        const res = await api.put(`${base}/rows`, { key: keyOf(row), values: { [column.name]: value } });
        Object.assign(row, res.row);
        displayCell(td, row[column.name], column);
        td.classList.add('editable');
        toast(`Updated ${column.name}`);
      } catch (err) {
        displayCell(td, original, column);
        td.classList.add('editable');
        toast(err.message + (err.detail ? `\n${err.detail}` : ''), 'error');
      }
    }
    ta.addEventListener('keydown', ev => {
      if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
      else if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); commit(ta.value); }
    });
    ta.addEventListener('blur', () => commit(ta.value));
  }

  async function editRow(row) {
    const form = rowForm(displayColumns(data.structure), row, { mode: 'edit' });
    const status = h('div');
    await modal({
      title: `Edit row in ${ctx.table}`,
      body: h('div', null, status, form.el),
      buttons: [
        { label: 'Cancel', value: null },
        {
          label: 'Save', class: 'primary',
          action: async () => {
            const values = form.values();
            if (!Object.keys(values).length) return true;
            try {
              await api.put(`${base}/rows`, { key: keyOf(row), values });
              toast('Row updated');
              load();
              return true;
            } catch (err) {
              clear(status, errorBox(err));
              return false;
            }
          },
        },
      ],
    });
  }

  function copyRow(row) {
    const copy = { ...row };
    delete copy[CTID];
    for (const c of data.structure.columns) {
      if (c.identity || c.generated === 's' || (c.default && c.default.startsWith('nextval('))) delete copy[c.name];
    }
    try { sessionStorage.setItem('pa-insert-prefill', JSON.stringify(copy)); } catch { /* ignore */ }
    go(ctx, { tab: 'insert' });
  }

  async function deleteRows(rows) {
    const ok = await modal({
      title: 'Delete rows',
      body: `Delete ${rows.length} row(s) from "${ctx.table}"? This cannot be undone.`,
      buttons: [{ label: 'Cancel', value: false }, { label: 'Delete', value: true, class: 'danger' }],
    });
    if (!ok) return;
    try {
      const res = await api.del(`${base}/rows`, { keys: rows.map(keyOf) });
      toast(`Deleted ${res.deleted} row(s)`);
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  await load();
}
