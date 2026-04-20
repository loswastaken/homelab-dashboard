const express   = require('express');
const fs        = require('fs');
const path      = require('path');
const http      = require('http');
const https     = require('https');
const crypto    = require('crypto');
const bcrypt    = require('bcryptjs');
const session   = require('express-session');
const FileStore = require('session-file-store')(session);

const app       = express();
const PORT      = process.env.PORT || 55964;
const DATA_DIR  = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'services.json');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const SESS_DIR  = path.join(DATA_DIR, 'sessions');

if (!fs.existsSync(DATA_DIR))  fs.mkdirSync(DATA_DIR,  { recursive: true });
if (!fs.existsSync(SESS_DIR))  fs.mkdirSync(SESS_DIR,  { recursive: true });

app.set('trust proxy', 1); // required when behind Cloudflare / any reverse proxy
app.use(express.json());

// ─── Data helpers ────────────────────────────────────────────────────────────

function load() {
  try   { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return defaults(); }
}

function save(d) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
}

function defaults() {
  return {
    settings: {
      checkInterval: 60,
      siteTitle:     'Homelab Dashboard',
      displayName:   '',
      serverLabel:   '',
      nasIp:         '',
    },
    categories: [],
    services:   []
  };
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────

function loadAuth() {
  try   { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); }
  catch { return null; }
}

function saveAuth(data) {
  fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2));
}

function isSetupDone() {
  const auth = loadAuth();
  return !!(auth && auth.passwordHash);
}

// Generate stable session secret + report API key on first start, persist in auth.json.
function initSecrets() {
  const auth = loadAuth() || {};
  let changed = false;
  if (!auth.sessionSecret) { auth.sessionSecret = crypto.randomBytes(48).toString('hex'); changed = true; }
  if (!auth.apiKey)        { auth.apiKey        = crypto.randomBytes(24).toString('hex'); changed = true; }
  if (changed) saveAuth(auth);
  return auth;
}

const secrets = initSecrets();

// ─── Rate limiting ────────────────────────────────────────────────────────────

const loginAttempts = new Map();

function checkRateLimit(ip) {
  const now  = Date.now();
  let entry  = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 15 * 60 * 1000 };
    loginAttempts.set(ip, entry);
  }
  return entry;
}

// ─── Session ─────────────────────────────────────────────────────────────────

app.use(session({
  store: new FileStore({ path: SESS_DIR, ttl: 7 * 24 * 3600, retries: 0, logFn: () => {} }),
  secret: secrets.sessionSecret,
  resave: false,
  saveUninitialized: false,
  name: 'hld.sid',
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

// ─── Auth routes (public — before the auth gate) ──────────────────────────────

app.get('/setup', (req, res) => {
  if (isSetupDone()) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'setup.html'));
});

app.post('/api/setup', async (req, res) => {
  if (isSetupDone()) return res.status(403).json({ error: 'Already configured' });
  const { username, password, displayName } = req.body;
  if (!username || !password || password.length < 8)
    return res.status(400).json({ error: 'Username required; password must be at least 8 characters' });
  const passwordHash = await bcrypt.hash(password, 12);
  const auth = loadAuth() || {};
  saveAuth({ ...auth, username, passwordHash });
  if (displayName) {
    const d = load();
    d.settings.displayName = displayName.trim();
    save(d);
  }
  req.session.authenticated = true;
  req.session.username = username;
  res.json({ ok: true });
});

app.get('/login', (req, res) => {
  if (req.session.authenticated) return res.redirect('/');
  if (!isSetupDone()) return res.redirect('/setup');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', async (req, res) => {
  const ip    = req.ip || req.socket.remoteAddress || 'unknown';
  const entry = checkRateLimit(ip);
  if (entry.count >= 5) {
    const mins = Math.ceil((entry.resetAt - Date.now()) / 60000);
    return res.status(429).json({ error: `Too many attempts — try again in ${mins} min` });
  }
  const { username, password } = req.body;
  const auth  = loadAuth();
  const valid = auth && username === auth.username && await bcrypt.compare(password, auth.passwordHash);
  if (!valid) {
    entry.count++;
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  entry.count = 0;
  req.session.authenticated = true;
  req.session.username = username;
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ─── Auth gate ────────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  // Report endpoint: accept valid API key in lieu of a session
  if (req.path.match(/^\/api\/services\/[^/]+\/report$/) && req.method === 'POST') {
    const auth = loadAuth();
    if (auth && req.headers['x-api-key'] === auth.apiKey) return next();
  }

  // Allow static assets (images, fonts, etc.) so login/setup pages render correctly
  if (/\.(svg|ico|png|jpg|webp|css|js|woff2?)$/.test(req.path)) return next();

  if (!isSetupDone()) {
    return req.path.startsWith('/api/')
      ? res.status(403).json({ error: 'Setup required' })
      : res.redirect('/setup');
  }

  if (!req.session.authenticated) {
    return req.path.startsWith('/api/')
      ? res.status(401).json({ error: 'Unauthorized' })
      : res.redirect('/login');
  }

  next();
});

// ─── Static files (protected) ────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

// ─── Health check ─────────────────────────────────────────────────────────────

function ping(url, timeoutMs = 5000) {
  return new Promise(resolve => {
    let parsed;
    try { parsed = new URL(url); } catch { return resolve({ ok: false, elapsed: null }); }

    const isHttps = parsed.protocol === 'https:';
    const mod = isHttps ? https : http;
    const t0  = Date.now();

    const req = mod.request({
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname || '/',
      method:   'HEAD',
      timeout:  timeoutMs,
      rejectUnauthorized: false
    }, res => {
      resolve({ ok: res.statusCode < 500, elapsed: Date.now() - t0 });
      res.resume();
    });

    req.on('timeout', () => { req.destroy(); resolve({ ok: false, elapsed: null }); });
    req.on('error',   () => resolve({ ok: false, elapsed: null }));
    req.end();
  });
}

function calcUptime(history) {
  if (!history || history.length === 0) return '—';
  const relevant = history.filter(v => v !== 3);
  if (relevant.length === 0) return '—';
  return (relevant.filter(v => v === 1).length / relevant.length * 100).toFixed(1) + '%';
}

function pushHistory(hist, tick) {
  return [...(hist || []).slice(-29), tick];
}

async function checkAll() {
  const toCheck = load().services
    .filter(s => s.url && s.checkEnabled && !s.maintenance)
    .map(s => ({ id: s.id, url: s.url }));

  const results = await Promise.all(
    toCheck.map(async ({ id, url }) => ({ id, r: await ping(url) }))
  );

  const fresh = load();
  for (const { id, r } of results) {
    const svc = fresh.services.find(s => s.id === id);
    if (!svc) continue;
    const tick   = r.ok ? 1 : 0;
    svc.history  = pushHistory(svc.history, tick);
    svc.status   = r.ok ? 'online' : (svc.status === 'degraded' ? 'degraded' : 'offline');
    svc.response = r.ok ? r.elapsed + 'ms' : '—';
    svc.uptime   = calcUptime(svc.history);
    svc.lastChecked = new Date().toISOString();
  }

  for (const svc of fresh.services) {
    if (svc.maintenance) {
      svc.history     = pushHistory(svc.history, 3);
      svc.status      = 'maintenance';
      svc.lastChecked = new Date().toISOString();
    }
  }

  save(fresh);
  console.log(`[${new Date().toLocaleTimeString()}] Checked ${results.length} services`);
}

// ─── Scheduling ──────────────────────────────────────────────────────────────

let checkTimer = null;

function scheduleChecks() {
  if (checkTimer) clearInterval(checkTimer);
  const interval = Math.max(10, (load().settings?.checkInterval || 60)) * 1000;
  checkTimer = setInterval(checkAll, interval);
  console.log(`[scheduler] Checks every ${interval / 1000}s`);
  checkAll();
}

// ─── API: Services ───────────────────────────────────────────────────────────

app.get('/api/services', (_, res) => {
  const auth = loadAuth() || {};
  res.json({ ...load(), apiKey: auth.apiKey });
});

app.post('/api/services', (req, res) => {
  const d   = load();
  const svc = {
    id:           Date.now().toString(),
    name:         '',
    desc:         '',
    abbr:         '',
    cat:          '',
    url:          '',
    port:         '',
    hasUI:        true,
    checkEnabled: true,
    status:       'unknown',
    response:     '—',
    uptime:       '—',
    history:      [],
    lastChecked:  null,
    ...req.body
  };
  d.services.push(svc);
  save(d);
  res.json(svc);
});

app.put('/api/services/:id', (req, res) => {
  const d    = load();
  const i    = d.services.findIndex(s => s.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Not found' });
  const prev = d.services[i];
  d.services[i] = { ...prev, ...req.body };
  if (req.body.maintenance !== undefined && req.body.maintenance !== prev.maintenance) {
    d.services[i].status = req.body.maintenance ? 'maintenance' : 'unknown';
  }
  save(d);
  res.json(d.services[i]);
});

app.delete('/api/services/:id', (req, res) => {
  const d = load();
  d.services = d.services.filter(s => s.id !== req.params.id);
  save(d);
  res.json({ ok: true });
});

app.post('/api/services/:id/resolve', (req, res) => {
  const d   = load();
  const svc = d.services.find(s => s.id === req.params.id);
  if (!svc) return res.status(404).json({ error: 'Not found' });
  svc.status  = 'online';
  svc.history = pushHistory(svc.history, 1);
  svc.uptime  = calcUptime(svc.history);
  save(d);
  res.json(svc);
});

// External status report — accepts session auth OR X-Api-Key header (for PM2 agent, etc.)
app.post('/api/services/:id/report', (req, res) => {
  const d   = load();
  const svc = d.services.find(s => s.id === req.params.id);
  if (!svc) return res.status(404).json({ error: 'Not found' });

  const { status, desc } = req.body;
  const tick = status === 'online' ? 1 : status === 'degraded' ? 2 : 0;

  if (status)             svc.status = status;
  if (desc !== undefined) svc.desc   = desc;
  svc.history     = pushHistory(svc.history, tick);
  svc.uptime      = calcUptime(svc.history);
  svc.lastChecked = new Date().toISOString();

  save(d);
  res.json(svc);
});

app.post('/api/services/:id/maintenance', (req, res) => {
  const d   = load();
  const svc = d.services.find(s => s.id === req.params.id);
  if (!svc) return res.status(404).json({ error: 'Not found' });
  svc.maintenance = !svc.maintenance;
  svc.status      = svc.maintenance ? 'maintenance' : 'unknown';
  save(d);
  res.json(svc);
});

app.post('/api/services/:id/pin', (req, res) => {
  const d   = load();
  const svc = d.services.find(s => s.id === req.params.id);
  if (!svc) return res.status(404).json({ error: 'Not found' });
  svc.pinnedAt = svc.pinnedAt ? null : Date.now();
  save(d);
  res.json(svc);
});

app.post('/api/check-all', async (req, res) => {
  await checkAll();
  res.json({ ok: true });
});

app.post('/api/services/:id/check', async (req, res) => {
  const d   = load();
  const svc = d.services.find(s => s.id === req.params.id);
  if (!svc) return res.status(404).json({ error: 'Not found' });

  if (svc.url && svc.checkEnabled) {
    const r      = await ping(svc.url);
    const tick   = r.ok ? 1 : 0;
    svc.history  = pushHistory(svc.history, tick);
    svc.status   = r.ok ? 'online' : 'offline';
    svc.response     = r.ok ? r.elapsed + 'ms' : '—';
    svc.uptime       = calcUptime(svc.history);
    svc.lastChecked  = new Date().toISOString();
    save(d);
  }
  res.json(svc);
});

// ─── API: Account ────────────────────────────────────────────────────────────

app.put('/api/auth', async (req, res) => {
  const { currentPassword, newUsername, newPassword } = req.body;
  const auth = loadAuth();
  if (!auth) return res.status(400).json({ error: 'No account configured' });
  if (!currentPassword) return res.status(400).json({ error: 'Current password required' });

  const valid = await bcrypt.compare(currentPassword, auth.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

  if (newUsername) auth.username = newUsername.trim();
  if (newPassword) {
    if (newPassword.length < 8)
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    auth.passwordHash = await bcrypt.hash(newPassword, 12);
  }

  saveAuth(auth);
  if (newUsername) req.session.username = newUsername.trim();
  res.json({ ok: true });
});

// ─── API: Config ─────────────────────────────────────────────────────────────

app.get('/api/config', (_, res) => {
  const d    = load();
  const auth = loadAuth() || {};
  res.json({ settings: d.settings, categories: d.categories, apiKey: auth.apiKey });
});

app.put('/api/config', (req, res) => {
  const d = load();
  if (req.body.settings) {
    d.settings = { ...d.settings, ...req.body.settings };
    scheduleChecks();
  }
  if (req.body.categories) d.categories = req.body.categories;
  save(d);
  res.json({ settings: d.settings, categories: d.categories });
});

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  🟢  Homelab Dashboard → http://localhost:${PORT}\n`);
  scheduleChecks();
});
