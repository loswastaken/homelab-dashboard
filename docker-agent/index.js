const { spawnSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:55964';
const POLL_MS       = parseInt(process.env.POLL_INTERVAL_MS || '30000', 10);
const API_KEY       = process.env.REPORT_API_KEY || '';
const AGENT_NAME    = process.env.AGENT_NAME || os.hostname() || 'docker-agent';

const DATA_DIR = path.join(__dirname, 'data');
const ID_FILE  = path.join(DATA_DIR, 'agent-id');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let agentId = '';
try { agentId = fs.readFileSync(ID_FILE, 'utf8').trim(); } catch {}

// Boot-loop detector: timestamps (ms) per containerId for transitions into
// `health: starting`. An entry is captured only on the rising edge (prev poll
// wasn't starting, this one is). ≥3 entries within 10 min → degraded.
const startingHistory = new Map();
const prevHealth = new Map();
const BOOT_LOOP_WINDOW_MS = 10 * 60 * 1000;
const BOOT_LOOP_THRESHOLD = 3;

// ─── Docker ───────────────────────────────────────────────────────────────────

// We use a pipe-delimited custom template rather than `--format '{{json .}}'`
// because the JSON formatter hangs against older Docker daemons
// (observed on Synology DSM running API 1.43). The fields we emit are the
// same shape the rest of this file reads off the parsed object.
// `Status` contains human text like "Up 2 hours (healthy)" or
// "Up 30 seconds (health: starting)" or "Exited (137) 5 minutes ago".
const PS_FMT = '{{.ID}}|{{.Names}}|{{.State}}|{{.Status}}';

function dockerList() {
  const t0 = Date.now();
  const r = spawnSync('docker', ['ps', '-a', '--format', PS_FMT], {
    encoding: 'utf8',
    timeout:  30000
  });
  const elapsed = Date.now() - t0;
  if (r.error)  throw r.error;
  if (r.status !== 0) {
    throw new Error(`docker ps exited ${r.status}: ${(r.stderr || '').trim()}`);
  }
  const items = (r.stdout || '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      const [ID, Names, State, Status] = l.split('|');
      return { ID, Names, State, Status };
    });
  return { items, elapsed };
}

function parseHealth(statusText) {
  if (!statusText) return null;
  const m = statusText.match(/\((health:\s*)?(healthy|unhealthy|starting)\)/i);
  return m ? m[2].toLowerCase() : null;
}

function recordStartingIfRising(containerId, health) {
  const prev = prevHealth.get(containerId);
  if (health === 'starting' && prev !== 'starting') {
    const arr = startingHistory.get(containerId) || [];
    arr.push(Date.now());
    startingHistory.set(containerId, arr);
  }
  prevHealth.set(containerId, health);
}

function pruneStarting(containerId) {
  const arr = startingHistory.get(containerId);
  if (!arr) return [];
  const cutoff = Date.now() - BOOT_LOOP_WINDOW_MS;
  const kept = arr.filter(t => t >= cutoff);
  if (kept.length) startingHistory.set(containerId, kept);
  else             startingHistory.delete(containerId);
  return kept;
}

function dockerToDashboard(container) {
  const state = (container.State || '').toLowerCase();
  const statusText = container.Status || '';
  const health = parseHealth(statusText);
  const containerId = container.ID || container.Id || container.Names || container.Name;

  recordStartingIfRising(containerId, health);
  const startingCount = pruneStarting(containerId).length;

  if (state === 'running') {
    if (health === 'unhealthy') {
      return { status: 'degraded', desc: `unhealthy · ${statusText}` };
    }
    if (health === 'starting') {
      if (startingCount >= BOOT_LOOP_THRESHOLD) {
        return { status: 'degraded', desc: `boot-loop: ${startingCount} restarts in 10m` };
      }
      return { status: 'online', desc: `starting · ${statusText}` };
    }
    // healthy or no healthcheck
    return { status: 'online', desc: health === 'healthy' ? `running (healthy) · ${statusText}` : `running · ${statusText}` };
  }
  if (state === 'restarting' || state === 'paused') {
    return { status: 'degraded', desc: `${state} · ${statusText}` };
  }
  // exited, dead, created, removing, etc.
  return { status: 'offline', desc: `${state} · ${statusText}` };
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function httpJson(method, url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : '';
    const req = mod.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + (parsed.search || ''),
      method,
      headers: {
        'Accept':       'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(API_KEY ? { 'X-Api-Key': API_KEY } : {})
      }
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0, 200)}`));
        try { resolve(buf ? JSON.parse(buf) : {}); }
        catch { reject(new Error('Invalid JSON from dashboard')); }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function register() {
  try {
    const out = await httpJson('POST', `${DASHBOARD_URL}/api/docker/agents/register`, {
      name:     AGENT_NAME,
      hostname: os.hostname()
    });
    if (out.agentId && out.agentId !== agentId) {
      agentId = out.agentId;
      fs.writeFileSync(ID_FILE, agentId);
    }
    console.log(`[${ts()}] Registered as ${AGENT_NAME} → ${agentId}`);
  } catch (err) {
    console.error(`[${ts()}] Register failed: ${err.message}`);
  }
}

// ─── Poll ─────────────────────────────────────────────────────────────────────

async function poll() {
  if (!agentId) await register();
  if (!agentId) return;

  let containers, dockerElapsed;
  try {
    const out = dockerList();
    containers = out.items;
    dockerElapsed = out.elapsed;
  } catch (err) {
    console.error(`[${ts()}] docker ps failed: ${err.message}`);
    return;
  }

  // Extract the container name from `Names` (comma-sep) — take the first one.
  const normalized = containers.map(c => {
    const rawNames = c.Names || c.Name || '';
    const name = String(rawNames).split(',')[0].trim().replace(/^\//, '');
    return { raw: c, name, id: (c.ID || '').slice(0, 12) };
  });

  const discovery = normalized.map(n => ({
    name:   n.name,
    id:     n.id,
    state:  (n.raw.State || '').toLowerCase(),
    status: n.raw.Status || '',
    health: parseHealth(n.raw.Status) || ''
  }));

  try {
    await httpJson('POST', `${DASHBOARD_URL}/api/docker/agents/${agentId}/discovery`, { items: discovery });
  } catch (err) {
    if (/HTTP 404/.test(err.message)) {
      console.warn(`[${ts()}] Agent id not recognized, re-registering`);
      agentId = '';
      try { fs.unlinkSync(ID_FILE); } catch {}
      return;
    }
    console.error(`[${ts()}] Discovery push failed: ${err.message}`);
    return;
  }

  let monitored;
  try {
    const r = await httpJson('GET', `${DASHBOARD_URL}/api/docker/agents/${agentId}/monitored`);
    monitored = Array.isArray(r.monitored) ? r.monitored : [];
  } catch (err) {
    console.error(`[${ts()}] Monitored pull failed: ${err.message}`);
    return;
  }

  for (const m of monitored) {
    const match = normalized.find(n => n.name === m.name);
    let body;
    if (!match) {
      body = { status: 'offline', desc: 'container not found' };
    } else {
      body = dockerToDashboard(match.raw);
    }
    body.response = dockerElapsed;
    try {
      await httpJson('POST', `${DASHBOARD_URL}/api/services/${m.serviceId}/report`, body);
      console.log(`[${ts()}] ${m.name} → ${body.status} (${dockerElapsed}ms)`);
    } catch (err) {
      console.error(`[${ts()}] Report failed for ${m.name}: ${err.message}`);
    }
  }
}

function ts() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

// ─── Start ────────────────────────────────────────────────────────────────────

console.log(`[${ts()}] docker-agent starting — polling every ${POLL_MS / 1000}s → ${DASHBOARD_URL}`);
(async () => {
  await register();
  await poll();
  setInterval(poll, POLL_MS);
})();
