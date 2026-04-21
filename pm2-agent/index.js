const { execSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:55964';
const POLL_MS       = parseInt(process.env.POLL_INTERVAL_MS || '30000', 10);
const API_KEY       = process.env.REPORT_API_KEY || '';
const AGENT_NAME    = process.env.AGENT_NAME || os.hostname() || 'pm2-agent';

const DATA_DIR = path.join(__dirname, 'data');
const ID_FILE  = path.join(DATA_DIR, 'agent-id');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let agentId = '';
try { agentId = fs.readFileSync(ID_FILE, 'utf8').trim(); } catch {}

// ─── PM2 ─────────────────────────────────────────────────────────────────────

function pm2List() {
  const raw = execSync('pm2 jlist', { encoding: 'utf8', timeout: 10000 });
  return JSON.parse(raw);
}

function pm2ToDashboardStatus(pm2Status) {
  if (pm2Status === 'online')                              return 'online';
  if (pm2Status === 'stopped' || pm2Status === 'stopping') return 'offline';
  return 'degraded'; // errored, launching, one-launch-status, etc.
}

function fmtUptime(ms) {
  if (!ms || ms < 0) return null;
  const s = Math.floor(ms / 1000);
  if (s < 60)    return `${s}s`;
  if (s < 3600)  return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
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

// ─── Registration ─────────────────────────────────────────────────────────────

async function register() {
  try {
    const out = await httpJson('POST', `${DASHBOARD_URL}/api/pm2/agents/register`, {
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

  let procs;
  try { procs = pm2List(); }
  catch (err) {
    console.error(`[${ts()}] pm2 jlist failed: ${err.message}`);
    return;
  }

  const discovery = procs.map(p => {
    const env = p.pm2_env || {};
    return {
      name:     p.name,
      status:   env.status || 'unknown',
      restarts: env.restart_time != null ? env.restart_time : 0,
      uptime:   env.pm_uptime ? fmtUptime(Date.now() - env.pm_uptime) : null
    };
  });

  try {
    await httpJson('POST', `${DASHBOARD_URL}/api/pm2/agents/${agentId}/discovery`, { items: discovery });
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
    const r = await httpJson('GET', `${DASHBOARD_URL}/api/pm2/agents/${agentId}/monitored`);
    monitored = Array.isArray(r.monitored) ? r.monitored : [];
  } catch (err) {
    console.error(`[${ts()}] Monitored pull failed: ${err.message}`);
    return;
  }

  for (const m of monitored) {
    const proc = procs.find(p => p.name === m.name);
    let body;
    if (!proc) {
      body = { status: 'offline', desc: 'process not found' };
    } else {
      const env = proc.pm2_env || {};
      const status = pm2ToDashboardStatus(env.status);
      const restarts = env.restart_time != null ? env.restart_time : 0;
      const uptime   = env.pm_uptime ? fmtUptime(Date.now() - env.pm_uptime) : null;
      body = {
        status,
        desc: uptime
          ? `restarts: ${restarts} · up ${uptime}`
          : `restarts: ${restarts} · ${env.status}`
      };
    }
    try {
      await httpJson('POST', `${DASHBOARD_URL}/api/services/${m.serviceId}/report`, body);
      console.log(`[${ts()}] ${m.name} → ${body.status}`);
    } catch (err) {
      console.error(`[${ts()}] Report failed for ${m.name}: ${err.message}`);
    }
  }
}

function ts() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

// ─── Start ────────────────────────────────────────────────────────────────────

console.log(`[${ts()}] pm2-agent starting — polling every ${POLL_MS / 1000}s → ${DASHBOARD_URL}`);
(async () => {
  await register();
  await poll();
  setInterval(poll, POLL_MS);
})();
