#!/usr/bin/env node
const express = require('express');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { exec } = require('child_process');
const store = require('./store');
const { checkForUpdate } = require('./update');

// Defaults are for the desktop app. Hosted mode (see README "Deploy on a server") is opt-in via env vars.
const HOST = process.env.HOST || '127.0.0.1';
const START_PORT = parseInt(process.env.PORT, 10) || 7070;
const LOOPBACK = ['127.0.0.1', 'localhost', '::1', '[::1]'];
const IS_LOCAL = LOOPBACK.includes(HOST);
const NO_OPEN = process.argv.includes('--no-open') || !IS_LOCAL;
const ROOT = path.join(__dirname, '..');

const ALLOWED_HOSTS = ['127.0.0.1', 'localhost', '[::1]', ...(process.env.POSTADMIN_ALLOWED_HOSTS || '')
  .split(',').map(h => h.trim().toLowerCase()).filter(Boolean)];
const AUTH_USER = process.env.POSTADMIN_USER || '';
const AUTH_PASS = process.env.POSTADMIN_PASSWORD || '';
const AUTH_ON = Boolean(AUTH_USER && AUTH_PASS);

// Never expose saved credentials to the network without a login.
if (!IS_LOCAL && !AUTH_ON) {
  console.error(`Refusing to listen on ${HOST} without a login. Set POSTADMIN_USER and POSTADMIN_PASSWORD.`);
  process.exit(1);
}
if (AUTH_ON && AUTH_PASS.length < 12) {
  console.error('POSTADMIN_PASSWORD must be at least 12 characters.');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
if (process.env.POSTADMIN_TRUST_PROXY) app.set('trust proxy', process.env.POSTADMIN_TRUST_PROXY);

// Saved URIs contain passwords, so only answer requests addressed to known hosts (blocks DNS rebinding).
app.use((req, res, next) => {
  const host = (req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (!ALLOWED_HOSTS.includes(host)) return res.status(403).send('Forbidden');
  next();
});

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// HTTP Basic auth for hosted mode. Only safe behind HTTPS (the reverse proxy provides it).
const failures = new Map(); // ip -> { count, until }
if (AUTH_ON) {
  app.use((req, res, next) => {
    const ip = req.ip;
    const f = failures.get(ip);
    if (f && f.until > Date.now()) return res.status(429).send('Too many failed logins. Try again later.');
    const [scheme, encoded] = (req.headers.authorization || '').split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString();
      const i = decoded.indexOf(':');
      const okUser = safeEqual(decoded.slice(0, i), AUTH_USER);
      const okPass = safeEqual(decoded.slice(i + 1), AUTH_PASS);
      if (i >= 0 && okUser && okPass) {
        failures.delete(ip);
        return next();
      }
      const count = (f ? f.count : 0) + 1;
      failures.set(ip, { count, until: count >= 10 ? Date.now() + 15 * 60 * 1000 : 0 });
    }
    res.set('WWW-Authenticate', 'Basic realm="PostAdmin", charset="UTF-8"');
    res.status(401).send('Login required');
  });
}

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: false, limit: '50mb' }));

app.use('/vendor/codemirror', express.static(path.join(ROOT, 'node_modules', 'codemirror')));
app.use(express.static(path.join(ROOT, 'public')));

const { version } = require('../package.json');
app.get('/api/version', (req, res) => res.json({ version }));
app.get('/api/update', async (req, res) => res.json(await checkForUpdate()));
app.use('/api/connections', require('./routes/connections'));
// Literal requires so the pkg bundler can see every route module.
const connRoutes = [require('./routes/meta'), require('./routes/data'), require('./routes/query'), require('./routes/io'), require('./routes/ddl')];
for (const routes of connRoutes) app.use('/api/c/:id', routes);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || (err.code ? 400 : 500);
  if (status === 500) console.error(err);
  if (res.headersSent) return res.end();
  let hint = err.hint;
  if (err.code === 'ENOTFOUND') {
    hint = `Host "${err.hostname}" can't be resolved from this computer. If it's a Docker Compose service name, ` +
      'use localhost (or 127.0.0.1) and the port published in docker-compose.yml, e.g. ports: "5432:5432".';
  } else if (err.code === 'ECONNREFUSED') {
    hint = 'Nothing is listening on that host/port. Is the database (or its Docker container) running, and is the port published?';
  }
  res.status(status).json({
    error: err.message,
    code: err.code,
    position: err.position ? Number(err.position) : undefined,
    detail: err.detail,
    hint,
    sql: err.sql,
  });
});

function findPort(port) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(findPort(port + 1)));
    srv.once('listening', () => srv.close(() => resolve(port)));
    srv.listen(port, HOST);
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

// On a server the reverse proxy expects a fixed port, so don't hop to the next free one.
(IS_LOCAL ? findPort(START_PORT) : Promise.resolve(START_PORT)).then(port => {
  app.listen(port, HOST, () => {
    const url = `http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${port}`;
    console.log(`PostAdmin v${version} running at ${url}${AUTH_ON ? ' (login required)' : ''}`);
    if (!IS_LOCAL) console.log(`Allowed hosts: ${ALLOWED_HOSTS.join(', ')}`);
    console.log(`Data directory: ${store.DATA_DIR}`);
    console.log('Press Ctrl+C to stop.');
    if (!NO_OPEN) openBrowser(url);
  });
});
