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
Click **+ Add Service**. Fill in:

| Field | Notes |
|---|---|
| Name | Display name |
| Abbreviation | 2–4 chars shown in the icon badge |
| Description | Shown below the name on the card |
| Category | Groups services in sidebar + filter tabs |
| Port | Display only — doesn't affect health checks |
| Check URL | Full URL to ping; leave blank to skip auto-check |
| Has Web UI | Shows "Open ↗" link on the card |
| Enable Auto-Check | Toggles HTTP health checking |

### Card Actions
Hover a card to reveal action buttons:
- **✎** — edit
- **×** — delete (confirmation required)
- **✓ Resolve** — clears degraded/offline → online
- **Pin** — pins the service to the top of the grid
- **Maintenance** — toggles maintenance mode

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
| Setting | Notes |
|---|---|
| Enable Notifications | Toggle browser push notifications on/off (requires browser permission grant) |
| Test Notification | Sends a test push to all registered subscribers |

Push notifications fire on `offline`, `degraded`, and `recovery` transitions. Subscriptions are managed per-browser and stored server-side. Requires HTTPS (or localhost) for the browser permission prompt to work.

### Report API Key
Used by external agents (PM2 agent, scripts) to push status updates without a session. Pass as the `X-Api-Key` header to `POST /api/services/:id/report`.

### Categories
- Reorder with **↑ / ↓**
- Delete with **×** (services are not deleted, just uncategorized)
- Choose preset color swatches or type any `#rrggbb` hex

### Updates
Click **Check for Updates** to compare the running build against the latest commit on `main`. If an update is available it applies automatically — no confirmation step. The page reloads once the new container is live.

---

## PM2 Agent

The PM2 agent runs on any host where PM2 manages processes and pushes process status to the dashboard for services that don't have a check URL.

### Setup
```bash
git clone https://github.com/loswastaken/homelab-dashboard.git
cd ~/homelab-dashboard/pm2-agent
nano ecosystem.config.js   # set REPORT_API_KEY from Dashboard → Settings → Report API Key
pm2 start ecosystem.config.js
pm2 save
```

### Process Map
Edit `pm2-agent/index.js` to map your PM2 process names to dashboard service IDs:
```js
const PM2_MAP = {
  'my-app':     'service-id-from-dashboard',   // PM2 process name → dashboard service ID
  'another-app': 'another-service-id',
};
```

Service IDs are visible in the dashboard URL when editing a service, or in `data/services.json`.

### Auto-Update (Cron)
```bash
crontab -e
# Add:
*/15 * * * * bash ~/homelab-dashboard/pm2-agent/update-agent.sh >> ~/pm2-agent-update.log 2>&1
```

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
| GET | `/api/config` | Settings + categories + API key |
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
