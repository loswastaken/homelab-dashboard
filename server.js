const express = require('express');
const fs      = require('fs');
const path    = require('path');
const http    = require('http');
const https   = require('https');

const app       = express();
const PORT      = process.env.PORT || 55964;
const DATA_DIR  = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'services.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
    settings: { checkInterval: 60, siteTitle: 'los.dev · Homelab', nasIp: '10.24.4.26' },
    categories: [
      { id: 'media', name: 'Media Stack',     color: 'blue'   },
      { id: 'bot',   name: 'Bots',            color: 'purple' },
      { id: 'infra', name: 'Infrastructure',  color: 'amber'  }
    ],
    services: []
  };
}

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
      rejectUnauthorized: false  // allow self-signed certs (Cloudflare tunnels, Proxmox, etc.)
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
  return (history.filter(v => v === 1).length / history.length * 100).toFixed(1) + '%';
}

function pushHistory(hist, tick) {
  return [...(hist || []).slice(-29), tick];
}

async function checkAll() {
  // Step 1: snapshot only IDs + URLs to ping — hold nothing else.
  // If we kept the full `d` object during pings and saved it afterwards
  // we would overwrite any concurrent writes (add service, delete, config change).
  const toCheck = load().services
    .filter(s => s.url && s.checkEnabled)
    .map(s => ({ id: s.id, url: s.url }));

  // Step 2: run all pings concurrently (each can block up to 5 s on timeout)
  const results = await Promise.all(
    toCheck.map(async ({ id, url }) => ({ id, r: await ping(url) }))
  );

  // Step 3: re-load the FRESH file — this picks up any adds/deletes/config
  //         changes that happened while pings were in flight
  const fresh = load();
  for (const { id, r } of results) {
    const svc = fresh.services.find(s => s.id === id);
    if (!svc) continue; // deleted while pinging — skip it
    const tick   = r.ok ? 1 : 0;
    svc.history  = pushHistory(svc.history, tick);
    svc.status   = r.ok ? 'online' : (svc.status === 'degraded' ? 'degraded' : 'offline');
    svc.response = r.ok ? r.elapsed + 'ms' : '—';
    svc.uptime   = calcUptime(svc.history);
    svc.lastChecked = new Date().toISOString();
  }

  // Step 4: save fresh data with health results merged in
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
  checkAll(); // run immediately on start / reschedule
}

// ─── API: Services ───────────────────────────────────────────────────────────

app.get('/api/services', (_, res) => res.json(load()));

app.post('/api/services', (req, res) => {
  const d   = load();
  const svc = {
    id:          Date.now().toString(),
    name:        '',
    desc:        '',
    abbr:        '',
    cat:         '',
    url:         '',
    port:        '',
    hasUI:       true,
    checkEnabled: true,
    status:      'unknown',
    response:    '—',
    uptime:      '—',
    history:     [],
    lastChecked: null,
    ...req.body
  };
  d.services.push(svc);
  save(d);
  res.json(svc);
});

app.put('/api/services/:id', (req, res) => {
  const d = load();
  const i = d.services.findIndex(s => s.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Not found' });
  d.services[i] = { ...d.services[i], ...req.body };
  save(d);
  res.json(d.services[i]);
});

app.delete('/api/services/:id', (req, res) => {
  const d = load();
  d.services = d.services.filter(s => s.id !== req.params.id);
  save(d);
  res.json({ ok: true });
});

// Resolve: manually clear degraded/offline → online
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

// Force-check a single service now
app.post('/api/services/:id/check', async (req, res) => {
  const d   = load();
  const svc = d.services.find(s => s.id === req.params.id);
  if (!svc) return res.status(404).json({ error: 'Not found' });

  if (svc.url && svc.checkEnabled) {
    const r     = await ping(svc.url);
    const tick  = r.ok ? 1 : 0;
    svc.history = pushHistory(svc.history, tick);
    svc.status  = r.ok ? 'online' : 'offline';
    svc.response     = r.ok ? r.elapsed + 'ms' : '—';
    svc.uptime       = calcUptime(svc.history);
    svc.lastChecked  = new Date().toISOString();
    save(d);
  }
  res.json(svc);
});

// ─── API: Config ─────────────────────────────────────────────────────────────

app.get('/api/config', (_, res) => {
  const d = load();
  res.json({ settings: d.settings, categories: d.categories });
});

app.put('/api/config', (req, res) => {
  const d = load();
  if (req.body.settings) {
    d.settings = { ...d.settings, ...req.body.settings };
    scheduleChecks(); // restart timer if interval changed
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
