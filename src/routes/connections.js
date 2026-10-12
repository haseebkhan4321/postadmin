const express = require('express');
const store = require('../store');
const { closePools, testUri } = require('../pools');
const { wrap } = require('../sql');

const router = express.Router();

// Never send the password to the browser in listings; the edit form fetches the full URI on demand.
function maskUri(uri) {
  try {
    const u = new URL(uri);
    if (u.password) u.password = '****';
    return u.toString();
  } catch {
    return uri;
  }
}

// Connections without a group belong to the built-in Local group, which is never stored by name.
// Undefined keys are dropped when the file is written.
function groupOf(body) {
  const group = String(body.group || '').trim();
  return group && group.toLowerCase() !== 'local' ? group : undefined;
}

function validate(body) {
  const name = String(body.name || '').trim();
  const uri = String(body.uri || '').trim();
  if (!name) return 'Name is required';
  if (!/^postgres(ql)?(\+[\w-]+)?:\/\//i.test(uri)) return 'URI must start with postgres:// or postgresql://';
  return null;
}

router.get('/', (req, res) => {
  res.json(store.listConnections().map(c => ({ ...c, uri: maskUri(c.uri) })));
});

router.get('/:id', (req, res) => {
  const conn = store.getConnection(req.params.id);
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  res.json(conn);
});

router.post('/test', wrap(async (req, res) => {
  const uri = req.body.uri || store.getConnection(req.body.id)?.uri;
  if (!uri) return res.status(400).json({ error: 'URI is required' });
  res.json(await testUri(uri));
}));

router.post('/', (req, res) => {
  const error = validate(req.body);
  if (error) return res.status(400).json({ error });
  const { name, uri, color } = req.body;
  res.status(201).json(store.saveConnection({ name: name.trim(), uri: uri.trim(), color, group: groupOf(req.body) }));
});

router.put('/:id', wrap(async (req, res) => {
  const error = validate(req.body);
  if (error) return res.status(400).json({ error });
  const { name, uri, color } = req.body;
  const conn = store.saveConnection({ id: req.params.id, name: name.trim(), uri: uri.trim(), color, group: groupOf(req.body) });
  if (!conn) return res.status(404).json({ error: 'Connection not found' });
  await closePools(req.params.id);
  res.json(conn);
}));

router.delete('/groups/:name', (req, res) => {
  if (!groupOf({ group: req.params.name })) return res.status(400).json({ error: 'The Local group cannot be deleted' });
  res.json({ moved: store.clearGroup(req.params.name) });
});

router.delete('/:id', wrap(async (req, res) => {
  await closePools(req.params.id);
  if (!store.deleteConnection(req.params.id)) return res.status(404).json({ error: 'Connection not found' });
  res.json({ ok: true });
}));

module.exports = router;
