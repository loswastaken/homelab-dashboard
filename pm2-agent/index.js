const { execSync } = require('child_process');
const http = require('http');

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://10.24.4.26:55964';
const POLL_MS       = parseInt(process.env.POLL_INTERVAL_MS || '30000', 10);

// Map PM2 process names → dashboard service IDs.
// Add/remove entries to match your pm2 list output.
const PM2_MAP = {
  'redbot':      'redbot',
  'zeppelin':    'zeppelin',
};

// ─── PM2 ─────────────────────────────────────────────────────────────────────

function pm2List() {
  const raw = execSync('pm2 jlist', { encoding: 'utf8', timeout: 10000 });
  return JSON.parse(raw);
}

function pm2ToDashboardStatus(pm2Status) {
  if (pm2Status === 'online')                          return 'online';
  if (pm2Status === 'stopped' || pm2Status === 'stopping') return 'offline';
  return 'degraded'; // errored, launching, one-launch, etc.
}

function fmtUptime(ms) {
  if (!ms || ms < 0) return null;
  const s = Math.floor(ms / 1000);
  if (s < 60)    return `${s}s`;
  if (s < 3600)  return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// ─── Dashboard API ────────────────────────────────────────────────────────────

function put(serviceId, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url     = new URL(`${DASHBOARD_URL}/api/services/${serviceId}`);

    const req = http.request({
      hostname: url.hostname,
      port:     url.port || 80,
      path:     url.pathname,
      method:   'PUT',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      res.resume();
      resolve(res.statusCode);
    });

    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─── Poll ─────────────────────────────────────────────────────────────────────

async function poll() {
  let procs;
  try {
    procs = pm2List();
  } catch (err) {
    console.error(`[${ts()}] pm2 jlist failed: ${err.message}`);
    return;
  }

  for (const proc of procs) {
    const serviceId = PM2_MAP[proc.name];
    if (!serviceId) continue;

    const env      = proc.pm2_env || {};
    const status   = pm2ToDashboardStatus(env.status);
    const restarts = env.restart_time != null ? env.restart_time : 0;
    const uptime   = env.pm_uptime ? fmtUptime(Date.now() - env.pm_uptime) : null;

    const body = {
      status,
      // Overwrite desc with live PM2 stats so the dashboard shows something useful.
      desc: uptime
        ? `restarts: ${restarts} · up ${uptime}`
        : `restarts: ${restarts} · ${env.status}`,
    };

    try {
      const code = await put(serviceId, body);
      console.log(`[${ts()}] ${proc.name} → ${status} (HTTP ${code})`);
    } catch (err) {
      console.error(`[${ts()}] Failed to update ${proc.name}: ${err.message}`);
    }
  }
}

function ts() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

// ─── Start ────────────────────────────────────────────────────────────────────

console.log(`[${ts()}] pm2-agent starting — polling every ${POLL_MS / 1000}s → ${DASHBOARD_URL}`);
poll();
setInterval(poll, POLL_MS);
