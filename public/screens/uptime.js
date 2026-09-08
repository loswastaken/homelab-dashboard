/* Uptime history — range switcher, stat pods, per-service bar rows, incident log. */
(function () {
  'use strict';
  const S = App.state;
  const BAR_OPTS = { minH: 19, maxH: 30, lowH: 13 };
  let root = null;
  let histPending = false;
  let histFailed = false;
  let openChips = [];        // [{ el, since }] — open-incident duration chips, ticked once a second
  let downOffenders = [];    // [{ name, since|null }] — feeds the DOWN NOW pod note
  let downNoteEl = null;
  let lastSub = '';

  function visibleList() { return App.sortServices(App.servicesInFolder(S.folder)); }
  // Skeleton state: services not loaded yet, or history still on its way (and not known to have failed).
  function loadingHistory() { return !S.loaded || (S.histAt === 0 && !histFailed); }

  function layout() {
    const seg = Object.keys(App.RANGES).map(r =>
      `<button type="button" class="seg-opt${S.range === r ? ' active' : ''}" data-range="${App.esc(r)}" aria-pressed="${S.range === r ? 'true' : 'false'}">${App.esc(App.RANGES[r].label)}</button>`).join('');
    return `
      <div class="hdr">
        <div class="hdr-title-wrap">
          <h1>Uptime <b>history</b></h1>
          <div class="hdr-sub" id="up-sub">loading…</div>
        </div>
        <span class="hdr-spacer"></span>
        <div class="hdr-actions">
          <div class="seg-group up-range" id="up-range" role="group" aria-label="Time range">${seg}</div>
          <button class="btn btn-secondary" id="up-refresh"><span id="up-refresh-icon">↻</span> Refresh</button>
        </div>
      </div>
      <div class="pods" id="up-pods"></div>
      <div class="panel">
        <div class="panel-hdr">
          <span class="panel-title" id="up-folder">${App.esc(App.folderLabel(S.folder))}</span>
          <span class="chip-count" id="up-count">—</span>
          <span class="rule"></span>
          <span class="hint" id="up-bucket"></span>
        </div>
        <div class="rows" id="up-rows"></div>
      </div>
      <div class="panel up-log-panel">
        <div class="panel-hdr">
          <span class="caption">Incident log</span>
          <span class="rule"></span>
          <span class="hint" id="up-log-note"></span>
        </div>
        <div class="log" id="up-log"></div>
      </div>`;
  }

  function render(rootEl) {
    root = rootEl;
    root.innerHTML = layout();
    root.querySelectorAll('#up-range .seg-opt').forEach(b => b.onclick = () => App.setRange(b.dataset.range));
    root.querySelector('#up-refresh').onclick = refresh;
    lastSub = '';
    patchAll();
    if (S.loaded && S.histAt === 0) ensureHistory();
  }

  async function refresh() {
    const btn = root.querySelector('#up-refresh'), icon = root.querySelector('#up-refresh-icon');
    if (!btn || btn.disabled) return;
    btn.disabled = true; icon.classList.add('spin');
    try { await App.doRefreshAll(); }
    finally { if (root.contains(btn)) { btn.disabled = false; icon.classList.remove('spin'); } }
  }

  // Make sure /api/history has been fetched at least once before computing anything.
  async function ensureHistory() {
    if (S.histAt > 0 || histPending || !S.loaded) return;
    histPending = true;
    try { histFailed = !(await App.fetchHistory(true)); }
    finally { histPending = false; }
    patchAll();
  }

  /* ─── Patching ───────────────────────────────────────────────────────── */
  function patchAll() {
    if (!root || !root.isConnected) return;
    if (S.histAt > 0) histFailed = false;
    const range = S.range;
    const loading = loadingHistory();
    const list = S.loaded ? visibleList() : [];
    const rows = list.map(s => {
      const buckets = loading ? [] : App.bucketsFor(s.id, range);
      let weight = 0;
      for (const b of buckets) if (!b.empty && b.uptime != null) weight += (b.online || 0) + (b.degraded || 0) + (b.offline || 0);
      return { svc: s, buckets, uptime: loading ? null : App.uptimeFor(s.id, range), weight };
    });
    const incidents = loading ? [] : App.buildIncidents(list, range);
    patchHeader(list, range);
    patchPods(rows, range, incidents, loading);
    patchRows(rows, range, loading);
    patchLog(incidents, range, loading);
  }

  function patchHeader(list, range) {
    root.querySelectorAll('#up-range .seg-opt').forEach(b => {
      const on = b.dataset.range === range;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const sub = root.querySelector('#up-sub');
    let txt;
    if (!S.loaded) txt = S.online ? 'loading…' : 'connection error — retrying';
    else {
      txt = `showing ${list.length} ${App.plural(list.length, 'service')} · last ${range}`;
      if (!S.online) txt += ' · connection error';
    }
    if (txt !== lastSub) { sub.textContent = txt; lastSub = txt; }
  }

  /* ─── Stat pods ──────────────────────────────────────────────────────── */
  function podHtml(label, value, color, note, noteId) {
    return `<div class="pod">
      <span class="pod-lbl">${App.esc(label)}</span>
      <span class="pod-val" style="color:${color}">${App.esc(value)}</span>
      <span class="pod-note"${noteId ? ` id="${noteId}"` : ''} title="${App.esc(note)}">${App.esc(note)}</span>
    </div>`;
  }
  function downNoteText(now) {
    if (!downOffenders.length) return 'nothing is down';
    const parts = downOffenders.slice(0, 2).map(o => o.since != null ? `${o.name} · ${App.fmtDur(now - o.since)}` : o.name);
    return parts.join(', ') + (downOffenders.length > 2 ? ` +${downOffenders.length - 2} more` : '');
  }
  function patchPods(rows, range, incidents, loading) {
    const box = root.querySelector('#up-pods');
    const ok = App.statusColor('online'), warn = App.statusColor('degraded'), down = App.statusColor('offline');
    const noHist = S.histAt === 0;
    const noData = histFailed ? 'history unavailable — try Refresh' : loading ? 'loading history…' : 'data appears after the first check cycle';
    const withData = rows.filter(r => r.uptime != null);

    // AVG UPTIME — mean of per-service uptime weighted by each service's check count in range.
    let avg = null;
    if (withData.length) {
      let num = 0, den = 0;
      for (const r of withData) { num += r.uptime * r.weight; den += r.weight; }
      avg = den > 0 ? num / den : null;
    }
    const avgNote = avg == null ? noData
      : withData.length === rows.length ? `across ${withData.length} ${App.plural(withData.length, 'service')}`
      : `across ${withData.length} of ${rows.length} services`;

    // INCIDENTS — offline + degraded transitions in range, summed over the visible services.
    const incCount = noHist ? null : rows.reduce((n, r) => n + App.incidentsFor(r.svc.id, range), 0);

    // DOWN NOW — live status; the note names the offenders and how long their open incident has run.
    downOffenders = S.loaded ? rows.filter(r => App.isBad(App.statusOf(r.svc))).map(r => {
      const inc = incidents.find(i => i.svcId === r.svc.id && i.endedAt === null && i.severity !== 'maintenance');
      return { name: r.svc.name, since: inc ? new Date(inc.startedAt).getTime() : null };
    }) : [];

    // BEST UPTIME — highest figure; note lists up to three services tied at the top.
    let best = null;
    for (const r of withData) if (best == null || r.uptime > best) best = r.uptime;
    const top = best == null ? [] : withData.filter(r => Math.abs(r.uptime - best) < 0.005).map(r => r.svc.name);
    const bestNote = top.length ? top.slice(0, 3).join(', ') + (top.length > 3 ? ` +${top.length - 3} more` : '') : noData;

    box.innerHTML =
      podHtml('Avg uptime', App.fmtPct(avg, 2), ok, avgNote) +
      podHtml('Incidents', incCount == null ? '—' : String(incCount), warn, noHist ? noData : `in the last ${range}`) +
      podHtml('Down now', S.loaded ? String(downOffenders.length) : '—', downOffenders.length ? down : ok,
        S.loaded ? downNoteText(Date.now()) : 'loading…', 'up-down-note') +
      podHtml('Best uptime', App.fmtPct(best, 2), ok, bestNote);
    downNoteEl = box.querySelector('#up-down-note');
  }

  /* ─── Rows ───────────────────────────────────────────────────────────── */
  function rowHtml(r) {
    const svc = r.svc, st = App.statusOf(svc), hue = App.folderHue(svc), folder = App.folderOf(svc);
    const color = App.statusColor(st);   // 'var(--paused)' for disabled
    const note = (folder ? folder.name.toLowerCase() : 'no folder') + ' · ' + (svc.response || '—');
    return `<button type="button" class="row" data-id="${App.esc(svc.id)}" title="${App.esc(svc.name)}">
      <span class="row-avatar" style="background:${App.tint(hue)};color:${App.acc(hue)}">${App.esc(svc.abbr || '?')}</span>
      <span class="row-info">
        <span class="row-name">${App.esc(svc.name)}</span>
        <span class="row-note">${App.esc(note)}</span>
      </span>
      <span class="row-bars">${App.barsHtml(r.buckets, BAR_OPTS)}</span>
      <span class="row-dot" style="background:${color}"></span>
      <span class="row-uptime" style="color:${color}">${App.esc(App.fmtPct(r.uptime, 1))}</span>
    </button>`;
  }
  function skeletonHtml(range) {
    const bars = App.barsHtml(Array.from({ length: App.RANGES[range].slots }, () => ({ empty: true })), BAR_OPTS);
    return Array.from({ length: 5 }, (_, i) => `<div class="row row-skel" style="animation-delay:${i * 90}ms">
      <span class="row-avatar skel"></span>
      <span class="row-info"><span class="skel" style="width:46%;height:13px"></span><span class="skel" style="width:30%;height:9px"></span></span>
      <span class="row-bars">${bars}</span>
      <span class="row-dot skel"></span>
      <span class="row-uptime"><span class="skel" style="display:inline-block;width:100%;height:14px"></span></span>
    </div>`).join('');
  }
  function emptyHtml() {
    if (!S.data.categories.length) return `<div class="empty"><span class="glyph">◔</span>
      <span>No folders yet. Create one under <b>Settings → Folders</b>, then add your first service.</span></div>`;
    if (!S.data.services.length) return `<div class="empty"><span class="glyph">◔</span>
      <span>No services yet. Add one from the <b>Dashboard</b> to start tracking uptime.</span></div>`;
    return `<div class="empty"><span class="glyph">◔</span><span>Nothing in this folder yet.</span></div>`;
  }
  function patchRows(rows, range, loading) {
    root.querySelector('#up-folder').textContent = App.folderLabel(S.folder);
    root.querySelector('#up-count').textContent = S.loaded ? `${rows.length} of ${S.data.services.length}` : '—';
    root.querySelector('#up-bucket').textContent = `${App.RANGES[range].bucket} per bar`;
    const box = root.querySelector('#up-rows');
    if (loading) { box.innerHTML = skeletonHtml(range); return; }
    if (!rows.length) { box.innerHTML = emptyHtml(); return; }
    box.innerHTML = rows.map(rowHtml).join('');
    box.querySelectorAll('.row[data-id]').forEach(b => b.onclick = () => App.selectService(b.dataset.id, { goDashboard: true }));
  }

  /* ─── Incident log ───────────────────────────────────────────────────── */
  function logRowHtml(i) {
    const hue = App.SEVERITY_HUE[i.severity] ?? App.SEVERITY_HUE.degraded;
    const open = i.endedAt === null;
    const start = new Date(i.startedAt).getTime();
    const dur = open ? 'open · ' + App.fmtDur(Date.now() - start) : App.fmtDur(new Date(i.endedAt).getTime() - start);
    return `<div class="log-row">
      <span class="log-dot" style="background:${App.acc(hue)}"></span>
      <span class="log-name" title="${App.esc(i.name)}">${App.esc(i.name)}</span>
      <span class="log-cause">${App.esc(i.cause)}</span>
      <span class="log-when">${App.esc(App.fmtWhen(i.startedAt))}</span>
      <span class="log-dur" style="background:${App.tint(hue)};color:${App.acc(hue)}"${open ? ` data-open="${App.esc(i.startedAt)}"` : ''}>${App.esc(dur)}</span>
    </div>`;
  }
  function patchLog(incidents, range, loading) {
    const box = root.querySelector('#up-log'), note = root.querySelector('#up-log-note');
    openChips = [];
    if (loading) { note.textContent = ''; box.innerHTML = `<div class="empty"><span>loading history…</span></div>`; return; }
    if (histFailed) { note.textContent = ''; box.innerHTML = `<div class="empty"><span>History unavailable — try <b>Refresh</b>.</span></div>`; return; }
    const open = incidents.filter(i => i.endedAt === null).length;
    note.textContent = open ? `${open} ${App.plural(open, 'open incident')}` : 'all resolved';
    const shown = incidents.slice(0, 50);
    if (!shown.length) {
      box.innerHTML = `<div class="empty"><span class="glyph">◔</span><span>No incidents in the last ${App.esc(range)} — all clear.</span></div>`;
      return;
    }
    box.innerHTML = shown.map(logRowHtml).join('');
    openChips = [...box.querySelectorAll('.log-dur[data-open]')].map(el => ({ el, since: new Date(el.dataset.open).getTime() }));
  }

  // Once a second: only the open-incident elapsed labels change, so touch just those text nodes.
  function onTick() {
    if (!root || !root.isConnected) return;
    const now = Date.now();
    for (const c of openChips) {
      const t = 'open · ' + App.fmtDur(now - c.since);
      if (c.el.textContent !== t) c.el.textContent = t;
    }
    if (downNoteEl && downOffenders.some(o => o.since != null)) {
      const t = downNoteText(now);
      if (downNoteEl.textContent !== t) { downNoteEl.textContent = t; downNoteEl.title = t; }
    }
  }

  App.registerScreen('uptime', {
    title: 'Uptime history',
    render,
    onData: () => {
      patchAll();
      // Boot fetches history itself right after the first data emit; this is the fallback if that never lands.
      if (S.loaded && S.histAt === 0 && !histPending) setTimeout(ensureHistory, 1500);
    },
    onFolder: () => patchAll(),
    onRange: () => patchAll(),
    onSelect: () => {},          // no selection UI on this screen; defined so the core doesn't force a re-render
    onTick,
  });
})();
