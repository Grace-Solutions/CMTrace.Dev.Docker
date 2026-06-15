window.CMT = window.CMT || {};

/*
 * CMT.insights — smart insights summary + inline error-code decoration +
 * a compact timeline chart.
 *
 * Three responsibilities:
 *  1. decorateMessage(message) — a security/perf-critical helper called once
 *     per visible grid row. It HTML-escapes the whole message first, THEN
 *     wraps every detected error-code token in a <span class="code-tag">.
 *     It must never emit unescaped user text and must be correct even with
 *     overlapping/adjacent codes.
 *  2. buildSummary() — renders the docked #insights panel: headline counts,
 *     a "top errors" list (grouped by normalized message, clickable to jump),
 *     and a canvas timeline bucketed by time.
 *  3. open/close/toggle of the panel, persisting the open state in
 *     store.settings.insightsOpen.
 *
 * Pure client-side, classic script, namespace CMT, no external deps.
 */
(function () {
  'use strict';

  // ---- lazy short-hands (load-order safe) ---------------------------------
  function util() { return CMT.util; }
  function store() { return CMT.store; }
  function grid() { return CMT.grid; }
  function ui() { return CMT.ui; }
  function errorlookup() { return CMT.errorlookup; }
  function errorKB() { return CMT.errorKB; }

  function $(id) { return document.getElementById(id); }

  // Number of buckets in the timeline chart.
  var TIMELINE_BUCKETS = 60;
  // How many grouped errors to show in the TOP ERRORS list.
  var TOP_ERRORS_LIMIT = 6;
  // Cap on entries scanned for the summary so a 1M-row file stays responsive.
  // The summary is a sampled-at-full pass; the cap keeps the grouping cheap.
  var SUMMARY_SCAN_CAP = 200000;

  // ----- module-local state ------------------------------------------------
  // Cached timeline buckets so a "view" event can stay lightweight (the heavy
  // recompute happens on "data"). Each bucket: {t0, t1, err, warn, info,
  // total, firstIdx}. firstIdx is the entry idx of the first entry in range.
  var timelineBuckets = null;
  // Geometry the last draw used, so canvas clicks can map x -> bucket.
  var timelineGeom = null;
  // Bound redraw handle for resize.
  var onTimelineResize = null;

  // =======================================================================
  //  decorateMessage  (SECURITY + PERF CRITICAL)
  // =======================================================================

  // A single combined matcher for error-code-like tokens used purely to find
  // SPANS inside the message. We do NOT trust this to validate codes — we use
  // CMT.errorlookup.extractCodes for the canonical token set, then locate each
  // token's spans here. This regex only drives "where to wrap".
  //
  //  - 0x-prefixed hex (full run; tokens longer than 8 hex digits are skipped
  //    in the sweep so an overlong literal is never split into a wrong prefix)
  //  - bare 8-hex containing at least one a-f letter (classic HRESULT spelling);
  //    the letter requirement is enforced in the sweep so plain 8-digit decimals
  //    (PIDs, counts) are not decorated as codes
  //  - signed/large decimals are handled via the extractCodes token set, not
  //    here, to avoid wrapping line numbers etc.
  var RE_HEXLIKE = /0[xX][0-9A-Fa-f]+|\b[0-9A-Fa-f]{8}\b/g;

  // A bounded sweep for SHORT decimal tokens (1..10 digits). extractCodes only
  // keeps 5+ digit / negative decimals to avoid false positives when scanning
  // raw logs, but classic codes such as 1603/1618/1619/3010 are short. We only
  // wrap such a token when CMT.errorKB recognizes it as a real curated code, so
  // arbitrary line numbers / counts are never decorated.
  var RE_DECLIKE = /-?\b[0-9]{1,10}\b/g;

  /**
   * Escape a single character for HTML text content. Used while we walk the
   * raw message so we can interleave escaped text with <span> wrappers without
   * ever concatenating unescaped user input.
   * @param {string} s
   * @returns {string}
   */
  function esc(s) {
    return util().escapeHtml(s);
  }

  /**
   * decorateMessage(message) -> safe HTML string.
   *
   * Algorithm:
   *  1. Collect the canonical set of code tokens via errorlookup.extractCodes
   *     PLUS any hex-like tokens found directly in the message. This gives the
   *     literal substrings to wrap.
   *  2. Scan the message left-to-right, finding the earliest non-overlapping
   *     occurrence of any wanted token at each step. Emit escaped text for the
   *     gap, then an escaped <span class="code-tag"> for the matched token.
   *  3. Anything not matched is escaped verbatim.
   *
   * Every byte of user text passes through escapeHtml; the only literal HTML we
   * emit is the fixed span scaffolding with attribute-escaped code values.
   *
   * @param {string} message
   * @returns {string} safe HTML
   */
  function decorateMessage(message) {
    var u = util();
    if (message == null) return '';
    var text = String(message);
    if (!text) return '';

    // ---- 1) build the set of literal token substrings to wrap ----
    // Use a regex sweep for hex-like spans (cheap, drives positions), and the
    // canonical extractCodes for the full token spellings (incl. decimals).
    // We then keep only tokens that actually appear literally in `text` so we
    // can locate their byte positions deterministically.
    var tokens = collectTokens(text);

    if (tokens.length === 0) {
      // Fast path: nothing to decorate — just escape the whole thing.
      return esc(text);
    }

    // ---- 2) find all non-overlapping match spans, earliest-first ----
    // For each token we find every occurrence; then we sweep positions and
    // greedily pick the earliest-starting (longest on tie) match, skipping any
    // that overlap an already-emitted span. This handles adjacent/overlapping
    // codes correctly (e.g. "0x800040050x80070005").
    var spans = findSpans(text, tokens);
    if (spans.length === 0) {
      return esc(text);
    }

    var out = [];
    var cursor = 0;
    for (var i = 0; i < spans.length; i++) {
      var sp = spans[i];
      if (sp.start < cursor) continue; // defensive: skip overlaps
      if (sp.start > cursor) {
        out.push(esc(text.slice(cursor, sp.start)));
      }
      var raw = text.slice(sp.start, sp.end);
      out.push(wrapCode(raw));
      cursor = sp.end;
    }
    if (cursor < text.length) {
      out.push(esc(text.slice(cursor)));
    }
    return out.join('');
  }

  /**
   * Build the deduplicated list of literal token substrings to wrap. Combines
   * the canonical extractCodes output with a direct hex-like regex sweep so
   * adjacency cases the extractor's word-boundaries might miss are covered.
   * @param {string} text
   * @returns {string[]}
   */
  function collectTokens(text) {
    var seen = Object.create(null);
    var tokens = [];

    function add(tok) {
      if (!tok) return;
      // Only keep tokens that literally occur in the text (extractCodes returns
      // the original spelling, so they should — but stay defensive).
      if (seen[tok] !== undefined) return;
      seen[tok] = true;
      tokens.push(tok);
    }

    var lk = errorlookup();
    if (lk && typeof lk.extractCodes === 'function') {
      var codes = lk.extractCodes(text);
      for (var i = 0; i < codes.length; i++) add(codes[i]);
    }

    // Direct hex-like sweep to catch adjacent codes without surrounding
    // whitespace/boundaries (extractCodes uses \b which can miss "AAA0x...").
    RE_HEXLIKE.lastIndex = 0;
    var m;
    while ((m = RE_HEXLIKE.exec(text)) !== null) {
      var tok = m[0];
      if (RE_HEXLIKE.lastIndex === m.index) RE_HEXLIKE.lastIndex++; // guard
      if (tok.charAt(1) === 'x' || tok.charAt(1) === 'X') {
        // 0x-prefixed: only wrap a plausible code width. An overlong literal
        // (>8 hex digits) is left untouched rather than split into a wrong
        // truncated code + leftover digits.
        if (tok.length - 2 > 8) continue;
      } else if (!/[A-Fa-f]/.test(tok)) {
        // Bare 8-char run with no hex letter is a plain decimal (PID, count,
        // ticks) — skip it so it is not decorated as an HRESULT.
        continue;
      }
      add(tok);
    }

    // Short decimal codes (e.g. 1603) are intentionally skipped by extractCodes
    // to avoid wrapping arbitrary numbers. Wrap them only when the curated
    // CMT.errorKB knows the code, so well-known codes still decorate without
    // false positives on line numbers / counts.
    var kb = errorKB();
    if (kb && typeof kb.lookup === 'function') {
      RE_DECLIKE.lastIndex = 0;
      var d;
      while ((d = RE_DECLIKE.exec(text)) !== null) {
        var tok = d[0];
        if (RE_DECLIKE.lastIndex === d.index) RE_DECLIKE.lastIndex++; // guard
        if (seen[tok] !== undefined) continue;
        if (kb.lookup(tok)) add(tok);
      }
    }

    // Longest tokens first so a longer code wins over a shorter prefix at the
    // same position (e.g. "0x80004005" beats "0x8000").
    tokens.sort(function (a, b) { return b.length - a.length; });
    return tokens;
  }

  /**
   * Find non-overlapping spans for the given tokens, returned sorted by start.
   * Greedy earliest-start / longest-token resolution.
   * @param {string} text
   * @param {string[]} tokens longest-first
   * @returns {Array<{start:number,end:number}>}
   */
  function findSpans(text, tokens) {
    var candidates = [];
    for (var t = 0; t < tokens.length; t++) {
      var tok = tokens[t];
      var len = tok.length;
      if (!len) continue;
      var from = 0;
      var idx;
      while ((idx = text.indexOf(tok, from)) !== -1) {
        candidates.push({ start: idx, end: idx + len, len: len });
        from = idx + 1; // allow overlapping occurrences; resolved below
      }
    }
    if (candidates.length === 0) return [];

    // Sort by start asc, then by length desc (prefer the longer token).
    candidates.sort(function (a, b) {
      if (a.start !== b.start) return a.start - b.start;
      return b.len - a.len;
    });

    // Greedy non-overlapping selection.
    var spans = [];
    var lastEnd = 0;
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (c.start >= lastEnd) {
        spans.push({ start: c.start, end: c.end });
        lastEnd = c.end;
      }
    }
    return spans;
  }

  /**
   * Produce the safe <span class="code-tag"> scaffolding for one code token.
   * The token is escaped for both the visible text and the attributes.
   * @param {string} code raw matched substring
   * @returns {string}
   */
  function wrapCode(code) {
    var u = util();
    var attr = u.escapeAttr(code);
    var body = u.escapeHtml(code);
    return '<span class="code-tag" data-code="' + attr +
      '" title="Look up ' + attr + '">' + body + '</span>';
  }

  // =======================================================================
  //  PANEL OPEN / CLOSE / TOGGLE
  // =======================================================================

  function isOpen() {
    var s = store();
    return !!(s && s.state && s.state.settings && s.state.settings.insightsOpen);
  }

  function hasData() {
    var s = store();
    return !!(s && s.state && s.state.entries && s.state.entries.length);
  }

  /**
   * Reflect the current open state into the DOM (panel + button) and, when
   * opening with data present, (re)render the summary.
   */
  function applyOpenState() {
    var panel = $('insights');
    var open = isOpen();
    if (panel) panel.hidden = !open;

    var btn = $('btn-insights');
    if (btn) btn.setAttribute('aria-pressed', open ? 'true' : 'false');

    // The grid lives in a flex column; toggling the panel changes its height,
    // so nudge the grid to re-measure/re-render.
    var g = grid();
    if (g && typeof g.refresh === 'function') g.refresh();

    if (open) buildSummary();
  }

  function setOpen(open, persist) {
    var s = store();
    if (s && s.state && s.state.settings) s.state.settings.insightsOpen = !!open;
    if (persist && s && typeof s.saveSettings === 'function') s.saveSettings();
    applyOpenState();
  }

  function open() { setOpen(true, true); }
  function close() { setOpen(false, true); }
  function toggle() { setOpen(!isOpen(), true); }

  // =======================================================================
  //  SUMMARY RENDER
  // =======================================================================

  /**
   * Public refresh: rebuild the summary if the panel is currently open.
   */
  function refresh() {
    if (isOpen()) buildSummary();
  }

  /**
   * Render the full insights summary into #insights-content.
   * Safe to call with no data (renders an empty-state hint).
   */
  function buildSummary() {
    var content = $('insights-content');
    if (!content) return;
    var u = util();
    var s = store();

    content.innerHTML = '';

    if (!hasData()) {
      content.appendChild(u.el('div', {
        className: 'insights-empty',
        text: 'Open a log to see insights, top errors and a timeline.'
      }));
      timelineBuckets = null;
      timelineGeom = null;
      return;
    }

    var st = (s && typeof s.stats === 'function') ? s.stats() : null;

    // (a) headline counts -------------------------------------------------
    content.appendChild(buildHeadline(st));

    // (b) top errors ------------------------------------------------------
    var topWrap = u.el('div', { className: 'insights-section insights-toperr' });
    topWrap.appendChild(u.el('h4', { className: 'insights-h', text: 'Top errors' }));
    topWrap.appendChild(buildTopErrors());
    content.appendChild(topWrap);

    // (c) timeline --------------------------------------------------------
    var tlWrap = u.el('div', { className: 'insights-section insights-timeline' });
    tlWrap.appendChild(u.el('h4', { className: 'insights-h', text: 'Timeline' }));
    var canvasBox = u.el('div', { className: 'insights-timeline-box' });
    var canvas = u.el('canvas', { className: 'insights-timeline-canvas' });
    canvasBox.appendChild(canvas);
    tlWrap.appendChild(canvasBox);
    tlWrap.appendChild(u.el('div', {
      className: 'insights-timeline-legend',
      html:
        '<span class="tll tll-err"></span>errors' +
        '<span class="tll tll-warn"></span>warnings' +
        '<span class="tll tll-info"></span>info'
    }));
    content.appendChild(tlWrap);

    computeTimeline();
    wireTimelineCanvas(canvas);
    drawTimeline(canvas);
  }

  /**
   * Headline counts row: errors / warnings / info, distinct components, span.
   * @param {object|null} st store.stats() result
   * @returns {Element}
   */
  function buildHeadline(st) {
    var u = util();
    var wrap = u.el('div', { className: 'insights-headline' });

    function stat(cls, value, label) {
      var card = u.el('div', { className: 'insights-stat ' + cls });
      card.appendChild(u.el('span', { className: 'is-val', text: fmtNum(value) }));
      card.appendChild(u.el('span', { className: 'is-lbl', text: label }));
      return card;
    }

    var errors = st ? st.errors : 0;
    var warnings = st ? st.warnings : 0;
    var info = st ? st.info : 0;
    var comps = st ? st.components : 0;

    wrap.appendChild(stat('is-err', errors, errors === 1 ? 'error' : 'errors'));
    wrap.appendChild(stat('is-warn', warnings, warnings === 1 ? 'warning' : 'warnings'));
    wrap.appendChild(stat('is-info', info, info === 1 ? 'info line' : 'info lines'));
    wrap.appendChild(stat('is-comp', comps, comps === 1 ? 'component' : 'components'));

    // Time span as a wide card.
    var spanCard = u.el('div', { className: 'insights-stat is-span' });
    spanCard.appendChild(u.el('span', { className: 'is-val', text: formatSpan(st) }));
    spanCard.appendChild(u.el('span', { className: 'is-lbl', text: 'time span' }));
    wrap.appendChild(spanCard);

    return wrap;
  }

  /**
   * Human-readable elapsed span between the first and last timed entry.
   * @param {object|null} st
   * @returns {string}
   */
  function formatSpan(st) {
    if (!st || st.timeFrom == null || st.timeTo == null) return '—';
    var ms = st.timeTo - st.timeFrom;
    if (!isFinite(ms) || ms < 0) return '—';
    if (ms < 1000) return ms + ' ms';
    var sec = Math.floor(ms / 1000);
    if (sec < 60) return sec + 's';
    var min = Math.floor(sec / 60);
    var remSec = sec % 60;
    if (min < 60) return min + 'm ' + remSec + 's';
    var hr = Math.floor(min / 60);
    var remMin = min % 60;
    if (hr < 24) return hr + 'h ' + remMin + 'm';
    var days = Math.floor(hr / 24);
    var remHr = hr % 24;
    return days + 'd ' + remHr + 'h';
  }

  // =======================================================================
  //  TOP ERRORS  (grouped by normalized message)
  // =======================================================================

  // Normalize a message to a grouping key: strip variable runs (hex, digits,
  // guids, paths) so "Failed for X-123" and "Failed for Y-456" collapse.
  var RE_GUID = /\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\b/g;
  var RE_HEX = /\b0[xX][0-9A-Fa-f]+\b/g;
  var RE_WINPATH = /[A-Za-z]:\\[^\s"']+/g;
  var RE_UNCPATH = /\\\\[^\s"']+/g;
  var RE_NUM = /\d+/g;
  var RE_WS = /\s+/g;

  /**
   * Collapse a message into a stable grouping key.
   * @param {string} msg
   * @returns {string}
   */
  function normalizeMessage(msg) {
    var s = (msg || '').split('\n')[0];
    s = s.replace(RE_GUID, '#');
    s = s.replace(RE_WINPATH, '#');
    s = s.replace(RE_UNCPATH, '#');
    s = s.replace(RE_HEX, '#');
    s = s.replace(RE_NUM, '#');
    s = s.replace(RE_WS, ' ').trim();
    return s.toLowerCase();
  }

  /**
   * Build the TOP ERRORS list element: grouped error messages with counts, a
   * clickable sample (jumps to first occurrence) and detected-code chips.
   * @returns {Element}
   */
  function buildTopErrors() {
    var u = util();
    var s = store();
    var entries = (s && s.state && s.state.entries) || [];

    var groups = Object.create(null);
    var order = [];
    var scanned = 0;

    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.type !== 3) continue;
      var first = (e.message || '').split('\n')[0].trim();
      if (!first) continue;
      var key = normalizeMessage(e.message);
      if (!key) continue;
      var g = groups[key];
      if (!g) {
        g = groups[key] = {
          count: 0,
          sample: first,
          firstEntryIdx: e.idx
        };
        order.push(key);
      }
      g.count++;
      scanned++;
      if (scanned >= SUMMARY_SCAN_CAP) break;
    }

    if (order.length === 0) {
      return u.el('div', { className: 'insights-empty', text: 'No errors logged.' });
    }

    var ranked = order.map(function (k) { return groups[k]; });
    ranked.sort(function (a, b) { return b.count - a.count; });
    ranked = ranked.slice(0, TOP_ERRORS_LIMIT);

    var list = u.el('div', { className: 'toperr-list' });
    for (var r = 0; r < ranked.length; r++) {
      list.appendChild(buildTopErrorRow(ranked[r]));
    }
    return list;
  }

  /**
   * One row of the top-errors list.
   * @param {{count:number, sample:string, firstEntryIdx:number}} group
   * @returns {Element}
   */
  function buildTopErrorRow(group) {
    var u = util();

    var sample = group.sample;
    if (sample.length > 200) sample = sample.slice(0, 197) + '…';

    var row = u.el('div', {
      className: 'toperr-row',
      role: 'button',
      tabindex: '0',
      title: 'Jump to first occurrence'
    });

    var badge = u.el('span', {
      className: 'toperr-count',
      text: '×' + fmtNum(group.count)
    });
    row.appendChild(badge);

    var body = u.el('div', { className: 'toperr-body' });
    body.appendChild(u.el('div', { className: 'toperr-msg', text: sample }));

    // detected error-code chips
    var lk = errorlookup();
    if (lk && typeof lk.extractCodes === 'function') {
      var codes = lk.extractCodes(group.sample);
      if (codes && codes.length) {
        var chips = u.el('div', { className: 'toperr-chips' });
        for (var c = 0; c < codes.length && c < 5; c++) {
          chips.appendChild(buildCodeChip(codes[c]));
        }
        body.appendChild(chips);
      }
    }
    row.appendChild(body);

    function jump() { jumpToEntryIdx(group.firstEntryIdx); }
    row.addEventListener('click', jump);
    row.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        jump();
      }
    });

    return row;
  }

  /**
   * A small chip for a detected error code; clicking opens the error lookup
   * (and never bubbles up to trigger the row's jump handler).
   * @param {string} code
   * @returns {Element}
   */
  function buildCodeChip(code) {
    var u = util();
    return u.el('button', {
      className: 'toperr-chip',
      type: 'button',
      title: 'Look up ' + code,
      text: code,
      onClick: function (ev) {
        if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
        var cui = ui();
        if (cui && typeof cui.openErrorLookup === 'function') cui.openErrorLookup(code);
      }
    });
  }

  // =======================================================================
  //  NAVIGATION HELPERS
  // =======================================================================

  /**
   * Find the view position of an entry idx within the current filtered view.
   * @param {number} entryIdx
   * @returns {number} view position or -1
   */
  function viewPosOfEntryIdx(entryIdx) {
    var s = store();
    if (!s || !s.state || !Array.isArray(s.state.view)) return -1;
    var view = s.state.view;
    for (var i = 0; i < view.length; i++) {
      if (view[i] === entryIdx) return i;
    }
    return -1;
  }

  /**
   * Scroll the grid to the entry with the given idx and select it. When the
   * entry is filtered out of the current view, toast a gentle notice.
   * @param {number} entryIdx
   */
  function jumpToEntryIdx(entryIdx) {
    var s = store();
    var pos = viewPosOfEntryIdx(entryIdx);
    if (pos < 0) {
      var cui = ui();
      if (cui && typeof cui.toast === 'function') {
        cui.toast('That entry is hidden by the current filter', 'warn');
      }
      return;
    }
    var g = grid();
    if (g && typeof g.scrollToViewPos === 'function') g.scrollToViewPos(pos, true);
    if (s && typeof s.setSelection === 'function') s.setSelection(new Set([pos]), pos);
  }

  // =======================================================================
  //  TIMELINE  (canvas bar chart)
  // =======================================================================

  /**
   * Bucket all timed entries into TIMELINE_BUCKETS by time. Stores the result
   * in module-local timelineBuckets. Single linear pass; cheap at 1M rows.
   */
  function computeTimeline() {
    var s = store();
    var entries = (s && s.state && s.state.entries) || [];

    var st = (s && typeof s.stats === 'function') ? s.stats() : null;
    var t0 = st ? st.timeFrom : null;
    var t1 = st ? st.timeTo : null;

    if (t0 == null || t1 == null) {
      timelineBuckets = null;
      return;
    }

    var span = t1 - t0;
    // Guard a zero/negative span (all entries share one timestamp).
    if (!(span > 0)) span = 1;

    var n = TIMELINE_BUCKETS;
    var buckets = new Array(n);
    for (var b = 0; b < n; b++) {
      buckets[b] = {
        t0: t0 + Math.floor((span * b) / n),
        t1: t0 + Math.floor((span * (b + 1)) / n),
        err: 0,
        warn: 0,
        info: 0,
        total: 0,
        firstIdx: -1
      };
    }

    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var t = e.time;
      if (t == null) continue;
      var bi = Math.floor(((t - t0) / span) * n);
      if (bi < 0) bi = 0;
      if (bi >= n) bi = n - 1;
      var bk = buckets[bi];
      if (e.type === 3) bk.err++;
      else if (e.type === 2) bk.warn++;
      else bk.info++;
      bk.total++;
      if (bk.firstIdx === -1) bk.firstIdx = e.idx;
    }

    timelineBuckets = buckets;
  }

  /**
   * Read a CSS custom property (or theme color) with a fallback.
   * @param {string} name e.g. "--err"
   * @param {string} fallback
   * @returns {string}
   */
  function cssVar(name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name);
      if (v) {
        v = v.trim();
        if (v) return v;
      }
    } catch (e) { /* ignore */ }
    return fallback;
  }

  /**
   * Draw the timeline bar chart into the canvas, devicePixelRatio-aware.
   * Each bucket is a stacked bar (info at the base, then warn, then err on top)
   * so a rare error still shows red even inside a busy bucket.
   * @param {HTMLCanvasElement} canvas
   */
  function drawTimeline(canvas) {
    if (!canvas || typeof canvas.getContext !== 'function') return;

    var box = canvas.parentNode;
    var cssW = (box && box.clientWidth) || canvas.clientWidth || 300;
    var cssH = (box && box.clientHeight) || canvas.clientHeight || 64;
    if (cssW < 1) cssW = 1;
    if (cssH < 1) cssH = 1;

    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';

    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    var buckets = timelineBuckets;
    if (!buckets || !buckets.length) {
      timelineGeom = null;
      return;
    }

    var errColor = cssVar('--err', '#ff5d5d');
    var warnColor = cssVar('--warn', '#f5a623');
    var infoColor = cssVar('--fg-dim', '#8b93a7');

    var n = buckets.length;
    var gap = n <= 80 ? 1 : 0;
    var slot = cssW / n;
    var barW = Math.max(1, slot - gap);

    // Scale to the busiest bucket so the chart fills the height.
    var maxTotal = 1;
    for (var k = 0; k < n; k++) {
      if (buckets[k].total > maxTotal) maxTotal = buckets[k].total;
    }

    var pad = 2;
    var usableH = Math.max(1, cssH - pad);

    for (var i = 0; i < n; i++) {
      var bk = buckets[i];
      if (bk.total === 0) continue;
      var x = Math.floor(i * slot);
      var infoH = (bk.info / maxTotal) * usableH;
      var warnH = (bk.warn / maxTotal) * usableH;
      var errH = (bk.err / maxTotal) * usableH;

      // Ensure any non-zero category is at least 1px tall so it stays visible.
      if (bk.info > 0 && infoH < 1) infoH = 1;
      if (bk.warn > 0 && warnH < 1) warnH = 1;
      if (bk.err > 0 && errH < 1) errH = 1;

      var y = cssH;
      if (infoH > 0) {
        y -= infoH;
        ctx.fillStyle = infoColor;
        ctx.fillRect(x, y, barW, infoH);
      }
      if (warnH > 0) {
        y -= warnH;
        ctx.fillStyle = warnColor;
        ctx.fillRect(x, y, barW, warnH);
      }
      if (errH > 0) {
        y -= errH;
        ctx.fillStyle = errColor;
        ctx.fillRect(x, y, barW, errH);
      }
    }

    timelineGeom = { cssW: cssW, cssH: cssH, n: n, slot: slot };
  }

  /**
   * Wire pointer + resize behavior on the timeline canvas. Idempotent per
   * canvas element (guards against double-binding when the summary rebuilds —
   * the old canvas is discarded so its listeners go with it).
   * @param {HTMLCanvasElement} canvas
   */
  function wireTimelineCanvas(canvas) {
    if (!canvas || canvas._cmtWired) return;
    canvas._cmtWired = true;

    canvas.addEventListener('click', function (ev) {
      if (!timelineGeom || !timelineBuckets) return;
      var rect = canvas.getBoundingClientRect();
      var x = ev.clientX - rect.left;
      var n = timelineGeom.n;
      var bi = Math.floor((x / timelineGeom.cssW) * n);
      if (bi < 0) bi = 0;
      if (bi >= n) bi = n - 1;

      // Walk outward from the clicked bucket to the nearest one that has data,
      // so clicking a gap still lands somewhere sensible.
      var target = nearestBucketWithData(bi);
      if (target < 0) return;
      var entryIdx = timelineBuckets[target].firstIdx;
      if (entryIdx >= 0) jumpToEntryIdx(entryIdx);
    });

    // Redraw on container resize so the chart tracks the panel width. One
    // observer follows the canvas regardless of which summary build owns it.
    if (typeof ResizeObserver !== 'undefined') {
      try {
        var ro = new ResizeObserver(function () { drawTimeline(canvas); });
        ro.observe(canvas.parentNode || canvas);
      } catch (e) { /* ignore */ }
    } else if (!onTimelineResize) {
      onTimelineResize = util().debounce(function () {
        var c = document.querySelector('.insights-timeline-canvas');
        if (c) drawTimeline(c);
      }, 120);
      window.addEventListener('resize', onTimelineResize);
    }
  }

  /**
   * Find the bucket index nearest `bi` (preferring `bi` itself) that contains
   * at least one entry. Returns -1 when every bucket is empty.
   * @param {number} bi
   * @returns {number}
   */
  function nearestBucketWithData(bi) {
    var buckets = timelineBuckets;
    if (!buckets) return -1;
    var n = buckets.length;
    if (bi >= 0 && bi < n && buckets[bi].total > 0) return bi;
    for (var d = 1; d < n; d++) {
      var lo = bi - d;
      var hi = bi + d;
      if (lo >= 0 && buckets[lo].total > 0) return lo;
      if (hi < n && buckets[hi].total > 0) return hi;
    }
    return -1;
  }

  // =======================================================================
  //  MISC
  // =======================================================================

  function fmtNum(n) {
    if (n == null || isNaN(n)) return '0';
    return Number(n).toLocaleString();
  }

  // =======================================================================
  //  INIT
  // =======================================================================

  /**
   * Wire the panel controls and subscribe to store events. Idempotent-ish:
   * safe to call once on app boot. Never throws on empty state.
   */
  function init() {
    // Close button inside the panel header.
    var closeBtn = $('insights-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', function () { close(); });
    }

    var s = store();
    if (s && typeof s.on === 'function') {
      // Heavy recompute on new data; only meaningful when the panel is open.
      s.on('data', function () { refresh(); });
      // Lightweight on view changes — re-run the (cheap) summary so counts and
      // the timeline track the active file/filter. buildSummary itself is O(n)
      // but only fires while the panel is visible.
      s.on('view', util().debounce(function () { refresh(); }, 120));
    }

    // Reflect persisted open state once on boot (renders if data is present).
    applyOpenState();
  }

  // =======================================================================
  //  PUBLIC API
  // =======================================================================
  CMT.insights = {
    init: init,
    refresh: refresh,
    toggle: toggle,
    open: open,
    close: close,
    buildSummary: buildSummary,
    decorateMessage: decorateMessage
  };
})();
