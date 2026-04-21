const express   = require('express');
const fs        = require('fs');
const path      = require('path');
const http      = require('http');
const https     = require('https');
const crypto    = require('crypto');
const bcrypt    = require('bcryptjs');
const session   = require('express-session');
const FileStore = require('session-file-store')(session);
const webpush   = require('web-push');

const app       = express();
const PORT      = process.env.PORT || 55964;
const BUILD_SHA = process.env.BUILD_SHA || 'dev';
const REPO      = 'loswastaken/homelab-dashboard';
const DATA_DIR  = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'services.json');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
const SUBS_FILE  = path.join(DATA_DIR, 'push-subscriptions.json');
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
      weatherEnabled: false,
      weatherLocation: '',
      weatherCountryCode: '',
      weatherUnits: 'fahrenheit',
      pushEnabled: false,
    },
    categories:  [],
    services:    [],
    statusPages: []
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

// ─── Push notifications (VAPID + subscriptions) ──────────────────────────────

function loadVapid() {
  try   { return JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8')); }
  catch { return null; }
}

function ensureVapid() {
  let keys = loadVapid();
  if (!keys || !keys.publicKey || !keys.privateKey) {
    keys = webpush.generateVAPIDKeys();
    fs.writeFileSync(VAPID_FILE, JSON.stringify(keys, null, 2));
  }
  webpush.setVapidDetails('mailto:vasquezct02@protonmail.com', keys.publicKey, keys.privateKey);
  return keys;
}

function loadSubs() {
  try   { const v = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')); return Array.isArray(v) ? v : []; }
  catch { return []; }
}

function saveSubs(list) {
  fs.writeFileSync(SUBS_FILE, JSON.stringify(list, null, 2));
}

const vapidKeys = ensureVapid();

function eventLabel(type) {
  if (type === 'offline')  return 'Offline';
  if (type === 'degraded') return 'Degraded';
  if (type === 'recovery') return 'Recovered';
  return type;
}

async function notifyPush(svc, type, note = '') {
  const subs = loadSubs();
  if (subs.length === 0) return;
  const payload = JSON.stringify({
    title: `${svc.name || 'Service'} — ${eventLabel(type)}`,
    body:  note || '',
    tag:   `${svc.id}-${type}`,
    url:   '/'
  });
  const stale = new Set();
  await Promise.allSettled(subs.map(async sub => {
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) stale.add(sub.endpoint);
      else console.error('[push] send failed:', err.statusCode || err.message);
    }
  }));
  if (stale.size) saveSubs(subs.filter(s => !stale.has(s.endpoint)));
}

function maybeNotify(svc, type, note) {
  try {
    if (!['offline','degraded','recovery'].includes(type)) return;
    if (!load().settings?.pushEnabled) return;
    notifyPush(svc, type, note);
  } catch (e) {
    console.error('[push] maybeNotify error:', e.message);
  }
}

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

// ─── Status pages helpers (public-facing) ───────────────────────────────────

const RESERVED_SLUGS = new Set([
  'api', 'login', 'logout', 'setup', 'static', 'public', 'status',
  'status-pages', 'admin', 'history', 'new', 'edit', 'index'
]);

function validateSlug(slug, pages, selfId) {
  if (typeof slug !== 'string') return { ok: false, error: 'Slug is required' };
  const s = slug.trim();
  if (s.length < 2 || s.length > 40) return { ok: false, error: 'Slug must be 2–40 characters' };
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)) return { ok: false, error: 'Use lowercase letters, numbers, and single dashes (e.g. my-page)' };
  if (RESERVED_SLUGS.has(s)) return { ok: false, error: `Slug "${s}" is reserved` };
  const clash = (pages || []).find(p => p.slug === s && p.id !== selfId);
  if (clash) return { ok: false, error: 'Slug is already in use' };
  return { ok: true, value: s };
}

function findStatusPageBySlug(d, slug) {
  if (!d.statusPages || !Array.isArray(d.statusPages)) return null;
  return d.statusPages.find(p => p.slug === slug) || null;
}

function sanitizeServiceForPublic(svc, page, categoriesById) {
  const includeCategory = page.includedCategoryIds && page.includedCategoryIds.includes(svc.cat);
  const cat = includeCategory && categoriesById[svc.cat] ? {
    id:    categoriesById[svc.cat].id,
    name:  categoriesById[svc.cat].name,
    color: categoriesById[svc.cat].color
  } : null;
  return {
    id:           svc.id,
    name:         svc.name,
    abbr:         svc.abbr || '',
    status:       svc.status || 'unknown',
    disabled:     !!svc.disabled,
    maintenance:  !!svc.maintenance,
    uptime:       svc.uptime || '—',
    category:      cat,
    dailyHistory:  (svc.dailyHistory  || []).slice(-90),
    hourlyHistory: (svc.hourlyHistory || []).slice(-24),
    events:        (svc.events        || []).slice(-200).map(e => ({ ts: e.ts, type: e.type }))
  };
}

function computeOverallStatus(services) {
  const active = services.filter(s => !s.disabled);
  if (active.length === 0) return 'operational';
  if (active.some(s => s.status === 'offline')) return 'outage';
  if (active.some(s => s.status === 'degraded')) return 'degraded';
  if (active.every(s => s.maintenance || s.status === 'maintenance')) return 'maintenance';
  return 'operational';
}

// ─── Public routes (no auth) ────────────────────────────────────────────────

app.get('/status/:slug', (req, res) => {
  const slug = (req.params.slug || '').toLowerCase();
  const d = load();
  const page = findStatusPageBySlug(d, slug);
  if (!page) {
    return res.status(404).send(
      '<!doctype html><meta charset="utf-8"><title>Status page not found</title>' +
      '<body style="background:#0f0f10;color:#d9d4c1;font-family:system-ui;display:flex;' +
      'align-items:center;justify-content:center;height:100vh;margin:0">' +
      '<div style="text-align:center"><h1 style="font-weight:500">Status page not found</h1>' +
      '<p style="color:#7a7566">The URL you requested does not match any published status page.</p></div>'
    );
  }
  res.sendFile(path.join(__dirname, 'public', 'status-page.html'));
});

app.get('/api/public/status/:slug', (req, res) => {
  const slug = (req.params.slug || '').toLowerCase();
  const d = load();
  const page = findStatusPageBySlug(d, slug);
  if (!page) return res.status(404).json({ error: 'Status page not found' });

  const catsById = {};
  for (const c of (d.categories || [])) catsById[c.id] = c;

  const svcById = {};
  for (const s of (d.services || [])) svcById[s.id] = s;

  const services = (page.serviceIds || [])
    .map(id => svcById[id])
    .filter(Boolean)
    .map(svc => sanitizeServiceForPublic(svc, page, catsById))
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));

  res.json({
    page: {
      name:              page.name,
      description:       page.description || '',
      showEventLog:      page.showEventLog !== false,
      showOverallBanner: page.showOverallBanner !== false,
      updatedAt:         page.updatedAt || page.createdAt || null
    },
    services,
    overall: computeOverallStatus(services)
  });
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

function fetchJSON(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const mod = isHttps ? https : http;
    const req = mod.request({
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + (parsed.search || ''),
      method:   'GET',
      headers:  opts.headers || { 'User-Agent': `${REPO}/1.0`, 'Accept': 'application/json' }
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`Remote API returned HTTP ${res.statusCode}`));
        }
        try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON from remote API')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Request timed out')); });
    req.end();
  });
}

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
      const elapsed = Date.now() - t0;
      const serverError = res.statusCode >= 500;
      resolve({ ok: !serverError, serverError, elapsed });
      res.resume();
    });

    req.on('timeout', () => { req.destroy(); resolve({ ok: false, serverError: false, elapsed: null }); });
    req.on('error',   () => resolve({ ok: false, serverError: false, elapsed: null }));
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

// ─── Daily history & event log helpers ───────────────────────────────────────

const TODAY_KEY = () => new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
const HOUR_KEY  = () => new Date().toISOString().slice(0, 13); // 'YYYY-MM-DDTHH'

function pushEvent(svc, type, note = '') {
  if (!Array.isArray(svc.events)) svc.events = [];
  svc.events.push({ ts: new Date().toISOString(), type, note });
  if (svc.events.length > 500) svc.events = svc.events.slice(-500);
}

function accumulateDailyTick(svc, tick) {
  if (!Array.isArray(svc.dailyHistory)) svc.dailyHistory = [];
  const today = TODAY_KEY();
  let entry = svc.dailyHistory.find(e => e.date === today);
  if (!entry) {
    entry = { date: today, online: 0, degraded: 0, offline: 0, maintenance: 0, total: 0 };
    svc.dailyHistory.push(entry);
    // keep max 90 days
    if (svc.dailyHistory.length > 90) svc.dailyHistory = svc.dailyHistory.slice(-90);
  }
  entry.total++;
  if      (tick === 1) entry.online++;
  else if (tick === 2) entry.degraded++;
  else if (tick === 3) entry.maintenance++;
  else                 entry.offline++;
  // recalculate uptime% for the day (exclude maintenance from denominator)
  const denom = entry.online + entry.degraded + entry.offline;
  entry.uptime = denom > 0 ? parseFloat((entry.online / denom * 100).toFixed(2)) : null;
}

function accumulateHourlyTick(svc, tick) {
  if (!Array.isArray(svc.hourlyHistory)) svc.hourlyHistory = [];
  const hour = HOUR_KEY();
  let entry = svc.hourlyHistory.find(e => e.ts === hour);
  if (!entry) {
    entry = { ts: hour, online: 0, degraded: 0, offline: 0, maintenance: 0, total: 0 };
    svc.hourlyHistory.push(entry);
    // keep max 168 hours (7 days)
    if (svc.hourlyHistory.length > 168) svc.hourlyHistory = svc.hourlyHistory.slice(-168);
  }
  entry.total++;
  if      (tick === 1) entry.online++;
  else if (tick === 2) entry.degraded++;
  else if (tick === 3) entry.maintenance++;
  else                 entry.offline++;
  const denom = entry.online + entry.degraded + entry.offline;
  entry.uptime = denom > 0 ? parseFloat((entry.online / denom * 100).toFixed(2)) : null;
}

const WEATHER_CODE_MAP = {
  0: 'Clear',
  1: 'Mostly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Rime fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Dense drizzle',
  56: 'Freezing drizzle',
  57: 'Dense freezing drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  66: 'Freezing rain',
  67: 'Heavy freezing rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Rain showers',
  81: 'Heavy showers',
  82: 'Violent showers',
  85: 'Snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with hail',
  99: 'Severe hail storm',
};

const weatherCache = { key: '', expiresAt: 0, data: null };

function normalizeWeatherSettings(raw = {}) {
  const weatherUnits = raw.weatherUnits === 'celsius' ? 'celsius' : 'fahrenheit';
  return {
    weatherEnabled: !!raw.weatherEnabled,
    weatherLocation: (raw.weatherLocation || '').trim(),
    weatherCountryCode: (raw.weatherCountryCode || '').trim().toUpperCase(),
    weatherUnits
  };
}

async function getWeatherData(force = false) {
  const d = load();
  const w = normalizeWeatherSettings(d.settings);
  if (!w.weatherEnabled) throw new Error('Weather is disabled');
  if (!w.weatherLocation) throw new Error('Weather location is required');

  const cacheKey = `${w.weatherLocation}|${w.weatherCountryCode}|${w.weatherUnits}`;
  if (!force && weatherCache.data && weatherCache.key === cacheKey && weatherCache.expiresAt > Date.now()) {
    return weatherCache.data;
  }

  const geoUrl = new URL('https://geocoding-api.open-meteo.com/v1/search');
  geoUrl.searchParams.set('name', w.weatherLocation);
  geoUrl.searchParams.set('count', '1');
  geoUrl.searchParams.set('language', 'en');
  if (w.weatherCountryCode) geoUrl.searchParams.set('countryCode', w.weatherCountryCode);

  const geo = await fetchJSON(geoUrl.toString(), {
    headers: { 'User-Agent': `${REPO}/1.0`, 'Accept': 'application/json' }
  });
  const place = Array.isArray(geo.results) ? geo.results[0] : null;
  if (!place) throw new Error('Location not found. Try ZIP, city, or add country code.');

  const forecastUrl = new URL('https://api.open-meteo.com/v1/forecast');
  forecastUrl.searchParams.set('latitude', String(place.latitude));
  forecastUrl.searchParams.set('longitude', String(place.longitude));
  forecastUrl.searchParams.set('timezone', 'auto');
  forecastUrl.searchParams.set('current', 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,is_day');
  forecastUrl.searchParams.set('temperature_unit', w.weatherUnits);
  forecastUrl.searchParams.set('wind_speed_unit', w.weatherUnits === 'celsius' ? 'kmh' : 'mph');

  const forecast = await fetchJSON(forecastUrl.toString(), {
    headers: { 'User-Agent': `${REPO}/1.0`, 'Accept': 'application/json' }
  });
  if (!forecast.current) throw new Error('Weather data unavailable');

  const tempUnit = w.weatherUnits === 'celsius' ? 'C' : 'F';
  const windUnit = w.weatherUnits === 'celsius' ? 'km/h' : 'mph';
  const result = {
    location: place.name || '',
    admin1: place.admin1 || '',
    countryCode: place.country_code ? place.country_code.toUpperCase() : (place.country || ''),
    latitude: place.latitude,
    longitude: place.longitude,
    temperature: forecast.current.temperature_2m,
    feelsLike: forecast.current.apparent_temperature,
    windSpeed: forecast.current.wind_speed_10m,
    weatherCode: forecast.current.weather_code,
    weatherText: WEATHER_CODE_MAP[forecast.current.weather_code] || 'Unknown',
    isDay: !!forecast.current.is_day,
    observedAt: forecast.current.time,
    units: { temperature: tempUnit, windSpeed: windUnit }
  };

  weatherCache.key = cacheKey;
  weatherCache.data = result;
  weatherCache.expiresAt = Date.now() + 5 * 60 * 1000;
  return result;
}

async function checkAll() {
  const toCheck = load().services
    .filter(s => s.url && s.checkEnabled && !s.maintenance && !s.disabled)
    .map(s => ({ id: s.id, url: s.url }));

  const results = await Promise.all(
    toCheck.map(async ({ id, url }) => ({ id, r: await ping(url) }))
  );

  const fresh = load();
  for (const { id, r } of results) {
    const svc = fresh.services.find(s => s.id === id);
    if (!svc) continue;
    const prevStatus = svc.status;
    const tick   = r.serverError ? 2 : r.ok ? 1 : 0;
    svc.history  = pushHistory(svc.history, tick);
    svc.status   = r.serverError ? 'degraded' : r.ok ? 'online' : (svc.status === 'degraded' ? 'degraded' : 'offline');
    svc.response = (r.ok || r.serverError) ? r.elapsed + 'ms' : '—';
    svc.uptime   = calcUptime(svc.history);
    svc.lastChecked = new Date().toISOString();
    accumulateDailyTick(svc, tick);
    accumulateHourlyTick(svc, tick);
    // event log: record transitions
    if (prevStatus !== svc.status) {
      if (svc.status === 'offline')  { pushEvent(svc, 'offline',  'Service became unreachable'); maybeNotify(svc, 'offline',  'Service became unreachable'); }
      if (svc.status === 'degraded') { pushEvent(svc, 'degraded', 'Service returned 5xx response'); maybeNotify(svc, 'degraded', 'Service returned 5xx response'); }
      if (svc.status === 'online' && (prevStatus === 'offline' || prevStatus === 'degraded')) {
        pushEvent(svc, 'recovery', `Recovered from ${prevStatus}`);
        maybeNotify(svc, 'recovery', `Recovered from ${prevStatus}`);
      }
    }
  }

  for (const svc of fresh.services) {
    if (svc.disabled) continue;
    if (svc.maintenance) {
      svc.history     = pushHistory(svc.history, 3);
      accumulateDailyTick(svc, 3);
      accumulateHourlyTick(svc, 3);
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
  res.json({ ...load(), apiKey: auth.apiKey, version: BUILD_SHA.slice(0, 7) });
});

app.get('/api/weather', async (req, res) => {
  try {
    const force = req.query.force === '1';
    const weather = await getWeatherData(force);
    res.json(weather);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
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
    disabled:     false,
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
  if (req.body.disabled !== undefined && !!req.body.disabled !== !!prev.disabled) {
    if (req.body.disabled) {
      d.services[i].maintenance = false;
      d.services[i].status = 'disabled';
    } else {
      d.services[i].status = 'unknown';
    }
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
  const prevStatus = svc.status;
  const tick = status === 'online' ? 1 : status === 'degraded' ? 2 : 0;

  if (status)             svc.status = status;
  if (desc !== undefined) svc.desc   = desc;
  svc.history     = pushHistory(svc.history, tick);
  svc.uptime      = calcUptime(svc.history);
  svc.lastChecked = new Date().toISOString();
  accumulateDailyTick(svc, tick);
  accumulateHourlyTick(svc, tick);
  if (status === 'degraded' && prevStatus !== 'degraded') {
    const note = desc || 'Service reported degraded';
    pushEvent(svc, 'degraded', note);
    maybeNotify(svc, 'degraded', note);
  }
  if (status === 'offline' && prevStatus !== 'offline') {
    const note = desc || 'Service reported offline';
    pushEvent(svc, 'offline', note);
    maybeNotify(svc, 'offline', note);
  }
  if (status === 'online' && (prevStatus === 'offline' || prevStatus === 'degraded')) {
    const note = `Recovered from ${prevStatus}`;
    pushEvent(svc, 'recovery', note);
    maybeNotify(svc, 'recovery', note);
  }

  save(d);
  res.json(svc);
});

app.post('/api/services/:id/maintenance', (req, res) => {
  const d   = load();
  const svc = d.services.find(s => s.id === req.params.id);
  if (!svc) return res.status(404).json({ error: 'Not found' });
  svc.maintenance = !svc.maintenance;
  svc.status      = svc.maintenance ? 'maintenance' : 'unknown';
  pushEvent(svc, svc.maintenance ? 'maintenance' : 'recovery',
    svc.maintenance ? 'Maintenance mode enabled' : 'Maintenance mode disabled');
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
    const tick   = r.serverError ? 2 : r.ok ? 1 : 0;
    svc.history  = pushHistory(svc.history, tick);
    svc.status   = r.serverError ? 'degraded' : r.ok ? 'online' : 'offline';
    svc.response = (r.ok || r.serverError) ? r.elapsed + 'ms' : '—';
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
    const incoming = { ...req.body.settings };
    if (incoming.weatherCountryCode !== undefined) incoming.weatherCountryCode = String(incoming.weatherCountryCode || '').trim().toUpperCase();
    if (incoming.weatherLocation !== undefined) incoming.weatherLocation = String(incoming.weatherLocation || '').trim();
    if (incoming.weatherUnits !== undefined) incoming.weatherUnits = incoming.weatherUnits === 'celsius' ? 'celsius' : 'fahrenheit';
    if (incoming.weatherEnabled !== undefined) incoming.weatherEnabled = !!incoming.weatherEnabled;
    d.settings = { ...d.settings, ...incoming };
    scheduleChecks();
  }
  if (req.body.categories) d.categories = req.body.categories;
  save(d);
  res.json({ settings: d.settings, categories: d.categories });
});

// ─── API: Push Notifications ─────────────────────────────────────────────────

app.get('/api/push/vapid-public-key', (_, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

app.post('/api/push/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  const subs = loadSubs();
  const idx  = subs.findIndex(s => s.endpoint === sub.endpoint);
  const entry = { endpoint: sub.endpoint, keys: sub.keys, addedAt: new Date().toISOString() };
  if (idx >= 0) subs[idx] = entry; else subs.push(entry);
  saveSubs(subs);
  res.json({ ok: true, count: subs.length });
});

app.post('/api/push/unsubscribe', (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
  const subs = loadSubs().filter(s => s.endpoint !== endpoint);
  saveSubs(subs);
  res.json({ ok: true, count: subs.length });
});

app.post('/api/push/test', async (req, res) => {
  const sub = req.body && req.body.subscription;
  if (!sub || !sub.endpoint || !sub.keys) {
    return res.status(400).json({ error: 'Missing subscription in body' });
  }
  try {
    await webpush.sendNotification(sub, JSON.stringify({
      title: 'Homelab — Test notification',
      body:  'If you can see this, push notifications are working.',
      tag:   'test-' + Date.now(),
      url:   '/'
    }));
    res.json({ ok: true });
  } catch (err) {
    if (err && (err.statusCode === 404 || err.statusCode === 410)) {
      const subs = loadSubs().filter(s => s.endpoint !== sub.endpoint);
      saveSubs(subs);
    }
    res.status(500).json({ ok: false, error: err.message || 'Send failed' });
  }
});

// ─── API: Updates ────────────────────────────────────────────────────────────

app.get('/api/update/check', async (req, res) => {
  try {
    const data      = await fetchJSON(`https://api.github.com/repos/${REPO}/commits/main`);
    const latestSha = data.sha;
    const isDev     = BUILD_SHA === 'dev';
    res.json({
      current:       isDev ? 'dev' : BUILD_SHA.slice(0, 7),
      currentFull:   BUILD_SHA,
      latest:        latestSha.slice(0, 7),
      latestFull:    latestSha,
      hasUpdate:     !isDev && BUILD_SHA !== latestSha,
      isDev,
      commitMessage: data.commit.message.split('\n')[0],
      commitDate:    data.commit.committer.date,
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to reach GitHub: ' + e.message });
  }
});

app.post('/api/update/apply', async (req, res) => {
  const token = process.env.WATCHTOWER_HTTP_API_TOKEN;
  const base  = (process.env.WATCHTOWER_HTTP_API_URL || 'http://watchtower:8080').replace(/\/$/, '');

  if (!token) {
    return res.json({
      ok: false, manual: true,
      message: 'Add WATCHTOWER_HTTP_API_TOKEN to your docker-compose environment to enable one-click updates. Watchtower will apply this update automatically within 5 minutes.'
    });
  }

  try {
    const parsed = new URL(`${base}/v1/update`);
    const mod    = parsed.protocol === 'https:' ? https : http;
    await new Promise((resolve, reject) => {
      const r = mod.request({
        hostname: parsed.hostname,
        port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path:     '/v1/update',
        method:   'POST',
        headers:  { 'Authorization': `Bearer ${token}` }
      }, resp => { resolve(); resp.resume(); });
      r.on('error', reject);
      r.setTimeout(8000, () => { r.destroy(); reject(new Error('Timeout contacting Watchtower')); });
      r.end();
    });
    res.json({ ok: true, message: 'Watchtower triggered — the container will restart momentarily.' });
  } catch (e) {
    // A timeout means Watchtower received the request and is restarting the container
    if (e.message && e.message.includes('Timeout')) {
      return res.json({ ok: true, message: 'Watchtower triggered — the container will restart momentarily.' });
    }
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── API: History ────────────────────────────────────────────────────────────

app.get('/api/history', (req, res) => {
  const d = load();
  const out = d.services.map(s => ({
    id:           s.id,
    name:         s.name,
    abbr:         s.abbr,
    cat:          s.cat,
    status:       s.status,
    disabled:     !!s.disabled,
    maintenance:  !!s.maintenance,
    uptime:       s.uptime,
    dailyHistory:  (s.dailyHistory  || []).slice(-90),
    hourlyHistory: (s.hourlyHistory || []).slice(-168),
    events:        (s.events        || []).slice(-500),
  }));
  res.json({ services: out, categories: d.categories });
});

// ─── API: Status Pages (auth-gated CRUD) ────────────────────────────────────

function normalizeStatusPageInput(body, existingPages, selfId) {
  const errors = [];
  const out = {};

  if (body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name) errors.push('Name is required');
    if (name.length > 60) errors.push('Name must be 60 characters or fewer');
    out.name = name;
  }
  if (body.slug !== undefined) {
    const v = validateSlug(body.slug, existingPages, selfId);
    if (!v.ok) errors.push(v.error);
    else out.slug = v.value;
  }
  if (body.description !== undefined) {
    const desc = String(body.description || '');
    if (desc.length > 280) errors.push('Description must be 280 characters or fewer');
    out.description = desc;
  }
  if (body.serviceIds !== undefined) {
    if (!Array.isArray(body.serviceIds)) errors.push('serviceIds must be an array');
    else out.serviceIds = body.serviceIds.filter(id => typeof id === 'string');
  }
  if (body.includedCategoryIds !== undefined) {
    if (!Array.isArray(body.includedCategoryIds)) errors.push('includedCategoryIds must be an array');
    else out.includedCategoryIds = body.includedCategoryIds.filter(id => typeof id === 'string');
  }
  if (body.showEventLog !== undefined) out.showEventLog = !!body.showEventLog;
  if (body.showOverallBanner !== undefined) out.showOverallBanner = !!body.showOverallBanner;

  return { errors, data: out };
}

app.get('/api/status-pages', (_, res) => {
  const d = load();
  res.json({ pages: d.statusPages || [] });
});

app.post('/api/status-pages', (req, res) => {
  const d = load();
  if (!Array.isArray(d.statusPages)) d.statusPages = [];
  const { errors, data } = normalizeStatusPageInput(req.body || {}, d.statusPages, null);
  if (req.body?.name === undefined)  errors.push('Name is required');
  if (req.body?.slug === undefined)  errors.push('Slug is required');
  if (errors.length) return res.status(400).json({ error: errors[0], errors });

  const now = new Date().toISOString();
  const page = {
    id:                  crypto.randomUUID(),
    slug:                data.slug,
    name:                data.name,
    description:         data.description || '',
    serviceIds:          data.serviceIds || [],
    includedCategoryIds: data.includedCategoryIds || [],
    showEventLog:        data.showEventLog !== false,
    showOverallBanner:   data.showOverallBanner !== false,
    createdAt:           now,
    updatedAt:           now
  };
  d.statusPages.push(page);
  save(d);
  res.status(201).json({ page });
});

app.put('/api/status-pages/:id', (req, res) => {
  const d = load();
  if (!Array.isArray(d.statusPages)) d.statusPages = [];
  const target = d.statusPages.find(p => p.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'Status page not found' });

  const { errors, data } = normalizeStatusPageInput(req.body || {}, d.statusPages, target.id);
  if (errors.length) return res.status(400).json({ error: errors[0], errors });

  Object.assign(target, data);
  target.updatedAt = new Date().toISOString();
  save(d);
  res.json({ page: target });
});

app.delete('/api/status-pages/:id', (req, res) => {
  const d = load();
  if (!Array.isArray(d.statusPages)) d.statusPages = [];
  const before = d.statusPages.length;
  d.statusPages = d.statusPages.filter(p => p.id !== req.params.id);
  if (d.statusPages.length === before) return res.status(404).json({ error: 'Status page not found' });
  save(d);
  res.json({ ok: true });
});

// ─── Midnight daily-history rollover ─────────────────────────────────────────

function scheduleMidnightRollover() {
  const now  = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 5, 0); // 00:00:05 tomorrow
  const msUntil = next - now;
  setTimeout(() => {
    // Seal today's entry (nothing to write — accumulateDailyTick already does it live)
    console.log('[history] Daily rollover at', new Date().toISOString());
    scheduleMidnightRollover(); // reschedule for tomorrow
  }, msUntil);
}

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  🟢  Homelab Dashboard → http://localhost:${PORT}\n`);
  scheduleChecks();
  scheduleMidnightRollover();
});
