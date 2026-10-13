const express = require('express');
const { getPool } = require('../pools');
const { ident, qualified, wrap } = require('../sql');
const { tableStructure } = require('./meta');

const router = express.Router({ mergeParams: true });

const EXACT_COUNT_LIMIT = 100000;
const MAX_PAGE_SIZE = 1000;
const CTID = '__ctid';

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// Every column is selected as text so values round-trip exactly through the editor.
function selectList(columns, alias) {
  return columns.map(c => `${alias}.${ident(c.name)}::text AS ${ident(c.name)}`).join(', ');
}

// Builds `WHERE pk = $n AND ...` from a row identity: either primary-key values or a ctid.
function whereFor(structure, key, params) {
  if (key && key[CTID] !== undefined) {
    params.push(key[CTID]);
    return `ctid = $${params.length}::tid`;
  }
  if (!structure.primaryKey.length) throw badRequest('Table has no primary key; a ctid is required');
  return structure.primaryKey.map(col => {
    if (!key || key[col] === undefined) throw badRequest(`Missing primary key value for "${col}"`);
    if (key[col] === null) return `${ident(col)} IS NULL`;
    params.push(key[col]);
    return `${ident(col)} = $${params.length}`;
  }).join(' AND ');
}

function returning(structure) {
  const cols = selectList(structure.columns, qualified(structure.schema, structure.table));
  return structure.primaryKey.length ? cols : `${cols}, ctid::text AS ${CTID}`;
}

function checkColumns(structure, values) {
  const known = new Set(structure.columns.map(c => c.name));
  for (const col of Object.keys(values)) {
    if (!known.has(col)) throw badRequest(`Unknown column "${col}"`);
  }
}

const base = '/db/:db/schemas/:schema/tables/:table';

router.get(`${base}/rows`, wrap(async (req, res) => {
  const p = getPool(req.params.id, req.params.db);
  const structure = await tableStructure(p, req.params.schema, req.params.table);
  const size = Math.min(Math.max(parseInt(req.query.size, 10) || 50, 1), MAX_PAGE_SIZE);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const filter = String(req.query.filter || '').trim();
  const isTable = ['r', 'p'].includes(structure.relkind);
  const useCtid = isTable && !structure.primaryKey.length;

  let order = '';
  if (req.query.sort) {
    if (!structure.columns.some(c => c.name === req.query.sort)) throw badRequest('Unknown sort column');
    order = ` ORDER BY _t.${ident(req.query.sort)} ${req.query.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`;
  } else if (structure.primaryKey.length) {
    order = ' ORDER BY ' + structure.primaryKey.map(c => `_t.${ident(c)}`).join(', ');
  }

  const from = `FROM ${qualified(req.params.schema, req.params.table)} AS _t${filter ? ` WHERE (${filter})` : ''}`;
  const extra = useCtid ? `, _t.ctid::text AS ${CTID}` : '';
  const sql = `SELECT ${selectList(structure.columns, '_t')}${extra} ${from}${order} LIMIT ${size} OFFSET ${(page - 1) * size}`;

  const client = await p.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '60s'");
    const { rows } = await client.query(sql);

    let total = Number(structure.estimate);
    let exact = false;
    if (filter || !isTable || total < EXACT_COUNT_LIMIT) {
      const count = await client.query(`SELECT count(*)::bigint AS n ${from}`);
      total = Number(count.rows[0].n);
      exact = true;
    }
    await client.query('COMMIT');
    res.json({ sql, rows, total, exact, page, size, structure, editable: isTable, keyMode: useCtid ? 'ctid' : 'pk' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    err.sql = sql;
    throw err;
  } finally {
    client.release();
  }
}));

router.post(`${base}/rows`, wrap(async (req, res) => {
  const p = getPool(req.params.id, req.params.db);
  const structure = await tableStructure(p, req.params.schema, req.params.table);
  const values = req.body.values || {};
  checkColumns(structure, values);
  const cols = Object.keys(values);
  const params = cols.map(c => values[c]);
  const target = qualified(req.params.schema, req.params.table);
  const overriding = cols.some(c => structure.columns.find(x => x.name === c).identity === 'a')
    ? ' OVERRIDING SYSTEM VALUE' : '';
  const sql = cols.length
    ? `INSERT INTO ${target} (${cols.map(ident).join(', ')})${overriding} VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING ${returning(structure)}`
    : `INSERT INTO ${target} DEFAULT VALUES RETURNING ${returning(structure)}`;
  const { rows } = await p.query(sql, params);
  res.status(201).json({ row: rows[0], sql });
}));

router.put(`${base}/rows`, wrap(async (req, res) => {
  const p = getPool(req.params.id, req.params.db);
  const structure = await tableStructure(p, req.params.schema, req.params.table);
  const values = req.body.values || {};
  checkColumns(structure, values);
  const cols = Object.keys(values);
  if (!cols.length) throw badRequest('Nothing to update');
  const params = cols.map(c => values[c]);
  const sets = cols.map((c, i) => `${ident(c)} = $${i + 1}`).join(', ');
  const where = whereFor(structure, req.body.key, params);
  const sql = `UPDATE ${qualified(req.params.schema, req.params.table)} SET ${sets} WHERE ${where} RETURNING ${returning(structure)}`;

  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(sql, params);
    if (result.rowCount !== 1) throw badRequest(`Update would affect ${result.rowCount} rows; rolled back`);
    await client.query('COMMIT');
    res.json({ row: result.rows[0], sql });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

router.delete(`${base}/rows`, wrap(async (req, res) => {
  const p = getPool(req.params.id, req.params.db);
  const structure = await tableStructure(p, req.params.schema, req.params.table);
  const keys = req.body.keys || [];
  if (!keys.length) throw badRequest('No rows selected');

  const client = await p.connect();
  try {
    await client.query('BEGIN');
    let deleted = 0;
    for (const key of keys) {
      const params = [];
      const result = await client.query(
        `DELETE FROM ${qualified(req.params.schema, req.params.table)} WHERE ${whereFor(structure, key, params)}`, params);
      if (result.rowCount > 1) throw badRequest('A key matched more than one row; rolled back');
      deleted += result.rowCount;
    }
    await client.query('COMMIT');
    res.json({ deleted });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
