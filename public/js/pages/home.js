import { api } from '../api.js';
import { h, append, clear, toast, modal, errorBox, route, groupConnections, DEFAULT_GROUP } from '../ui.js';
import { forgetConnection, refresh } from '../app.js';

const COLORS = ['#336791', '#1e8449', '#c0392b', '#8e44ad', '#d35400', '#16a085', '#7f8c8d'];

function buildUri({ host, port, user, password, database, sslmode }) {
  const auth = user ? encodeURIComponent(user) + (password ? ':' + encodeURIComponent(password) : '') + '@' : '';
  const q = sslmode ? `?sslmode=${sslmode}` : '';
  return `postgresql://${auth}${host || 'localhost'}:${port || 5432}/${encodeURIComponent(database || 'postgres')}${q}`;
}

// groups: existing group names offered as suggestions; group: preset for a new connection.
async function editConnection(existing, onSaved, { groups = [], group = '' } = {}) {
  const name = h('input', { value: existing?.name || '', placeholder: 'My database', style: { width: '100%' } });
  const groupList = h('datalist', { id: 'conn-groups' }, groups.map(g => h('option', { value: g })));
  const groupInput = h('input', {
    value: existing ? existing.group || '' : group, placeholder: `${DEFAULT_GROUP} (default) — or e.g. Production, Client X`,
    list: 'conn-groups', style: { width: '100%' },
  });
  const uri = h('input', {
    value: existing?.uri || '', placeholder: 'postgresql://user:password@host:5432/dbname?sslmode=require',
    style: { width: '100%' }, class: 'mono',
  });
  let color = existing?.color || COLORS[0];
  const swatches = h('div', { class: 'inline' }, COLORS.map(c => {
    const sw = h('span', {
      style: { width: '20px', height: '20px', borderRadius: '50%', background: c, cursor: 'pointer', display: 'inline-block',
        outline: c === color ? '2px solid var(--text)' : 'none', outlineOffset: '2px' },
      onclick: () => {
        color = c;
        for (const s of swatches.children) s.style.outline = 'none';
        sw.style.outline = '2px solid var(--text)';
      },
    });
    return sw;
  }));

  const parts = { host: h('input', { placeholder: 'localhost' }), port: h('input', { placeholder: '5432', style: { width: '80px' } }),
    user: h('input', { placeholder: 'postgres' }), password: h('input', { type: 'password' }),
    database: h('input', { placeholder: 'postgres' }),
    sslmode: h('select', null, ['', 'disable', 'prefer', 'require', 'verify-full'].map(m => h('option', { value: m }, m || '(default)'))) };
  const builder = h('details', { style: { marginTop: '8px' } },
    h('summary', { class: 'muted', style: { cursor: 'pointer' } }, 'Build URI from fields'),
    h('div', { class: 'form-grid', style: { marginTop: '8px' } },
      Object.entries(parts).flatMap(([k, el]) => [h('label', null, k), el]),
      h('span'), h('button', {
        onclick: () => {
          uri.value = buildUri(Object.fromEntries(Object.entries(parts).map(([k, el]) => [k, el.value.trim()])));
        },
      }, 'Fill URI')));

  const status = h('div');
  const test = async () => {
    clear(status, h('div', { class: 'muted' }, 'Testing…'));
    try {
      const r = await api.post('/connections/test', { uri: uri.value.trim() });
      clear(status, h('div', { class: 'alert ok' }, `Connected to "${r.database}" as ${r.user}\n${r.version}`));
    } catch (err) {
      clear(status, errorBox(err));
    }
    return false;
  };

  const saved = await modal({
    title: existing ? 'Edit connection' : 'New connection',
    body: h('div', null,
      h('div', { class: 'form-grid', style: { gridTemplateColumns: 'max-content 1fr' } },
        h('label', null, 'Name'), name,
        h('label', null, 'URI'), uri,
        h('label', null, 'Group'), h('div', null, groupInput, groupList),
        h('label', null, 'Color'), swatches),
      builder,
      h('p', { class: 'muted small' }, 'Saved in plain text on this computer only. SSL settings in the URI (sslmode=require) are honoured.'),
      status),
    buttons: [
      { label: 'Test connection', action: test },
      { label: 'Cancel', value: null },
      {
        label: 'Save', class: 'primary',
        action: async () => {
          const body = { name: name.value.trim() || 'Untitled', uri: uri.value.trim(), color, group: groupInput.value.trim() };
          try {
            const res = existing ? await api.put(`/connections/${existing.id}`, body) : await api.post('/connections', body);
            if (existing) forgetConnection(existing.id);
            onSaved(res);
            return true;
          } catch (err) {
            clear(status, errorBox(err));
            return false;
          }
        },
        value: true,
      },
    ],
  });
  return saved;
}

// Opens the new-connection form from anywhere (sidebar "+"), suggesting existing groups.
export async function newConnection(group = '') {
  const conns = await api.get('/connections').catch(() => []);
  const groups = groupConnections(conns).map(([g]) => g);
  return editConnection(null, c => { toast('Connection saved'); location.hash = route('c', c.id); }, { groups, group });
}

export async function render(ctx, el) {
  const conns = await api.get('/connections');
  const groups = groupConnections(conns);
  const groupNames = groups.map(([g]) => g);
  const create = group => newConnection(group);

  const card = c => h('div', { class: 'conn-card', style: { borderLeftColor: c.color } },
    h('a', { class: 'name', href: route('c', c.id) }, c.name),
    h('div', { class: 'uri' }, c.uri),
    h('div', { class: 'row' },
      h('a', { class: 'btn btn-primary', href: route('c', c.id) }, 'Open'),
      h('button', {
        onclick: async () => {
          try {
            const r = await api.post('/connections/test', { id: c.id });
            toast(`OK — ${r.version.split(' on ')[0]}`);
          } catch (err) { toast(err.message, 'error'); }
        },
      }, 'Test'),
      h('button', { onclick: async () => editConnection(await api.get(`/connections/${c.id}`), () => { toast('Saved'); refresh(); }, { groups: groupNames }) }, 'Edit'),
      h('button', {
        class: 'danger',
        onclick: async () => {
          const ok = await modal({
            title: 'Delete connection', body: `Remove "${c.name}" from saved connections? The database itself is not touched.`,
            buttons: [{ label: 'Cancel', value: false }, { label: 'Delete', value: true, class: 'danger' }],
          });
          if (!ok) return;
          await api.del(`/connections/${c.id}`);
          forgetConnection(c.id);
          toast('Connection removed');
          refresh();
        },
      }, 'Delete')));

  const deleteGroup = async g => {
    const ok = await modal({
      title: 'Delete group',
      body: `Delete the group "${g}"? Its connections move to ${DEFAULT_GROUP}; none are removed.`,
      buttons: [{ label: 'Cancel', value: false }, { label: 'Delete group', value: true, class: 'danger' }],
    });
    if (!ok) return;
    try {
      await api.del(`/connections/groups/${encodeURIComponent(g)}`);
      toast(`Group "${g}" deleted`);
      refresh();
    } catch (err) { toast(err.message, 'error'); }
  };

  const sections = groups.map(([g, list]) => {
    const isDefault = g === DEFAULT_GROUP;
    return h('section', { class: 'conn-group' },
      h('div', { class: 'conn-group-head' },
        h('h3', null, g, h('span', { class: 'muted' }, ` (${list.length})`), isDefault ? h('span', { class: 'muted small' }, ' · default') : null),
        h('button', { class: 'icon-btn', title: `New connection in "${g}"`, onclick: () => create(isDefault ? '' : g) }, '+'),
        isDefault ? null : h('button', { class: 'icon-btn', title: `Delete group "${g}"`, onclick: () => deleteGroup(g) }, '🗑')),
      list.length ? h('div', { class: 'conn-list' }, list.map(card)) : h('p', { class: 'muted small' }, 'No connections in this group.'));
  });

  append(el,
    h('div', { class: 'toolbar' },
      h('h2', { style: { margin: 0 } }, 'Saved connections'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'primary', onclick: () => create('') }, '+ New connection')),
    conns.length ? sections
      : h('div', { class: 'card empty' },
        h('p', null, 'No connections yet. Paste a PostgreSQL URI to get started.'),
        h('button', { class: 'primary', onclick: () => editConnection(null, c => { location.hash = route('c', c.id); }) }, '+ New connection')),
  );
}
