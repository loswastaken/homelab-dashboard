/* Settings — tabbed form over a draft copy of settings + folders, with dirty-state Save/Cancel. */
(function () {
  'use strict';
  const S = App.state;
  let root = null;
  let draft = null;          // { settings: {...strings/bools}, categories: [...] }
  let baseline = '';         // JSON of the draft as loaded (dirty = draft !== baseline)
  let agents = { pm2: [], docker: [], loaded: false };
  let revealedKey = null;    // API key while revealed on the API Key tab (never stored in App.state)
  let updateInfo = { state: 'idle', text: '' };
  let saveError = '';
  let updateBusy = false;

  const STRING_KEYS = ['displayName', 'siteTitle', 'serverLabel', 'nasIp', 'checkInterval', 'reportStaleAfter',
    'degradedEscalateCount', 'degradedEscalateWindowMinutes', 'slowThresholdMs', 'weatherLocation', 'weatherCountryCode',
    'weatherUnits', 'iftttWebhookKey', 'iftttEventName', 'ntfyTopic', 'defaultFolder'];
  const BOOL_KEYS = ['weatherEnabled', 'pushEnabled', 'iftttEnabled', 'ntfyEnabled', 'hideEmptyFolders', 'compactHive'];

  const TABS = [
    { id: 'general',       label: 'General',       blurb: 'Identity, polling cadence and the agents reporting in.' },
    { id: 'account',       label: 'Account',       blurb: 'Sign-in for the single admin user.' },
    { id: 'weather',       label: 'Weather',       blurb: 'The chip under your greeting.' },
    { id: 'notifications', label: 'Notifications', blurb: 'Where outage messages land.' },
    { id: 'alerts',        label: 'Alerts',        blurb: 'What counts as an incident worth waking you for.' },
    { id: 'folders',       label: 'Folders',       blurb: 'Folders group services in the sidebar and on status pages.' },
    { id: 'apikey',        label: 'API Key',       blurb: 'Agents and scripts authenticate with this key.' },
    { id: 'updates',       label: 'Updates',       blurb: '' },
  ];
  const esc = App.esc;

  /* ─── Draft ──────────────────────────────────────────────────────────── */
  function loadDraft() {
    const s = S.data.settings || {};
    const settings = {};
    for (const k of STRING_KEYS) settings[k] = String(s[k] ?? '');
    for (const k of BOOL_KEYS) settings[k] = !!s[k];
    if (!settings.weatherUnits) settings.weatherUnits = 'fahrenheit';
    draft = { settings, categories: JSON.parse(JSON.stringify(S.data.categories || [])) };
    baseline = JSON.stringify(draft);
  }
  const isDirty = () => !!draft && JSON.stringify(draft) !== baseline;
  function updateDirty() {
    if (!root) return;
    const dirty = isDirty();
    const save = root.querySelector('#st-save'), cancel = root.querySelector('#st-cancel');
    if (save) save.disabled = !dirty;
    if (cancel) cancel.disabled = !dirty;
    const err = root.querySelector('#st-error');
    if (err) { err.hidden = !saveError; err.textContent = saveError; }
  }
  window.addEventListener('beforeunload', e => {
    if (S.screen === 'settings' && isDirty()) { e.preventDefault(); e.returnValue = ''; }
  });

  /* ─── Layout ─────────────────────────────────────────────────────────── */
  function layout() {
    return `
      <div class="hdr">
        <div class="hdr-title-wrap">
          <h1>Settings</h1>
          <div class="hdr-sub">changes save to data/services.json</div>
        </div>
        <span class="hdr-spacer"></span>
        <div class="hdr-actions">
          <button class="btn btn-secondary" id="st-cancel" disabled>Cancel</button>
          <button class="btn btn-primary" id="st-save" disabled>Save settings</button>
        </div>
      </div>
      <div class="result-box err" id="st-error" hidden></div>
      <div class="tabbar" id="st-tabs">${TABS.map(t => `<button class="tab${S.tab === t.id ? ' active' : ''}" data-tab="${t.id}">${esc(t.label)}</button>`).join('')}</div>
      <div class="panel settings-panel" id="st-panel"></div>`;
  }

  function render(rootEl) {
    root = rootEl;
    if (!draft || !isDirty()) loadDraft();
    if (!TABS.find(t => t.id === S.tab)) S.tab = 'general';
    root.innerHTML = layout();
    root.querySelectorAll('#st-tabs .tab').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
    root.querySelector('#st-save').onclick = save;
    root.querySelector('#st-cancel').onclick = () => { saveError = ''; loadDraft(); renderPanel(); App.toast('Changes discarded'); };
    renderPanel();
  }
  function switchTab(id) {
    S.tab = id;
    root.querySelectorAll('#st-tabs .tab').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
    renderPanel();
  }

  /* ─── Field builders ─────────────────────────────────────────────────── */
  const lbl = (label, hint, forId) => `<label class="field-lbl"${forId ? ` for="${forId}"` : ''}>${esc(label)}${hint ? ` <span>${esc(hint)}</span>` : ''}</label>`;
  function text(key, label, hint, o = {}) {
    const v = draft.settings[key] ?? '';
    return `<div class="field${o.wide ? ' wide' : ''}">${lbl(label, hint, 'st-' + key)}
      <input class="input${o.ui ? ' ui' : ''}" id="st-${key}" data-key="${key}" type="${o.type || 'text'}" value="${esc(v)}"
        placeholder="${esc(o.placeholder || '')}"${o.min != null ? ` min="${o.min}"` : ''}${o.max != null ? ` max="${o.max}"` : ''}${o.maxlength ? ` maxlength="${o.maxlength}"` : ''}${o.autocomplete ? ` autocomplete="${o.autocomplete}"` : ''}></div>`;
  }
  function toggle(key, label, hint, o = {}) {
    return `<div class="field">${lbl(label, hint)}${App.toggleHtml(key, !!draft.settings[key], '', '', o.disabled)}
      ${o.msgId ? `<div class="field-msg" id="${o.msgId}"></div>` : ''}</div>`;
  }
  function select(key, label, hint, options) {
    const v = draft.settings[key] ?? '';
    return `<div class="field">${lbl(label, hint, 'st-' + key)}<div class="select-wrap"><select class="input ui" id="st-${key}" data-key="${key}">
      ${options.map(([val, txt]) => `<option value="${esc(val)}"${String(v) === String(val) ? ' selected' : ''}>${esc(txt)}</option>`).join('')}
    </select></div></div>`;
  }
  function section(caption, inner, id) {
    return `<div class="section"${id ? ` id="${id}"` : ''}><span class="caption">${esc(caption)}</span>${inner}</div>`;
  }
  function wireFields(panel) {
    panel.querySelectorAll('[data-key]').forEach(el => {
      const key = el.dataset.key;
      const handler = () => { draft.settings[key] = el.value; updateDirty(); };
      el.addEventListener('input', handler);
      el.addEventListener('change', handler);
    });
    App.wireToggles(panel, (id, on, btn) => {
      if (id === 'pushEnabled') return onPushToggle(on, btn);
      if (id in draft.settings) { draft.settings[id] = on; updateDirty(); }
    });
  }

  /* ─── Panel ──────────────────────────────────────────────────────────── */
  function renderPanel() {
    const panel = root.querySelector('#st-panel');
    const tab = TABS.find(t => t.id === S.tab) || TABS[0];
    const blurb = tab.id === 'updates' ? updatesBlurb() : tab.blurb;
    let body = '';
    switch (tab.id) {
      case 'general':       body = generalHtml(); break;
      case 'account':       body = accountHtml(); break;
      case 'weather':       body = weatherHtml(); break;
      case 'notifications': body = notificationsHtml(); break;
      case 'alerts':        body = alertsHtml(); break;
      case 'folders':       body = foldersHtml(); break;
      case 'apikey':        body = apiKeyHtml(); break;
      case 'updates':       body = updatesHtml(); break;
    }
    panel.innerHTML = `<div class="settings-intro"><span class="settings-title">${esc(tab.label)}</span><span class="settings-blurb" id="st-blurb">${esc(blurb)}</span></div>${body}`;
    wireFields(panel);
    switch (tab.id) {
      case 'general':       wireGeneral(panel); break;
      case 'account':       wireAccount(panel); break;
      case 'notifications': wireNotifications(panel); break;
      case 'folders':       wireFolders(panel); break;
      case 'apikey':        wireApiKey(panel); break;
      case 'updates':       wireUpdates(panel); break;
    }
    updateDirty();
  }

  /* ─── General ────────────────────────────────────────────────────────── */
  function generalHtml() {
    return `<div class="fields">
        ${text('displayName', 'Your name', '(shown in greeting)', { ui: true, placeholder: 'Alex' })}
        ${text('siteTitle', 'Site title', '(browser tab)', { ui: true, placeholder: 'Homelab Dashboard' })}
        ${text('serverLabel', 'Server label', '(sidebar footer)', { ui: true, placeholder: 'Synology DS423+' })}
        ${text('nasIp', 'Server IP', '(sidebar footer)', { placeholder: '10.0.0.1' })}
        ${text('checkInterval', 'Health check interval', '(seconds, min 10)', { type: 'number', min: 10, max: 86400, placeholder: '60' })}
        ${text('reportStaleAfter', 'Stale report threshold', '(seconds, push-reported services)', { type: 'number', min: 10, max: 86400, placeholder: '120' })}
        ${toggle('compactHive', 'Compact hive', '(smaller bubbles on the dashboard)')}
      </div>
      ${section('Connected agents', `<div id="st-agents"><div class="note">Loading…</div></div>`)}`;
  }
  function wireGeneral(panel) { renderAgents(panel); }
  async function loadAgents() {
    const [p, d] = await Promise.all([App.api('GET', '/api/pm2/agents'), App.api('GET', '/api/docker/agents')]);
    agents = { pm2: p.json?.agents || [], docker: d.json?.agents || [], loaded: true };
  }
  async function renderAgents(panel) {
    const box = panel.querySelector('#st-agents');
    if (!box) return;
    await loadAgents();
    if (!box.isConnected) return;
    const rows = [...agents.pm2.map(a => ({ kind: 'pm2', a })), ...agents.docker.map(a => ({ kind: 'docker', a }))];
    if (!rows.length) { box.innerHTML = `<div class="note">No agents connected yet. Install one from the <b>API Key</b> tab and it will register itself here.</div>`; return; }
    box.innerHTML = `<div class="rows">` + rows.map(({ kind, a }) => {
      const count = typeof a.items === 'number' ? a.items : (Array.isArray(a.items) ? a.items.length : 0);
      return `<div class="agent-row${a.stale ? ' stale' : ''}" data-kind="${kind}" data-id="${esc(a.id)}">
        <span class="kind-chip ${kind}">${kind === 'pm2' ? 'PM2' : 'Docker'}</span>
        <div class="agent-text"><span class="agent-name">${esc(a.name || a.hostname || a.id)}</span>
          <span class="agent-meta">${esc(a.hostname || '')} · ${count} ${App.plural(count, 'item')} · seen ${esc(a.lastSeen ? App.relTime(a.lastSeen) : 'never')}</span></div>
        <button class="btn btn-secondary btn-sm" data-act="rename">Rename</button>
        <button class="btn btn-danger btn-sm" data-act="delete">Delete</button>
      </div>`;
    }).join('') + `</div>`;
    box.querySelectorAll('.agent-row').forEach(row => {
      const kind = row.dataset.kind, id = row.dataset.id;
      const a = agents[kind].find(x => x.id === id);
      row.querySelector('[data-act="rename"]').onclick = async () => {
        const name = await App.prompt({ title: 'Rename agent', label: 'Agent name', value: a?.name || a?.hostname || '', okLabel: 'Rename' });
        if (name == null || !name.trim()) return;
        const r = await App.api('PUT', `/api/${kind}/agents/${encodeURIComponent(id)}`, { name: name.trim() });
        if (!r.ok) return App.toast(r.json.error || 'Rename failed', 'err');
        App.toast('Agent renamed', 'ok');
        renderAgents(panel);
      };
      row.querySelector('[data-act="delete"]').onclick = async () => {
        const ok = await App.confirm({ title: 'Remove agent', message: `Remove "${a?.name || id}"? Services mapped to it stop receiving reports until they are remapped.`, okLabel: 'Remove', danger: true });
        if (!ok) return;
        const r = await App.api('DELETE', `/api/${kind}/agents/${encodeURIComponent(id)}`);
        if (!r.ok) return App.toast(r.json.error || 'Delete failed', 'err');
        App.toast('Agent removed');
        renderAgents(panel);
      };
    });
  }

  /* ─── Account ────────────────────────────────────────────────────────── */
  function accountHtml() {
    return `<div class="fields">
        <div class="field">${lbl('Current password', '(required to make changes)', 'st-curpw')}<input class="input" id="st-curpw" type="password" placeholder="••••••••" autocomplete="current-password"></div>
        <div class="field">${lbl('New username', '(leave blank to keep)', 'st-newuser')}<input class="input ui" id="st-newuser" placeholder="admin" autocomplete="username"></div>
        <div class="field">${lbl('New password', '(leave blank to keep)', 'st-newpw')}<input class="input" id="st-newpw" type="password" placeholder="••••••••" autocomplete="new-password"></div>
      </div>
      <div class="inline-actions"><button class="btn btn-primary btn-sm" id="st-acct-btn">Update account</button><span class="field-msg" id="st-acct-msg"></span></div>
      <div class="note">Account changes apply immediately with this button — they are not part of <b>Save settings</b>.</div>`;
  }
  function wireAccount(panel) {
    const msg = panel.querySelector('#st-acct-msg');
    const setMsg = (t, cls) => { msg.textContent = t; msg.className = 'field-msg ' + (cls || ''); };
    panel.querySelector('#st-acct-btn').onclick = async e => {
      const btn = e.currentTarget;   // currentTarget is null after the await below
      const cur = panel.querySelector('#st-curpw').value, user = panel.querySelector('#st-newuser').value.trim(), pw = panel.querySelector('#st-newpw').value;
      if (!cur) return setMsg('Current password is required.', 'err');
      if (!user && !pw) return setMsg('Enter a new username or password.', 'warn');
      btn.disabled = true;
      const r = await App.api('PUT', '/api/auth', { currentPassword: cur, newUsername: user, newPassword: pw }, { allow401: true });
      btn.disabled = false;
      if (r.ok) { setMsg('Account updated.', 'ok'); panel.querySelector('#st-curpw').value = ''; panel.querySelector('#st-newuser').value = ''; panel.querySelector('#st-newpw').value = ''; }
      else setMsg(r.json.error || 'Update failed.', 'err');
    };
  }

  /* ─── Weather ────────────────────────────────────────────────────────── */
  function weatherHtml() {
    return `<div class="fields">
      ${toggle('weatherEnabled', 'Show on dashboard', '(in the greeting line)')}
      ${text('weatherLocation', 'Location', '(ZIP or city)', { ui: true, placeholder: '10001 or New York' })}
      ${text('weatherCountryCode', 'Country code', '(optional, e.g. US)', { placeholder: 'US', maxlength: 2 })}
      ${select('weatherUnits', 'Units', '', [['fahrenheit', 'Fahrenheit (°F, mph)'], ['celsius', 'Celsius (°C, km/h)']])}
    </div>`;
  }

  /* ─── Notifications ──────────────────────────────────────────────────── */
  function notificationsHtml() {
    return section('Browser push', `<div class="fields">
        ${toggle('pushEnabled', 'Web Push', '(this browser subscribes when enabled)', { msgId: 'st-push-msg' })}
        <div class="field">${lbl('Test', '(sends to every subscribed browser)')}<div class="inline-actions"><button class="btn btn-secondary btn-sm" id="st-push-test">Send test notification</button></div></div>
      </div>`)
    + section('IFTTT', `<div class="fields">
        ${toggle('iftttEnabled', 'IFTTT webhooks', '(Maker channel)')}
        ${text('iftttWebhookKey', 'Webhook key', '(from ifttt.com/maker_webhooks/settings)', { type: 'password', autocomplete: 'off', placeholder: 'key or full Maker URL' })}
        ${text('iftttEventName', 'Event name', '', { placeholder: 'homelab_alert' })}
        <div class="field">${lbl('Test', '(uses the values above, saved or not)')}<div class="inline-actions"><button class="btn btn-secondary btn-sm" id="st-ifttt-test">Send test event</button><span class="field-msg" id="st-ifttt-msg"></span></div></div>
      </div>`)
    + section('ntfy', `<div class="fields">
        ${toggle('ntfyEnabled', 'ntfy push', '(via ntfy.sh)')}
        ${text('ntfyTopic', 'Topic', '(subscribe to it in the ntfy app)', { placeholder: 'los-homelab-a8f3', autocomplete: 'off' })}
        <div class="field">${lbl('Test', '(uses the topic above, saved or not)')}<div class="inline-actions"><button class="btn btn-secondary btn-sm" id="st-ntfy-test">Send test notification</button><span class="field-msg" id="st-ntfy-msg"></span></div></div>
      </div>`);
  }
  function setPushMsg(t, cls) {
    const el = root?.querySelector('#st-push-msg');
    if (!el) return;
    el.textContent = t || ''; el.className = 'field-msg ' + (cls || '');
  }
  async function syncPushWithBrowser() {
    const btn = root?.querySelector('[data-toggle="pushEnabled"]');
    if (!btn || !window.Push) return;
    if (!window.Push.supported()) { setPushMsg('Push notifications are not supported in this browser.', 'err'); return; }
    const state = await window.Push.currentState();
    if (state.keyMismatch) setPushMsg('This browser is subscribed with an outdated server key and cannot receive alerts — turn Web Push off and on again to re-subscribe.', 'err');
    else if (!state.subscribed && draft.settings.pushEnabled) setPushMsg('Enabled globally, but this browser is not subscribed — turn it off and on again to subscribe here.', 'warn');
    else if (state.subscribed && !draft.settings.pushEnabled) setPushMsg('This browser is subscribed, but alerts are muted globally.', '');
  }
  async function onPushToggle(on, btn) {
    if (!window.Push || !window.Push.supported()) { App.setToggle(btn, false); setPushMsg('Push notifications are not supported in this browser.', 'err'); return; }
    try {
      if (on) { await window.Push.registerPush(); setPushMsg('Subscribed on this browser. Save to enable alerts globally.', 'ok'); }
      else { await window.Push.unregisterPush(); setPushMsg('Unsubscribed on this browser.', ''); }
      draft.settings.pushEnabled = on;
    } catch (e) {
      App.setToggle(btn, !on);
      setPushMsg(e?.message || 'Permission denied', 'err');
    }
    updateDirty();
  }
  function wireNotifications(panel) {
    syncPushWithBrowser();
    panel.querySelector('#st-push-test').onclick = async e => {
      const b = e.currentTarget;
      if (!window.Push || !window.Push.supported()) return setPushMsg('Push notifications are not supported in this browser.', 'err');
      b.disabled = true;
      try { await window.Push.testPush(); setPushMsg('Test sent — check for the notification.', 'ok'); }
      catch (err) { setPushMsg(err?.message || 'Test failed', 'err'); }
      b.disabled = false;
    };
    const test = (btnId, msgId, path, body, okText) => {
      const b = panel.querySelector(btnId), m = panel.querySelector(msgId);
      b.onclick = async () => {
        b.disabled = true; m.textContent = 'Sending…'; m.className = 'field-msg';
        const r = await App.api('POST', path, body());
        b.disabled = false;
        if (r.ok) { m.textContent = okText; m.className = 'field-msg ok'; }
        else { m.textContent = (r.json.error || `HTTP ${r.status}`).slice(0, 200); m.className = 'field-msg err'; }
      };
    };
    test('#st-ifttt-test', '#st-ifttt-msg', '/api/ifttt/test', () => ({ webhookKey: draft.settings.iftttWebhookKey.trim(), eventName: draft.settings.iftttEventName.trim() }), 'Test event sent.');
    test('#st-ntfy-test', '#st-ntfy-msg', '/api/ntfy/test', () => ({ topic: draft.settings.ntfyTopic.trim() }), 'Test notification sent.');
  }

  /* ─── Alerts ─────────────────────────────────────────────────────────── */
  function alertsHtml() {
    return `<div class="fields">
        ${text('degradedEscalateCount', 'Streak threshold', '(consecutive bad checks)', { type: 'number', min: 1, max: 100, placeholder: '3' })}
        ${text('degradedEscalateWindowMinutes', 'Escalation window', '(minutes)', { type: 'number', min: 1, max: 1440, placeholder: '5' })}
        ${text('slowThresholdMs', 'Slow response threshold', '(ms, 0 = disabled)', { type: 'number', min: 0, max: 600000, placeholder: '0' })}
      </div>
      <div class="note">A URL service that returns 5xx, exceeds the slow-response threshold, or fails to connect counts as a bad check. After the streak threshold it is marked <b>degraded</b> and a notification fires; the same count again escalates it to <b>offline</b>. One good check resets the streak, and a gap longer than the window between bad checks restarts it (the window is never shorter than two check intervals, so a scheduled streak always counts). Each URL service can override the slow-response threshold from its own edit dialog.</div>`;
  }

  /* ─── Folders ────────────────────────────────────────────────────────── */
  const cats = () => draft.categories;
  const topCats = () => cats().filter(c => !c.parentId);
  const subsOf = id => cats().filter(c => c.parentId === id);
  function svcCount(id) {
    const subIds = new Set(subsOf(id).map(c => c.id));
    return S.data.services.filter(s => s.cat === id || subIds.has(s.cat)).length;
  }
  function foldersHtml() {
    const options = [['', 'All services']];
    for (const c of topCats()) { options.push([c.id, c.name]); for (const sub of subsOf(c.id)) options.push([sub.id, '↳ ' + sub.name]); }
    return `<div class="fields">
        ${select('defaultFolder', 'Default folder', '(on dashboard load)', options)}
        ${toggle('hideEmptyFolders', 'Hide empty folders', '(in the sidebar)')}
      </div>
      ${section('Folders · drag to reorder', `<div class="rows" id="st-folder-list"></div>
        <div><button class="btn btn-tint btn-sm" id="st-add-folder">+ Add folder</button></div>`)}`;
  }
  function folderRowHtml(c, sub) {
    const hue = App.hueOf(c.color);
    const n = svcCount(c.id);
    return `<div class="folder-row${sub ? ' sub' : ''}" data-id="${esc(c.id)}" data-group="${esc(c.parentId || '')}">
      <span class="grab" title="Drag to reorder">⠿</span>
      <span class="folder-swatch" style="background:${App.acc(hue)};box-shadow:0 0 0 4px ${App.tint(hue)}"></span>
      <span class="folder-row-name">${esc(c.name)}</span>
      <span class="folder-row-count">${n} ${App.plural(n, 'service')}</span>
      <button class="btn btn-secondary btn-sm" data-act="rename">Rename</button>
      <button class="btn btn-secondary btn-sm" data-act="recolor">Recolor</button>
      <button class="btn btn-danger btn-sm" data-act="delete">Delete</button>
    </div>`;
  }
  function renderFolderList(panel) {
    const list = panel.querySelector('#st-folder-list');
    if (!list) return;
    const rows = [];
    for (const c of topCats()) { rows.push(folderRowHtml(c, false)); for (const sub of subsOf(c.id)) rows.push(folderRowHtml(sub, true)); }
    list.innerHTML = rows.length ? rows.join('') : `<div class="note">No folders yet. Add one to start grouping services.</div>`;
    list.querySelectorAll('.folder-row').forEach(row => {
      const id = row.dataset.id;
      row.querySelector('[data-act="rename"]').onclick = () => openFolderModal(panel, id);
      row.querySelector('[data-act="recolor"]').onclick = () => openColorModal(panel, id);
      row.querySelector('[data-act="delete"]').onclick = () => deleteFolder(panel, id);
    });
    wireDrag(list, panel);
  }
  function wireFolders(panel) {
    renderFolderList(panel);
    panel.querySelector('#st-add-folder').onclick = () => openFolderModal(panel, null);
  }
  function markFoldersChanged(panel) {
    if (draft.settings.defaultFolder && !cats().find(c => c.id === draft.settings.defaultFolder)) draft.settings.defaultFolder = '';
    // Rebuild the tab so the default-folder select reflects renames/adds/deletes.
    renderPanel();
    void panel;
  }
  function wireDrag(list, panel) {
    list.querySelectorAll('.grab').forEach(handle => {
      handle.onpointerdown = e => {
        e.preventDefault();
        const row = handle.closest('.folder-row');
        const id = row.dataset.id, group = row.dataset.group;
        let target = null, after = false;
        row.classList.add('dragging');
        try { handle.setPointerCapture(e.pointerId); } catch {}
        const clear = () => list.querySelectorAll('.folder-row').forEach(r => r.classList.remove('drop-before', 'drop-after'));
        const move = ev => {
          const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.folder-row');
          clear(); target = null;
          if (el && el !== row && el.dataset.group === group && list.contains(el)) {
            const rect = el.getBoundingClientRect();
            after = ev.clientY > rect.top + rect.height / 2;
            target = el;
            el.classList.add(after ? 'drop-after' : 'drop-before');
          }
        };
        const up = () => {
          handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up);
          try { handle.releasePointerCapture(e.pointerId); } catch {}
          row.classList.remove('dragging'); clear();
          if (target) reorderFolder(id, target.dataset.id, after, panel);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
      };
    });
  }
  function reorderFolder(id, targetId, after, panel) {
    const list = cats();
    const from = list.findIndex(c => c.id === id);
    if (from < 0) return;
    const [item] = list.splice(from, 1);
    let to = list.findIndex(c => c.id === targetId);
    if (to < 0) { list.splice(from, 0, item); return; }
    if (after) to++;
    list.splice(to, 0, item);
    renderFolderList(panel);
    updateDirty();
  }
  const slugId = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || ('cat-' + Date.now());
  function colorPickerHtml(current) {
    const presetSel = App.PRESET_HUES[current] !== undefined ? current : '';
    const hex = /^#[0-9a-fA-F]{6}$/.test(current || '') ? current : '';
    return `<div class="field">${lbl('Color', '(a preset, or any #rrggbb)')}
      <div class="swatches" id="fm-swatches">${App.PRESET_ORDER.map(p => `<span class="swatch${presetSel === p ? ' selected' : ''}" data-preset="${p}" title="${p}" style="background:${App.acc(App.PRESET_HUES[p])}"></span>`).join('')}</div>
      <input class="input" id="fm-hex" placeholder="#4fd39b" maxlength="7" value="${esc(hex)}" style="max-width:180px">
      <div class="field-msg" id="fm-color-msg"></div></div>`;
  }
  function wireColorPicker(B, initial) {
    let color = initial || 'green';
    const swatches = B.querySelector('#fm-swatches'), hexInp = B.querySelector('#fm-hex'), msg = B.querySelector('#fm-color-msg');
    const paint = () => { swatches.querySelectorAll('.swatch').forEach(sw => sw.classList.toggle('selected', sw.dataset.preset === color)); };
    swatches.querySelectorAll('.swatch').forEach(sw => sw.onclick = () => { color = sw.dataset.preset; hexInp.value = ''; msg.textContent = ''; paint(); });
    hexInp.addEventListener('input', () => {
      const v = hexInp.value.trim();
      if (!v) { msg.textContent = ''; if (!App.PRESET_HUES[color]) color = 'green'; paint(); return; }
      if (/^#[0-9a-fA-F]{6}$/.test(v)) { color = v.toLowerCase(); msg.textContent = ''; msg.className = 'field-msg'; paint(); }
      else { msg.textContent = 'Use the form #rrggbb'; msg.className = 'field-msg err'; }
    });
    paint();
    return () => color;
  }
  function openFolderModal(panel, id) {
    const cat = id ? cats().find(c => c.id === id) : null;
    const isEdit = !!cat;
    const hasSubs = isEdit && subsOf(cat.id).length > 0;
    const parents = topCats().filter(c => c.id !== id);
    const body = `<div class="fields">
        <div class="field wide">${lbl('Name', '', 'fm-name')}<input class="input ui" id="fm-name" maxlength="60" placeholder="Storage" value="${esc(cat?.name || '')}"></div>
        ${isEdit ? '' : colorPickerHtml('green')}
        <div class="field">${lbl('Parent', hasSubs ? '(this folder has subfolders)' : '(optional, top-level folders only)', 'fm-parent')}
          <div class="select-wrap"><select class="input ui" id="fm-parent"${hasSubs ? ' disabled' : ''}>
            <option value="">None (top-level)</option>
            ${parents.map(p => `<option value="${esc(p.id)}"${cat?.parentId === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
          </select></div></div>
      </div>
      <div class="form-msg" id="fm-msg"></div>`;
    const m = App.modal({
      title: isEdit ? 'Rename folder' : 'Add folder', body,
      foot: `<button class="btn btn-secondary" data-act="cancel">Cancel</button><button class="btn btn-primary" data-act="ok">${isEdit ? 'Save' : 'Add folder'}</button>`
    });
    const B = m.body;
    const getColor = isEdit ? null : wireColorPicker(B, 'green');
    m.foot.querySelector('[data-act="cancel"]').onclick = () => m.close();
    m.foot.querySelector('[data-act="ok"]').onclick = () => {
      const name = B.querySelector('#fm-name').value.trim();
      const parentSel = B.querySelector('#fm-parent');
      const parentId = parentSel.disabled ? (cat?.parentId || '') : parentSel.value;
      const msg = B.querySelector('#fm-msg');
      if (!name) { msg.textContent = 'Name is required.'; return; }
      if (isEdit) {
        cat.name = name;
        if (parentId) cat.parentId = parentId; else delete cat.parentId;
      } else {
        const newId = slugId(name);
        if (cats().find(c => c.id === newId)) { msg.textContent = `A folder with the id "${newId}" already exists.`; return; }
        const entry = { id: newId, name, color: getColor() };
        if (parentId) entry.parentId = parentId;
        cats().push(entry);
      }
      m.close();
      markFoldersChanged(panel);
      App.toast(isEdit ? 'Folder updated — save to apply' : 'Folder added — save to apply');
    };
    setTimeout(() => B.querySelector('#fm-name').focus(), 40);
  }
  function openColorModal(panel, id) {
    const cat = cats().find(c => c.id === id);
    if (!cat) return;
    const m = App.modal({
      title: `Recolor ${cat.name}`, cls: 'narrow', body: colorPickerHtml(cat.color),
      foot: `<button class="btn btn-secondary" data-act="cancel">Cancel</button><button class="btn btn-primary" data-act="ok">Apply</button>`
    });
    const getColor = wireColorPicker(m.body, cat.color);
    m.foot.querySelector('[data-act="cancel"]').onclick = () => m.close();
    m.foot.querySelector('[data-act="ok"]').onclick = () => { cat.color = getColor(); m.close(); renderFolderList(panel); updateDirty(); };
  }
  async function deleteFolder(panel, id) {
    const cat = cats().find(c => c.id === id);
    if (!cat) return;
    const subs = subsOf(id);
    const n = svcCount(id);
    const ok = await App.confirm({
      title: 'Delete folder',
      message: `Delete "${cat.name}"${subs.length ? ` and its ${subs.length} ${App.plural(subs.length, 'subfolder')}` : ''}? ${n ? `${n} ${App.plural(n, 'service')} in it will keep their folder id but only show under All services until reassigned.` : 'It contains no services.'} Nothing is persisted until you save.`,
      okLabel: 'Delete', danger: true
    });
    if (!ok) return;
    draft.categories = cats().filter(c => c.id !== id && c.parentId !== id);
    markFoldersChanged(panel);
  }

  /* ─── API Key ────────────────────────────────────────────────────────── */
  const MASK = '••••••••••••••••••••••••';
  function apiKeyHtml() {
    const origin = location.origin;
    return section('Push endpoint', `
        <div class="endpoint-box">
          <span class="endpoint-txt">POST ${esc(origin)}/api/services/{serviceId}/report<br>X-Api-Key: <span id="st-key">${revealedKey ? esc(revealedKey) : MASK}</span></span>
          <button class="btn btn-secondary btn-sm" id="st-key-reveal">${revealedKey ? 'Hide' : 'Reveal'}</button>
          <button class="btn btn-secondary btn-sm" id="st-key-copy">Copy</button>
          <button class="btn btn-warn btn-sm" id="st-key-regen">Regenerate</button>
        </div>
        <span class="note">Agents post here on every poll. Regenerating invalidates all running agents until they are updated with the new key.</span>`)
      + section('Install the PM2 agent', `<span class="note">Run on any host where PM2 manages processes. The agent registers itself and appears in the service dialog's PM2 host list.</span>
        <pre class="snippet" id="st-pm2-snippet">${esc(pm2Snippet())}</pre><div><button class="btn btn-secondary btn-sm" data-copy="st-pm2-snippet">Copy</button></div>`)
      + section('Install the Docker agent', `<span class="note">Run on any host with Docker. The container needs the Docker socket mounted read-only.</span>
        <pre class="snippet" id="st-docker-snippet">${esc(dockerSnippet())}</pre><div><button class="btn btn-secondary btn-sm" data-copy="st-docker-snippet">Copy</button></div>`);
  }
  const keyForSnippet = () => revealedKey || 'PASTE_KEY_FROM_DASHBOARD_SETTINGS';
  function pm2Snippet() {
    return '# On the host, as the user that runs PM2:\n' +
      'cd ~ && git clone https://github.com/loswastaken/homelab-dashboard.git\n' +
      'cd homelab-dashboard/pm2-agent\n\n' +
      '# Edit ecosystem.config.js and set:\n' +
      '#   DASHBOARD_URL:   ' + location.origin + '\n' +
      '#   REPORT_API_KEY:  ' + keyForSnippet() + '\n\n' +
      'pm2 start ecosystem.config.js\npm2 save\n\n' +
      '# Auto-update every 15 min (optional):\n' +
      '(crontab -l 2>/dev/null; echo "*/15 * * * * bash ~/homelab-dashboard/pm2-agent/update-agent.sh >> ~/pm2-agent-update.log 2>&1") | crontab -';
  }
  function dockerSnippet() {
    return '# On the host — runs as a Docker container with socket access.\n' +
      'mkdir -p ~/homelab-docker-agent/data && cd ~/homelab-docker-agent\n\n' +
      'cat > docker-compose.yml <<YAML\nservices:\n  docker-agent:\n' +
      '    image: ghcr.io/loswastaken/homelab-dashboard-docker-agent:latest\n' +
      '    container_name: homelab-docker-agent\n    restart: unless-stopped\n    network_mode: host\n' +
      '    environment:\n      DASHBOARD_URL:  ' + location.origin + '\n      REPORT_API_KEY: ' + keyForSnippet() + '\n' +
      '    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock:ro\n      - ./data:/app/data\n' +
      '    labels:\n      com.centurylinklabs.watchtower.scope: homelab\nYAML\n\nsudo docker compose up -d';
  }
  async function fetchKey() {
    const r = await App.api('GET', '/api/auth/api-key');
    if (!r.ok) { App.toast(r.json.error || 'Could not load the API key', 'err'); return null; }
    return r.json.apiKey || '';
  }
  function wireApiKey(panel) {
    panel.querySelector('#st-key-reveal').onclick = async () => {
      if (revealedKey) { revealedKey = null; renderPanel(); return; }
      const k = await fetchKey();
      if (k == null) return;
      revealedKey = k; renderPanel();
    };
    panel.querySelector('#st-key-copy').onclick = async e => {
      const btn = e.currentTarget;
      const k = revealedKey || await fetchKey();
      if (k == null) return;
      App.copyText(k, btn);
    };
    panel.querySelector('#st-key-regen').onclick = async () => {
      const ok = await App.confirm({ title: 'Regenerate API key', message: 'Every running PM2 and Docker agent will start failing with 401 until it is updated with the new key. Continue?', okLabel: 'Regenerate', danger: true });
      if (!ok) return;
      const r = await App.api('POST', '/api/auth/api-key/regenerate');
      if (!r.ok) return App.toast(r.json.error || 'Regeneration failed', 'err');
      if (revealedKey) revealedKey = r.json.apiKey || null;
      App.toast('API key regenerated — update your agents', 'warn');
      renderPanel();
    };
    panel.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => App.copyText(panel.querySelector('#' + b.dataset.copy)?.textContent || '', b));
  }

  /* ─── Updates ────────────────────────────────────────────────────────── */
  function updatesBlurb() {
    const v = S.data.version || 'dev';
    const st = updateInfo.state === 'checking' ? 'checking…'
      : updateInfo.state === 'current' ? 'up to date'
      : updateInfo.state === 'behind' ? 'one release behind'
      : updateInfo.state === 'dev' ? 'local dev build'
      : updateInfo.state === 'error' ? 'update check failed'
      : 'not checked yet';
    return `Running ${v} · ${st}`;
  }
  function updatesHtml() {
    return `<div class="endpoint-box">
        <div class="agent-text" style="min-width:200px"><span class="caption">Current build</span><span class="endpoint-txt" style="font-size:15px">${esc(S.data.version || 'dev')}</span></div>
        <button class="btn btn-primary btn-sm" id="st-upd-check"${updateBusy ? ' disabled' : ''}>${updateBusy ? 'Checking…' : 'Check for updates'}</button>
      </div>
      <div class="result-box" id="st-upd-result" hidden></div>
      <span class="note">Updates are pulled by Watchtower from GHCR. When a newer image is found it is applied immediately and the dashboard reloads once the new build is live.</span>`;
  }
  function updResult(msg, kind) {
    const el = root?.querySelector('#st-upd-result');
    if (!el) return;
    el.hidden = false; el.className = 'result-box ' + kind; el.textContent = msg;
  }
  function setBlurb() { const b = root?.querySelector('#st-blurb'); if (b && S.tab === 'updates') b.textContent = updatesBlurb(); }
  async function wireUpdates(panel) {
    panel.querySelector('#st-upd-check').onclick = checkForUpdates;
    if (updateInfo.state === 'idle' && !updateBusy) {
      updateInfo.state = 'checking'; setBlurb();
      const r = await App.api('GET', '/api/update/check');
      if (!r.ok) updateInfo = { state: 'error', text: r.json.error || '' };
      else if (r.json.isDev) updateInfo = { state: 'dev' };
      else updateInfo = { state: r.json.hasUpdate ? 'behind' : 'current', text: r.json.latest || '' };
      setBlurb();
    }
  }
  async function checkForUpdates() {
    const btn = root.querySelector('#st-upd-check');
    const resetBtn = () => { updateBusy = false; if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = 'Check for updates'; } };
    updateBusy = true; btn.disabled = true; btn.textContent = 'Checking…';
    root.querySelector('#st-upd-result').hidden = true;
    const r = await App.api('GET', '/api/update/check');
    if (!r.ok) { updateInfo = { state: 'error' }; setBlurb(); updResult(r.json.error || `HTTP ${r.status}`, 'err'); return resetBtn(); }
    if (r.json.isDev) { updateInfo = { state: 'dev' }; setBlurb(); updResult('Running a local dev build — version tracking only works in deployed containers.', 'warn'); return resetBtn(); }
    if (!r.json.hasUpdate) { updateInfo = { state: 'current' }; setBlurb(); updResult(`Up to date (${r.json.current}).`, 'ok'); return resetBtn(); }
    updateInfo = { state: 'behind' }; setBlurb();
    updResult(`Update found: ${r.json.latest} — "${r.json.commitMessage || ''}" — applying…`, 'warn');
    await applyUpdate(resetBtn);
  }
  async function applyUpdate(resetBtn) {
    let r;
    try { r = await App.api('POST', '/api/update/apply'); }
    catch { updResult('Restarting…', 'ok'); return waitForRestart(resetBtn); }
    const d = r.json || {};
    if (d.ok) { updResult('Update triggered — restarting…', 'ok'); return waitForRestart(resetBtn); }
    if (d.manual) { updResult(d.message || 'Apply the update manually on the host.', 'warn'); return resetBtn(); }
    if (d.error && /timeout/i.test(d.error)) { updResult('Restarting…', 'ok'); return waitForRestart(resetBtn); }
    if (r.status === 0) { updResult('Restarting…', 'ok'); return waitForRestart(resetBtn); }
    updResult(d.error || 'Update failed.', 'err');
    resetBtn();
  }
  function waitForRestart(resetBtn) {
    const currentSha = S.data.version || null;
    updResult('Restarting — the page reloads automatically once the new version is live…', 'ok');
    let elapsed = 0;
    const POLL_MS = 3000, TIMEOUT_MS = 90 * 1000;
    setTimeout(() => {
      const iv = setInterval(async () => {
        elapsed += POLL_MS;
        try {
          const res = await fetch('/api/services', { cache: 'no-store' });
          if (!res.ok) return;
          const data = await res.json();
          const sha = data.version || null;
          if (!currentSha || (sha && sha !== currentSha)) { clearInterval(iv); window.location.reload(); return; }
          if (elapsed >= TIMEOUT_MS) {
            clearInterval(iv);
            updResult('No restart detected. The new image may still be building (GitHub Actions takes a few minutes) — try again shortly.', 'warn');
            resetBtn();
          }
        } catch { /* container restarting — keep polling */ }
      }, POLL_MS);
    }, 8000);
  }

  /* ─── Save / leave ───────────────────────────────────────────────────── */
  const int = (v, fb) => { const n = parseInt(v, 10); return isNaN(n) ? fb : n; };
  async function save() {
    const s = draft.settings;
    const payload = {
      settings: {
        displayName: s.displayName.trim(), siteTitle: s.siteTitle.trim(), serverLabel: s.serverLabel.trim(), nasIp: s.nasIp.trim(),
        checkInterval: Math.max(10, int(s.checkInterval, 60)),
        reportStaleAfter: Math.max(10, int(s.reportStaleAfter, 120)),
        degradedEscalateCount: Math.max(1, int(s.degradedEscalateCount, 3)),
        degradedEscalateWindowMinutes: Math.max(1, int(s.degradedEscalateWindowMinutes, 5)),
        slowThresholdMs: Math.max(0, int(s.slowThresholdMs, 0)),
        weatherEnabled: s.weatherEnabled, weatherLocation: s.weatherLocation.trim(),
        weatherCountryCode: s.weatherCountryCode.trim().toUpperCase(), weatherUnits: s.weatherUnits === 'celsius' ? 'celsius' : 'fahrenheit',
        pushEnabled: s.pushEnabled, iftttEnabled: s.iftttEnabled, iftttWebhookKey: s.iftttWebhookKey.trim(), iftttEventName: s.iftttEventName.trim(),
        ntfyEnabled: s.ntfyEnabled, ntfyTopic: s.ntfyTopic.trim(),
        defaultFolder: s.defaultFolder, hideEmptyFolders: s.hideEmptyFolders, compactHive: s.compactHive,
      },
      categories: draft.categories,
    };
    const btn = root.querySelector('#st-save');
    btn.disabled = true; btn.textContent = 'Saving…';
    const r = await App.api('PUT', '/api/config', payload);
    btn.textContent = 'Save settings';
    if (!r.ok) { saveError = r.json.error || 'Failed to save settings.'; updateDirty(); App.toast(saveError, 'err'); return; }
    saveError = '';
    S.data.settings = { ...S.data.settings, ...(r.json.settings || payload.settings) };
    S.data.categories = r.json.categories || payload.categories;
    loadDraft();
    renderPanel();
    App.toast('Settings saved', 'ok');
    await App.afterSettingsSaved();
  }
  async function onLeave() {
    if (!isDirty()) { revealedKey = null; return true; }
    const ok = await App.confirm({ title: 'Discard changes?', message: 'You have unsaved settings. Leave without saving?', okLabel: 'Discard', danger: true });
    if (ok) { saveError = ''; draft = null; revealedKey = null; }
    return ok;
  }
  function onData() {
    if (!root || !root.isConnected || !draft) return;
    if (isDirty()) return;                       // never clobber in-progress edits
    const before = baseline;
    loadDraft();
    const panel = root.querySelector('#st-panel');
    const typing = panel && panel.contains(document.activeElement) && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (baseline !== before && !typing) renderPanel();
    else if (S.tab === 'general' && panel) renderAgents(panel);
    else if (S.tab === 'updates') setBlurb();
  }

  App.registerScreen('settings', {
    title: 'Settings',
    render,
    onData,
    onLeave,
    onFolder: () => {},
    onSelect: () => {},
    onRange: () => {},
  });
})();
