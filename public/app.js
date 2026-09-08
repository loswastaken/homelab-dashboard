/* ═══════════════════════════════════════════════════════════════════════════
   HomeLab Dashboard — core runtime
   Shared state, router, data polling, sidebar (folder rail), modals, and the
   helper API every screen module builds on. Screens register themselves with
   App.registerScreen(id, { title, render(root, fresh), onData?(fresh),
   onLeave?() → boolean|Promise<boolean> }) and are mounted into #screen.
═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const App = window.App = {};

  /* ─── State ───────────────────────────────────────────────────────────── */
  App.state = {
    screen: 'dashboard',
    folder: 'all',            // 'all' | category id (global — shared by Dashboard + Uptime)
    sel: null,                // selected service id (detail rail)
    range: '30d',             // '24h' | '7d' | '30d'
    tab: 'general',           // settings tab
    page: null,               // selected status page id
    data: { services: [], categories: [], settings: {}, statusPages: [], pm2Agents: [], dockerAgents: [], version: '' },
    hist: {},                 // service id → { dailyHistory, hourlyHistory, events }
    histAt: 0,
    loaded: false,
    lastChecked: null,
    nextFireAt: null,
    weather: { text: '', data: null, error: false },
    online: true,
  };
  const S = App.state;
  App.screens = {};
  App.registerScreen = (id, def) => { App.screens[id] = def; };

  /* ─── Tokens / palette ────────────────────────────────────────────────── */
  App.acc  = h => `oklch(0.80 0.13 ${h})`;
  App.tint = h => `oklch(0.80 0.13 ${h} / 0.14)`;
  App.textOn = h => `oklch(0.86 0.11 ${h})`;

  App.PRESET_HUES = { green: 158, amber: 75, red: 25, blue: 240, purple: 300, pink: 340, slate: 200 };
  App.PRESET_ORDER = ['green', 'amber', 'red', 'blue', 'purple', 'pink', 'slate'];

  // sRGB hex → OKLab hue, so custom category colors keep the fixed-L/C accent formula.
  App.hueFromHex = function (hex) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return null;
    let h = m[1];
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const r = lin(parseInt(h.slice(0, 2), 16)), g = lin(parseInt(h.slice(2, 4), 16)), b = lin(parseInt(h.slice(4, 6), 16));
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const A = 1.9779984951 * l - 2.4285922050 * m_ + 0.4505937099 * s;
    const B = 0.0259040371 * l + 0.7827717662 * m_ - 0.8086757660 * s;
    if (Math.abs(A) < 1e-4 && Math.abs(B) < 1e-4) return 200; // achromatic → slate
    let hue = Math.atan2(B, A) * 180 / Math.PI;
    if (hue < 0) hue += 360;
    return Math.round(hue);
  };
  App.hueOf = function (color) {
    if (!color) return 158;
    if (App.PRESET_HUES[color] !== undefined) return App.PRESET_HUES[color];
    const h = App.hueFromHex(color);
    return h == null ? 158 : h;
  };

  App.STATUS = {
    online:      { h: 158, cls: 'ok',      label: 'online',      long: 'Online · all checks passing' },
    degraded:    { h: 75,  cls: 'warn',    label: 'degraded',    long: 'Degraded · needs a look' },
    offline:     { h: 25,  cls: 'down',    label: 'offline',     long: 'Offline · unreachable' },
    maintenance: { h: 265, cls: 'maint',   label: 'maintenance', long: 'Paused · maintenance mode' },
    pending:     { h: 220, cls: 'pending', label: 'pending',     long: 'Pending · awaiting first check' },
    disabled:    { h: null, cls: 'paused', label: 'disabled',    long: 'Disabled · removed from checks' },
  };
  App.statusOf = function (svc) {
    if (!svc) return 'pending';
    if (svc.disabled) return 'disabled';
    if (svc.maintenance) return 'maintenance';
    const st = svc.status;
    return App.STATUS[st] && st !== 'disabled' && st !== 'maintenance' ? st : 'pending';
  };
  App.statusColor = st => App.STATUS[st]?.h != null ? App.acc(App.STATUS[st].h) : 'var(--paused)';
  App.statusTint  = st => App.STATUS[st]?.h != null ? App.tint(App.STATUS[st].h) : 'var(--paused-tint)';
  App.statusText  = st => App.STATUS[st]?.h != null ? App.textOn(App.STATUS[st].h) : 'var(--t-sec)';
  App.isBad = st => st === 'degraded' || st === 'offline';

  /* ─── Escaping / formatting ───────────────────────────────────────────── */
  App.esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  App.fmtTime = d => new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  App.fmtWhen = iso => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
  App.fmtDateUTC = iso => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  App.fmtHourKey = key => new Date(key + ':00:00Z').toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric' });
  App.relTime = function (iso) {
    const t = new Date(iso).getTime();
    if (!t) return 'never';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 5)     return 'just now';
    if (s < 60)    return s + 's ago';
    if (s < 3600)  return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  };
  App.fmtDur = function (ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d >= 1) return d + 'd ' + (h % 24) + 'h';
    if (h >= 1) return h + 'h ' + (m % 60) + 'm';
    return m + 'm ' + (s % 60) + 's';
  };
  App.fmtPct = (n, digits = 1) => (n == null || isNaN(n)) ? '—' : n.toFixed(digits) + '%';
  App.plural = (n, one, many) => n === 1 ? one : (many || one + 's');

  /* ─── Categories → folders ────────────────────────────────────────────── */
  App.catFor = id => S.data.categories.find(c => c.id === id) || null;
  App.topLevelCats = () => S.data.categories.filter(c => !c.parentId);
  App.subCatsOf = id => S.data.categories.filter(c => c.parentId === id);
  App.folderOf = function (svc) {
    const cat = App.catFor(svc?.cat);
    if (!cat) return null;
    return cat.parentId ? (App.catFor(cat.parentId) || cat) : cat;
  };
  App.folderHue = svc => App.hueOf((App.catFor(svc?.cat) || App.folderOf(svc) || {}).color);
  App.folderLabel = function (id) {
    if (!id || id === 'all') return 'All services';
    return App.catFor(id)?.name || 'Folder';
  };
  App.servicesInFolder = function (id) {
    const all = S.data.services;
    if (!id || id === 'all') return all;
    const subIds = new Set(App.subCatsOf(id).map(c => c.id));
    return all.filter(s => s.cat === id || subIds.has(s.cat));
  };
  App.sortServices = function (list) {
    const alpha = (a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
    const pinned = list.filter(s => s.pinnedAt && !s.disabled).sort(alpha);
    const rest   = list.filter(s => !(s.pinnedAt && !s.disabled) && !s.disabled).sort(alpha);
    const off    = list.filter(s => s.disabled).sort(alpha);
    return [...pinned, ...rest, ...off];
  };
  App.folderHealth = function (list) {
    const bad = list.filter(s => App.isBad(App.statusOf(s))).length;
    if (!list.length) return { bad: 0, text: 'empty', cls: 'idle' };
    return bad ? { bad, text: bad + ' need a look', cls: 'bad' } : { bad: 0, text: 'all healthy', cls: 'ok' };
  };
  App.fleetCounts = function (list) {
    const c = { online: 0, degraded: 0, offline: 0, pending: 0, paused: 0, total: list.length };
    for (const s of list) {
      const st = App.statusOf(s);
      if (st === 'online') c.online++;
      else if (st === 'degraded') c.degraded++;
      else if (st === 'offline') c.offline++;
      else if (st === 'pending') c.pending++;
      else c.paused++;
    }
    return c;
  };

  /* ─── History buckets ─────────────────────────────────────────────────── */
  App.RANGES = {
    '24h': { slots: 24, bucket: '1 hour',  label: '24h', hours: 24 },
    '7d':  { slots: 28, bucket: '6 hours', label: '7d',  hours: 24 * 7 },
    '30d': { slots: 30, bucket: '1 day',   label: '30d', hours: 24 * 30 },
  };
  App.histFor = id => S.hist[id] || { dailyHistory: [], hourlyHistory: [], events: [] };
  App.rangeCutoff = function (range) {
    const r = App.RANGES[range] || App.RANGES['30d'];
    return Date.now() - r.hours * 3600 * 1000;
  };
  function mergeEntries(entries, label) {
    const acc = { label, online: 0, degraded: 0, offline: 0, maintenance: 0, total: 0 };
    for (const e of entries) {
      acc.online += e.online || 0; acc.degraded += e.degraded || 0;
      acc.offline += e.offline || 0; acc.maintenance += e.maintenance || 0; acc.total += e.total || 0;
    }
    const denom = acc.online + acc.degraded + acc.offline;
    acc.uptime = denom > 0 ? parseFloat((acc.online / denom * 100).toFixed(2)) : null;
    return acc;
  }
  // Returns exactly RANGES[range].slots buckets, left-padded with { empty: true }.
  App.bucketsFor = function (svcId, range) {
    const r = App.RANGES[range] || App.RANGES['30d'];
    const h = App.histFor(svcId);
    let out = [];
    if (range === '24h') {
      out = (h.hourlyHistory || []).slice(-24).map(e => ({ ...e, label: App.fmtHourKey(e.ts) }));
    } else if (range === '7d') {
      const hours = (h.hourlyHistory || []).slice(-168);
      // Group into 6-hour buckets aligned from the newest hour backwards.
      const groups = [];
      for (let end = hours.length; end > 0; end -= 6) {
        const chunk = hours.slice(Math.max(0, end - 6), end);
        groups.unshift(mergeEntries(chunk, App.fmtHourKey(chunk[0].ts) + ' +6h'));
      }
      out = groups.slice(-28);
    } else {
      out = (h.dailyHistory || []).slice(-30).map(e => ({ ...e, label: App.fmtDateUTC(e.date) }));
    }
    while (out.length < r.slots) out.unshift({ empty: true });
    return out.slice(-r.slots);
  };
  App.bucketKind = function (b) {
    if (!b || b.empty) return 'empty';
    if (b.uptime == null) return (b.maintenance > 0 ? 'maint' : 'empty');
    if (b.uptime >= 99) return 'ok';
    if (b.uptime >= 80) return 'warn';
    return 'down';
  };
  App.uptimeFor = function (svcId, range) {
    const bs = App.bucketsFor(svcId, range).filter(b => !b.empty && b.uptime != null);
    if (!bs.length) return null;
    let up = 0, denom = 0;
    for (const b of bs) { const d = (b.online || 0) + (b.degraded || 0) + (b.offline || 0); up += b.online || 0; denom += d; }
    return denom > 0 ? up / denom * 100 : null;
  };
  // Pill-bar strip HTML. Heights encode uptime for healthy buckets (99% → minH,
  // 100% → maxH); unhealthy buckets sit at the low height so outages read at a glance.
  App.barsHtml = function (buckets, opts = {}) {
    const minH = opts.minH ?? 19, maxH = opts.maxH ?? 30, lowH = opts.lowH ?? Math.round(minH * 0.7);
    return buckets.map(b => {
      const kind = App.bucketKind(b);
      let h = lowH;
      if (kind === 'ok') h = Math.round(minH + (maxH - minH) * Math.min(1, Math.max(0, (b.uptime - 99) / 1)));
      else if (kind === 'maint') h = Math.round((minH + lowH) / 2);
      else if (kind === 'empty') h = lowH;
      const tip = b.empty ? '' : ` data-tip="${App.esc(b.label)}: ${App.fmtPct(b.uptime, 2)}"`;
      return `<span class="bar ${kind}" style="height:${h}px"${tip}></span>`;
    }).join('');
  };
  App.tickBuckets = function (svc) {
    // The live 30-tick history bar (per-check cadence) as buckets.
    const ticks = (svc?.history || []).slice(-30);
    const out = ticks.map(v => v === 1 ? { uptime: 100, online: 1, total: 1, label: 'check' }
      : v === 2 ? { uptime: 90, degraded: 1, total: 1, label: 'degraded check' }
      : v === 3 ? { uptime: null, maintenance: 1, total: 1, label: 'maintenance' }
      : { uptime: 0, offline: 1, total: 1, label: 'offline check' });
    while (out.length < 30) out.unshift({ empty: true });
    return out;
  };
  App.incidentsFor = function (svcId, range) {
    const cutoff = App.rangeCutoff(range);
    return (App.histFor(svcId).events || []).filter(e =>
      (e.type === 'offline' || e.type === 'degraded') && new Date(e.ts).getTime() >= cutoff).length;
  };
  // Pair transition events into incidents: { svcId, name, severity, cause, startedAt, endedAt|null }.
  App.buildIncidents = function (services, range) {
    const cutoff = App.rangeCutoff(range);
    const out = [];
    for (const svc of services) {
      const events = (App.histFor(svc.id).events || []).slice().sort((a, b) => new Date(a.ts) - new Date(b.ts));
      let open = null, maint = null;
      for (const e of events) {
        if (e.type === 'offline' || e.type === 'degraded') {
          const sev = e.type === 'offline' ? 'outage' : 'degraded';
          if (open) {
            if (sev === 'outage' && open.severity !== 'outage') { open.severity = 'outage'; open.cause = e.note || open.cause; }
          } else {
            open = { svcId: svc.id, name: svc.name, severity: sev, cause: e.note || (sev === 'outage' ? 'went offline' : 'degraded'), startedAt: e.ts, endedAt: null };
            out.push(open);
          }
        } else if (e.type === 'recovery') {
          if (open) { open.endedAt = e.ts; open = null; }
        } else if (e.type === 'maintenance') {
          const enabling = !/disabled/i.test(e.note || '');
          if (enabling && !maint) { maint = { svcId: svc.id, name: svc.name, severity: 'maintenance', cause: 'planned maintenance', startedAt: e.ts, endedAt: null }; out.push(maint); }
          else if (!enabling && maint) { maint.endedAt = e.ts; maint = null; }
          if (open && enabling) { open.endedAt = e.ts; open = null; }
        }
      }
      // An open incident on a service that is now healthy was resolved without a recovery event (e.g. resolve/restart).
      if (open && !App.isBad(App.statusOf(svc))) { open.endedAt = svc.lastChecked || new Date().toISOString(); }
      if (maint && !svc.maintenance) { maint.endedAt = new Date().toISOString(); }
    }
    return out
      .filter(i => i.endedAt === null || new Date(i.startedAt).getTime() >= cutoff)
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  };
  App.SEVERITY_HUE = { outage: 25, degraded: 75, maintenance: 265 };

  /* ─── Fetch / API ─────────────────────────────────────────────────────── */
  // A 401 normally means the session expired → bounce to /login. Endpoints that
  // legitimately answer 401 for a bad credential (PUT /api/auth with a wrong
  // current password) pass { allow401: true } so the error reaches the form.
  App.api = async function (method, path, body, o = {}) {
    const opts = { method, headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    let res;
    try { res = await fetch(path, opts); }
    catch (e) { return { ok: false, status: 0, json: { error: 'Could not reach the server' } }; }
    let json = {};
    try { json = await res.json(); } catch {}
    if (res.status === 401 && !o.allow401) { window.location.href = '/login'; return { ok: false, status: 401, json: { error: 'Signed out' } }; }
    return { ok: res.ok, status: res.status, json };
  };

  App.fetchData = async function (fresh = false) {
    const r = await App.api('GET', '/api/services');
    if (!r.ok) { S.online = false; App.emitData(fresh); return false; }
    const prevSnap = snapshot();
    S.data = { ...S.data, ...r.json };
    S.data.services = S.data.services || [];
    S.data.categories = S.data.categories || [];
    S.data.statusPages = S.data.statusPages || [];
    S.data.settings = S.data.settings || {};
    S.online = true;
    S.loaded = true;
    S.lastChecked = new Date();
    if (!App.catFor(S.folder) && S.folder !== 'all') S.folder = 'all';
    if (S.sel && !S.data.services.find(s => s.id === S.sel)) S.sel = null;
    App.applyChrome();
    if (prevSnap !== snapshot() && Date.now() - S.histAt > 15000) App.fetchHistory(true).then(() => App.emitData(false));
    App.emitData(fresh);
    return true;
  };
  function snapshot() { return S.data.services.map(s => s.id + ':' + App.statusOf(s)).join('|'); }

  App.fetchHistory = async function (force = false) {
    if (!force && Date.now() - S.histAt < 60000) return true;
    const r = await App.api('GET', '/api/history');
    if (!r.ok) return false;
    const map = {};
    for (const s of (r.json.services || [])) map[s.id] = { dailyHistory: s.dailyHistory || [], hourlyHistory: s.hourlyHistory || [], events: s.events || [] };
    S.hist = map;
    S.histAt = Date.now();
    return true;
  };

  App.emitData = function (fresh) {
    App.renderSidebar();
    App.updateFavicon();
    const scr = App.screens[S.screen];
    if (scr && scr.onData) scr.onData(fresh);
  };

  // Manual "force a check now": POST /api/check-all is a read-only preview
  // server-side (response/lastChecked only — no ticks, no status changes).
  App.doRefreshAll = async function () {
    try { await App.api('POST', '/api/check-all'); } catch {}
    await Promise.all([App.fetchHistory(true), App.fetchData(true)]);
    App.emitData(true);
  };

  /* ─── Polling (wall-clock anchored) ───────────────────────────────────── */
  let pollTimeout = null;
  App.scheduleNextPoll = function () {
    clearTimeout(pollTimeout);
    const intervalMs = Math.max(10, S.data.settings?.checkInterval || 60) * 1000;
    S.nextFireAt = Math.ceil(Date.now() / intervalMs) * intervalMs;
    pollTimeout = setTimeout(onPollFire, Math.max(0, S.nextFireAt - Date.now()));
  };
  async function onPollFire() {
    try {
      // Read-only poll: the server's own loop drives ping cadence. fresh=false
      // lets screens patch in place instead of re-animating.
      await App.fetchData(false);
      if (Date.now() - S.histAt > 5 * 60 * 1000 || S.screen === 'uptime') {
        if (await App.fetchHistory(true)) App.emitData(false);
      }
    } finally { App.scheduleNextPoll(); }
  }
  App.secondsToNextPoll = () => S.nextFireAt ? Math.max(0, Math.ceil((S.nextFireAt - Date.now()) / 1000)) : 0;

  /* ─── Weather ─────────────────────────────────────────────────────────── */
  const US_STATES = { 'Alabama':'AL','Alaska':'AK','Arizona':'AZ','Arkansas':'AR','California':'CA',
    'Colorado':'CO','Connecticut':'CT','Delaware':'DE','Florida':'FL','Georgia':'GA','Hawaii':'HI',
    'Idaho':'ID','Illinois':'IL','Indiana':'IN','Iowa':'IA','Kansas':'KS','Kentucky':'KY',
    'Louisiana':'LA','Maine':'ME','Maryland':'MD','Massachusetts':'MA','Michigan':'MI',
    'Minnesota':'MN','Mississippi':'MS','Missouri':'MO','Montana':'MT','Nebraska':'NE',
    'Nevada':'NV','New Hampshire':'NH','New Jersey':'NJ','New Mexico':'NM','New York':'NY',
    'North Carolina':'NC','North Dakota':'ND','Ohio':'OH','Oklahoma':'OK','Oregon':'OR',
    'Pennsylvania':'PA','Rhode Island':'RI','South Carolina':'SC','South Dakota':'SD',
    'Tennessee':'TN','Texas':'TX','Utah':'UT','Vermont':'VT','Virginia':'VA','Washington':'WA',
    'West Virginia':'WV','Wisconsin':'WI','Wyoming':'WY','District of Columbia':'DC' };
  const WEATHER_ICONS = {
    0:'☀️', 1:'🌤️', 2:'⛅', 3:'☁️', 45:'🌫️', 48:'🌫️',
    51:'🌦️', 53:'🌦️', 55:'🌧️', 56:'🌧️', 57:'🌧️',
    61:'🌧️', 63:'🌧️', 65:'🌧️', 66:'🌨️', 67:'🌨️',
    71:'🌨️', 73:'❄️', 75:'❄️', 77:'❄️',
    80:'🌦️', 81:'🌧️', 82:'⛈️', 85:'🌨️', 86:'❄️',
    95:'⛈️', 96:'⛈️', 99:'⛈️'
  };
  let weatherTimer = null;
  App.fetchWeather = async function () {
    const s = S.data.settings || {};
    if (!s.weatherEnabled) { S.weather = { text: '', data: null, error: false }; return notifyWeather(); }
    if (!s.weatherLocation) { S.weather = { text: 'set a weather location in Settings', data: null, error: true }; return notifyWeather(); }
    const r = await App.api('GET', '/api/weather');
    if (!r.ok) S.weather = { text: 'weather unavailable', data: null, error: true };
    else S.weather = { text: '', data: r.json, error: false };
    notifyWeather();
  };
  function notifyWeather() { const scr = App.screens[S.screen]; if (scr && scr.onWeather) scr.onWeather(); }
  App.weatherText = function () {
    const w = S.weather;
    if (w.error) return w.text;
    if (!w.data) return '';
    const d = w.data;
    const icon = WEATHER_ICONS[d.weatherCode] || '🌡️';
    const state = US_STATES[d.admin1] || d.admin1 || '';
    const loc = [d.location, state].filter(Boolean).join(', ');
    return `${icon} ${Math.round(d.temperature)}°${d.units?.temperature || ''} ${loc}`.trim();
  };
  App.startWeatherPoll = function () {
    clearInterval(weatherTimer);
    App.fetchWeather();
    weatherTimer = setInterval(App.fetchWeather, 10 * 60 * 1000);
  };

  /* ─── Chrome: title, favicon, greeting ────────────────────────────────── */
  App.siteTitle = () => S.data.settings?.siteTitle || 'Homelab';
  App.brandName = () => (App.siteTitle().split('·')[0] || '').trim() || 'Homelab';
  App.applyChrome = function () {
    const scr = App.screens[S.screen];
    document.title = scr?.title ? `${scr.title} · ${App.siteTitle()}` : App.siteTitle();
    const brand = document.getElementById('brand-name');
    if (brand) brand.textContent = App.brandName();
    const s = S.data.settings || {};
    const name = document.getElementById('server-name');
    const meta = document.getElementById('server-meta');
    if (name) name.textContent = s.serverLabel || 'Homelab Server';
    if (meta) meta.textContent = [s.nasIp, S.data.version || 'dev'].filter(Boolean).join(' · ');
    const tile = document.getElementById('brand-tile');
    if (tile) tile.textContent = App.brandName().replace(/[^a-z0-9]/gi, '').slice(0, 2).toLowerCase() || 'hl';
  };
  App.greetingHtml = function () {
    const h = new Date().getHours();
    const g = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const name = S.data.settings?.displayName || '';
    return name ? `${g}, <b>${App.esc(name)}.</b>` : `${g}.`;
  };
  App.updateFavicon = function () {
    const active  = S.data.services.filter(s => !s.disabled);
    const visible = active.filter(s => !s.maintenance);
    let href = '/favicon.svg';
    if (visible.some(s => s.status === 'offline'))       href = '/favicon-offline.svg';
    else if (visible.some(s => s.status === 'degraded')) href = '/favicon-degraded.svg';
    else if (active.some(s => s.maintenance))            href = '/favicon-maintenance.svg';
    let link = document.querySelector("link[rel='icon']");
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; link.type = 'image/svg+xml'; document.head.appendChild(link); }
    if (link.getAttribute('href') !== href) link.href = href;
  };

  /* ─── Router ──────────────────────────────────────────────────────────── */
  const ROUTES = { dashboard: '/', uptime: '/uptime', status: '/status', settings: '/settings' };
  App.ROUTES = ROUTES;
  function screenFromPath(p) {
    p = (p || '/').replace(/\/+$/, '') || '/';
    return Object.keys(ROUTES).find(k => ROUTES[k] === p) || 'dashboard';
  }
  App.navigate = async function (id, opts = {}) {
    if (!App.screens[id]) id = 'dashboard';
    if (id === S.screen && !opts.force) { App.collapseRail(); return true; }
    const cur = App.screens[S.screen];
    if (cur && cur.onLeave && !opts.skipGuard) {
      const ok = await cur.onLeave();
      if (ok === false) return false;
    }
    S.screen = id;
    if (!opts.silent) history[opts.replace ? 'replaceState' : 'pushState']({ screen: id }, '', ROUTES[id]);
    App.collapseRail();
    App.renderScreen(true);
    App.renderSidebar();
    App.applyChrome();
    if (opts.scrollTop !== false) window.scrollTo({ top: 0 });
    return true;
  };
  App.renderScreen = function (fresh) {
    const root = document.getElementById('screen');
    const scr = App.screens[S.screen];
    if (!scr) return;
    if (fresh) { root.className = 'screen'; root.innerHTML = ''; void root.offsetWidth; }
    scr.render(root, fresh);
  };
  window.addEventListener('popstate', async () => {
    const target = screenFromPath(location.pathname);
    const cur = App.screens[S.screen];
    if (cur && cur.onLeave) {
      const ok = await cur.onLeave();
      if (ok === false) { history.pushState({ screen: S.screen }, '', ROUTES[S.screen]); return; }
    }
    S.screen = target;
    App.collapseRail();
    App.renderScreen(true);
    App.renderSidebar();
    App.applyChrome();
  });

  /* ─── Selection ───────────────────────────────────────────────────────── */
  App.setFolder = function (id) {
    S.folder = id || 'all';
    App.collapseRail();
    App.renderSidebar();
    const scr = App.screens[S.screen];
    if (scr && scr.onFolder) scr.onFolder(); else App.renderScreen(false);
  };
  App.selectService = function (id, opts = {}) {
    S.sel = id;
    if (opts.goDashboard && S.screen !== 'dashboard') return App.navigate('dashboard');
    const scr = App.screens[S.screen];
    if (scr && scr.onSelect) scr.onSelect(); else App.renderScreen(false);
  };
  App.setRange = function (r) {
    if (!App.RANGES[r]) return;
    S.range = r;
    const scr = App.screens[S.screen];
    if (scr && scr.onRange) scr.onRange(); else App.renderScreen(false);
  };
  App.selectedService = () => S.data.services.find(s => s.id === S.sel) || null;

  /* ─── Sidebar ─────────────────────────────────────────────────────────── */
  const NAV = [
    ['dashboard', 'Dashboard',      '◫'],
    ['uptime',    'Uptime history', '◔'],
    ['status',    'Status pages',   '◎'],
    ['settings',  'Settings',       '⚙'],
  ];
  App.renderSidebar = function () {
    const nav = document.getElementById('nav');
    if (nav) {
      nav.innerHTML = NAV.map(([id, label, glyph]) =>
        `<button class="nav-item${S.screen === id ? ' active' : ''}" data-screen="${id}" title="${label}">
          <span class="nav-dot"></span><span class="rail-only">${glyph}</span><span class="nav-label">${label}</span>
        </button>`).join('');
      nav.querySelectorAll('[data-screen]').forEach(b => b.onclick = () => App.navigate(b.dataset.screen));
    }
    const box = document.getElementById('folders');
    if (!box) return;
    const hideEmpty = !!S.data.settings?.hideEmptyFolders;
    const rows = [];
    const folderRow = (id, label, hue, list, sub) => {
      const hp = App.folderHealth(list);
      const active = S.folder === id;
      const initial = (label || '?').trim().charAt(0).toUpperCase() || '?';
      return `<button class="folder${active ? ' active' : ''}${sub ? ' sub' : ''}" data-folder="${App.esc(id)}" title="${App.esc(label)} · ${list.length}"
          style="${active ? '' : ''}--fh:${hue}">
        <span class="folder-dot" style="background:${App.acc(hue)}"></span>
        <span class="rail-only" style="width:100%;height:100%;border-radius:16px;background:${App.tint(hue)};color:${App.acc(hue)};align-items:center;justify-content:center">${App.esc(initial)}
          <span class="folder-badge${hp.bad ? ' bad' : ''}">${hp.bad || list.length}</span></span>
        <span class="folder-text">
          <span class="folder-name">${App.esc(label)}</span>
          <span class="folder-sub ${hp.cls}">${App.esc(hp.text)}</span>
        </span>
        <span class="folder-count">${list.length}</span>
      </button>`;
    };
    rows.push(folderRow('all', 'All services', 158, S.data.services, false));
    for (const cat of App.topLevelCats()) {
      const list = App.servicesInFolder(cat.id);
      if (hideEmpty && !list.length && S.folder !== cat.id) continue;
      rows.push(folderRow(cat.id, cat.name, App.hueOf(cat.color), list, false));
      for (const sub of App.subCatsOf(cat.id)) {
        const sl = App.servicesInFolder(sub.id);
        if (hideEmpty && !sl.length && S.folder !== sub.id) continue;
        rows.push(folderRow(sub.id, sub.name, App.hueOf(sub.color), sl, true));
      }
    }
    box.innerHTML = `<div class="caption">Folders</div>` + rows.join('');
    box.querySelectorAll('[data-folder]').forEach(b => b.onclick = () => App.setFolder(b.dataset.folder));
  };
  App.expandRail = function () {
    document.getElementById('sidebar')?.classList.add('expanded');
    document.getElementById('sidebar-backdrop')?.classList.add('show');
  };
  App.collapseRail = function () {
    document.getElementById('sidebar')?.classList.remove('expanded');
    document.getElementById('sidebar-backdrop')?.classList.remove('show');
  };
  App.isRailMode = () => window.matchMedia('(max-width: 900px)').matches;

  /* ─── Toasts / dialogs / modals ───────────────────────────────────────── */
  App.toast = function (msg, kind = '') {
    const box = document.getElementById('toasts');
    if (!box) return;
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 320); }, 3200);
  };

  // Generic modal. Returns { el, body, close }. Multiple modals stack.
  App.modal = function ({ title, body = '', foot = '', cls = '', onClose = null, closeOnBackdrop = true }) {
    const root = document.getElementById('modal-root');
    const ov = document.createElement('div');
    ov.className = 'overlay show';
    ov.innerHTML = `<div class="modal ${cls}" role="dialog" aria-modal="true">
      <div class="modal-hdr"><div class="modal-title">${App.esc(title)}</div><button class="modal-close" aria-label="Close">×</button></div>
      <div class="modal-body"></div>
      ${foot ? `<div class="modal-foot">${foot}</div>` : ''}
    </div>`;
    const bodyEl = ov.querySelector('.modal-body');
    if (typeof body === 'string') bodyEl.innerHTML = body; else bodyEl.appendChild(body);
    root.appendChild(ov);
    document.body.classList.add('modal-open');
    let closed = false;
    const close = (result) => {
      if (closed) return; closed = true;
      ov.remove();
      if (!root.querySelector('.overlay')) document.body.classList.remove('modal-open');
      document.removeEventListener('keydown', onKey);
      if (onClose) onClose(result);
    };
    const onKey = e => { if (e.key === 'Escape' && root.lastElementChild === ov) close(undefined); };
    document.addEventListener('keydown', onKey);
    ov.querySelector('.modal-close').onclick = () => close(undefined);
    if (closeOnBackdrop) ov.addEventListener('mousedown', e => { if (e.target === ov) close(undefined); });
    return { el: ov, body: bodyEl, foot: ov.querySelector('.modal-foot'), close };
  };

  App.confirm = function ({ title = 'Are you sure?', message = '', okLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
    return new Promise(resolve => {
      const m = App.modal({
        title, cls: 'narrow',
        body: `<div class="note" style="font-size:13.5px;color:var(--t-strong);line-height:1.5">${App.esc(message)}</div>`,
        foot: `<button class="btn btn-secondary" data-act="cancel">${App.esc(cancelLabel)}</button>
               <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${App.esc(okLabel)}</button>`,
        onClose: r => resolve(!!r)
      });
      m.foot.querySelector('[data-act="cancel"]').onclick = () => m.close(false);
      m.foot.querySelector('[data-act="ok"]').onclick = () => m.close(true);
      setTimeout(() => m.foot.querySelector('[data-act="ok"]').focus(), 30);
    });
  };

  App.prompt = function ({ title = 'Enter a value', label = '', value = '', placeholder = '', okLabel = 'Save', mono = false, maxlength = 80 }) {
    return new Promise(resolve => {
      let result = null;
      const m = App.modal({
        title, cls: 'narrow',
        body: `<div class="field">${label ? `<label class="field-lbl">${App.esc(label)}</label>` : ''}
          <input class="input${mono ? '' : ' ui'}" id="prompt-input" value="${App.esc(value)}" placeholder="${App.esc(placeholder)}" maxlength="${maxlength}"></div>`,
        foot: `<button class="btn btn-secondary" data-act="cancel">Cancel</button>
               <button class="btn btn-primary" data-act="ok">${App.esc(okLabel)}</button>`,
        onClose: () => resolve(result)
      });
      const input = m.body.querySelector('#prompt-input');
      const ok = () => { result = input.value; m.close(true); };
      m.foot.querySelector('[data-act="cancel"]').onclick = () => m.close(false);
      m.foot.querySelector('[data-act="ok"]').onclick = ok;
      input.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
      setTimeout(() => { input.focus(); input.select(); }, 30);
    });
  };

  App.copyText = async function (text, btn) {
    const done = () => { if (btn) { const prev = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => btn.textContent = prev, 1400); } };
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); done(); return true; }
    } catch {}
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    document.body.removeChild(ta);
    if (ok) done(); else App.toast('Copy failed — select and copy manually', 'err');
    return ok;
  };

  // Toggle control markup + wiring. Usage: App.toggleHtml(id, on, label, desc) then App.wireToggles(root).
  App.toggleHtml = function (id, on, label = '', desc = '', disabled = false) {
    return `<button type="button" class="toggle-row${on ? ' on' : ''}${disabled ? ' disabled' : ''}" data-toggle="${App.esc(id)}" aria-pressed="${on ? 'true' : 'false'}"${disabled ? ' disabled' : ''}>
      <span class="toggle"><span class="toggle-knob"></span></span>
      <span class="toggle-state">${label ? App.esc(label) : `<span class="toggle-word">${on ? 'Enabled' : 'Disabled'}</span>`}${desc ? `<span class="toggle-desc">${App.esc(desc)}</span>` : ''}</span>
    </button>`;
  };
  App.wireToggles = function (root, onChange) {
    root.querySelectorAll('[data-toggle]').forEach(b => {
      b.onclick = () => {
        if (b.disabled) return;
        const on = !b.classList.contains('on');
        App.setToggle(b, on);
        if (onChange) onChange(b.dataset.toggle, on, b);
      };
    });
  };
  App.setToggle = function (b, on) {
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    const w = b.querySelector('.toggle-word');
    if (w) w.textContent = on ? 'Enabled' : 'Disabled';
  };
  App.toggleValue = (root, id) => !!root.querySelector(`[data-toggle="${id}"]`)?.classList.contains('on');

  /* ─── Service actions ─────────────────────────────────────────────────── */
  App.deleteService = async function (id) {
    const svc = S.data.services.find(s => s.id === id);
    if (!svc) return;
    const ok = await App.confirm({ title: 'Delete service', message: `Delete "${svc.name}"? Its history and events are removed and this cannot be undone.`, okLabel: 'Delete', danger: true });
    if (!ok) return;
    const r = await App.api('DELETE', `/api/services/${encodeURIComponent(id)}`);
    if (!r.ok) return App.toast(r.json.error || 'Delete failed', 'err');
    if (S.sel === id) S.sel = null;
    App.toast(`Deleted ${svc.name}`);
    await App.doRefreshAll();
  };
  App.resolveService = async function (id) {
    const r = await App.api('POST', `/api/services/${encodeURIComponent(id)}/resolve`);
    if (!r.ok) return App.toast(r.json.error || 'Resolve failed', 'err');
    App.toast('Marked as online', 'ok');
    await App.doRefreshAll();
  };
  App.togglePin = async function (id) {
    const r = await App.api('POST', `/api/services/${encodeURIComponent(id)}/pin`);
    if (!r.ok) return App.toast(r.json.error || 'Pin failed', 'err');
    await App.fetchData(true);
  };
  App.toggleMaintenance = async function (id) {
    const svc = S.data.services.find(s => s.id === id);
    if (!svc) return;
    const r = await App.api('PUT', `/api/services/${encodeURIComponent(id)}`, { maintenance: !svc.maintenance });
    if (!r.ok) return App.toast(r.json.error || 'Update failed', 'err');
    App.toast(svc.maintenance ? 'Checks resumed' : 'Paused for maintenance');
    await App.doRefreshAll();
  };
  App.checkService = async function (id) {
    const r = await App.api('POST', `/api/services/${encodeURIComponent(id)}/check`);
    if (!r.ok) return App.toast(r.json.error || 'Check failed', 'err');
    await App.fetchData(false);
    App.toast('Rechecked');
  };

  /* ─── Service modal (add / edit) ──────────────────────────────────────── */
  let agentCache = { pm2: [], docker: [] };
  App.openServiceModal = async function (id) {
    const svc = id ? S.data.services.find(s => s.id === id) : null;
    const isEdit = !!svc;
    const cats = S.data.categories;
    const catOptions = App.topLevelCats().map(c =>
      `<option value="${App.esc(c.id)}"${svc?.cat === c.id ? ' selected' : ''}>${App.esc(c.name)}</option>` +
      App.subCatsOf(c.id).map(sub => `<option value="${App.esc(sub.id)}"${svc?.cat === sub.id ? ' selected' : ''}>&nbsp;&nbsp;↳ ${App.esc(sub.name)}</option>`).join('')
    ).join('');
    const defaultCat = svc?.cat || (S.folder !== 'all' ? S.folder : '');
    const slowSaved = svc?.slowThresholdMs;
    const body = `
      <div class="fields">
        <div class="field"><label class="field-lbl">Name</label><input class="input ui" id="f-name" placeholder="Plex" value="${App.esc(svc?.name || '')}"></div>
        <div class="field"><label class="field-lbl">Code <span>(up to 4 chars, shown on the bubble)</span></label><input class="input" id="f-abbr" placeholder="PLX" maxlength="4" value="${App.esc(svc?.abbr || '')}" style="text-transform:uppercase"></div>
        <div class="field wide"><label class="field-lbl">Description</label><input class="input ui" id="f-desc" placeholder="Media server" value="${App.esc(svc?.desc || '')}"></div>
        <div class="field"><label class="field-lbl">Folder</label><div class="select-wrap"><select class="input ui" id="f-cat">${cats.length ? catOptions : '<option value="">No folders yet — add one in Settings → Folders</option>'}</select></div></div>
        <div class="field"><label class="field-lbl">Port <span>(display only)</span></label><input class="input" id="f-port" placeholder="32400" value="${App.esc(svc?.port || '')}"></div>
      </div>
      <div class="field">
        <label class="field-lbl">Check type</label>
        <div class="seg-strip" id="f-check-type">
          <button type="button" class="seg-opt" data-type="url">URL</button>
          <button type="button" class="seg-opt" data-type="pm2">PM2</button>
          <button type="button" class="seg-opt" data-type="docker">Docker</button>
        </div>
      </div>
      <div class="fields when-url">
        <div class="field wide"><label class="field-lbl">Check URL</label><input class="input" id="f-url" placeholder="http://10.0.0.5:32400" value="${App.esc(svc?.url || '')}"></div>
        <div class="field wide">
          <label class="field-lbl">Slow response threshold <span>(ms — blank inherits the global default)</span></label>
          <input class="input" id="f-slow-ms" type="number" min="1" max="600000" placeholder="inherits global" value="${(slowSaved === 0 || slowSaved == null) ? '' : App.esc(slowSaved)}">
          ${App.toggleHtml('slowDisabled', slowSaved === 0, 'Disable slow-response monitoring', 'Offline / degraded monitoring still runs for this service.')}
        </div>
      </div>
      <div class="fields when-pm2">
        <div class="field"><label class="field-lbl">PM2 host</label><div class="select-wrap"><select class="input ui" id="f-pm2-agent"></select></div></div>
        <div class="field"><label class="field-lbl">Process</label><div class="select-wrap"><select class="input ui" id="f-pm2-item"></select></div>
          <input class="input" id="f-pm2-manual" placeholder="process name" value="" hidden>
          <a href="#" class="note" id="f-pm2-toggle">Enter a process name manually</a></div>
      </div>
      <div class="fields when-docker">
        <div class="field"><label class="field-lbl">Docker host</label><div class="select-wrap"><select class="input ui" id="f-docker-agent"></select></div></div>
        <div class="field"><label class="field-lbl">Container</label><div class="select-wrap"><select class="input ui" id="f-docker-item"></select></div>
          <input class="input" id="f-docker-manual" placeholder="container name" value="" hidden>
          <a href="#" class="note" id="f-docker-toggle">Enter a container name manually</a></div>
      </div>
      <div class="modal-sec"><span class="caption">Options</span><span class="rule"></span></div>
      <div class="fields">
        ${App.toggleHtml('hasUI', svc ? !!svc.hasUI : true, 'Has a web UI', 'Shows the Open button in the detail rail')}
        ${App.toggleHtml('checkEnabled', svc ? !!svc.checkEnabled : true, 'Auto-check', 'Ping on every health-check cycle')}
        ${App.toggleHtml('maintenance', !!svc?.maintenance, 'Maintenance mode', 'Pause checks and suppress alerts')}
        ${App.toggleHtml('disabled', !!svc?.disabled, 'Disabled', 'Remove from all checks; shown dimmed')}
      </div>
      <div class="form-msg" id="f-msg"></div>`;
    const m = App.modal({
      title: isEdit ? 'Edit service' : 'Add service', cls: 'wide', body,
      foot: `${isEdit ? '<button class="btn btn-danger" data-act="delete" style="margin-right:auto">Delete</button>' : ''}
             <button class="btn btn-secondary" data-act="cancel">Cancel</button>
             <button class="btn btn-primary" data-act="save">${isEdit ? 'Save changes' : 'Add service'}</button>`
    });
    const B = m.body, q = sel => B.querySelector(sel);
    if (defaultCat) q('#f-cat').value = defaultCat;
    App.wireToggles(B, (key, on) => {
      if (key === 'slowDisabled') { const inp = q('#f-slow-ms'); inp.disabled = on; if (on) inp.value = ''; inp.placeholder = on ? 'disabled for this service' : 'inherits global'; }
    });
    if (slowSaved === 0) { q('#f-slow-ms').disabled = true; q('#f-slow-ms').placeholder = 'disabled for this service'; }

    let checkType = svc?.checkType || 'url';
    const setType = t => {
      checkType = t;
      B.querySelectorAll('#f-check-type .seg-opt').forEach(b => b.classList.toggle('active', b.dataset.type === t));
      B.querySelectorAll('.when-url').forEach(el => el.hidden = t !== 'url');
      B.querySelectorAll('.when-pm2').forEach(el => el.hidden = t !== 'pm2');
      B.querySelectorAll('.when-docker').forEach(el => el.hidden = t !== 'docker');
    };
    B.querySelectorAll('#f-check-type .seg-opt').forEach(b => b.onclick = () => setType(b.dataset.type));
    setType(checkType);

    const manual = { pm2: false, docker: false };
    const wireManual = kind => {
      q(`#f-${kind}-toggle`).onclick = e => {
        e.preventDefault();
        manual[kind] = !manual[kind];
        const sel = q(`#f-${kind}-item`), inp = q(`#f-${kind}-manual`);
        sel.parentElement.hidden = manual[kind]; inp.hidden = !manual[kind];
        if (manual[kind]) inp.value = sel.value || inp.value;
        q(`#f-${kind}-toggle`).textContent = manual[kind] ? 'Pick from the list instead' : (kind === 'pm2' ? 'Enter a process name manually' : 'Enter a container name manually');
      };
    };
    wireManual('pm2'); wireManual('docker');

    const loadItems = async (kind, agentId, selected) => {
      const sel = q(`#f-${kind}-item`);
      if (!agentId) { sel.innerHTML = '<option value="">Select a host first</option>'; sel.disabled = true; return; }
      sel.disabled = false; sel.innerHTML = '<option value="">Loading…</option>';
      const r = await App.api('GET', `/api/${kind}/agents/${encodeURIComponent(agentId)}/items`);
      const items = Array.isArray(r.json?.items) ? r.json.items : [];
      if (!items.length) { sel.innerHTML = `<option value="">No ${kind === 'pm2' ? 'processes' : 'containers'} reported yet</option>`; return; }
      const has = selected && items.some(i => i.name === selected);
      sel.innerHTML = (selected && !has ? `<option value="${App.esc(selected)}" selected>${App.esc(selected)} (custom)</option>` : '') +
        items.map(i => {
          const tag = kind === 'pm2' ? (i.status || 'unknown') : (i.state || (i.status || '').split(' ')[0] || 'unknown');
          return `<option value="${App.esc(i.name)}"${i.name === selected ? ' selected' : ''}>${App.esc(i.name)} (${App.esc(tag)})</option>`;
        }).join('');
    };
    const populateAgents = (kind, selectedId) => {
      const sel = q(`#f-${kind}-agent`);
      const list = agentCache[kind] || [];
      if (!list.length) { sel.innerHTML = `<option value="">No ${kind === 'pm2' ? 'PM2' : 'Docker'} agents connected — see Settings → API Key</option>`; sel.disabled = true; return ''; }
      sel.disabled = false;
      sel.innerHTML = list.map(a => `<option value="${App.esc(a.id)}"${a.id === selectedId ? ' selected' : ''}>${App.esc(a.name)}${a.stale ? ' · stale' : ''}</option>`).join('');
      if (!selectedId) sel.value = list[0].id;
      return sel.value;
    };
    (async () => {
      const [p, d] = await Promise.all([App.api('GET', '/api/pm2/agents'), App.api('GET', '/api/docker/agents')]);
      agentCache = { pm2: p.json?.agents || [], docker: d.json?.agents || [] };
      const pm2Id = populateAgents('pm2', svc?.pm2AgentId || '');
      const dkId  = populateAgents('docker', svc?.dockerAgentId || '');
      await Promise.all([loadItems('pm2', pm2Id, svc?.pm2ProcessName || ''), loadItems('docker', dkId, svc?.dockerContainerName || '')]);
      q('#f-pm2-agent').onchange = () => loadItems('pm2', q('#f-pm2-agent').value, '');
      q('#f-docker-agent').onchange = () => loadItems('docker', q('#f-docker-agent').value, '');
    })();

    const setMsg = t => { q('#f-msg').textContent = t || ''; };
    m.foot.querySelector('[data-act="cancel"]').onclick = () => m.close();
    const del = m.foot.querySelector('[data-act="delete"]');
    if (del) del.onclick = async () => { m.close(); App.deleteService(svc.id); };
    m.foot.querySelector('[data-act="save"]').onclick = async () => {
      const slowDisabled = App.toggleValue(B, 'slowDisabled');
      const slowRaw = q('#f-slow-ms').value.trim();
      let slowMs = null;
      if (checkType === 'url') { if (slowDisabled) slowMs = 0; else if (slowRaw !== '') slowMs = Math.max(0, parseInt(slowRaw, 10) || 0); }
      const pm2Name = (manual.pm2 ? q('#f-pm2-manual').value : q('#f-pm2-item').value).trim();
      const dkName  = (manual.docker ? q('#f-docker-manual').value : q('#f-docker-item').value).trim();
      const payload = {
        name: q('#f-name').value.trim(),
        abbr: q('#f-abbr').value.trim().toUpperCase().slice(0, 4),
        desc: q('#f-desc').value.trim(),
        cat:  q('#f-cat').value,
        checkType,
        url:  checkType === 'url' ? q('#f-url').value.trim() : '',
        port: q('#f-port').value.trim(),
        pm2AgentId:          checkType === 'pm2'    ? q('#f-pm2-agent').value    : '',
        pm2ProcessName:      checkType === 'pm2'    ? pm2Name : '',
        dockerAgentId:       checkType === 'docker' ? q('#f-docker-agent').value : '',
        dockerContainerName: checkType === 'docker' ? dkName : '',
        hasUI:        App.toggleValue(B, 'hasUI'),
        checkEnabled: App.toggleValue(B, 'checkEnabled'),
        maintenance:  App.toggleValue(B, 'maintenance'),
        disabled:     App.toggleValue(B, 'disabled'),
        slowThresholdMs: slowMs
      };
      if (!payload.name || !payload.abbr) return setMsg('Name and code are required.');
      if (!payload.cat) return setMsg('Pick a folder (create one under Settings → Folders first).');
      if (checkType === 'url' && !payload.url) return setMsg('A URL is required for URL-checked services.');
      if (checkType === 'pm2' && (!payload.pm2AgentId || !payload.pm2ProcessName)) return setMsg('Select a PM2 host and process, or enter a process name manually.');
      if (checkType === 'docker' && (!payload.dockerAgentId || !payload.dockerContainerName)) return setMsg('Select a Docker host and container, or enter a container name manually.');
      const btn = m.foot.querySelector('[data-act="save"]');
      btn.disabled = true;
      const r = isEdit ? await App.api('PUT', `/api/services/${encodeURIComponent(svc.id)}`, payload) : await App.api('POST', '/api/services', payload);
      btn.disabled = false;
      if (!r.ok) return setMsg(r.json.error || 'Failed to save service.');
      m.close();
      if (!isEdit && r.json?.id) S.sel = r.json.id;
      App.toast(isEdit ? 'Service saved' : 'Service added', 'ok');
      await App.doRefreshAll();
    };
    setTimeout(() => q('#f-name').focus(), 40);
  };

  /* ─── Settings save hook ──────────────────────────────────────────────── */
  App.afterSettingsSaved = async function () {
    await App.fetchData(true);
    App.scheduleNextPoll();
    App.startWeatherPoll();
  };

  /* ─── Boot ────────────────────────────────────────────────────────────── */
  App.logout = async function () {
    try { await fetch('/api/logout', { method: 'POST' }); } catch {}
    window.location.href = '/login';
  };
  App.boot = async function () {
    S.screen = screenFromPath(location.pathname);
    history.replaceState({ screen: S.screen }, '', ROUTES[S.screen]);
    document.getElementById('signout').onclick = App.logout;
    document.getElementById('brand').onclick = () => {
      if (!App.isRailMode()) return;
      const sb = document.getElementById('sidebar');
      sb.classList.contains('expanded') ? App.collapseRail() : App.expandRail();
    };
    document.getElementById('sidebar-backdrop').onclick = App.collapseRail;
    window.addEventListener('resize', () => { if (!App.isRailMode()) App.collapseRail(); });
    App.renderSidebar();
    App.renderScreen(true);          // skeleton while loading
    const ok = await App.fetchData(true);
    if (ok) {
      const def = S.data.settings?.defaultFolder;
      if (def && App.catFor(def)) { S.folder = def; App.renderSidebar(); }
      await App.fetchHistory(true);
      App.emitData(true);
      App.scheduleNextPoll();
      App.startWeatherPoll();
    }
    setInterval(() => { const scr = App.screens[S.screen]; if (scr && scr.onTick) scr.onTick(); }, 1000);
  };
})();
