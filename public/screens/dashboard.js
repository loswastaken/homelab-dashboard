/* Dashboard — folder-scoped bubble hive + detail rail + fleet ribbon. */
(function () {
  'use strict';
  const S = App.state;
  let root = null;
  const prevSnap = new Map();   // id → "status|pinned|name|abbr|cat" for smart patching
  let lastSub = '';
  let lastMeta = '';

  function snap(s) { return `${App.statusOf(s)}|${s.pinnedAt ? 1 : 0}|${s.name}|${s.abbr}|${s.cat}`; }
  const isPinned = s => !!s.pinnedAt && !s.disabled;

  /* Header is two tiers: the human line (greeting, date, weather, actions)
     and the fleet strip (health ribbon + counts + check timing). */
  function layout() {
    return `
      <div class="hdr hdr-dash" id="dash-hdr">
        <div class="hdr-top">
          <div class="hdr-title-wrap">
            <h1 id="greeting">${App.greetingHtml()}</h1>
            <div class="hdr-sub" id="dash-sub"></div>
          </div>
          <span class="hdr-spacer"></span>
          <div class="hdr-actions">
            <button class="btn btn-secondary" id="recheck"><span id="recheck-icon">↻</span> Recheck</button>
            <button class="btn btn-primary" id="add-svc">+ Add service</button>
          </div>
        </div>
        <div class="fleet">
          <div class="ribbon" id="ribbon">
            <span class="ribbon-seg ok"></span><span class="ribbon-seg warn"></span>
            <span class="ribbon-seg down"></span><span class="ribbon-seg pending"></span>
            <span class="ribbon-seg paused"></span>
          </div>
          <div class="fleet-foot">
            <div class="legend" id="legend"></div>
            <span class="fleet-meta" id="fleet-meta">loading…</span>
          </div>
        </div>
      </div>
      <div class="hive-wrap">
        <div class="panel hive-panel">
          <div class="panel-hdr">
            <span class="panel-title" id="hive-title">${App.esc(App.folderLabel(S.folder))}</span>
            <span class="chip-count" id="hive-count">—</span>
            <span class="rule"></span>
            <span class="hint" id="hive-hint">click a bubble</span>
          </div>
          <div class="pinned" id="pinned" hidden>
            <div class="pinned-hdr"><span class="caption">Pinned</span><span class="rule"></span></div>
            <div class="hive hive-pinned${S.data.settings?.compactHive ? ' compact' : ''}" id="hive-pinned"></div>
          </div>
          <div class="hive${S.data.settings?.compactHive ? ' compact' : ''}" id="hive"></div>
        </div>
        <div class="rail" id="rail"></div>
      </div>`;
  }

  function render(rootEl, fresh) {
    root = rootEl;
    root.innerHTML = layout();
    root.querySelector('#add-svc').onclick = () => App.openServiceModal(null);
    root.querySelector('#recheck').onclick = recheck;
    prevSnap.clear();
    lastSub = ''; lastMeta = '';
    patchAll(true);
  }

  async function recheck() {
    const btn = root.querySelector('#recheck'), icon = root.querySelector('#recheck-icon');
    if (!btn) return;
    btn.disabled = true; icon.classList.add('spin');
    try { await App.doRefreshAll(); }
    finally { if (root.contains(btn)) { btn.disabled = false; icon.classList.remove('spin'); } }
  }

  /* ─── Header ─────────────────────────────────────────────────────────── */
  function patchHeader() {
    const g = root.querySelector('#greeting');
    if (g) { const html = App.greetingHtml(); if (g.innerHTML !== html) g.innerHTML = html; }
    patchSub();
    patchMeta();
    const list = S.data.services;
    const c = App.fleetCounts(list);
    const segs = root.querySelectorAll('#ribbon .ribbon-seg');
    const vals = [c.online, c.degraded, c.offline, c.pending, c.paused];
    segs.forEach((el, i) => { el.style.flex = String(vals[i]); el.style.display = vals[i] ? '' : 'none'; });
    if (!list.length) { segs[4].style.display = ''; segs[4].style.flex = '1'; }
    // Only states that are actually present get a legend entry; a row of
    // zeros was the main source of header noise.
    const legend = root.querySelector('#legend');
    const item = (cls, n, label) => `<span class="legend-item"><span class="legend-dot ${cls}"></span>${n} ${label}</span>`;
    let html = '';
    if (!S.loaded) html = '';
    else if (!list.length) html = `<span class="legend-note">no services yet</span>`;
    else {
      if (c.online)   html += item('ok', c.online, 'online');
      if (c.degraded) html += item('warn', c.degraded, 'degraded');
      if (c.offline)  html += item('down', c.offline, 'offline');
      if (c.pending)  html += item('pending', c.pending, 'pending');
      if (c.paused)   html += item('paused', c.paused, 'paused');
      if (!c.degraded && !c.offline) html += `<span class="legend-note ok">all healthy</span>`;
    }
    if (legend.innerHTML !== html) legend.innerHTML = html;
  }
  // Under the greeting: human context only (date + weather).
  function patchSub() {
    const el = root?.querySelector('#dash-sub');
    if (!el) return;
    const parts = [new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })];
    const w = App.weatherText();
    if (w) parts.push(w);
    const txt = parts.join(' · ');
    if (txt !== lastSub) { el.textContent = txt; lastSub = txt; }
  }
  // Under the ribbon: machine context (last check, countdown, connectivity).
  function patchMeta() {
    const el = root?.querySelector('#fleet-meta');
    if (!el) return;
    let txt;
    if (!S.loaded) txt = S.online ? 'loading…' : 'connection error — retrying';
    else {
      const parts = ['checked ' + App.fmtTime(S.lastChecked || Date.now())];
      const next = App.secondsToNextPoll();
      if (next > 0) parts.push('next in ' + next + 's');
      if (!S.online) parts.push('connection error');
      txt = parts.join(' · ');
    }
    if (txt !== lastMeta) { el.textContent = txt; lastMeta = txt; }
  }

  /* ─── Hive ───────────────────────────────────────────────────────────── */
  function uptimeLabel(svc, st) {
    if (st === 'disabled') return 'paused';
    if (st === 'maintenance') return 'maintenance';
    if (st === 'pending') return 'pending';
    const u = App.uptimeFor(svc.id, '30d');
    if (u != null) return App.fmtPct(u, 1);
    const live = parseFloat(svc.uptime);
    return isNaN(live) ? '—' : live.toFixed(1) + '%';
  }
  // wide = pinned-row variant (avatar left, text right) that stretches to fill the row.
  function bubbleHtml(svc, wide) {
    const st = App.statusOf(svc);
    const hue = App.folderHue(svc);
    const dim = st === 'disabled' || st === 'maintenance';
    return `<button class="bubble${wide ? ' wide' : ''}${S.sel === svc.id ? ' selected' : ''}${dim ? ' dim' : ''}" data-id="${App.esc(svc.id)}" title="${App.esc(svc.name)}">
      <span class="bubble-avatar" style="background:${App.tint(hue)};color:${App.acc(hue)}">${App.esc(svc.abbr || '?')}
        <span class="bubble-dot" style="background:${App.statusColor(st)}"></span></span>
      <span class="bubble-text">
        <span class="bubble-name">${App.esc(svc.name)}</span>
        <span class="bubble-uptime" data-field="uptime" style="color:${App.statusColor(st)}">${App.esc(uptimeLabel(svc, st))}</span>
      </span>
    </button>`;
  }
  function skeletonHtml() {
    return Array.from({ length: 8 }, (_, i) => `<div class="bubble bubble-skel" style="animation-delay:${i * 90}ms">
      <span class="bubble-avatar skel"></span>
      <span class="skel" style="width:70%;height:12px"></span>
      <span class="skel" style="width:40%;height:10px"></span></div>`).join('');
  }
  function emptyHtml() {
    if (!S.data.categories.length) return `<div class="empty" style="grid-column:1/-1"><span class="glyph">◫</span>
      <span>No folders yet. Create one under <b>Settings → Folders</b>, then add your first service.</span></div>`;
    if (!S.data.services.length) return `<div class="empty" style="grid-column:1/-1"><span class="glyph">◫</span>
      <span>No services yet. Click <b>+ Add service</b> to start monitoring.</span></div>`;
    return `<div class="empty" style="grid-column:1/-1"><span class="glyph">◫</span><span>Nothing in this folder yet.</span></div>`;
  }
  function stagger(container, offset) {
    container.querySelectorAll('.bubble').forEach((el, i) => {
      el.style.animation = 'hl-in .3s ease both';
      el.style.animationDelay = `${Math.min(i + offset, 24) * 30}ms`;
    });
  }
  function patchHive(fresh) {
    const hive = root.querySelector('#hive');
    const pinnedWrap = root.querySelector('#pinned');
    const pinnedGrid = root.querySelector('#hive-pinned');
    const compact = !!S.data.settings?.compactHive;
    hive.classList.toggle('compact', compact);
    pinnedGrid.classList.toggle('compact', compact);
    root.querySelector('#hive-title').textContent = App.folderLabel(S.folder);
    const list = App.sortServices(App.servicesInFolder(S.folder));
    root.querySelector('#hive-count').textContent = `${list.length} of ${S.data.services.length}`;
    root.querySelector('#hive-hint').textContent = list.length ? 'click a bubble' : '';
    if (!S.loaded) { pinnedWrap.hidden = true; hive.innerHTML = skeletonHtml(); return; }
    if (!list.length) { pinnedWrap.hidden = true; pinnedGrid.innerHTML = ''; hive.innerHTML = emptyHtml(); prevSnap.clear(); return; }

    // Pinned services get their own full-width row above everything else so
    // pinned and unpinned bubbles never share a line.
    const pinned = list.filter(isPinned);
    const rest   = list.filter(s => !isPinned(s));
    pinnedWrap.hidden = !pinned.length;

    const ids = (grid, tag) => [...grid.querySelectorAll('.bubble[data-id]')].map(b => tag + b.dataset.id);
    const expected = [...pinned.map(s => 'p' + s.id), ...rest.map(s => 'r' + s.id)].join(',');
    const rendered = [...ids(pinnedGrid, 'p'), ...ids(hive, 'r')].join(',');
    if (fresh || expected !== rendered) {
      pinnedGrid.innerHTML = pinned.map(s => bubbleHtml(s, true)).join('');
      hive.innerHTML = rest.length ? rest.map(s => bubbleHtml(s, false)).join('') : '';
      stagger(pinnedGrid, 0);
      stagger(hive, pinned.length);
      list.forEach(s => prevSnap.set(s.id, snap(s)));
    } else {
      for (const s of list) {
        const wide = isPinned(s);
        const el = (wide ? pinnedGrid : hive).querySelector(`.bubble[data-id="${CSS.escape(s.id)}"]`);
        if (!el) continue;
        const sn = snap(s);
        if (prevSnap.get(s.id) !== sn) {
          const tmp = document.createElement('div'); tmp.innerHTML = bubbleHtml(s, wide);
          const n = tmp.firstElementChild; n.classList.add('flash'); el.replaceWith(n);
        } else {
          el.classList.toggle('selected', S.sel === s.id);
          const u = el.querySelector('[data-field="uptime"]');
          const txt = uptimeLabel(s, App.statusOf(s));
          if (u && u.textContent !== txt) u.textContent = txt;
        }
        prevSnap.set(s.id, sn);
      }
    }
    root.querySelectorAll('.hive .bubble[data-id]').forEach(b => b.onclick = () => App.selectService(b.dataset.id));
  }

  /* ─── Detail rail ────────────────────────────────────────────────────── */
  function agentName(svc) {
    if (svc.checkType === 'pm2') { const a = (S.data.pm2Agents || []).find(a => a.id === svc.pm2AgentId); return a ? `${a.name} (PM2)` : 'PM2 agent'; }
    if (svc.checkType === 'docker') { const a = (S.data.dockerAgents || []).find(a => a.id === svc.dockerAgentId); return a ? `${a.name} (Docker)` : 'Docker agent'; }
    return 'dashboard · HTTP check';
  }
  function railHtml(svc) {
    if (!svc) {
      const hasAny = S.data.services.length > 0;
      return `<div class="rail-empty"><span class="glyph">◎</span>
        <span>${hasAny ? 'Pick a bubble to see its sparkline, metrics and actions.' : 'Add a service to see its details here.'}</span></div>`;
    }
    const st = App.statusOf(svc);
    const hue = App.folderHue(svc);
    const folder = App.folderOf(svc);
    const up30 = App.uptimeFor(svc.id, '30d');
    const live = parseFloat(svc.uptime);
    const upText = up30 != null ? App.fmtPct(up30, 2) : (isNaN(live) ? '—' : live.toFixed(1) + '%');
    const buckets = App.tickBuckets(svc);
    const inc = App.incidentsFor(svc.id, '30d');
    const canOpen = !!(svc.hasUI && svc.url);
    const canCheck = svc.checkType === 'url' && !!svc.url && svc.checkEnabled !== false && !svc.maintenance && !svc.disabled;
    const bad = App.isBad(st);
    const pausedLabel = svc.maintenance ? 'Resume' : 'Pause';
    const long = st === 'pending' && svc.checkType !== 'url' ? 'Pending · waiting for the agent' : App.STATUS[st].long;
    return `
      <div class="rail-head">
        <div class="rail-avatar" style="background:${App.tint(hue)};color:${App.acc(hue)}">${App.esc(svc.abbr || '?')}</div>
        <div class="rail-title"><span class="rail-name">${App.esc(svc.name)}</span><span class="rail-desc">${App.esc(svc.desc || (folder ? folder.name : ''))}</span></div>
      </div>
      <span class="status-pill" style="background:${App.statusTint(st)};color:${App.statusText(st)}"><span class="dot"></span>${App.esc(long)}</span>
      <div class="well" title="Last 30 checks">${App.barsHtml(buckets, { minH: 34, maxH: 60, lowH: 22 })}</div>
      <div class="metrics">
        <div class="metric"><span class="metric-k">Uptime 30d</span><span class="metric-v">${App.esc(upText)}</span></div>
        <div class="metric"><span class="metric-k">Response</span><span class="metric-v">${App.esc(svc.response || '—')}</span></div>
        <div class="metric"><span class="metric-k">Port</span><span class="metric-v">${App.esc(svc.port || '—')}</span></div>
        <div class="metric"><span class="metric-k">Incidents 30d</span><span class="metric-v">${st === 'disabled' ? '—' : inc}</span></div>
      </div>
      <div class="rail-actions">
        ${canOpen ? `<a class="btn btn-primary btn-block" href="${App.esc(svc.url)}" target="_blank" rel="noopener">Open ${App.esc(svc.name)} ↗</a>`
                  : `<button class="btn btn-secondary btn-block" disabled title="No web UI configured">No web UI</button>`}
        <div class="row2">
          <button class="btn btn-secondary btn-square" data-act="edit">Edit</button>
          ${canCheck ? '<button class="btn btn-secondary btn-square" data-act="check">Recheck</button>'
                     : `<button class="btn btn-secondary btn-square" data-act="pin">${svc.pinnedAt ? 'Unpin' : 'Pin'}</button>`}
        </div>
        <div class="row2">
          ${svc.disabled ? '<button class="btn btn-secondary btn-square" data-act="enable">Enable</button>'
                         : `<button class="btn btn-secondary btn-square" data-act="maint">${pausedLabel}</button>`}
          ${bad ? '<button class="btn btn-tint btn-square" data-act="resolve">Resolve</button>'
                : (canCheck ? `<button class="btn btn-secondary btn-square" data-act="pin">${svc.pinnedAt ? 'Unpin' : 'Pin'}</button>`
                            : '<button class="btn btn-danger btn-square" data-act="delete">Delete</button>')}
        </div>
      </div>
      <div class="rail-foot">agent ${App.esc(agentName(svc))}<br>${App.esc(folder ? folder.name.toLowerCase() : 'no folder')} · port ${App.esc(svc.port || '—')}<br>${svc.lastChecked ? 'last contact ' + App.esc(App.relTime(svc.lastChecked)) : 'no checks yet'}</div>`;
  }
  function patchRail() {
    const rail = root.querySelector('#rail');
    const svc = App.selectedService();
    rail.innerHTML = railHtml(svc);
    if (!svc) return;
    const on = (act, fn) => { const b = rail.querySelector(`[data-act="${act}"]`); if (b) b.onclick = fn; };
    on('edit',    () => App.openServiceModal(svc.id));
    on('check',   async e => { e.currentTarget.disabled = true; await App.checkService(svc.id); });
    on('pin',     () => App.togglePin(svc.id));
    on('maint',   () => App.toggleMaintenance(svc.id));
    on('resolve', () => App.resolveService(svc.id));
    on('delete',  () => App.deleteService(svc.id));
    on('enable',  async () => { const r = await App.api('PUT', `/api/services/${encodeURIComponent(svc.id)}`, { disabled: false }); if (r.ok) { App.toast('Service enabled'); App.doRefreshAll(); } else App.toast(r.json.error || 'Failed', 'err'); });
  }

  function patchAll(fresh) {
    if (!root || !root.isConnected) return;
    patchHeader();
    patchHive(fresh);
    patchRail();
  }

  App.registerScreen('dashboard', {
    title: 'Dashboard',
    render,
    onData: fresh => patchAll(fresh),
    onFolder: () => { patchHive(true); },
    onSelect: () => { patchHive(false); patchRail(); },
    onTick: () => { patchSub(); patchMeta(); },
    onWeather: () => { patchSub(); },
  });
})();
