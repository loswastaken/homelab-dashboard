/* Status pages — page cards + live public preview + create/edit editor. */
(function () {
  'use strict';
  const S = App.state;
  let root = null;
  let previewRange = '30d';   // preview's own range, independent of App.state.range
  let lastSub = '';
  let lastMeta = '';

  const PAGE_HUES = [158, 220, 300, 340, 75, 265, 25, 240];
  const RESERVED = new Set(['api', 'login', 'logout', 'setup', 'static', 'public', 'status',
    'status-pages', 'admin', 'history', 'uptime', 'settings', 'new', 'edit', 'index']);
  const BANNER = {
    operational: { cls: '',      msg: 'All systems operational' },
    degraded:    { cls: 'warn',  msg: 'Degraded performance' },
    outage:      { cls: 'down',  msg: 'Partial outage' },
    maintenance: { cls: 'maint', msg: 'Scheduled maintenance' },
  };

  /* ─── Helpers ────────────────────────────────────────────────────────── */
  const pages = () => S.data.statusPages || [];
  const pageById = id => pages().find(p => p.id === id) || null;
  const pageUrl = p => `${location.origin}/status/${p.slug}`;
  const pageHost = p => `${location.host}/status/${p.slug}`;
  function hueForSlug(slug) {
    let h = 0;
    for (const ch of String(slug || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return PAGE_HUES[h % PAGE_HUES.length];
  }
  function fmtCount(n) {
    n = Number(n) || 0;
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(n);
  }
  function pageServices(p) {
    return (p.serviceIds || []).map(id => S.data.services.find(s => s.id === id)).filter(Boolean);
  }
  // What a visitor sees: the server hides disabled + pending services publicly.
  function publicServices(p) {
    return pageServices(p)
      .filter(s => { const st = App.statusOf(s); return st !== 'disabled' && st !== 'pending'; })
      .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
  }
  function pageUptime(p) {
    const vals = pageServices(p).map(s => App.uptimeFor(s.id, '30d')).filter(v => v != null);
    if (!vals.length) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  function overallOf(list) {
    if (!list.length) return 'operational';
    const sts = list.map(App.statusOf);
    if (sts.includes('offline')) return 'outage';
    if (sts.includes('degraded')) return 'degraded';
    if (sts.every(st => st === 'maintenance')) return 'maintenance';
    return 'operational';
  }
  function ensureSelection() {
    if (S.page && pageById(S.page)) return;
    S.page = pages().length ? pages()[0].id : null;
  }
  function slugify(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  }
  function validateSlug(slug, selfId) {
    if (!slug) return { ok: false, error: 'Slug is required' };
    if (slug.length < 2 || slug.length > 40) return { ok: false, error: 'Slug must be 2–40 characters' };
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return { ok: false, error: 'Use lowercase letters, numbers, and single dashes (e.g. my-page)' };
    if (RESERVED.has(slug)) return { ok: false, error: `"${slug}" is reserved` };
    if (pages().some(p => p.slug === slug && p.id !== selfId)) return { ok: false, error: 'Slug is already in use' };
    return { ok: true };
  }

  /* ─── Layout ─────────────────────────────────────────────────────────── */
  function layout() {
    return `
      <div class="hdr">
        <div class="hdr-title-wrap">
          <h1>Status <b>pages</b></h1>
          <div class="hdr-sub" id="status-sub">loading…</div>
        </div>
        <span class="hdr-spacer"></span>
        <div class="hdr-actions">
          <button class="btn btn-primary" id="new-page">+ New status page</button>
        </div>
      </div>
      <div class="status-wrap">
        <div class="cards" id="cards"></div>
        <div class="panel preview" id="preview"></div>
      </div>`;
  }

  function render(rootEl) {
    root = rootEl;
    root.innerHTML = layout();
    root.querySelector('#new-page').onclick = () => openEditor(null);
    lastSub = ''; lastMeta = '';
    patchAll(true);
  }

  /* ─── Header ─────────────────────────────────────────────────────────── */
  function patchHeader() {
    const el = root.querySelector('#status-sub');
    if (!el) return;
    let txt;
    if (!S.loaded) txt = S.online ? 'loading…' : 'connection error — retrying';
    else {
      const list = pages();
      const views = list.reduce((a, p) => a + (Number(p.views30d) || 0), 0);
      txt = list.length
        ? `${list.length} ${App.plural(list.length, 'page')} · ${fmtCount(views)} ${views === 1 ? 'visitor' : 'visitors'} this month`
        : 'no pages yet · share uptime without sharing your dashboard';
    }
    if (txt !== lastSub) { el.textContent = txt; lastSub = txt; }
  }

  /* ─── Page cards ─────────────────────────────────────────────────────── */
  function cardHtml(p) {
    const hue = hueForSlug(p.slug);
    const vis = p.visibility === 'private' ? 'private' : 'public';
    const visHue = vis === 'private' ? 265 : 158;
    const n = pageServices(p).length;
    const up = pageUptime(p);
    const initial = (p.name || '?').trim().charAt(0).toUpperCase() || '?';
    return `<div class="pcard${S.page === p.id ? ' selected' : ''}" data-id="${App.esc(p.id)}" role="button" tabindex="0">
      <div class="pcard-top">
        <div class="pcard-tile" style="background:${App.tint(hue)};color:${App.acc(hue)}">${App.esc(initial)}</div>
        <div class="pcard-text">
          <span class="pcard-name">${App.esc(p.name || 'Untitled page')}</span>
          <span class="pcard-url">${App.esc(pageHost(p))}</span>
        </div>
        <span class="vis-chip" style="background:${App.tint(visHue)};color:${App.textOn(visHue)}">${vis}</span>
      </div>
      <div class="pcard-bottom">
        <span class="meta-chip">${n} ${App.plural(n, 'service')}</span>
        <span class="meta-chip">${up == null ? '—' : App.fmtPct(up, 1)} 30d</span>
        <span class="meta-chip">${fmtCount(p.views30d)} views</span>
        <span class="pcard-spacer"></span>
        <button class="btn btn-secondary btn-sm" data-act="edit">Edit</button>
        <button class="btn btn-secondary btn-sm" data-act="copy">Copy link</button>
        <button class="btn btn-secondary btn-sm" data-act="open">Open ↗</button>
        <button class="btn btn-danger btn-sm" data-act="delete">Delete</button>
      </div>
    </div>`;
  }
  function cardsEmptyHtml() {
    if (!S.loaded) return `<div class="panel"><div class="empty"><span class="glyph">◎</span><span>${S.online ? 'Loading status pages…' : 'Connection error — retrying.'}</span></div></div>`;
    return `<div class="panel"><div class="empty"><span class="glyph">◎</span>
      <span>No status pages yet. Click <b>+ New status page</b> to publish a public uptime page for a set of services.</span></div></div>`;
  }
  function patchCards(fresh) {
    const box = root.querySelector('#cards');
    if (!box) return;
    const list = pages();
    if (!list.length) { box.innerHTML = cardsEmptyHtml(); return; }
    box.innerHTML = list.map(cardHtml).join('');
    box.querySelectorAll('.pcard').forEach((card, i) => {
      // Stagger the fade-in only on a fresh render; polls patch silently.
      if (fresh) { card.style.animation = 'hl-in .3s ease both'; card.style.animationDelay = `${Math.min(i, 12) * 30}ms`; }
      const id = card.dataset.id;
      card.onclick = () => selectPage(id);
      card.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectPage(id); } };
      card.querySelectorAll('[data-act]').forEach(btn => {
        btn.onclick = e => {
          e.stopPropagation();
          const p = pageById(id);
          if (!p) return;
          const act = btn.dataset.act;
          if (act === 'edit') openEditor(id);
          else if (act === 'copy') App.copyText(pageUrl(p), btn);
          else if (act === 'open') window.open(pageUrl(p), '_blank', 'noopener');
          else if (act === 'delete') deletePage(id);
        };
      });
    });
  }
  function selectPage(id) {
    if (S.page === id) return;
    S.page = id;
    root.querySelectorAll('.pcard').forEach(c => c.classList.toggle('selected', c.dataset.id === id));
    patchPreview();
  }
  async function deletePage(id) {
    const p = pageById(id);
    if (!p) return;
    const ok = await App.confirm({
      title: 'Delete status page',
      message: `Delete "${p.name}"? The public URL /status/${p.slug} will stop working immediately.`,
      okLabel: 'Delete', danger: true
    });
    if (!ok) return;
    const r = await App.api('DELETE', `/api/status-pages/${encodeURIComponent(id)}`);
    if (!r.ok) return App.toast(r.json.error || 'Delete failed', 'err');
    S.data.statusPages = pages().filter(x => x.id !== id);
    if (S.page === id) S.page = null;
    App.toast(`Deleted ${p.name}`);
    patchAll(false);
  }

  /* ─── Public preview ─────────────────────────────────────────────────── */
  function previewRowHtml(svc) {
    const st = App.statusOf(svc);
    const hue = App.folderHue(svc);
    const up = App.uptimeFor(svc.id, previewRange);
    const live = parseFloat(svc.uptime);
    const upText = up != null ? App.fmtPct(up, 1) : (isNaN(live) ? '—' : live.toFixed(1) + '%');
    const bars = App.barsHtml(App.bucketsFor(svc.id, previewRange).slice(-20), { minH: 11, maxH: 18, lowH: 7 });
    return `<div class="preview-row">
      <span class="mini-tile" style="background:${App.tint(hue)};color:${App.acc(hue)}">${App.esc(svc.abbr || '?')}</span>
      <span class="mini-name">${App.esc(svc.name)}</span>
      <span class="mini-bars">${bars}</span>
      <span class="mini-uptime" style="color:${App.statusColor(st)}">${App.esc(upText)}</span>
    </div>`;
  }
  function previewHtml(p) {
    if (!p) {
      return `<div class="preview-hdr"><span class="caption">Public preview</span><span class="rule"></span><span class="preview-url">—</span></div>
        <div class="preview-page"><div class="empty preview-empty"><span class="glyph">◎</span>
          <span>${S.loaded ? 'Create a page to preview what visitors will see.' : 'Loading…'}</span></div></div>`;
    }
    const list = publicServices(p);
    const overall = overallOf(list);
    const b = BANNER[overall];
    const meta = S.lastChecked ? App.relTime(S.lastChecked) : 'just now';
    const rows = list.length
      ? `<div class="preview-rows">${list.map(previewRowHtml).join('')}</div>`
      : `<div class="note preview-note">No services on this page yet — click <b>Edit</b> to pick some.</div>`;
    return `<div class="preview-hdr"><span class="caption">Public preview</span><span class="rule"></span>
        <a class="preview-url" href="${App.esc(pageUrl(p))}" target="_blank" rel="noopener" title="Open public page">${App.esc(pageHost(p))}</a></div>
      <div class="preview-page">
        ${p.showOverallBanner === false ? '' : `<div class="banner ${b.cls}">
          <span class="banner-dot"></span>
          <span class="banner-msg">${App.esc(b.msg)}</span>
          <span class="banner-meta" id="preview-meta">${App.esc(meta)}</span>
        </div>`}
        <div class="preview-title">
          <span class="preview-name">${App.esc(p.name || 'Untitled page')}</span>
          ${p.description ? `<span class="preview-blurb">${App.esc(p.description)}</span>` : ''}
        </div>
        ${rows}
        <div class="range-pills">
          ${['24h', '7d', '30d'].map(r => `<button type="button" class="range-pill${previewRange === r ? ' active' : ''}" data-range="${r}">${r}</button>`).join('')}
        </div>
      </div>`;
  }
  function patchPreview() {
    const box = root.querySelector('#preview');
    if (!box) return;
    const p = S.page ? pageById(S.page) : null;
    box.innerHTML = previewHtml(p);
    lastMeta = '';
    box.querySelectorAll('.range-pill').forEach(btn => btn.onclick = () => {
      if (previewRange === btn.dataset.range) return;
      previewRange = btn.dataset.range;
      patchPreview();
    });
  }
  function patchMeta() {
    const el = root?.querySelector('#preview-meta');
    if (!el || !S.lastChecked) return;
    const txt = App.relTime(S.lastChecked);
    if (txt !== lastMeta) { el.textContent = txt; lastMeta = txt; }
  }

  function patchAll(fresh) {
    if (!root || !root.isConnected) return;
    ensureSelection();
    patchHeader();
    patchCards(fresh);
    patchPreview();
  }

  /* ─── Editor modal (create / edit) ───────────────────────────────────── */
  function openEditor(id) {
    const page = id ? pageById(id) : null;
    const isEdit = !!page;
    const sel = new Set(page?.serviceIds || []);
    const reveal = new Set(page?.includedCategoryIds || []);
    const origSlug = page?.slug || '';
    let slugTouched = isEdit;

    const body = `
      <div class="fields">
        <div class="field"><label class="field-lbl" for="sp-name">Name <span>(page title)</span></label>
          <input class="input ui" id="sp-name" maxlength="60" placeholder="Media stack" value="${App.esc(page?.name || '')}"></div>
        <div class="field"><label class="field-lbl" for="sp-slug">Slug <span>(URL path)</span></label>
          <input class="input" id="sp-slug" maxlength="40" placeholder="media" value="${App.esc(page?.slug || '')}" spellcheck="false" autocapitalize="off" autocomplete="off">
          <div class="field-msg" id="sp-slug-msg"></div></div>
        <div class="field wide"><label class="field-lbl" for="sp-desc">Description <span>(optional, up to 280 characters)</span></label>
          <textarea class="input" id="sp-desc" maxlength="280" placeholder="Short summary shown under the banner.">${App.esc(page?.description || '')}</textarea></div>
        <div class="field"><label class="field-lbl" for="sp-vis">Visibility</label>
          <div class="select-wrap"><select class="input ui" id="sp-vis">
            <option value="public">Public</option>
            <option value="private">Private</option>
          </select></div>
          <div class="field-msg" id="sp-vis-msg"></div></div>
      </div>
      <div class="modal-sec"><span class="caption">Services</span><span class="rule"></span><span class="hint" id="sp-count"></span></div>
      <div class="pick-list" id="sp-picker"></div>
      <div class="modal-sec"><span class="caption">Options</span><span class="rule"></span></div>
      <div class="fields">
        ${App.toggleHtml('showOverallBanner', page ? page.showOverallBanner !== false : true, 'Show overall status banner', 'The big "All systems operational" banner at the top')}
        ${App.toggleHtml('showEventLog', page ? page.showEventLog !== false : true, 'Show recent incidents', 'Combined incident log at the bottom of the page')}
      </div>
      <div class="form-msg" id="sp-msg"></div>`;
    const m = App.modal({
      title: isEdit ? 'Edit status page' : 'New status page', cls: 'wide', body,
      foot: `<button class="btn btn-secondary" data-act="cancel">Cancel</button>
             <button class="btn btn-primary" data-act="save">${isEdit ? 'Save changes' : 'Create page'}</button>`
    });
    const B = m.body, q = s => B.querySelector(s);
    App.wireToggles(B);
    q('#sp-vis').value = page?.visibility === 'private' ? 'private' : 'public';

    /* slug + visibility messaging */
    const updateSlugMsg = () => {
      const slug = q('#sp-slug').value.trim().toLowerCase();
      const el = q('#sp-slug-msg');
      const v = validateSlug(slug, page?.id);
      el.classList.remove('ok', 'err', 'warn');
      if (!v.ok) { el.classList.add('err'); el.textContent = v.error; return; }
      const url = `${location.origin}/status/${slug}`;
      if (isEdit && slug !== origSlug) { el.classList.add('warn'); el.textContent = `${url} — changing the slug breaks links you have already shared`; }
      else { el.classList.add('ok'); el.textContent = url; }
    };
    const updateVisMsg = () => {
      q('#sp-vis-msg').textContent = q('#sp-vis').value === 'private'
        ? 'Private pages require a signed-in dashboard session to view.'
        : 'Anyone with the link can view this page. Service URLs and event notes are never shown.';
    };
    q('#sp-name').addEventListener('input', () => {
      if (!slugTouched) q('#sp-slug').value = slugify(q('#sp-name').value);
      updateSlugMsg();
    });
    q('#sp-slug').addEventListener('input', () => { slugTouched = true; updateSlugMsg(); });
    q('#sp-vis').addEventListener('change', updateVisMsg);
    updateSlugMsg(); updateVisMsg();

    /* service picker — grouped by top-level folder, subfolders folded in */
    const groups = [];
    const seen = new Set();
    for (const cat of App.topLevelCats()) {
      const subIds = new Set(App.subCatsOf(cat.id).map(c => c.id));
      const list = App.sortServices(S.data.services.filter(s => s.cat === cat.id || subIds.has(s.cat)));
      list.forEach(s => seen.add(s.id));
      if (list.length) groups.push({ id: cat.id, name: cat.name, hue: App.hueOf(cat.color), list });
    }
    const rest = App.sortServices(S.data.services.filter(s => !seen.has(s.id)));
    if (rest.length) groups.push({ id: '__uncat__', name: 'No folder', hue: null, list: rest });

    const catsIn = list => {
      const ids = [];
      for (const s of list) if (s.cat && App.catFor(s.cat) && !ids.includes(s.cat)) ids.push(s.cat);
      return ids;
    };
    const groupHtml = g => {
      const selected = g.list.filter(s => sel.has(s.id)).length;
      const pip = g.hue == null ? 'var(--paused)' : App.acc(g.hue);
      return `<div class="pick-group" data-group="${App.esc(g.id)}">
        <div class="pick-head">
          <span class="pick-pip" style="background:${pip}"></span>
          <span class="pick-name">${App.esc(g.name)}</span>
          <span class="pick-count" data-count>${selected}/${g.list.length}</span>
        </div>
        ${g.list.map(s => `<label class="pick-item">
          <input type="checkbox" data-svc="${App.esc(s.id)}"${sel.has(s.id) ? ' checked' : ''}>
          <span class="pick-item-name">${App.esc(s.name)}${s.disabled ? ' <span class="pick-flag">disabled · hidden publicly</span>' : ''}</span>
          ${s.abbr ? `<span class="pick-abbr">${App.esc(s.abbr)}</span>` : ''}
        </label>`).join('')}
        ${catsIn(g.list).map(cid => `<label class="pick-item pick-reveal">
          <input type="checkbox" data-reveal="${App.esc(cid)}"${reveal.has(cid) ? ' checked' : ''}>
          <span class="pick-item-name">Reveal folder name "${App.esc(App.catFor(cid).name)}" publicly</span>
        </label>`).join('')}
      </div>`;
    };
    const picker = q('#sp-picker');
    picker.innerHTML = groups.length
      ? groups.map(groupHtml).join('')
      : `<div class="note">No services yet — add some on the <b>Dashboard</b> first, then come back.</div>`;

    const refreshCounts = () => {
      let total = 0;
      picker.querySelectorAll('.pick-group').forEach(gEl => {
        const boxes = [...gEl.querySelectorAll('input[data-svc]')];
        const n = boxes.filter(b => b.checked).length;
        total += n;
        gEl.querySelector('[data-count]').textContent = `${n}/${boxes.length}`;
      });
      q('#sp-count').textContent = `${total} selected`;
      // Reveal toggles only matter for folders that have a selected service.
      picker.querySelectorAll('input[data-reveal]').forEach(inp => {
        const cid = inp.dataset.reveal;
        const has = S.data.services.some(s => s.cat === cid && sel.has(s.id));
        inp.disabled = !has;
        inp.closest('.pick-item').classList.toggle('disabled', !has);
      });
    };
    picker.querySelectorAll('input[data-svc]').forEach(inp => inp.addEventListener('change', () => {
      if (inp.checked) sel.add(inp.dataset.svc); else sel.delete(inp.dataset.svc);
      refreshCounts();
    }));
    picker.querySelectorAll('input[data-reveal]').forEach(inp => inp.addEventListener('change', () => {
      if (inp.checked) reveal.add(inp.dataset.reveal); else reveal.delete(inp.dataset.reveal);
    }));
    refreshCounts();

    /* save */
    const setMsg = t => { q('#sp-msg').textContent = t || ''; };
    m.foot.querySelector('[data-act="cancel"]').onclick = () => m.close();
    m.foot.querySelector('[data-act="save"]').onclick = async () => {
      const name = q('#sp-name').value.trim();
      const slug = q('#sp-slug').value.trim().toLowerCase();
      if (!name) return setMsg('Name is required.');
      const v = validateSlug(slug, page?.id);
      if (!v.ok) return setMsg(v.error);
      const serviceIds = S.data.services.filter(s => sel.has(s.id)).map(s => s.id);
      const includedCategoryIds = [...reveal].filter(cid => S.data.services.some(s => s.cat === cid && sel.has(s.id)));
      const payload = {
        name, slug,
        description: q('#sp-desc').value.trim(),
        serviceIds, includedCategoryIds,
        showOverallBanner: App.toggleValue(B, 'showOverallBanner'),
        showEventLog: App.toggleValue(B, 'showEventLog'),
        visibility: q('#sp-vis').value === 'private' ? 'private' : 'public',
      };
      const btn = m.foot.querySelector('[data-act="save"]');
      btn.disabled = true; setMsg('');
      const r = isEdit
        ? await App.api('PUT', `/api/status-pages/${encodeURIComponent(page.id)}`, payload)
        : await App.api('POST', '/api/status-pages', payload);
      btn.disabled = false;
      if (!r.ok) return setMsg(r.json.error || 'Failed to save the status page.');
      const saved = r.json.page || { ...(page || {}), ...payload, id: page?.id };
      if (!saved.id) return setMsg('Server did not return the saved page.');
      const list = pages();
      const idx = list.findIndex(p => p.id === saved.id);
      if (idx >= 0) list[idx] = { ...list[idx], ...saved }; else list.push(saved);
      S.data.statusPages = list;
      S.page = saved.id;
      m.close();
      App.toast(isEdit ? 'Status page saved' : 'Status page created', 'ok');
      patchAll(false);
    };
    setTimeout(() => q('#sp-name').focus(), 40);
  }

  App.registerScreen('status', {
    title: 'Status pages',
    render,
    onData: fresh => patchAll(fresh),
    onTick: () => { patchMeta(); },
  });
})();
