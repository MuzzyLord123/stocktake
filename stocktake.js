(function(){
  'use strict';

  const STORAGE_KEY_V1 = 'stocktake.v1';
  const STORAGE_KEY = 'stocktake.v2';
  const SCHEMA_VERSION = 2;
  const RECENT_LIMIT = 8;
  const MAX_UNDO = 20;

  // -------- STATE --------
  const DEFAULT_SETTINGS = {
    glove: false,
    contrast: false,
    light: false,
    largeText: false,
    haptic: true,
    voice: false,
    sound: false,
    strictFormat: false,
  };

  const HOWDENS_RE = /^[A-Z]{3}[0-9]{4}$/;
  // Pinned to a specific version so a future release of @zxing/browser
  // can't silently change scanner behavior or ship a compromised build.
  const ZXING_SRC = 'https://unpkg.com/@zxing/browser@0.1.5';

  const state = {
    initials: '',
    entries: [],
    catalogue: {},
    settings: Object.assign({}, DEFAULT_SETTINGS),
    ui: {
      mode: 'out',
      locNum: '',
      locLetter: '',
      tab: 'entry',
      logTime: 'today',
      logLoc: 'all',
      logSearch: '',
      logTotalOpen: false,
      sumGroup: 'location',
      sumTime: 'today',
      sumSearch: '',
    },
    undoStack: [],
    editingId: null,
  };

  // -------- PERSIST --------
  function applyLoadedData(data) {
    state.initials = data.initials || '';
    state.entries = Array.isArray(data.entries) ? data.entries : [];
    state.catalogue = (data.catalogue && typeof data.catalogue === 'object') ? data.catalogue : {};
    if (data.settings && typeof data.settings === 'object') {
      Object.keys(DEFAULT_SETTINGS).forEach(k => {
        if (typeof data.settings[k] === 'boolean') state.settings[k] = data.settings[k];
      });
    }
  }

  function migrateV1(raw) {
    // V1 had no version field; structure already matches V2 minus the new `light` setting.
    const data = JSON.parse(raw);
    return Object.assign({ schema: SCHEMA_VERSION }, data);
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        applyLoadedData(data);
        return;
      }
      // Try migration from v1.
      const legacy = localStorage.getItem(STORAGE_KEY_V1);
      if (legacy) {
        const migrated = migrateV1(legacy);
        applyLoadedData(migrated);
        save();
        try { localStorage.removeItem(STORAGE_KEY_V1); } catch(e) { console.warn('legacy cleanup failed', e); }
      }
    } catch(e) {
      console.warn('load failed', e);
    }
  }
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        schema: SCHEMA_VERSION,
        initials: state.initials,
        entries: state.entries,
        catalogue: state.catalogue,
        settings: state.settings,
      }));
    } catch(e) { console.warn('save failed', e); }
  }

  // -------- UTIL --------
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtDate(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
  }
  function fmtTime(ts) {
    const d = new Date(ts);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  function isToday(ts) {
    const d = new Date(ts);
    const n = new Date();
    return d.getFullYear() === n.getFullYear()
      && d.getMonth() === n.getMonth()
      && d.getDate() === n.getDate();
  }
  function escapeCSV(v) {
    if (v == null) return '';
    let s = String(v);
    // CSV-injection guard: a cell that starts with =, +, -, @, tab or CR
    // will be evaluated as a formula by Excel/Sheets when the export is opened.
    if (s.length && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  // -------- TOAST --------
  function toast(msg, kind) {
    const wrap = document.getElementById('toastWrap');
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(() => {
      el.classList.add('fade');
      setTimeout(() => el.remove(), 300);
    }, 1900);
  }

  // -------- LOCATION --------
  function getCurrentLoc() {
    const num = state.ui.locNum;
    const letter = state.ui.locLetter;
    if (!num || !letter) return '';
    return 'W' + pad2(num) + letter;
  }
  function setLocFromString(loc) {
    const m = /^W(\d{1,2})([ABC])$/.exec(loc.toUpperCase());
    if (!m) return false;
    state.ui.locNum = String(parseInt(m[1], 10));
    state.ui.locLetter = m[2];
    document.getElementById('locNum').value = state.ui.locNum;
    renderLocation();
    return true;
  }

  function renderLocation() {
    document.querySelectorAll('.loc-letter').forEach(b => {
      b.classList.toggle('active', b.dataset.letter === state.ui.locLetter);
    });
    const cur = getCurrentLoc();
    document.getElementById('locDisplay').textContent = cur || '—';
  }

  // -------- RECENTS --------
  function recentLocations() {
    const seen = new Set();
    const out = [];
    for (let i = state.entries.length - 1; i >= 0; i--) {
      const loc = state.entries[i].location;
      if (loc && !seen.has(loc)) {
        seen.add(loc);
        out.push(loc);
        if (out.length >= RECENT_LIMIT) break;
      }
    }
    return out;
  }
  function recentCodes() {
    const seen = new Set();
    const out = [];
    for (let i = state.entries.length - 1; i >= 0; i--) {
      const c = state.entries[i].code;
      if (c && !seen.has(c)) {
        seen.add(c);
        out.push(c);
        if (out.length >= RECENT_LIMIT) break;
      }
    }
    return out;
  }
  function renderChips() {
    const locWrap = document.getElementById('recentLocs');
    const codeWrap = document.getElementById('recentCodes');
    const locs = recentLocations();
    const codes = recentCodes();
    locWrap.innerHTML = '';
    codeWrap.innerHTML = '';
    if (!locs.length) {
      locWrap.innerHTML = '<span class="chips-empty">no recent locations</span>';
    } else {
      locs.forEach(l => {
        const c = document.createElement('button');
        c.className = 'chip';
        c.type = 'button';
        c.textContent = l;
        c.setAttribute('aria-label', 'Use recent location ' + l);
        c.onclick = () => { setLocFromString(l); };
        locWrap.appendChild(c);
      });
    }
    if (!codes.length) {
      codeWrap.innerHTML = '<span class="chips-empty">no recent codes</span>';
    } else {
      codes.forEach(c => {
        const b = document.createElement('button');
        b.className = 'chip';
        b.type = 'button';
        b.textContent = c;
        b.setAttribute('aria-label', 'Use recent code ' + c);
        b.onclick = () => {
          document.getElementById('codeInput').value = c;
          document.getElementById('codeInput').focus();
        };
        codeWrap.appendChild(b);
      });
    }
  }

  // -------- STATS --------
  function renderStats() {
    let inSum = 0, outSum = 0, count = 0;
    state.entries.forEach(e => {
      if (!isToday(e.timestamp)) return;
      count++;
      if (e.action === 'in') inSum += e.qty;
      else outSum += e.qty;
    });
    document.getElementById('statOut').textContent = outSum;
    document.getElementById('statIn').textContent = inSum;
    document.getElementById('statEntries').textContent = count;
  }

  // -------- LOG --------
  function filteredEntries() {
    const q = state.ui.logSearch.trim().toLowerCase();
    const curLoc = getCurrentLoc();
    return state.entries
      .slice()
      .reverse()
      .filter(e => {
        if (state.ui.logTime === 'today' && !isToday(e.timestamp)) return false;
        if (state.ui.logLoc === 'this' && curLoc && e.location !== curLoc) return false;
        if (state.ui.logLoc === 'this' && !curLoc) return false;
        if (q) {
          const desc = e.description || state.catalogue[e.code] || '';
          const hay = (e.code + ' ' + e.location + ' ' + (e.note||'') + ' ' + (e.initials||'') + ' ' + desc).toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
  }

  function renderLogTotal(items) {
    const bar = document.getElementById('logTotal');
    const btn = document.getElementById('totalBtn');
    if (!state.ui.logTotalOpen) {
      bar.classList.remove('visible');
      btn.textContent = 'SHOW TOTAL';
      return;
    }
    bar.classList.add('visible');
    btn.textContent = 'HIDE TOTAL';
    let inSum = 0, outSum = 0;
    items.forEach(e => { if (e.action === 'in') inSum += e.qty; else outSum += e.qty; });
    const net = inSum - outSum;
    document.getElementById('ltIn').textContent = '+' + inSum;
    document.getElementById('ltOut').textContent = '−' + outSum;
    const netEl = document.getElementById('ltNet');
    netEl.textContent = (net > 0 ? '+' : '') + net;
    netEl.className = 'lt-val ' + (net > 0 ? 'pos' : net < 0 ? 'neg' : 'zero');
    document.getElementById('ltCount').textContent = items.length;
    const parts = [];
    parts.push(state.ui.logTime === 'today' ? 'TODAY' : 'ALL TIME');
    if (state.ui.logLoc === 'this') {
      const cur = getCurrentLoc();
      parts.push(cur ? '@ ' + cur : '@ NO LOCATION');
    } else {
      parts.push('ALL LOCATIONS');
    }
    if (state.ui.logSearch.trim()) parts.push('"' + state.ui.logSearch.trim() + '"');
    document.getElementById('ltScope').textContent = parts.join(' · ');
  }

  function renderLog() {
    const list = document.getElementById('logList');
    const items = filteredEntries();
    renderLogTotal(items);
    list.innerHTML = '';
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-log';
      empty.textContent = state.entries.length === 0 ? 'NO ENTRIES YET' : 'NO MATCHES';
      list.appendChild(empty);
      return;
    }
    if (state.ui.logTotalOpen) {
      renderGroupedItems(items, list);
    } else {
      items.forEach(e => {
        const item = document.createElement('div');
        item.className = 'log-item ' + e.action;
        item.setAttribute('role', 'button');
        item.setAttribute('tabindex', '0');
        item.setAttribute('aria-label', `${e.action === 'in' ? 'Added' : 'Took'} ${e.qty} of ${e.code} at ${e.location}. Tap to edit.`);
        const fmtBadge = e.unusualFormat ? ` <span class="badge fmt" title="Non-standard format">FORMAT</span>` : '';
        const badge = (e.unknown ? ` <span class="badge cat">NOT IN CAT</span>` : '') + fmtBadge;
        const desc = e.description || (state.catalogue[e.code] || '');
        const metaParts = [`${fmtTime(e.timestamp)} · ${e.initials || '—'}`];
        if (desc) metaParts.push(`<span class="desc">${escapeHtml(desc)}</span>`);
        if (e.note) metaParts.push(`<span class="note">${escapeHtml(e.note)}</span>`);
        item.innerHTML = `
          <div class="log-action">${e.action === 'in' ? '+' : '−'}</div>
          <div class="log-main">
            <div class="log-line1">
              <span class="log-loc">${escapeHtml(e.location)}</span>
              <span class="log-code">${escapeHtml(e.code)}${badge}</span>
            </div>
            <div class="log-line2">${metaParts.join(' · ')}</div>
          </div>
          <div class="log-qty">${e.action === 'in' ? '+' : '−'}${e.qty}</div>
        `;
        item.onclick = () => openEdit(e.id);
        item.onkeydown = (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openEdit(e.id); }
        };
        list.appendChild(item);
      });
    }
  }

  function renderGroupedItems(items, list) {
    const groups = new Map();
    items.forEach(e => {
      if (!e.code) return;
      let g = groups.get(e.code);
      if (!g) { g = { code: e.code, in: 0, out: 0, locs: new Set(), count: 0, lastTs: 0 }; groups.set(e.code, g); }
      if (e.action === 'in') g.in += e.qty; else g.out += e.qty;
      g.locs.add(e.location);
      g.count++;
      if (e.timestamp > g.lastTs) g.lastTs = e.timestamp;
    });
    const arr = Array.from(groups.values()).sort((a, b) => b.lastTs - a.lastTs);
    arr.forEach(g => {
      const net = g.in - g.out;
      const cls = net > 0 ? 'in' : net < 0 ? 'out' : '';
      const sign = net > 0 ? '+' : net < 0 ? '−' : '';
      const locs = Array.from(g.locs);
      const locStr = locs.length === 1 ? locs[0] : locs.length + ' LOCS';
      const meta = `${g.count} ENTR${g.count === 1 ? 'Y' : 'IES'} · IN +${g.in} · OUT −${g.out}`;
      const item = document.createElement('div');
      item.className = 'log-item ' + cls;
      item.innerHTML = `
        <div class="log-action">∑</div>
        <div class="log-main">
          <div class="log-line1">
            <span class="log-loc">${escapeHtml(locStr)}</span>
            <span class="log-code">${escapeHtml(g.code)}</span>
          </div>
          <div class="log-line2">${meta}</div>
        </div>
        <div class="log-qty">${sign}${Math.abs(net)}</div>
      `;
      item.onclick = () => {
        document.getElementById('logSearch').value = g.code;
        state.ui.logSearch = g.code;
        state.ui.logTotalOpen = false;
        renderLog();
      };
      list.appendChild(item);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }

  // -------- SUMMARY --------
  function renderSummary() {
    const list = document.getElementById('groupList');
    const groupBy = state.ui.sumGroup;
    const onlyToday = state.ui.sumTime === 'today';
    const q = state.ui.sumSearch.trim().toLowerCase();

    const groups = new Map();
    state.entries.forEach(e => {
      if (onlyToday && !isToday(e.timestamp)) return;
      const key = groupBy === 'location' ? e.location : e.code;
      if (!key) return;
      if (q && !key.toLowerCase().includes(q)) return;
      let g = groups.get(key);
      if (!g) { g = { key, in: 0, out: 0 }; groups.set(key, g); }
      if (e.action === 'in') g.in += e.qty; else g.out += e.qty;
    });

    const arr = Array.from(groups.values());
    arr.sort((a, b) => {
      const na = (b.in + b.out) - (a.in + a.out);
      if (na !== 0) return na;
      return a.key.localeCompare(b.key);
    });

    list.innerHTML = '';
    if (!arr.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-log';
      empty.textContent = 'NO DATA';
      list.appendChild(empty);
      return;
    }

    arr.forEach(g => {
      const net = g.in - g.out;
      const cls = net > 0 ? 'pos' : net < 0 ? 'neg' : 'zero';
      const sign = net > 0 ? '+' : '';
      const item = document.createElement('div');
      item.className = 'group-item';
      item.innerHTML = `
        <div class="group-key">${escapeHtml(g.key)}</div>
        <div class="group-stat in"><span class="lbl">IN</span><span class="val">+${g.in}</span></div>
        <div class="group-stat out"><span class="lbl">OUT</span><span class="val">−${g.out}</span></div>
        <div class="group-stat net"><span class="lbl">NET</span><span class="val ${cls}">${sign}${net}</span></div>
      `;
      list.appendChild(item);
    });
  }

  // -------- RENDER ALL --------
  function renderAll() {
    renderStats();
    renderChips();
    renderLog();
    renderSummary();
    renderInitials();
    renderUndoBar();
  }

  function renderInitials() {
    const sub = document.getElementById('brandSub');
    if (state.initials) {
      sub.textContent = 'WAREHOUSE LOG // ' + state.initials;
      sub.style.color = '';
    } else {
      sub.textContent = 'WAREHOUSE LOG // SET INITIALS →';
      sub.style.color = 'var(--amber)';
    }
  }

  // -------- SETTINGS --------
  function applySettings() {
    const b = document.body;
    b.classList.toggle('glove', state.settings.glove);
    b.classList.toggle('contrast', state.settings.contrast);
    // Light theme is suppressed when high-contrast is on, since contrast forces black bg.
    b.classList.toggle('light', state.settings.light && !state.settings.contrast);
    b.classList.toggle('large-text', state.settings.largeText);
    b.classList.toggle('voice-on', state.settings.voice && voiceSupported);
    document.querySelectorAll('#settingsGroup .toggle').forEach(t => {
      const k = t.dataset.key;
      t.setAttribute('aria-pressed', state.settings[k] ? 'true' : 'false');
    });
    if (state.settings.voice && !voiceSupported) {
      // can't enable, silently revert
      state.settings.voice = false;
    }
    // Theme-color meta keeps PWA chrome in sync with the active theme.
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      const usingLight = state.settings.light && !state.settings.contrast;
      meta.setAttribute('content', usingLight ? '#f7f7f8' : '#0e1116');
    }
  }
  function setSetting(key, val) {
    state.settings[key] = !!val;
    save();
    applySettings();
  }
  function openSettings() {
    const inp = document.getElementById('settingsInitials');
    inp.value = state.initials || '';
    updateInitStatus();
    updateCatStatus();
    openModal('settingsModal');
    if (!state.initials) setTimeout(() => inp.focus(), 80);
  }
  function updateInitStatus() {
    const el = document.getElementById('initStatus');
    const v = (document.getElementById('settingsInitials').value || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (!v) { el.textContent = state.initials ? '' : 'REQUIRED — TAGGED ON EVERY ENTRY'; el.className = 'init-status warn'; return; }
    if (v.length < 2 || v.length > 6) { el.textContent = 'NEED 2-6 LETTERS'; el.className = 'init-status warn'; return; }
    el.textContent = 'SAVED'; el.className = 'init-status ok';
  }

  // -------- HAPTIC / SOUND --------
  function vibrate(pattern, opts) {
    if (!(opts && opts.force) && !state.settings.haptic) return;
    if (navigator.vibrate) {
      try { navigator.vibrate(pattern); }
      catch(e) { console.warn('vibrate failed', e); }
    }
  }
  let audioCtx = null;
  function beep(freq, durMs, opts) {
    if (!(opts && opts.force) && !state.settings.sound) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const t = audioCtx.currentTime;
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = freq || 880;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.32, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (durMs || 120) / 1000);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t);
      o.stop(t + (durMs || 120) / 1000 + 0.02);
    } catch(e) { console.warn('beep failed', e); }
  }

  // -------- VOICE --------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const voiceSupported = !!SR;
  let recognition = null;
  let listening = false;
  function setupRecognition() {
    if (!voiceSupported) return;
    recognition = new SR();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.continuous = false;
    recognition.onresult = (e) => {
      const transcript = (e.results[0][0].transcript || '').trim();
      const code = transcript.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const inp = document.getElementById('codeInput');
      if (code) {
        inp.value = code;
        toast('HEARD: ' + code, 'in');
      } else {
        toast('NO CODE HEARD', 'warn');
      }
    };
    recognition.onerror = (e) => {
      stopVoice();
      if (e.error !== 'aborted' && e.error !== 'no-speech') toast('VOICE ERROR', 'warn');
    };
    recognition.onend = () => stopVoice();
  }
  function startVoice() {
    if (!recognition) return;
    if (listening) { stopVoice(); return; }
    try {
      recognition.start();
      listening = true;
      document.getElementById('micBtn').classList.add('listening');
      document.getElementById('voiceOverlay').classList.add('active');
    } catch(e) {
      console.warn('voice start failed', e);
      stopVoice();
    }
  }
  function stopVoice() {
    listening = false;
    if (recognition) {
      try { recognition.abort(); }
      catch(e) { console.warn('voice stop failed', e); }
    }
    document.getElementById('micBtn').classList.remove('listening');
    document.getElementById('voiceOverlay').classList.remove('active');
  }

  // -------- NETWORK STATUS --------
  function updateNetStatus() {
    const el = document.getElementById('netStatus');
    if (navigator.onLine) {
      el.classList.remove('offline');
      el.title = 'Online';
    } else {
      el.classList.add('offline');
      el.title = 'Offline — entries still save locally';
    }
  }

  // -------- UNDO STACK --------
  function pushUndo(record) {
    state.undoStack.push(record);
    if (state.undoStack.length > MAX_UNDO) state.undoStack.shift();
  }

  function undoLast() {
    const rec = state.undoStack.pop();
    if (!rec) {
      toast('NOTHING TO UNDO', 'warn');
      return;
    }
    if (rec.type === 'add') {
      const idx = state.entries.findIndex(e => e.id === rec.id);
      if (idx !== -1) state.entries.splice(idx, 1);
      toast('UNDO: ADD', 'warn');
    } else if (rec.type === 'edit') {
      const idx = state.entries.findIndex(e => e.id === rec.before.id);
      if (idx !== -1) state.entries[idx] = rec.before;
      toast('UNDO: EDIT', 'warn');
    } else if (rec.type === 'delete') {
      // Re-insert at original index if possible, otherwise append.
      const arr = state.entries;
      const at = Math.min(rec.index, arr.length);
      arr.splice(at, 0, rec.entry);
      toast('UNDO: DELETE', 'warn');
    }
    save();
    renderAll();
  }

  function describeUndo(rec) {
    if (!rec) return '';
    if (rec.type === 'add') {
      const sign = rec.action === 'in' ? '+' : '−';
      return `Last: <strong>${escapeHtml(sign + rec.qty + ' ' + rec.code)}</strong> @ ${escapeHtml(rec.location)}`;
    }
    if (rec.type === 'edit') return `Last: edit ${escapeHtml(rec.before.code)} @ ${escapeHtml(rec.before.location)}`;
    if (rec.type === 'delete') return `Last: delete ${escapeHtml(rec.entry.code)} @ ${escapeHtml(rec.entry.location)}`;
    return '';
  }

  function renderUndoBar() {
    const bar = document.getElementById('undoBar');
    const txt = document.getElementById('undoText');
    const top = state.undoStack[state.undoStack.length - 1];
    if (!top) {
      bar.classList.remove('visible');
      return;
    }
    const count = state.undoStack.length;
    const tail = count > 1 ? `<span class="undo-count" title="${count} undo steps available">${count}</span>` : '';
    txt.innerHTML = describeUndo(top) + tail;
    bar.classList.add('visible');
  }

  // -------- SUBMIT --------
  function rejectFeedback(msg, focusEl, select) {
    toast(msg, 'warn');
    vibrate([100, 50, 100]);
    if (focusEl) {
      focusEl.focus();
      if (select && focusEl.select) focusEl.select();
    }
  }

  function submitEntry(opts) {
    opts = opts || {};
    const codeInput = document.getElementById('codeInput');
    const qtyInput = document.getElementById('qtyInput');
    const noteInput = document.getElementById('notesInput');

    if (!state.initials) {
      rejectFeedback('SET INITIALS FIRST');
      openSettings();
      return null;
    }
    const loc = getCurrentLoc();
    if (!loc) { rejectFeedback('PICK A LOCATION'); return null; }

    const code = ((opts.code != null ? opts.code : codeInput.value) || '').trim().toUpperCase();
    if (!code) { rejectFeedback('ENTER A CODE', codeInput); return null; }

    const formatOk = HOWDENS_RE.test(code);
    if (!formatOk && state.settings.strictFormat) {
      rejectFeedback('REJECTED — NEEDS LLLDDDD FORMAT', codeInput, true);
      return null;
    }

    const qty = Math.max(1, parseInt(opts.qty != null ? opts.qty : qtyInput.value, 10) || 1);
    const note = ((opts.note != null ? opts.note : noteInput.value) || '').trim();

    const catalogueLoaded = catalogueCount() > 0;
    const inCat = Object.prototype.hasOwnProperty.call(state.catalogue, code);
    const description = inCat ? (state.catalogue[code] || '') : '';
    const unknown = catalogueLoaded && !inCat;
    const unusualFormat = !formatOk;
    const isIn = state.ui.mode === 'in';

    const entry = {
      id: uid(),
      timestamp: Date.now(),
      initials: state.initials,
      action: state.ui.mode,
      location: loc,
      code,
      qty,
      note,
      description,
      unknown,
      unusualFormat,
    };
    state.entries.push(entry);
    save();

    pushUndo({ type: 'add', id: entry.id, action: entry.action, qty, code, location: loc });

    codeInput.value = '';
    qtyInput.value = '1';
    noteInput.value = '';
    document.getElementById('notesArea').classList.remove('open');
    document.getElementById('notesToggle').textContent = '+ ADD NOTE';

    if (unusualFormat) toast('LOGGED — UNUSUAL FORMAT, DOUBLE-CHECK', 'warn');
    else if (unknown) toast('LOGGED — CODE NOT IN CATALOGUE', 'warn');
    else toast(`${isIn ? 'ADDED' : 'TOOK'} ${qty}× ${code} @ ${loc}`, entry.action);

    vibrate(50);
    beep(isIn ? 1040 : 660, 110);

    document.getElementById('suggestions').classList.remove('open');
    renderAll();
    codeInput.focus();
    return entry;
  }

  // -------- EDIT --------
  function openEdit(id) {
    const e = state.entries.find(x => x.id === id);
    if (!e) return;
    state.editingId = id;
    document.getElementById('editLoc').value = e.location;
    document.getElementById('editCode').value = e.code;
    document.getElementById('editQty').value = e.qty;
    document.getElementById('editNote').value = e.note || '';
    document.querySelectorAll('#editAction .action-select-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.a === e.action);
    });
    openModal('editModal');
  }

  function saveEdit() {
    const idx = state.entries.findIndex(x => x.id === state.editingId);
    if (idx === -1) return;
    const e = state.entries[idx];
    const action = document.querySelector('#editAction .action-select-btn.active').dataset.a;
    const loc = document.getElementById('editLoc').value.trim().toUpperCase();
    const code = document.getElementById('editCode').value.trim().toUpperCase();
    const qty = Math.max(1, parseInt(document.getElementById('editQty').value, 10) || 1);
    const note = document.getElementById('editNote').value.trim();
    if (!loc || !code) { toast('LOC AND CODE REQUIRED', 'warn'); return; }
    const before = JSON.parse(JSON.stringify(e));
    e.action = action;
    e.location = loc;
    e.code = code;
    e.qty = qty;
    e.note = note;
    e.unusualFormat = !HOWDENS_RE.test(code);
    if (catalogueCount() > 0) {
      const inCat = Object.prototype.hasOwnProperty.call(state.catalogue, code);
      e.description = inCat ? (state.catalogue[code] || '') : '';
      e.unknown = !inCat;
    }
    pushUndo({ type: 'edit', before });
    save();
    closeAllModals();
    toast('UPDATED', 'in');
    renderAll();
  }

  function deleteEdit() {
    const idx = state.entries.findIndex(x => x.id === state.editingId);
    if (idx === -1) return;
    const removed = state.entries[idx];
    state.entries.splice(idx, 1);
    pushUndo({ type: 'delete', index: idx, entry: removed });
    save();
    closeAllModals();
    toast('DELETED', 'out');
    renderAll();
  }

  // -------- MODALS --------
  function openModal(id) {
    document.getElementById(id).classList.add('open');
  }
  function anyModalOpen() {
    return !!document.querySelector('.modal-backdrop.open');
  }
  function closeAllModals() {
    document.querySelectorAll('.modal-backdrop').forEach(m => m.classList.remove('open'));
    state.editingId = null;
  }

  // -------- EXPORT --------
  function downloadCSV(filename, content) {
    const blob = new Blob(['﻿' + content], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
  }

  function exportDetailed() {
    const rows = [['date','time','initials','location','action','code','description','quantity','note','in_catalogue']];
    state.entries.forEach(e => {
      const desc = e.description || (state.catalogue[e.code] || '');
      const inCat = Object.prototype.hasOwnProperty.call(state.catalogue, e.code);
      rows.push([
        fmtDate(e.timestamp),
        fmtTime(e.timestamp),
        e.initials || '',
        e.location,
        e.action,
        e.code,
        desc,
        e.qty,
        e.note || '',
        catalogueCount() > 0 ? (inCat ? 'yes' : 'no') : '',
      ]);
    });
    const csv = rows.map(r => r.map(escapeCSV).join(',')).join('\r\n');
    const stamp = fmtDate(Date.now()) + '_' + fmtTime(Date.now()).replace(':','');
    downloadCSV(`stocktake_detail_${stamp}.csv`, csv);
    closeAllModals();
    toast('CSV EXPORTED', 'in');
  }

  function exportSummaryCSV() {
    const byLoc = new Map();
    const byCode = new Map();
    state.entries.forEach(e => {
      const lk = e.location;
      const ck = e.code;
      if (lk) {
        let g = byLoc.get(lk); if (!g) { g = {in:0,out:0}; byLoc.set(lk,g); }
        if (e.action === 'in') g.in += e.qty; else g.out += e.qty;
      }
      if (ck) {
        let g = byCode.get(ck); if (!g) { g = {in:0,out:0}; byCode.set(ck,g); }
        if (e.action === 'in') g.in += e.qty; else g.out += e.qty;
      }
    });
    const rows = [['group_type','key','in','out','net']];
    Array.from(byLoc.entries()).sort((a,b)=>a[0].localeCompare(b[0])).forEach(([k,g]) => {
      rows.push(['location', k, g.in, g.out, g.in - g.out]);
    });
    Array.from(byCode.entries()).sort((a,b)=>a[0].localeCompare(b[0])).forEach(([k,g]) => {
      rows.push(['code', k, g.in, g.out, g.in - g.out]);
    });
    const csv = rows.map(r => r.map(escapeCSV).join(',')).join('\r\n');
    const stamp = fmtDate(Date.now()) + '_' + fmtTime(Date.now()).replace(':','');
    downloadCSV(`stocktake_summary_${stamp}.csv`, csv);
    closeAllModals();
    toast('CSV EXPORTED', 'in');
  }

  // -------- BIND --------
  function bind() {
    // Tabs
    document.querySelectorAll('.tab').forEach(t => {
      t.onclick = () => {
        const tab = t.dataset.tab;
        state.ui.tab = tab;
        document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
        document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + tab));
      };
    });

    // Mode toggle
    document.querySelectorAll('.mode-btn').forEach(b => {
      b.onclick = () => {
        state.ui.mode = b.dataset.mode;
        const tog = document.getElementById('modeToggle');
        tog.classList.toggle('out', state.ui.mode === 'out');
        tog.classList.toggle('in', state.ui.mode === 'in');
        const sb = document.getElementById('submitBtn');
        sb.classList.toggle('out', state.ui.mode === 'out');
        sb.classList.toggle('in', state.ui.mode === 'in');
        sb.textContent = state.ui.mode === 'out' ? 'LOG TAKE-OUT' : 'LOG ADD-IN';
      };
    });

    // Location number
    const locNum = document.getElementById('locNum');
    locNum.oninput = () => {
      let v = locNum.value.replace(/\D/g, '').slice(0, 2);
      if (v) {
        let n = parseInt(v, 10);
        if (n > 99) n = 99;
        if (n < 1 && v.length === 2) n = 1;
        v = n ? String(n) : '';
      }
      locNum.value = v;
      state.ui.locNum = v;
      renderLocation();
    };
    locNum.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('codeInput').focus();
      }
    };

    // Letters
    document.querySelectorAll('.loc-letter').forEach(b => {
      b.setAttribute('aria-label', 'Location row ' + b.dataset.letter);
      b.onclick = () => {
        state.ui.locLetter = b.dataset.letter;
        renderLocation();
        if (!document.getElementById('codeInput').value) {
          document.getElementById('codeInput').focus();
        }
      };
    });

    // Code input
    const codeInput = document.getElementById('codeInput');
    codeInput.oninput = () => {
      const start = codeInput.selectionStart;
      codeInput.value = codeInput.value.toUpperCase();
      try { codeInput.setSelectionRange(start, start); }
      catch(e) { /* old browsers — caret position is non-essential */ }
      renderSuggestions();
    };
    codeInput.onkeydown = (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSuggestion(1); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); moveSuggestion(-1); return; }
      if (e.key === 'Escape')    { document.getElementById('suggestions').classList.remove('open'); return; }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (suggestionFocus >= 0 && suggestionList[suggestionFocus]) {
          codeInput.value = suggestionList[suggestionFocus];
          document.getElementById('suggestions').classList.remove('open');
          return;
        }
        submitEntry();
      }
    };
    codeInput.onfocus = () => renderSuggestions();
    codeInput.onblur = () => {
      setTimeout(() => document.getElementById('suggestions').classList.remove('open'), 180);
    };

    // Catalogue — open import modal
    document.getElementById('catImportBtn').onclick = () => {
      document.getElementById('catFile').value = '';
      document.getElementById('catFileName').textContent = '';
      document.getElementById('catPaste').value = '';
      document.getElementById('catPreview').classList.remove('show');
      openModal('catImportModal');
    };

    // File picker
    document.getElementById('catFile').onchange = (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result || '');
        document.getElementById('catPaste').value = text;
        document.getElementById('catFileName').textContent = file.name;
        previewCatalogueText(text);
      };
      reader.onerror = () => toast('FILE READ FAILED', 'warn');
      reader.readAsText(file);
    };

    // Paste preview
    document.getElementById('catPaste').oninput = (e) => {
      previewCatalogueText(e.target.value);
    };

    // Import save
    document.getElementById('catImportSave').onclick = () => {
      const text = document.getElementById('catPaste').value;
      commitCatalogue(text);
    };

    // Clear catalogue (two-tap confirm)
    let catClearPrimed = false;
    let catClearTimer = null;
    const catClearBtn = document.getElementById('catClearBtn');
    catClearBtn.onclick = () => {
      if (catalogueCount() === 0) return;
      if (!catClearPrimed) {
        catClearPrimed = true;
        catClearBtn.textContent = 'TAP AGAIN';
        catClearBtn.classList.add('priming');
        clearTimeout(catClearTimer);
        catClearTimer = setTimeout(() => {
          catClearPrimed = false;
          catClearBtn.textContent = 'CLEAR';
          catClearBtn.classList.remove('priming');
        }, 2500);
        return;
      }
      clearTimeout(catClearTimer);
      catClearPrimed = false;
      state.catalogue = {};
      invalidateCatalogueCache();
      save();
      updateCatStatus();
      catClearBtn.textContent = 'CLEAR';
      catClearBtn.classList.remove('priming');
      toast('CATALOGUE CLEARED', 'warn');
      renderLog();
    };

    // Qty
    const qtyInput = document.getElementById('qtyInput');
    document.getElementById('qtyMinus').onclick = () => {
      const v = Math.max(1, (parseInt(qtyInput.value,10) || 1) - 1);
      qtyInput.value = v;
    };
    document.getElementById('qtyPlus').onclick = () => {
      const v = Math.max(1, (parseInt(qtyInput.value,10) || 1) + 1);
      qtyInput.value = v;
    };

    // Notes
    document.getElementById('notesToggle').onclick = () => {
      const a = document.getElementById('notesArea');
      const t = document.getElementById('notesToggle');
      a.classList.toggle('open');
      t.textContent = a.classList.contains('open') ? '− HIDE NOTE' : '+ ADD NOTE';
      if (a.classList.contains('open')) document.getElementById('notesInput').focus();
    };

    // Submit
    document.getElementById('submitBtn').onclick = submitEntry;

    // Undo
    document.getElementById('undoBtn').onclick = undoLast;

    // Settings (gear)
    document.getElementById('settingsBtn').onclick = openSettings;

    // Initials field inside settings — autosave
    const initInput = document.getElementById('settingsInitials');
    initInput.oninput = () => {
      const cleaned = initInput.value.toUpperCase().replace(/[^A-Z]/g, '');
      if (cleaned !== initInput.value) initInput.value = cleaned;
      if (cleaned.length >= 2 && cleaned.length <= 6) {
        state.initials = cleaned;
        save();
        renderInitials();
      } else if (!cleaned) {
        // allow clearing while typing; don't wipe persisted initials
      }
      updateInitStatus();
    };

    // Setting toggles
    document.querySelectorAll('#settingsGroup .toggle').forEach(t => {
      t.onclick = () => {
        const key = t.dataset.key;
        if (key === 'voice' && !voiceSupported && !state.settings.voice) {
          toast('VOICE NOT SUPPORTED', 'warn');
          return;
        }
        // Light and contrast can't both be on at once — user toggling either off-flips the other.
        if (key === 'light' && !state.settings.light && state.settings.contrast) {
          state.settings.contrast = false;
        }
        if (key === 'contrast' && !state.settings.contrast && state.settings.light) {
          state.settings.light = false;
        }
        setSetting(key, !state.settings[key]);
        if (key === 'sound' && state.settings.sound) beep(880, 90);
        if (key === 'haptic' && state.settings.haptic) vibrate(40);
      };
    });

    // Mic button
    document.getElementById('micBtn').onclick = startVoice;

    // Scan button
    document.getElementById('scanBtn').onclick = openScanner;
    document.getElementById('scannerClose').onclick = closeScanner;
    document.getElementById('scannerTorch').onclick = toggleTorch;
    document.getElementById('scannerContinuous').onclick = () => {
      scanner.continuous = !scanner.continuous;
      const btn = document.getElementById('scannerContinuous');
      btn.setAttribute('aria-pressed', scanner.continuous ? 'true' : 'false');
      updateScanCounter();
      if (!scanner.continuous) scanner.count = 0;
    };

    // Log filters
    document.querySelectorAll('#filterTime .filter-btn').forEach(b => {
      b.onclick = () => {
        document.querySelectorAll('#filterTime .filter-btn').forEach(x => x.classList.toggle('active', x === b));
        state.ui.logTime = b.dataset.f;
        renderLog();
      };
    });
    document.querySelectorAll('#filterLoc .filter-btn').forEach(b => {
      b.onclick = () => {
        document.querySelectorAll('#filterLoc .filter-btn').forEach(x => x.classList.toggle('active', x === b));
        state.ui.logLoc = b.dataset.f;
        renderLog();
      };
    });
    document.getElementById('logSearch').oninput = (e) => {
      state.ui.logSearch = e.target.value;
      renderLog();
    };
    document.getElementById('totalBtn').onclick = () => {
      state.ui.logTotalOpen = !state.ui.logTotalOpen;
      renderLog();
    };

    // Summary controls
    document.querySelectorAll('#sumGroup .filter-btn').forEach(b => {
      b.onclick = () => {
        document.querySelectorAll('#sumGroup .filter-btn').forEach(x => x.classList.toggle('active', x === b));
        state.ui.sumGroup = b.dataset.g;
        renderSummary();
      };
    });
    document.querySelectorAll('#sumTime .filter-btn').forEach(b => {
      b.onclick = () => {
        document.querySelectorAll('#sumTime .filter-btn').forEach(x => x.classList.toggle('active', x === b));
        state.ui.sumTime = b.dataset.f;
        renderSummary();
      };
    });
    document.getElementById('sumSearch').oninput = (e) => {
      state.ui.sumSearch = e.target.value;
      renderSummary();
    };

    // Edit modal
    document.querySelectorAll('#editAction .action-select-btn').forEach(b => {
      b.onclick = () => {
        document.querySelectorAll('#editAction .action-select-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
      };
    });
    document.getElementById('editSave').onclick = saveEdit;
    document.getElementById('editDelete').onclick = deleteEdit;

    // Export
    document.getElementById('exportBtn').onclick = () => {
      if (!state.entries.length) { toast('NOTHING TO EXPORT', 'warn'); return; }
      openModal('exportModal');
    };
    document.getElementById('exportDetail').onclick = exportDetailed;
    document.getElementById('exportSummary').onclick = exportSummaryCSV;

    // Clear
    const clearInput = document.getElementById('clearConfirmInput');
    const clearConfirmBtn = document.getElementById('clearConfirm');

    document.getElementById('clearBtn').onclick = () => {
      document.getElementById('clearCount').textContent = state.entries.length;
      clearInput.value = '';
      clearConfirmBtn.disabled = true;
      openModal('clearModal');
      setTimeout(() => clearInput.focus(), 80);
    };

    clearInput.oninput = () => {
      clearInput.value = clearInput.value.toUpperCase();
      clearConfirmBtn.disabled = clearInput.value.trim() !== 'DELETE';
    };
    clearInput.onkeydown = (e) => {
      if (e.key === 'Enter' && !clearConfirmBtn.disabled) {
        e.preventDefault();
        clearConfirmBtn.click();
      }
    };

    clearConfirmBtn.onclick = () => {
      if (clearInput.value.trim() !== 'DELETE') return;
      state.entries = [];
      state.initials = '';
      state.catalogue = {};
      state.undoStack = [];
      invalidateCatalogueCache();
      save();
      closeAllModals();
      toast('CLEARED', 'warn');
      renderAll();
      updateCatStatus();
    };

    // Modal backdrops
    document.querySelectorAll('.modal-backdrop').forEach(m => {
      m.addEventListener('click', (e) => {
        if (e.target === m) closeAllModals();
      });
    });
    document.querySelectorAll('[data-close]').forEach(b => {
      b.onclick = closeAllModals;
    });

    // Global keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Esc — universal close
      if (e.key === 'Escape') {
        if (scanner.open) { closeScanner(); return; }
        if (anyModalOpen()) { closeAllModals(); return; }
      }

      // Below shortcuts: skip while user is typing in an input/textarea
      const tag = (e.target && e.target.tagName) || '';
      const inField = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable);

      // Ctrl/Cmd+Z — undo (works even from inputs only when stack non-empty and not editing inside an input value)
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
        if (inField) return; // let browsers handle native input undo
        if (anyModalOpen() || scanner.open) return;
        e.preventDefault();
        undoLast();
        return;
      }

      if (inField) return;

      // "/" — focus code input
      if (e.key === '/') {
        if (anyModalOpen() || scanner.open) return;
        e.preventDefault();
        const ci = document.getElementById('codeInput');
        if (ci) { ci.focus(); ci.select(); }
        return;
      }
    });
  }

  // -------- CATALOGUE --------
  let _catKeysCache = null;
  function catalogueKeys() {
    if (_catKeysCache) return _catKeysCache;
    _catKeysCache = state.catalogue ? Object.keys(state.catalogue).sort() : [];
    return _catKeysCache;
  }
  function invalidateCatalogueCache() { _catKeysCache = null; }
  function catalogueCount() { return catalogueKeys().length; }

  function parseCatalogueLine(line) {
    line = line.trim();
    if (!line || line.startsWith('#')) return null;
    let code, desc = '';
    if (line[0] === '"') {
      const m = /^"((?:[^"]|"")*)"\s*[,;\t]?(.*)$/.exec(line);
      if (m) { code = m[1].replace(/""/g, '"'); desc = m[2].trim(); }
      else { code = line.replace(/^"|"$/g, ''); }
    } else {
      const m = /^([^,;\t]+)[,;\t](.*)$/.exec(line);
      if (m) { code = m[1].trim(); desc = m[2].trim(); }
      else { code = line.trim(); }
    }
    if (desc && desc[0] === '"') {
      const m2 = /^"((?:[^"]|"")*)"\s*$/.exec(desc);
      if (m2) desc = m2[1].replace(/""/g, '"');
    }
    code = code.toUpperCase();
    if (!code) return null;
    return [code, desc];
  }

  function isLikelyHeader(code, desc) {
    const c = code.toLowerCase();
    const d = (desc || '').toLowerCase();
    const codeHeaders = new Set(['code','sku','item','itemcode','item code','barcode','product','product code','part','part no','partno']);
    const descHeaders = new Set(['description','desc','name','product name','title']);
    return codeHeaders.has(c) || descHeaders.has(d);
  }

  function parseCatalogueText(text) {
    const lines = text.split(/\r?\n/);
    const map = {};
    let count = 0;
    let skipped = 0;
    let firstParsed = true;
    for (const raw of lines) {
      const parsed = parseCatalogueLine(raw);
      if (!parsed) continue;
      const [code, desc] = parsed;
      if (firstParsed && isLikelyHeader(code, desc)) {
        firstParsed = false;
        skipped++;
        continue;
      }
      firstParsed = false;
      if (code.length > 64) { skipped++; continue; }
      map[code] = desc;
      count++;
    }
    return { map, count, skipped };
  }

  function previewCatalogueText(text) {
    const el = document.getElementById('catPreview');
    if (!text || !text.trim()) { el.classList.remove('show'); el.innerHTML = ''; return; }
    const r = parseCatalogueText(text);
    if (!r.count) {
      el.classList.add('show');
      el.innerHTML = 'No valid codes found.';
      return;
    }
    const sample = Object.keys(r.map).slice(0, 3).map(k => k + (r.map[k] ? ' — ' + r.map[k] : '')).join(' · ');
    el.classList.add('show');
    el.innerHTML = `Will import <strong>${r.count}</strong> code${r.count === 1 ? '' : 's'}${r.skipped ? ` <span style="color:var(--text-faint)">(${r.skipped} skipped)</span>` : ''}<br><span style="color:var(--text-faint)">e.g. ${escapeHtml(sample)}</span>`;
  }

  function commitCatalogue(text) {
    const r = parseCatalogueText(text);
    if (!r.count) {
      toast('NO VALID CODES FOUND', 'warn');
      return;
    }
    state.catalogue = r.map;
    invalidateCatalogueCache();
    save();
    updateCatStatus();
    closeAllModals();
    toast(`IMPORTED ${r.count} CODE${r.count === 1 ? '' : 'S'}`, 'in');
    renderLog();
  }

  function updateCatStatus() {
    const el = document.getElementById('catStatus');
    const clearBtn = document.getElementById('catClearBtn');
    if (!el) return;
    const n = catalogueCount();
    if (n) {
      el.textContent = `CATALOGUE: ${n} CODE${n === 1 ? '' : 'S'} LOADED`;
      el.className = 'cat-status-text loaded';
      clearBtn.disabled = false;
    } else {
      el.textContent = 'NO CATALOGUE LOADED';
      el.className = 'cat-status-text';
      clearBtn.disabled = true;
    }
  }

  // -------- SUGGESTIONS --------
  let suggestionFocus = -1;
  let suggestionList = [];

  function renderSuggestions() {
    const wrap = document.getElementById('suggestions');
    const inp = document.getElementById('codeInput');
    const q = inp.value.trim().toUpperCase();
    if (!q || catalogueCount() === 0) {
      wrap.classList.remove('open');
      wrap.innerHTML = '';
      suggestionList = [];
      suggestionFocus = -1;
      return;
    }
    const codes = catalogueKeys();
    const prefix = [];
    const contains = [];
    for (const c of codes) {
      if (c === q) continue;
      if (c.startsWith(q)) prefix.push(c);
      else if (c.includes(q)) contains.push(c);
      if (prefix.length + contains.length > 50) break;
    }
    const results = prefix.concat(contains).slice(0, 6);
    suggestionList = results;
    suggestionFocus = -1;
    if (!results.length) {
      wrap.classList.remove('open');
      wrap.innerHTML = '';
      return;
    }
    wrap.innerHTML = '';
    results.forEach((code, idx) => {
      const desc = state.catalogue[code] || '';
      const item = document.createElement('div');
      item.className = 'suggestion-item';
      item.innerHTML = `
        <div class="suggestion-code">${highlightMatch(code, q)}</div>
        ${desc ? `<div class="suggestion-desc">${escapeHtml(desc)}</div>` : ''}
      `;
      item.addEventListener('mousedown', (e) => { e.preventDefault(); });
      item.addEventListener('click', () => {
        inp.value = code;
        wrap.classList.remove('open');
        inp.focus();
      });
      wrap.appendChild(item);
    });
    wrap.classList.add('open');
  }

  function highlightMatch(code, q) {
    const idx = code.indexOf(q);
    if (idx < 0) return escapeHtml(code);
    return escapeHtml(code.slice(0, idx))
      + `<span class="suggestion-mark">${escapeHtml(code.slice(idx, idx + q.length))}</span>`
      + escapeHtml(code.slice(idx + q.length));
  }

  function moveSuggestion(delta) {
    const wrap = document.getElementById('suggestions');
    if (!wrap.classList.contains('open') || !suggestionList.length) return;
    const items = wrap.querySelectorAll('.suggestion-item');
    suggestionFocus = (suggestionFocus + delta + items.length) % items.length;
    items.forEach((it, i) => it.classList.toggle('focus', i === suggestionFocus));
    items[suggestionFocus].scrollIntoView({ block: 'nearest' });
  }

  // -------- SCANNER --------
  const scanner = {
    open: false,
    starting: false,
    reader: null,
    controls: null,
    track: null,
    torchOn: false,
    continuous: false,
    count: 0,
    lastCode: '',
    lastTime: 0,
  };

  let zxingPromise = null;
  function loadZXing() {
    if (window.ZXingBrowser) return Promise.resolve(window.ZXingBrowser);
    if (zxingPromise) return zxingPromise;
    zxingPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = ZXING_SRC;
      s.async = true;
      s.onload = () => {
        if (window.ZXingBrowser) resolve(window.ZXingBrowser);
        else reject(new Error('ZXing global not exposed'));
      };
      s.onerror = () => { zxingPromise = null; reject(new Error('Failed to load scanner library')); };
      document.head.appendChild(s);
    });
    return zxingPromise;
  }

  async function maybeHideScanButton() {
    const btn = document.getElementById('scanBtn');
    if (!btn) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      btn.setAttribute('hidden', '');
      return;
    }
    if (!navigator.mediaDevices.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const hasCam = devices.some(d => d.kind === 'videoinput');
      if (!hasCam) btn.setAttribute('hidden', '');
    } catch (e) {
      console.warn('enumerateDevices failed', e);
    }
  }

  function setScannerHint(text, warn) {
    const el = document.getElementById('scannerHint');
    el.textContent = text;
    el.classList.toggle('warn', !!warn);
  }
  function flashHint(text, ms) {
    setScannerHint(text, true);
    clearTimeout(flashHint._t);
    flashHint._t = setTimeout(() => setScannerHint('HOLD STEADY — SCANNING FOR CODE…', false), ms || 1800);
  }
  function updateScanCounter() {
    const el = document.getElementById('scannerCounter');
    el.textContent = `SCANNED: ${scanner.count}`;
    el.classList.toggle('hidden', !scanner.continuous);
  }

  function showScannerError(err) {
    const el = document.getElementById('scannerError');
    const c = document.getElementById('scannerErrorContent');
    let title = 'CAMERA ERROR';
    let msg = (err && err.message) || 'Could not start the camera.';
    let showRetry = true;
    if (err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError' || err.name === 'SecurityError')) {
      title = 'PERMISSION DENIED';
      msg = 'Camera access needed. Enable it in your browser settings and try again.';
    } else if (err && (err.name === 'NotFoundError' || err.name === 'OverconstrainedError')) {
      title = 'NO CAMERA FOUND';
      msg = 'No usable camera was detected on this device.';
      showRetry = false;
    } else if (err && err.name === 'NotReadableError') {
      title = 'CAMERA BUSY';
      msg = 'The camera is in use by another app. Close it and try again.';
    }
    c.innerHTML = `
      <h4>${escapeHtml(title)}</h4>
      <div>${escapeHtml(msg)}</div>
      <div class="scanner-error-actions">
        <button id="scanErrCloseBtn">CLOSE</button>
        ${showRetry ? '<button id="scanErrRetryBtn" class="primary">RETRY</button>' : ''}
      </div>
    `;
    el.classList.add('show');
    document.getElementById('scanErrCloseBtn').onclick = closeScanner;
    if (showRetry) {
      document.getElementById('scanErrRetryBtn').onclick = () => {
        el.classList.remove('show');
        startCamera();
      };
    }
  }

  async function startCamera() {
    if (scanner.starting) return;
    scanner.starting = true;
    document.getElementById('scannerLoading').classList.add('show');
    try {
      const ZX = await loadZXing();
      if (!scanner.reader) {
        let hints;
        try {
          hints = new Map();
          if (ZX.BarcodeFormat && ZX.DecodeHintType) {
            const fmts = [
              ZX.BarcodeFormat.CODE_128,
              ZX.BarcodeFormat.CODE_39,
              ZX.BarcodeFormat.EAN_13,
              ZX.BarcodeFormat.EAN_8,
              ZX.BarcodeFormat.QR_CODE,
              ZX.BarcodeFormat.DATA_MATRIX,
            ].filter(f => f !== undefined && f !== null);
            if (fmts.length) hints.set(ZX.DecodeHintType.POSSIBLE_FORMATS, fmts);
          }
        } catch(e) {
          console.warn('zxing hints setup failed', e);
          hints = undefined;
        }
        scanner.reader = new ZX.BrowserMultiFormatReader(hints);
      }
      const video = document.getElementById('scannerVideo');
      const constraints = { video: { facingMode: { ideal: 'environment' } } };
      scanner.controls = await scanner.reader.decodeFromConstraints(
        constraints,
        video,
        (result, err, controls) => {
          if (result && scanner.open) handleScanResult(result.getText());
        }
      );
      document.getElementById('scannerLoading').classList.remove('show');
      setupTorchButton();
    } catch (err) {
      document.getElementById('scannerLoading').classList.remove('show');
      console.warn('camera error', err);
      showScannerError(err);
    } finally {
      scanner.starting = false;
    }
  }

  function setupTorchButton() {
    const torchBtn = document.getElementById('scannerTorch');
    torchBtn.setAttribute('hidden', '');
    torchBtn.classList.remove('on');
    scanner.torchOn = false;
    const video = document.getElementById('scannerVideo');
    const probe = () => {
      try {
        const stream = video.srcObject;
        if (!stream) return;
        const track = stream.getVideoTracks()[0];
        if (!track) return;
        scanner.track = track;
        const caps = (track.getCapabilities && track.getCapabilities()) || {};
        if (caps.torch) torchBtn.removeAttribute('hidden');
      } catch(e) {
        console.warn('torch probe failed', e);
      }
    };
    if (video.readyState >= 1 && video.srcObject) probe();
    else video.addEventListener('loadedmetadata', probe, { once: true });
  }

  function toggleTorch() {
    const t = scanner.track;
    if (!t || !t.applyConstraints) return;
    const next = !scanner.torchOn;
    t.applyConstraints({ advanced: [{ torch: next }] }).then(() => {
      scanner.torchOn = next;
      document.getElementById('scannerTorch').classList.toggle('on', next);
    }).catch(() => {
      toast('TORCH UNAVAILABLE', 'warn');
    });
  }

  function openScanner() {
    if (scanner.open || scanner.starting) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('CAMERA NOT SUPPORTED', 'warn');
      return;
    }
    scanner.open = true;
    scanner.count = 0;
    scanner.lastCode = '';
    scanner.lastTime = 0;
    document.getElementById('scannerError').classList.remove('show');
    setScannerHint('HOLD STEADY — SCANNING FOR CODE…', false);
    updateScanCounter();
    document.getElementById('scannerOverlay').classList.add('open');
    document.getElementById('scannerOverlay').setAttribute('aria-hidden', 'false');
    startCamera();
  }

  function closeScanner() {
    scanner.open = false;
    clearTimeout(flashHint._t);
    const overlay = document.getElementById('scannerOverlay');
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    document.getElementById('scannerError').classList.remove('show');
    document.getElementById('scannerLoading').classList.remove('show');
    if (scanner.controls) {
      try { scanner.controls.stop(); }
      catch(e) { console.warn('scanner stop failed', e); }
      scanner.controls = null;
    }
    const video = document.getElementById('scannerVideo');
    if (video.srcObject) {
      try { video.srcObject.getTracks().forEach(t => t.stop()); }
      catch(e) { console.warn('camera tracks stop failed', e); }
      video.srcObject = null;
    }
    scanner.track = null;
    scanner.torchOn = false;
  }

  function handleScanResult(rawText) {
    if (!rawText) return;
    const code = String(rawText).trim().toUpperCase().replace(/[^A-Z0-9_\-]/g, '');
    if (!code) return;

    const now = Date.now();
    if (code === scanner.lastCode && (now - scanner.lastTime) < 1300) return;
    scanner.lastCode = code;
    scanner.lastTime = now;

    vibrate(80, { force: true });
    beep(440, 80, { force: true });

    if (scanner.continuous) {
      if (!state.initials) { flashHint('SET INITIALS IN SETTINGS FIRST'); return; }
      const loc = getCurrentLoc();
      if (!loc) { flashHint('NEED LOCATION FIRST — CLOSE & SET IT'); return; }
      const entry = submitEntry({ code, qty: 1 });
      if (entry) {
        scanner.count++;
        updateScanCounter();
        flashHint(`LOGGED: ${code}`, 1100);
      }
    } else {
      closeScanner();
      const codeInput = document.getElementById('codeInput');
      codeInput.value = code;
      if (getCurrentLoc() && state.initials) {
        submitEntry();
      } else {
        toast('SCANNED — NOW SET LOCATION', 'in');
        codeInput.focus();
      }
    }
  }

  // -------- INIT --------
  load();
  setupRecognition();
  applySettings();
  bind();
  renderAll();
  updateNetStatus();
  maybeHideScanButton();
  window.addEventListener('online', updateNetStatus);
  window.addEventListener('offline', updateNetStatus);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./service-worker.js').catch(err => {
        console.warn('SW registration failed', err);
      });
    });
  }

  if (!state.initials) {
    setTimeout(openSettings, 300);
  }
})();
