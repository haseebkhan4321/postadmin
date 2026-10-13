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

// Leaves every value as Postgres's own text output, like the ::text casts of the default query.
const RAW_TEXT = { getTypeParser: () => value => value };

// Result rows keyed by column name; a repeated name (e.g. from a join) becomes "name (2)".
function keyedRows(fields, rows) {
  const seen = new Map();
  const names = fields.map(f => {
    const n = (seen.get(f.name) || 0) + 1;
    seen.set(f.name, n);
    return n === 1 ? f.name : `${f.name} (${n})`;
  });
  return { names, rows: rows.map(r => Object.fromEntries(names.map((n, i) => [n, r[i]]))) };
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
  const isTable = ['r', 'p'].includes(structure.relkind);
  const useCtid = isTable && !structure.primaryKey.length;
  // A query typed in the Browse box replaces the default one. It runs as a subquery inside a
  // read-only transaction, so it can only read, and LIMIT stops Postgres after one page.
  const custom = String(req.query.query || '').trim().replace(/;\s*$/, '');
  if (custom) return res.json(await customRows(p, custom, { req, structure, size, page, isTable }));

  let order = '';
  if (req.query.sort) {
    if (!structure.columns.some(c => c.name === req.query.sort)) throw badRequest('Unknown sort column');
    order = ` ORDER BY _t.${ident(req.query.sort)} ${req.query.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`;
  } else if (structure.primaryKey.length) {
    order = ' ORDER BY ' + structure.primaryKey.map(c => `_t.${ident(c)}`).join(', ');
  }

  const from = `FROM ${qualified(req.params.schema, req.params.table)} AS _t`;
  const extra = useCtid ? `, _t.ctid::text AS ${CTID}` : '';
  const sql = `SELECT ${selectList(structure.columns, '_t')}${extra} ${from}${order} LIMIT ${size} OFFSET ${(page - 1) * size}`;

  const client = await p.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '60s'");
    const { rows } = await client.query(sql);

    let total = Number(structure.estimate);
    let exact = false;
    if (!isTable || total < EXACT_COUNT_LIMIT) {
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

async function customRows(p, custom, { req, structure, size, page, isTable }) {
  const order = req.query.sort ? ` ORDER BY _q.${ident(req.query.sort)} ${req.query.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST` : '';
  const sql = `SELECT * FROM (\n${custom}\n) AS _q${order} LIMIT ${size} OFFSET ${(page - 1) * size}`;
  const client = await p.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '60s'");
    const result = await client.query({ text: sql, rowMode: 'array', types: RAW_TEXT });
    const { names, rows } = keyedRows(result.fields, result.rows);
    const count = await client.query(`SELECT count(*)::bigint AS n FROM (\n${custom}\n) AS _q`);
    await client.query('COMMIT');
    // Editable only when every returned column is a column of this table and the whole primary key is
    // included, so an edit can't land on the wrong row (joins and computed columns are read-only).
    const editable = isTable && structure.primaryKey.length > 0 && structure.primaryKey.every(c => names.includes(c))
      && names.every(n => structure.columns.some(c => c.name === n));
    return { sql, rows, total: Number(count.rows[0].n), exact: true, page, size, structure, editable, keyMode: 'pk', columns: names, custom: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    err.sql = sql;
    throw err;
  } finally {
    client.release();
  }
}

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
