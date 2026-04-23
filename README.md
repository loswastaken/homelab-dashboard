# Homelab Dashboard

Self-hosted service monitoring dashboard. Runs in Docker, dark-themed, no framework dependencies.

---

## Stack

| Layer | Tech |
|---|---|
| Backend | Node.js + Express |
| Frontend | Vanilla JS — `index.html` (dashboard) + `history.html` (uptime history) + `status-pages.html` / `status-page.html` (public status pages) |
| Persistence | `data/services.json` — mounted Docker volume |
| Auth | Session-based (bcrypt + express-session) |
| Images | Built by GitHub Actions, pushed to `ghcr.io` |
| Auto-update | Watchtower HTTP API (one-click from dashboard) |

---

## Initial Deployment (NAS)

### Prerequisites
- Docker + Docker Compose on the NAS
- SSH access to the NAS
- GitHub repo forked/cloned with Actions enabled

### 1. Create the data directory
```bash
mkdir -p /your/data/path
```

### 2. Pull the compose file
```bash
cd /your/data/path
curl -O https://raw.githubusercontent.com/loswastaken/homelab-dashboard/main/docker-compose.yml
```

### 3. Pull and start
```bash
sudo docker compose pull
sudo docker compose up -d
```

### 4. First-time setup
Open `http://NAS_IP:55964`. You'll be redirected to `/setup` to create your admin account (username + password, min 8 characters). This page is locked permanently after first use.

---

## Deploying Updates

### Automatic (Watchtower)
Watchtower polls GHCR every 5 minutes and redeploys automatically when a new image is available:

```
Push to main
  → GitHub Actions builds image (~1-2 min)
  → Watchtower detects new digest within 5 min
  → Container restarts with new image
  → data/ volume untouched
```

### One-click (from the dashboard)
Open **Settings → Updates** and click **Check for Updates**. If an update is available it applies immediately and the page reloads once the new version is live.

### Manual (SSH)
```bash
cd /your/data/path
sudo docker compose pull && sudo docker compose up -d
```

> **Note:** Watchtower only updates the Docker image — it does not pull `docker-compose.yml` changes. When the compose file itself changes, re-run the `curl` command above to fetch the latest version before `docker compose up -d`.

---

## Dashboard (`/`)

### Adding a Service
Click **+ Add Service**. Pick a **Check Type** at the top of the modal — the rest of the form adapts to what you choose.

| Check Type | Required fields | Notes |
|---|---|---|
| **URL** | Check URL | Standard HTTP(S) health check. The dashboard pings the URL on every cycle. |
| **PM2** | PM2 Host + Process | Status is pushed by the [PM2 agent](#pm2-agent) running on the host. Dropdowns populate from registered agents. |
| **Docker** | Docker Host + Container | Status is pushed by the [Docker agent](#docker-agent) running on the host. Dropdowns populate from registered agents. |

Other fields apply to all check types:

| Field | Notes |
|---|---|
| Name | Display name |
| Abbreviation | 2–4 chars shown in the icon badge |
| Description | Shown below the name on the card |
| Category | Groups services in sidebar + filter tabs |
| Port | Display only — doesn't affect health checks |
| Has Web UI | Shows "Open ↗" link on the card |
| Enable Auto-Check | Toggles HTTP health checking (URL type only) |

### Card Actions
Hover a card to reveal action buttons:
- **✎** — edit
- **×** — delete (confirmation required)
- **✓ Resolve** — clears degraded/offline → online
- **Pin** — pins the service to the top of the grid
- **Maintenance** — toggles maintenance mode

### Pending State
Newly added services start in a **pending** state (blue pill) until the first health check runs or the first `/report` arrives from the agent. No history ticks or notifications are generated during pending — it's just a "we haven't checked yet" placeholder. Pending services are also excluded from public status pages until they have real data.

### Maintenance Mode
- Auto-check suspended; history fills with grey maintenance ticks
- Excluded from the alert bar, live status dot, and favicon state
- Uptime % excludes maintenance ticks

### Filtering
Use the **tabs** above the grid or **sidebar categories** to filter by category.

---

## Uptime History (`/history.html`)

Accessible via **Uptime History** in the sidebar.

### List View
All services shown as rows with:
- Day-by-day bar strip (bar height = daily uptime %, colour = green/amber/red/grey)
- Current status pip and avg uptime label
- Hover any bar for date + exact uptime %

Click a row to expand the **detail panel**.

### Detail Panel
- Metric cards: avg uptime, incident count, best consecutive uptime streak
- Area/line chart of daily uptime % over the selected range
- Per-service event log

### Filters
- **Time range:** 30 days / 7 days / 24 hours
- **Service:** dropdown to narrow to a single service

### Event Log
Tracks status transitions with timestamps: offline, degraded, recovery, maintenance on/off. Shown globally at the bottom of the page and per-service in the detail panel.

> History data accumulates from the first time the container runs this version. There is no retroactive data from before deployment.

---

## Public Status Pages

Uptime Kuma-style public pages for sharing service health without exposing the dashboard.

### Managing Pages
Open **Status Pages** from the sidebar. Each page has:
- **Name, slug, description** — slug must be `a-z0-9` with dashes, 2–40 chars, and not a reserved word (`api`, `login`, `status`, etc.)
- **Service picker** — grouped by category; toggle per-category "reveal name" to show or hide category labels publicly
- **Banner** — optional overall status banner at the top
- **Event log** — optional global incident log at the bottom

### Public View
Served at `/status/<slug>` (no auth). Auto-refreshes every 60s; also has a manual ↺ button and an "Updated Xs ago" label. Range toggle: **24h / 7d / 30d** (default 30d; 24h uses hourly resolution).

### Privacy
The public API strips service URLs, ports, response times, last-checked timestamps, raw tick history, and event notes. Only `{ ts, type }` is exposed for events. Category names appear only if the page explicitly opts in per category.

---

## Settings

Open **Settings** from the sidebar.

### General
| Setting | Notes |
|---|---|
| Display Name | Your name shown in the greeting |
| Site Title | Browser tab title |
| Server Label | Shown in the sidebar footer |
| NAS IP | Shown in the sidebar footer |
| Health Check Interval | Seconds between auto-check cycles (min 10, default 60) |
| Report Stale After | Seconds before a push-reported service (no check URL) is flipped to offline if no `/report` arrives. Default 120. Per-service override: set `reportInterval` on the service and the threshold becomes `reportInterval × 4`. |

### Weather
Shows a live weather pill in the dashboard header (hidden on mobile). Uses the Open-Meteo free API — no API key required.

| Setting | Notes |
|---|---|
| Enable Weather | Toggle the pill on/off |
| Location | ZIP code or city name |
| Country Code | Optional 2-letter code (e.g. `US`) to disambiguate |
| Units | Fahrenheit or Celsius |

### Notifications

The dashboard can fire alerts on `offline` / `degraded` / `recovery` transitions through three independent channels. Each has its own enable toggle and is silently skipped when disabled, even if its config is populated. Test buttons on each channel accept unsaved field values so you can verify config before saving.

| Channel | Config | Notes |
|---|---|---|
| **Web Push** | Enable Notifications toggle + Test button | Browser push. Stored per-browser. Requires HTTPS (or localhost) for the permission prompt. |
| **IFTTT Maker** | Event name + webhook key + Test button | POSTs `value1=service name`, `value2=event label`, `value3=note` to `https://maker.ifttt.com/trigger/<event>/with/key/<key>`. Pasted URLs are auto-normalized to just the key. |
| **ntfy** | Topic + Test button | POSTs plain text to `https://ntfy.sh/<topic>` with priority (4=offline, 3=degraded, 2=recovery) and emoji tags. Subscribe via the official ntfy iOS/Android app. |

### Alerts

Thresholds that control when a flaky service actually flips to degraded/offline.

| Setting | Notes |
|---|---|
| Degraded escalation count | Consecutive degraded checks (5xx, timeouts, slow responses, connection errors) before escalating to offline. Default 3. |
| Degraded escalation window (min) | The streak must fit inside this rolling window; otherwise it resets. Default 5 minutes. |
| Slow-response threshold (ms) | A 2xx response slower than this counts as degraded. Default 0 (disabled globally). Override or disable per-service from the service modal's "Disable slow-response monitoring" toggle. |
| Slow-response streak required | Consecutive slow checks before a slow response actually marks a service degraded. Default 1. |

### API Key
Used by external agents (PM2 agent, Docker agent, scripts) to push status updates and register themselves. Pass as the `X-Api-Key` header. The tab also embeds ready-to-run install snippets for both agents with your dashboard URL + key pre-filled.

### Connected Agents
Under the General tab, any registered PM2 or Docker agent appears here. Each row shows the agent type, hostname, item count, and last seen time. Use **Rename** to give an agent a friendly label (stable across re-registrations) or **Delete** to remove one. A `stale` marker appears next to any agent that hasn't checked in for 10+ minutes.

### Categories
- Reorder with **↑ / ↓**
- Delete with **×** (services are not deleted, just uncategorized)
- Choose preset color swatches or type any `#rrggbb` hex

### Updates
Click **Check for Updates** to compare the running build against the latest commit on `main`. If an update is available it applies automatically — no confirmation step. The page reloads once the new container is live.

---

## PM2 Agent

The PM2 agent runs on any host where PM2 manages processes. The dashboard is the source of truth — the agent registers itself, pushes its full process list, and pulls back which services to report on. No hardcoded mapping.

### Setup
```bash
git clone https://github.com/loswastaken/homelab-dashboard.git
cd ~/homelab-dashboard/pm2-agent
# Edit ecosystem.config.js: set DASHBOARD_URL and REPORT_API_KEY
# (REPORT_API_KEY is visible in Dashboard → Settings → API Key)
pm2 start ecosystem.config.js
pm2 save
```

### Mapping services
Once the agent is running it appears in **Dashboard → Settings → General → Connected Agents**. When adding or editing a service, pick **PM2** as the check type, then select the host + process from the dropdowns — the process list is populated from the agent's live discovery.

### Auto-Update (Cron)
```bash
(crontab -l 2>/dev/null; echo "*/15 * * * * bash ~/homelab-dashboard/pm2-agent/update-agent.sh >> ~/pm2-agent-update.log 2>&1") | crontab -
```

### Status mapping
- PM2 `online` → **online**
- `stopped` / `stopping` → **offline**
- Anything else (`errored`, `launching`, etc.) → **degraded**

---

## Docker Agent

Runs as its own Docker container on any host with Docker. Mounts `/var/run/docker.sock` read-only so it can enumerate containers via the Docker CLI. Like the PM2 agent, it registers with the dashboard, pushes a discovery list, and pulls back which containers to report on.

### Setup
Copy this into a new directory on the host (the **Dashboard → Settings → API Key** tab embeds a version with your URL + key pre-filled):

```bash
mkdir -p ~/homelab-docker-agent/data && cd ~/homelab-docker-agent

cat > docker-compose.yml <<YAML
services:
  docker-agent:
    image: ghcr.io/loswastaken/homelab-dashboard-docker-agent:latest
    container_name: homelab-docker-agent
    restart: unless-stopped
    network_mode: host
    environment:
      DASHBOARD_URL:  http://DASHBOARD_HOST:55964
      REPORT_API_KEY: PASTE_KEY_FROM_DASHBOARD_SETTINGS
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./data:/app/data
    labels:
      com.centurylinklabs.watchtower.scope: homelab
YAML

sudo docker compose up -d
```

Edit the `DASHBOARD_URL` and `REPORT_API_KEY` values before starting.

### Mapping containers
Once running it appears in **Connected Agents**. On a service's modal, pick **Docker** as the check type, then select the host + container from the dropdowns.

### Auto-update
The `com.centurylinklabs.watchtower.scope: homelab` label makes Watchtower pull agent updates on the same 5-minute cycle as the dashboard itself — nothing else to configure.

### Status mapping
- `running` + `healthy` (or no healthcheck) → **online**
- `running` + `starting` (normal) → **online**, `desc: 'starting · ...'`
- `running` + `starting` (≥3 rising-edge transitions in 10 min) → **degraded**, `desc: 'boot-loop: N restarts in 10m'`
- `running` + `unhealthy` → **degraded**
- `restarting` / `paused` → **degraded**
- `exited` / `dead` / `created` / `removing` → **offline**

### Synology compatibility notes
DSM ships an older Docker daemon with some quirks — all handled in the image, but worth knowing:

- The daemon maxes out at API version **1.43**. The image pins `DOCKER_API_VERSION=1.43` so the newer Alpine `docker-cli` doesn't fail with *"client version is too new"*.
- `docker ps --format '{{json .}}'` hangs against this older daemon. The agent uses a plain pipe-delimited template instead.

If you need to override the daemon API version on another host (e.g. bleeding-edge Docker), set `DOCKER_API_VERSION` in the container's `environment` block.

---

## Cloudflare Tunnel

Point the tunnel at `localhost:55964`. The built-in login page handles auth. Adding a Cloudflare Access policy as a second layer is recommended but not required.

---

## Data & Persistence

All persistent data lives in the `data/` directory mounted via the Docker volume:

| File | Contents |
|---|---|
| `services.json` | Services, categories, settings, history ticks, daily history, hourly history, events |
| `auth.json` | Hashed password, session secret, report API key |
| `vapid.json` | VAPID keys for browser push notifications (auto-generated) |
| `push-subscriptions.json` | Active push subscriber endpoints |
| `sessions/` | Active session files (7-day TTL) |

Never included in the Docker image — lives only in the mounted volume.

**Backup:** Copy the `data/` directory. Restore by dropping it back in place and restarting the container.

---

## API Reference

All endpoints require an authenticated session except `/api/services/:id/report` (accepts `X-Api-Key` header), `/status/:slug`, and `/api/public/status/:slug` (public status pages — no auth).

| Method | Path | Description |
|---|---|---|
| GET | `/api/services` | Full data object + `version` (7-char SHA) |
| GET | `/api/history` | Daily history + hourly history + events per service |
| GET | `/api/weather` | Current weather for configured location |
| POST | `/api/services` | Add service |
| PUT | `/api/services/:id` | Edit service |
| DELETE | `/api/services/:id` | Remove service |
| POST | `/api/services/:id/resolve` | Clear degraded/offline → online |
| POST | `/api/services/:id/check` | Force health check now |
| POST | `/api/services/:id/maintenance` | Toggle maintenance mode |
| POST | `/api/services/:id/pin` | Toggle pin to top of grid |
| POST | `/api/services/:id/report` | External status push (API key auth) |
| POST | `/api/check-all` | Run health checks on all services |
| GET | `/api/push/vapid-public-key` | VAPID public key for push subscription |
| POST | `/api/push/subscribe` | Register a push subscription |
| POST | `/api/push/unsubscribe` | Remove a push subscription |
| POST | `/api/push/test` | Send a test push notification |
| POST | `/api/ifttt/test` | Send a test event to the IFTTT Maker webhook (accepts unsaved key/event) |
| POST | `/api/ntfy/test` | Send a test notification to the ntfy topic (accepts unsaved topic) |
| GET | `/api/config` | Settings + categories + API key |
| GET | `/api/auth/api-key` | Report API key — fetched on demand by the API Key tab |
| PUT | `/api/config` | Update settings + categories |
| GET | `/api/update/check` | Compare running SHA vs GitHub main |
| POST | `/api/update/apply` | Trigger Watchtower to pull + redeploy |
| POST | `/api/login` | Authenticate |
| POST | `/api/logout` | End session |
| GET | `/api/status-pages` | List configured public status pages |
| POST | `/api/status-pages` | Create a status page |
| PUT | `/api/status-pages/:id` | Update a status page |
| DELETE | `/api/status-pages/:id` | Delete a status page |
| GET | `/status/:slug` | Public status page HTML (no auth) |
| GET | `/api/public/status/:slug` | Sanitized public status data (no auth) |
| POST | `/api/pm2/agents/register` | PM2 agent self-register (API key) |
| POST | `/api/pm2/agents/:id/discovery` | PM2 agent pushes process list (API key) |
| GET | `/api/pm2/agents/:id/monitored` | PM2 agent pulls `[{ serviceId, name }]` (API key) |
| GET / PUT / DELETE | `/api/pm2/agents` & `/:id` & `/:id/items` | UI list / rename / delete / item dropdown |
| POST / GET / PUT / DELETE | `/api/docker/agents/...` | Same shape as PM2 routes above, for Docker agents |
