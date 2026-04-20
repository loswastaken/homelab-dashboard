# los.dev · Homelab Dashboard

Self-hosted service monitoring dashboard running in Docker on a Synology DS423+. Dark-themed, single-page, no framework dependencies.

---

## Stack

| Layer | Tech |
|---|---|
| Backend | Node.js + Express |
| Frontend | Vanilla JS, single HTML file |
| Persistence | `data/services.json` — mounted Docker volume |
| Auth | Session-based (bcrypt + express-session) |
| Images | Built by GitHub Actions, pushed to `ghcr.io` |
| Auto-update | Watchtower (dashboard) + cron script (PM2 agent) |

---

## Initial Deployment (NAS)

### Prerequisites
- Docker + Docker Compose on the NAS
- SSH access to the NAS
- GitHub repo forked/cloned with Actions enabled

### 1. Create the data directory
```bash
mkdir -p /volume2/docker/homelab-dashboard/data
```

### 2. Drop the compose file on the NAS
```bash
cat > /volume2/docker/homelab-dashboard/docker-compose.yml << 'EOF'
version: "3.8"

services:
  watchtower:
    image: containrrr/watchtower
    container_name: watchtower
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      - WATCHTOWER_POLL_INTERVAL=300
      - WATCHTOWER_CLEANUP=true
      - WATCHTOWER_SCOPE=homelab

  homelab-dashboard:
    image: ghcr.io/loswastaken/homelab-dashboard:latest
    container_name: homelab-dashboard
    network_mode: host
    environment:
      - PORT=55964
      - TZ=America/New_York
    volumes:
      - /volume2/docker/homelab-dashboard/data:/app/data
    restart: unless-stopped
    labels:
      - "com.centurylinklabs.watchtower.scope=homelab"
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:55964/api/services"]
      interval: 30s
      timeout: 5s
      retries: 3
EOF
```

### 3. Pull and start
```bash
sudo docker pull ghcr.io/loswastaken/homelab-dashboard:latest
cd /volume2/docker/homelab-dashboard
sudo docker compose up -d
```

### 4. First-time setup
Open `http://NAS_IP:55964` in a browser. You'll be redirected to `/setup` to create your admin account (username + password, min 8 characters). This page only appears once — after account creation it's gone permanently.

---

## Deploying Updates

Updates are fully automatic once Watchtower is running:

```
Push to main
  → GitHub Actions builds image (~1-2 min)
  → Watchtower detects new digest within 5 min
  → Container restarts with new image
  → data/services.json volume untouched
```

To force an immediate update on the NAS:
```bash
sudo docker pull ghcr.io/loswastaken/homelab-dashboard:latest
cd /volume2/docker/homelab-dashboard && sudo docker compose up -d
```

---

## Dashboard Usage

### Adding a Service
Click **+ Add Service** (top right). Fill in:

| Field | Notes |
|---|---|
| Name | Display name |
| Abbreviation | 2–4 chars shown in the icon |
| Description | Shown below the name |
| Category | Groups services in sidebar + tabs |
| Port | Display only — doesn't affect health checks |
| Check URL | Full URL to ping (leave blank to skip auto-check) |
| Has Web UI | Shows "Open ↗" link on the card |
| Enable Auto-Check | Toggles HTTP health checking |

### Editing / Deleting a Service
Hover any card to reveal the action buttons (top right of card):
- **✎** — open edit modal
- **×** — delete (confirmation required)
- **✓ Resolve** — appears when status is degraded or offline; clears it to online
- **🔧** — toggle maintenance mode

### Maintenance Mode
Click the **🔧** button on hover to put a service into maintenance:
- Auto-check is suspended
- History bars fill with a gray maintenance tick instead of up/down
- Status badge shows "maintenance"
- Service is excluded from the alert bar and live status dot
- Uptime % excludes maintenance ticks (doesn't drag the number down)

Click **End Maint** to bring it back — status resets to `unknown` and the next health check picks it up.

### Filtering
Use the **tabs** above the grid or the **sidebar categories** to filter by category.

### Manual Refresh
Click **↺ Refresh** to force an immediate health check cycle.

---

## Settings

Open **Settings** from the sidebar.

### General
| Setting | Default | Notes |
|---|---|---|
| Site Title | `los.dev · Homelab` | Shown in browser tab |
| NAS IP | `10.24.4.26` | Shown in sidebar footer |
| Health Check Interval | `60` | Seconds between auto-check cycles (min 10) |

### Report API Key
A static key used by external agents (PM2 agent, etc.) to push status updates without a session. Click **Copy** to copy it to clipboard. Pass it as the `X-Api-Key` header.

### Categories
- **↑ / ↓** — reorder categories (order is reflected in sidebar and filter tabs)
- **×** — delete a category (services in it are not deleted, just uncategorized)
- **Add** — create a new category with a name and color

**Colors:** Click a preset swatch or type any `#rrggbb` hex code directly in the input field.

---

## PM2 Agent (Bass VM)

The PM2 agent runs on Bass VM and polls `pm2 jlist` every 30 seconds, pushing status updates to the dashboard for processes that don't have a check URL.

### Initial Setup
```bash
# On Bass VM
git clone https://github.com/loswastaken/homelab-dashboard.git
cd ~/homelab-dashboard/pm2-agent

# Edit the ecosystem config — set REPORT_API_KEY to the value from Dashboard Settings
nano ecosystem.config.js

# Start the agent
pm2 start ecosystem.config.js
pm2 save
```

### Mapping PM2 Processes to Dashboard Services
Edit `pm2-agent/index.js` and update `PM2_MAP`:

```js
const PM2_MAP = {
  'Bass':     'redbot',    // PM2 process name → dashboard service ID
  'MyBot':    'mybot-id',
};
```

The left side must match the **Name** column in `pm2 list` exactly. The right side is the service's `id` field in `services.json`.

### Updating the API Key
```bash
nano ~/homelab-dashboard/pm2-agent/ecosystem.config.js
# Update REPORT_API_KEY

pm2 restart pm2-agent --update-env
```

### Auto-Update (Cron)
The agent checks GitHub for new commits every 15 minutes and restarts only if something changed:

```bash
crontab -e
# Add:
*/15 * * * * bash ~/homelab-dashboard/pm2-agent/update-agent.sh >> ~/pm2-agent-update.log 2>&1
```

Check update history:
```bash
tail -f ~/pm2-agent-update.log
```

---

## Cloudflare Tunnel

The dashboard is designed to be safely exposed via a Cloudflare tunnel with the built-in login page handling auth. No additional Cloudflare Access policy is strictly required (the app handles it), but adding one as a second layer is recommended.

Point the tunnel at `localhost:55964`.

---

## Data & Persistence

All persistent data lives in `/volume2/docker/homelab-dashboard/data/` on the NAS:

| File | Contents |
|---|---|
| `services.json` | All services, categories, settings, history |
| `auth.json` | Hashed password, session secret, report API key |
| `sessions/` | Active session files (7-day TTL) |

These are never included in the Docker image — they live only in the volume.

**Backup:** Just copy the `data/` directory. Restore by dropping it back in place and restarting the container.

---

## API Reference

All endpoints require an authenticated session except `/api/services/:id/report` (accepts `X-Api-Key` header instead).

| Method | Path | Description |
|---|---|---|
| GET | `/api/services` | Full data object |
| POST | `/api/services` | Add service |
| PUT | `/api/services/:id` | Edit service |
| DELETE | `/api/services/:id` | Remove service |
| POST | `/api/services/:id/resolve` | Clear degraded/offline → online |
| POST | `/api/services/:id/check` | Force health check now |
| POST | `/api/services/:id/maintenance` | Toggle maintenance mode |
| POST | `/api/services/:id/report` | External status push (API key auth) |
| GET | `/api/config` | Get settings + categories + API key |
| PUT | `/api/config` | Update settings + categories |
| POST | `/api/login` | Authenticate |
| POST | `/api/logout` | End session |
