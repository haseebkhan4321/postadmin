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
  // query: the SQL typed in the query box; '' means the default SELECT * of the table.
  if (!state.has(key)) state.set(key, { page: 1, size: 50, sort: null, dir: 'asc', query: '' });
  return state.get(key);
}

const quote = name => /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
const normalize = sql => sql.trim().replace(/;\s*$/, '').replace(/\s+/g, ' ');

export async function render(ctx, el) {
  const st = stateFor(ctx);
  const base = paths.table(ctx.id, ctx.db, ctx.schema, ctx.table);
  const defaultQuery = `SELECT * FROM ${quote(ctx.schema)}.${quote(ctx.table)}`;
  const sizeSelect = h('select', {
    value: String(st.size), title: 'Rows per page',
    onchange: () => { st.size = Number(sizeSelect.value); st.page = 1; load(); },
  }, [25, 50, 100, 250, 500, 1000].map(n => h('option', { value: String(n) }, `${n} rows`)));

  const pagerTop = h('div', { class: 'pager' });
  const pagerBottom = h('div', { class: 'pager' });
  const gridHost = h('div');
  const bulk = h('div', { class: 'toolbar', style: { marginTop: '8px' } });

  // Query card: the editor, with its actions in a footer bar.
  const textarea = h('textarea');
  const resetBtn = h('button', { class: 'ghost', title: `Back to ${defaultQuery}`, onclick: () => { editor.setValue(defaultQuery); runQuery(); } }, '↺ Reset');
  const editedNote = h('span', { class: 'query-edited', hidden: true }, '● Edited — press Run');
  const card = h('div', { class: 'query-card' },
    h('div', { class: 'query-editor' }, textarea),
    h('div', { class: 'query-bar' },
      h('button', { class: 'primary run-btn', title: 'Run the query (Ctrl+Enter)', onclick: () => runQuery() },
        '▶ Run', h('kbd', null, 'Ctrl ↵')),
      resetBtn,
      editedNote,
      h('span', { class: 'spacer' }),
      h('span', { class: 'query-hint' }, 'Read-only · paged'),
      h('button', { class: 'icon-btn ghost', title: 'Reload results', onclick: () => load() }, '↻')));
  append(el,
    card,
    h('div', { class: 'toolbar' }, pagerTop),
    gridHost,
    h('div', { class: 'toolbar', style: { marginTop: '8px' } }, pagerBottom),
    bulk);

  const editor = CodeMirror.fromTextArea(textarea, {
    mode: 'text/x-pgsql', lineNumbers: false, matchBrackets: true, lineWrapping: true, viewportMargin: Infinity,
    extraKeys: { 'Ctrl-Enter': () => runQuery(), 'Cmd-Enter': () => runQuery() },
  });
  editor.setValue(st.query || defaultQuery);
  editor.on('focus', () => card.classList.add('focused'));
  editor.on('blur', () => card.classList.remove('focused'));
  // Flags edits that haven't been run yet, so the grid is never mistaken for their result.
  const syncEdited = () => { editedNote.hidden = normalize(editor.getValue()) === normalize(st.query || defaultQuery); };
  editor.on('change', syncEdited);

  function runQuery() {
    const sql = editor.getValue();
    st.query = normalize(sql) === normalize(defaultQuery) ? '' : sql.trim();
    st.page = 1;
    st.sort = null;
    load();
  }

  let data;

  let loadSeq = 0;
  async function load() {
    // Keep the current page on screen (dimmed) while the next one loads, so the layout doesn't jump.
    // Only the first load, with nothing to show yet, gets the full spinner.
    const seq = ++loadSeq;
    if (gridHost.querySelector('table')) gridHost.classList.add('grid-loading');
    else clear(gridHost, spinner());
    resetBtn.style.display = st.query ? '' : 'none';
    syncEdited();
    const q = new URLSearchParams({ page: st.page, size: st.size });
    if (st.query) q.set('query', st.query);
    if (st.sort) { q.set('sort', st.sort); q.set('dir', st.dir); }
    let next;
    try {
      next = await api.get(`${base}/rows?${q}`);
    } catch (err) {
      if (seq !== loadSeq) return;
      gridHost.classList.remove('grid-loading');
      clear(gridHost, errorBox(err));
      clear(pagerTop); clear(pagerBottom, sizeSelect); clear(bulk);
      return;
    }
    // A newer request (e.g. clicking through pages quickly) supersedes this one.
    if (seq !== loadSeq) return;
    data = next;
    gridHost.classList.remove('grid-loading');
    const pages = Math.max(1, Math.ceil(data.total / st.size));
    if (st.page > pages && data.total > 0) { st.page = pages; return load(); }
    drawPager(pagerTop, pages);
    drawPager(pagerBottom, pages);
    append(pagerBottom, sizeSelect);
    drawGrid();
  }

  function drawPager(host, pages) {
    const pageInput = h('input', {
      type: 'number', min: 1, max: pages, value: String(st.page),
      onchange: () => { st.page = Math.min(pages, Math.max(1, Number(pageInput.value) || 1)); load(); },
    });
    const goto = p => () => { st.page = p; load(); };
    // Relative to the current page, so quick repeated clicks keep stepping while a page loads.
    const step = d => () => { st.page = Math.min(pages, Math.max(1, st.page + d)); load(); };
    const from = data.total ? (st.page - 1) * st.size + 1 : 0;
    const to = Math.min(data.total, st.page * st.size);
    clear(host,
      h('button', { disabled: st.page <= 1, onclick: goto(1) }, '«'),
      h('button', { disabled: st.page <= 1, onclick: step(-1) }, '‹'),
      'Page', pageInput, `of ${formatNumber(pages)}`,
      h('button', { disabled: st.page >= pages, onclick: step(1) }, '›'),
      h('button', { disabled: st.page >= pages, onclick: goto(pages) }, '»'),
      h('span', { class: 'muted' }, `Rows ${formatNumber(from)}–${formatNumber(to)} of ${data.exact ? '' : '~'}${formatNumber(data.total)}`));
  }

  // Columns of the current result: the table's columns, or for a custom query the columns it
  // returned (computed ones are read-only).
  function resultColumns() {
    const { structure } = data;
    if (!data.custom) return displayColumns(structure);
    return data.columns.map(n => structure.columns.find(c => c.name === n) || { name: n, type: 'computed', computed: true, nullable: true });
  }

  function keyOf(row) {
    if (data.keyMode === 'ctid') return { [CTID]: row[CTID] };
    return Object.fromEntries(data.structure.primaryKey.map(c => [c, row[c]]));
  }

  function drawGrid() {
    const { structure, rows, editable } = data;
    const cols = resultColumns();
    const selected = new Set();

    if (!rows.length) {
      clear(gridHost, h('div', { class: 'card empty' }, st.query ? 'No rows match the query.' : 'This table is empty.'));
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
    if (!editable || column.computed || column.generated === 's') return td;
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
    const form = rowForm(resultColumns().filter(c => !c.computed), row, { mode: 'edit' });
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
