window.CMT = window.CMT || {};
(function () {
  'use strict';

  // CMT.grid — a virtual-scrolling grid bound to the #grid DOM.
  //
  // Design summary (per shared contract):
  //  - #grid is the scroll container (position:relative, overflow:auto).
  //  - #grid-header is sticky inside it (handled by CSS) and holds six .col cells.
  //  - #grid-body holds #grid-sizer (its height = view.length * rowH) and
  //    #grid-rows which contains a fixed POOL of recycled row elements.
  //  - On scroll we compute the first visible index from scrollTop, then position
  //    each pooled row with transform: translateY((firstIndex+i)*rowH). We NEVER
  //    render all rows — only visibleCount + overscan are ever materialised.
  //  - Header and rows share grid-template-columns via the CSS var --grid-cols so
  //    columns stay aligned; column resize rewrites that var and persists widths.

  var OVERSCAN = 8;
  var DEFAULT_ROW_H = 24;
  var MIN_COL_W = 36;

  // Column definitions in render order. The first column (icon) and the flexible
  // text column are special. Header data-col attributes must match these keys.
  var COLS = ['icon', 'text', 'component', 'time', 'thread', 'source'];

  // Default widths used to (re)build the grid template. The text column is the
  // flexible 1fr track and is therefore not width-driven.
  var DEFAULT_COLS = {
    icon: 24,
    text: 0, // flexible (1fr); value unused
    component: 170,
    time: 188,
    thread: 96,
    source: 168
  };

  // Severity glyphs by entry.type (1=info, 2=warning, 3=error).
  var TYPE_GLYPH = { 1: 'ⓘ', 2: '⚠', 3: '⛔' };
  var TYPE_TITLE = { 1: 'Information', 2: 'Warning', 3: 'Error' };

  var grid = {
    // DOM references (resolved in init).
    container: null, // #grid (scroll container)
    header: null, // #grid-header
    body: null, // #grid-body
    sizer: null, // #grid-sizer
    rowsEl: null, // #grid-rows (holds the pool)

    // Pool of row descriptors: { el, cells:{icon,text,component,time,thread,source}, viewPos }.
    pool: [],
    poolSize: 0,

    // Current scroll/render state.
    rowH: DEFAULT_ROW_H,
    firstRendered: -1, // first view pos currently rendered by the pool window
    lastScrollTop: -1,

    // Selection anchor for shift+click ranges.
    anchor: 0,

    // Lazily-built lookup of compiled highlight rules (rebuilt on "highlight").
    _hlCompiled: null,

    _refreshScheduled: false,
    _store: null,
    _util: null
  };

  // ---------------------------------------------------------------------------
  // Small internal helpers
  // ---------------------------------------------------------------------------

  function store() {
    return grid._store || (grid._store = CMT.store);
  }
  function util() {
    return grid._util || (grid._util = CMT.util);
  }

  function clamp(n, lo, hi) {
    return n < lo ? lo : n > hi ? hi : n;
  }

  function getRowH() {
    var s = store();
    var h = s && s.settings ? Number(s.settings.rowHeight) : DEFAULT_ROW_H;
    if (!isFinite(h) || h <= 0) h = DEFAULT_ROW_H;
    return h;
  }

  function getColumns() {
    var s = store();
    var cols = s && s.settings ? s.settings.columns : null;
    var out = {};
    for (var i = 0; i < COLS.length; i++) {
      var key = COLS[i];
      var v = cols && cols[key] != null ? Number(cols[key]) : DEFAULT_COLS[key];
      if (key === 'text') {
        out[key] = 0;
      } else {
        if (!isFinite(v) || v < MIN_COL_W) v = Math.max(MIN_COL_W, DEFAULT_COLS[key]);
        out[key] = Math.round(v);
      }
    }
    return out;
  }

  // True on phone-width viewports, where the responsive CSS (media queries on
  // :root) decides which columns show and how wide they are.
  function isNarrow() {
    return typeof window !== 'undefined' && !!window.innerWidth && window.innerWidth <= 680;
  }

  // Build the CSS grid-template-columns string and push it onto --grid-cols so
  // both the header and the rows align. The text column is the 1fr flex track.
  // On phones we intentionally DON'T set an inline override: the desktop
  // template lists all six tracks (the hidden columns would still reserve
  // ~620px and overflow the screen), so we defer to the responsive CSS instead.
  function applyGridCols(cols) {
    if (isNarrow()) {
      if (grid.container) grid.container.style.removeProperty('--grid-cols');
      document.documentElement.style.removeProperty('--grid-cols');
      return;
    }
    var parts = [];
    for (var i = 0; i < COLS.length; i++) {
      var key = COLS[i];
      parts.push(key === 'text' ? 'minmax(120px, 1fr)' : cols[key] + 'px');
    }
    var tmpl = parts.join(' ');
    if (grid.container) {
      grid.container.style.setProperty('--grid-cols', tmpl);
    } else {
      document.documentElement.style.setProperty('--grid-cols', tmpl);
    }
  }

  function applyRowHVar() {
    grid.rowH = getRowH();
    if (grid.container) {
      grid.container.style.setProperty('--row-h', grid.rowH + 'px');
    }
  }

  // ---------------------------------------------------------------------------
  // Highlight rule compilation
  // ---------------------------------------------------------------------------

  function compiledHighlights() {
    if (grid._hlCompiled) return grid._hlCompiled;
    var rules = (store() && store().highlightRules) || [];
    var out = [];
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (!r || !r.enabled || !r.term) continue;
      var compiled = { color: r.color || '#ffd54f', term: r.term, regex: null, lower: null };
      if (r.regex) {
        try {
          compiled.regex = new RegExp(r.term, r.caseSensitive ? '' : 'i');
        } catch (e) {
          // Invalid regex: treat as a literal substring fallback.
          compiled.regex = null;
          compiled.lower = r.caseSensitive ? null : String(r.term).toLowerCase();
          compiled.caseSensitive = r.caseSensitive;
        }
      } else {
        compiled.caseSensitive = r.caseSensitive;
        compiled.lower = r.caseSensitive ? null : String(r.term).toLowerCase();
      }
      out.push(compiled);
    }
    grid._hlCompiled = out;
    return out;
  }

  // Return the first matching enabled highlight rule for the entry text, or null.
  function firstHighlight(text) {
    var rules = compiledHighlights();
    if (!rules.length) return null;
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (r.regex) {
        if (r.regex.test(text)) return r;
      } else if (r.caseSensitive) {
        if (text.indexOf(r.term) !== -1) return r;
      } else {
        if (text.toLowerCase().indexOf(r.lower) !== -1) return r;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Row pool construction
  // ---------------------------------------------------------------------------

  function buildRow() {
    var doc = document;
    var el = doc.createElement('div');
    el.className = 'row';
    el.setAttribute('role', 'row');

    var cells = {};
    for (var i = 0; i < COLS.length; i++) {
      var key = COLS[i];
      var c = doc.createElement('div');
      c.className = 'cell cell-' + key;
      c.setAttribute('role', 'cell');
      el.appendChild(c);
      cells[key] = c;
    }
    return { el: el, cells: cells, viewPos: -1 };
  }

  // Ensure the pool has at least `size` rows; create the missing ones.
  function ensurePool(size) {
    while (grid.pool.length < size) {
      var r = buildRow();
      grid.pool.push(r);
      grid.rowsEl.appendChild(r.el);
    }
    grid.poolSize = grid.pool.length;
    // Hide any surplus rows beyond what we need (kept for reuse, just display:none).
    for (var i = size; i < grid.pool.length; i++) {
      if (grid.pool[i].el.style.display !== 'none') {
        grid.pool[i].el.style.display = 'none';
        grid.pool[i].viewPos = -1;
      }
    }
  }

  function visibleCount() {
    var h = grid.container ? grid.container.clientHeight : 0;
    if (h <= 0) h = window.innerHeight || 600;
    return Math.ceil(h / grid.rowH) + 1;
  }

  // ---------------------------------------------------------------------------
  // Cell filling
  // ---------------------------------------------------------------------------

  function timeTextFor(entry) {
    if (entry.time != null) {
      var t = util().formatDateTime(entry.time);
      if (t) return t;
    }
    var d = entry.dateText || '';
    var tm = entry.timeText || '';
    var combined = (d + ' ' + tm).trim();
    return combined;
  }

  // Populate a pooled row for the given view position. Recycles the element:
  // updates text content and classes only — never recreates DOM.
  function fillRow(row, viewPos) {
    var s = store();
    var entry = s.getEntry(viewPos);
    var el = row.el;
    row.viewPos = viewPos;

    if (!entry) {
      el.style.display = 'none';
      return;
    }
    if (el.style.display === 'none') el.style.display = '';

    var u = util();
    var type = entry.type === 2 || entry.type === 3 ? entry.type : 1;

    // First line only for the grid (single-line, ellipsis). Detail view shows full.
    var msg = entry.message || '';
    var nl = msg.indexOf('\n');
    var firstLine = nl === -1 ? msg : msg.slice(0, nl);

    // --- text cells ---
    var cells = row.cells;

    setText(cells.icon, TYPE_GLYPH[type] || TYPE_GLYPH[1]);
    cells.icon.title = TYPE_TITLE[type] || TYPE_TITLE[1];

    // Log Text cell: when CMT.insights is available, render decorated HTML so
    // detected error codes become clickable .code-tag spans. decorateMessage
    // HTML-escapes all user text itself, so this stays XSS-safe. Otherwise fall
    // back to the plain (already-safe) textContent path.
    if (CMT.insights && typeof CMT.insights.decorateMessage === 'function') {
      var html = CMT.insights.decorateMessage(firstLine);
      if (cells.text.innerHTML !== html) cells.text.innerHTML = html;
    } else {
      setText(cells.text, firstLine);
    }
    cells.text.title = firstLine; // tooltip shows full first line
    setText(cells.component, entry.component || '');
    setText(cells.time, timeTextFor(entry));
    setText(cells.thread, entry.thread || '');
    setText(cells.source, entry.source || '');

    // --- merged view: per-file color dot so you can tell which log a row came
    //     from (only when more than one file is open). ---
    var multiFile = s.files && s.files.size > 1;
    if (multiFile) {
      var fileColor = (typeof s.fileColor === 'function') ? s.fileColor(entry.fileId) : null;
      el.style.setProperty('--file-color', fileColor || 'transparent');
      cells.component.title = (typeof s.fileName === 'function') ? s.fileName(entry.fileId) : '';
    } else if (el.style.getPropertyValue('--file-color')) {
      el.style.removeProperty('--file-color');
      cells.component.title = '';
    }

    // --- classes: severity, selection, find match, highlight ---
    var cls = 'row type-' + type;
    if (multiFile) cls += ' multi';

    var selected = s.selection && s.selection.has(viewPos);
    if (selected) cls += ' selected';
    if (viewPos === s.activeViewPos) cls += ' active';

    // Highlight: apply FIRST matching enabled rule (search message+component).
    var hl = firstHighlight((entry.message || '') + ' ' + (entry.component || ''));
    if (hl) {
      cls += ' hl';
      el.style.backgroundColor = hl.color;
    } else if (el.style.backgroundColor) {
      el.style.backgroundColor = '';
    }

    // find-match: managed separately via setActive (current find target). Keep it
    // in sync here too so a refresh preserves it.
    if (grid._findTarget != null && grid._findTarget === viewPos) {
      cls += ' find-match';
    }

    if (el.className !== cls) el.className = cls;
    el.setAttribute('data-viewpos', viewPos);
    el.setAttribute('aria-selected', selected ? 'true' : 'false');
  }

  // textContent assignment that avoids needless DOM churn.
  function setText(node, value) {
    value = value == null ? '' : String(value);
    if (node.firstChild && node.childNodes.length === 1 && node.firstChild.nodeType === 3) {
      if (node.firstChild.nodeValue !== value) node.firstChild.nodeValue = value;
    } else {
      node.textContent = value;
    }
  }

  // ---------------------------------------------------------------------------
  // Virtual render
  // ---------------------------------------------------------------------------

  function viewLen() {
    var s = store();
    return s && s.view ? s.view.length : 0;
  }

  // Position the pool window so that view rows starting at `firstIndex` are shown.
  function renderWindow(firstIndex, force) {
    var len = viewLen();
    var vis = visibleCount();
    var need = vis + OVERSCAN * 2;
    ensurePool(need);

    if (len === 0) {
      // Nothing to show: hide all pooled rows.
      for (var h = 0; h < grid.pool.length; h++) {
        if (grid.pool[h].el.style.display !== 'none') {
          grid.pool[h].el.style.display = 'none';
          grid.pool[h].viewPos = -1;
        }
      }
      grid.firstRendered = 0;
      return;
    }

    firstIndex = clamp(firstIndex, 0, Math.max(0, len - 1));
    // Back off by overscan so rows scrolling into view are pre-rendered.
    var start = Math.max(0, firstIndex - OVERSCAN);
    var end = Math.min(len, start + need);
    // If we hit the end, pull the window back so it stays full.
    if (end - start < need) start = Math.max(0, end - need);

    if (!force && start === grid.firstRendered) {
      // Window unchanged — still refresh cell contents (selection/highlight may
      // have changed); but only when force requested we re-run. Cheap path: bail.
      return;
    }

    var rowH = grid.rowH;
    var poolIdx = 0;
    for (var vp = start; vp < end; vp++, poolIdx++) {
      var row = grid.pool[poolIdx];
      fillRow(row, vp);
      // Position via transform translateY.
      var y = vp * rowH;
      var tf = 'translateY(' + y + 'px)';
      if (row.el.style.transform !== tf) row.el.style.transform = tf;
    }
    // Hide unused pooled rows (e.g. near the end of the list).
    for (; poolIdx < grid.pool.length; poolIdx++) {
      var extra = grid.pool[poolIdx];
      if (extra.el.style.display !== 'none') {
        extra.el.style.display = 'none';
        extra.viewPos = -1;
      }
    }
    grid.firstRendered = start;
  }

  function updateSizer() {
    var len = viewLen();
    var h = len * grid.rowH;
    if (grid.sizer) grid.sizer.style.height = h + 'px';
  }

  function onScroll() {
    if (!grid.container) return;
    var top = grid.container.scrollTop;
    grid.lastScrollTop = top;
    var first = Math.floor(top / grid.rowH);
    renderWindow(first, false);
    syncHeaderScroll();
  }

  // Keep the sticky header's horizontal position aligned with body scroll. With a
  // CSS position:sticky header this is usually automatic, but we also mirror the
  // horizontal scroll defensively in case the header is a separate scroll context.
  function syncHeaderScroll() {
    if (!grid.header || !grid.container) return;
    var x = grid.container.scrollLeft;
    // Only translate if header is not naturally tracking horizontal scroll.
    grid.header.style.transform = x ? 'translateX(' + 0 + 'px)' : '';
  }

  // ---------------------------------------------------------------------------
  // Public refresh (debounced)
  // ---------------------------------------------------------------------------

  function doRefresh() {
    grid._refreshScheduled = false;
    if (!grid.container) return;
    applyRowHVar();
    updateSizer();
    // Re-render the current window from scratch (force=true) so cell contents,
    // selection, highlight, find state are all up to date.
    var first = Math.floor((grid.lastScrollTop >= 0 ? grid.lastScrollTop : grid.container.scrollTop) / grid.rowH);
    renderWindow(first, true);
  }

  function scheduleRefresh() {
    if (grid._refreshScheduled) return;
    grid._refreshScheduled = true;
    // ~16ms debounce via rAF-ish timeout.
    setTimeout(doRefresh, 16);
  }

  // ---------------------------------------------------------------------------
  // Selection / interaction
  // ---------------------------------------------------------------------------

  function viewPosFromEvent(e) {
    var node = e.target;
    while (node && node !== grid.rowsEl) {
      if (node.classList && node.classList.contains('row')) {
        var vp = node.getAttribute('data-viewpos');
        if (vp != null) return parseInt(vp, 10);
      }
      node = node.parentNode;
    }
    return -1;
  }

  function selectPos(pos, additive, range) {
    var s = store();
    var len = viewLen();
    if (len === 0) return;
    pos = clamp(pos, 0, len - 1);

    if (typeof s.selectViewPos === 'function') {
      s.selectViewPos(pos, additive, range);
      if (!additive && !range) grid.anchor = pos;
      else if (!range) grid.anchor = pos;
      return;
    }

    // Fallback selection logic if store helper is absent.
    var set;
    if (range) {
      set = new Set();
      var lo = Math.min(grid.anchor, pos);
      var hi = Math.max(grid.anchor, pos);
      for (var i = lo; i <= hi; i++) set.add(i);
    } else if (additive) {
      set = new Set(s.selection || []);
      if (set.has(pos)) set.delete(pos);
      else set.add(pos);
      grid.anchor = pos;
    } else {
      set = new Set([pos]);
      grid.anchor = pos;
    }
    s.setSelection(set, pos);
  }

  // Walk up from a node to the nearest .code-tag within a row, or null.
  function codeTagFrom(node) {
    while (node && node !== grid.rowsEl) {
      if (node.classList && node.classList.contains('code-tag')) return node;
      node = node.parentNode;
    }
    return null;
  }

  function onClick(e) {
    // A click on a decorated error-code chip opens the lookup without changing
    // the row selection.
    var tag = codeTagFrom(e.target);
    if (tag) {
      var code = tag.dataset ? tag.dataset.code : tag.getAttribute('data-code');
      e.stopPropagation();
      if (code && CMT.ui && typeof CMT.ui.openErrorLookup === 'function') {
        CMT.ui.openErrorLookup(code);
      }
      return;
    }
    var pos = viewPosFromEvent(e);
    if (pos < 0) return;
    var additive = e.ctrlKey || e.metaKey;
    var range = e.shiftKey;
    selectPos(pos, additive, range);
  }

  function openDetail(pos) {
    var s = store();
    if (pos < 0 || pos >= viewLen()) return;
    selectPos(pos, false, false);
    var entry = s.getEntry(pos);
    if (entry && CMT.ui && typeof CMT.ui.showDetail === 'function') {
      CMT.ui.showDetail(entry);
    }
  }

  function onDblClick(e) {
    var pos = viewPosFromEvent(e);
    if (pos < 0) return;
    openDetail(pos);
  }

  function onKeyDown(e) {
    var s = store();
    var len = viewLen();
    if (len === 0) return;
    var active = s.activeViewPos != null && s.activeViewPos >= 0 ? s.activeViewPos : 0;
    var page = Math.max(1, visibleCount() - 1);
    var handled = true;
    var next = active;

    switch (e.key) {
      case 'ArrowDown':
        next = clamp(active + 1, 0, len - 1);
        break;
      case 'ArrowUp':
        next = clamp(active - 1, 0, len - 1);
        break;
      case 'PageDown':
        next = clamp(active + page, 0, len - 1);
        break;
      case 'PageUp':
        next = clamp(active - page, 0, len - 1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = len - 1;
        break;
      case 'Enter':
        openDetail(active);
        handled = true;
        e.preventDefault();
        return;
      default:
        handled = false;
    }

    if (!handled) return;
    e.preventDefault();
    var additive = e.ctrlKey || e.metaKey;
    var range = e.shiftKey;
    selectPos(next, false, range);
    if (!range && !additive) grid.anchor = next;
    grid.scrollToViewPos(next, false);
  }

  // ---------------------------------------------------------------------------
  // Column resizing
  // ---------------------------------------------------------------------------

  function setupResizers() {
    var resizers = grid.header.querySelectorAll('.col-resizer');
    for (var i = 0; i < resizers.length; i++) {
      bindResizer(resizers[i]);
    }
  }

  function bindResizer(handle) {
    var colCell = handle.closest ? handle.closest('.col') : ancestorWithClass(handle, 'col');
    if (!colCell) return;
    var colKey = colCell.getAttribute('data-col');
    if (!colKey || colKey === 'text') return; // flex column not resizable directly

    handle.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var startX = e.clientX;
      var cols = getColumns();
      var startW = cols[colKey] || DEFAULT_COLS[colKey];
      var pointerId = e.pointerId;
      try {
        handle.setPointerCapture(pointerId);
      } catch (err) {
        /* ignore */
      }
      document.documentElement.classList.add('col-resizing');

      function move(ev) {
        var dx = ev.clientX - startX;
        var w = Math.max(MIN_COL_W, Math.round(startW + dx));
        var live = getColumns();
        live[colKey] = w;
        applyGridCols(live);
      }
      function up(ev) {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        try {
          handle.releasePointerCapture(pointerId);
        } catch (err2) {
          /* ignore */
        }
        document.documentElement.classList.remove('col-resizing');
        var dx = ev.clientX - startX;
        var w = Math.max(MIN_COL_W, Math.round(startW + dx));
        persistColumnWidth(colKey, w);
      }
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }

  function persistColumnWidth(colKey, w) {
    var s = store();
    if (!s.settings) s.settings = {};
    if (!s.settings.columns) s.settings.columns = {};
    s.settings.columns[colKey] = w;
    var cols = getColumns();
    applyGridCols(cols);
    if (typeof s.saveSettings === 'function') s.saveSettings();
  }

  function ancestorWithClass(node, cls) {
    while (node) {
      if (node.classList && node.classList.contains(cls)) return node;
      node = node.parentNode;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Store event wiring
  // ---------------------------------------------------------------------------

  function wireStore() {
    var s = store();
    if (!s || typeof s.on !== 'function') return;

    s.on('view', function () {
      // View length changed — sizer + window must update.
      applyRowHVar();
      updateSizer();
      // Clamp scroll if the view shrank. Use the true scrollable extent
      // (includes the sticky header's flow height) so we don't clamp short.
      if (grid.container) {
        var maxTop = Math.max(0, grid.container.scrollHeight - grid.container.clientHeight);
        if (grid.container.scrollTop > maxTop) grid.container.scrollTop = maxTop;
      }
      scheduleRefresh();
    });

    s.on('data', function () {
      applyRowHVar();
      updateSizer();
      // Auto-scroll to bottom when tailing and fresh data arrived.
      if (s.tail) {
        scrollToBottom();
      }
      scheduleRefresh();
    });

    s.on('selection', function () {
      scheduleRefresh();
    });

    s.on('highlight', function () {
      grid._hlCompiled = null; // invalidate cache
      scheduleRefresh();
    });

    s.on('tail', function () {
      if (s.tail) scrollToBottom();
    });
  }

  function scrollToBottom() {
    var len = viewLen();
    if (len === 0 || !grid.container) return;
    applyRowHVar();
    updateSizer();
    // Use the true scrollable extent (sticky header flow height + rows) so the
    // newest row is fully visible when tailing; len*rowH alone is headerH short.
    var maxTop = grid.container.scrollHeight - grid.container.clientHeight;
    grid.container.scrollTop = Math.max(0, maxTop);
    onScroll();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  grid.init = function (container) {
    grid.container = container || document.getElementById('grid');
    if (!grid.container) return;

    grid.header = grid.container.querySelector('#grid-header') || document.getElementById('grid-header');
    grid.body = grid.container.querySelector('#grid-body') || document.getElementById('grid-body');
    grid.sizer = (grid.body && grid.body.querySelector('#grid-sizer')) || document.getElementById('grid-sizer');
    grid.rowsEl = (grid.body && grid.body.querySelector('#grid-rows')) || document.getElementById('grid-rows');

    if (!grid.rowsEl || !grid.sizer || !grid.body) {
      // The DOM contract requires these; bail gracefully if absent.
      return;
    }

    applyRowHVar();
    applyGridCols(getColumns());

    // Build an initial pool sized to the viewport.
    ensurePool(visibleCount() + OVERSCAN * 2);
    updateSizer();
    renderWindow(0, true);

    // Make the grid focusable for keyboard navigation.
    if (!grid.container.hasAttribute('tabindex')) {
      grid.container.setAttribute('tabindex', '0');
    }

    // Events.
    grid.container.addEventListener('scroll', onScroll, { passive: true });
    grid.rowsEl.addEventListener('click', onClick);
    grid.rowsEl.addEventListener('dblclick', onDblClick);
    grid.container.addEventListener('keydown', onKeyDown);

    // Column resize handles.
    if (grid.header) setupResizers();

    // Re-apply the column template when crossing the mobile/desktop breakpoint
    // (e.g. rotating a phone) so the responsive layout takes over and back.
    window.addEventListener('resize', function () {
      applyGridCols(getColumns());
    });

    // Keep rows sized correctly when the container resizes.
    if (typeof ResizeObserver !== 'undefined') {
      var ro = new ResizeObserver(function () {
        ensurePool(visibleCount() + OVERSCAN * 2);
        scheduleRefresh();
      });
      ro.observe(grid.container);
    } else {
      window.addEventListener('resize', function () {
        ensurePool(visibleCount() + OVERSCAN * 2);
        scheduleRefresh();
      });
    }

    wireStore();
  };

  // Re-render from store.view.
  grid.refresh = function () {
    if (!grid.container) return;
    grid._hlCompiled = null;
    applyRowHVar();
    applyGridCols(getColumns());
    updateSizer();
    var first = Math.floor(grid.container.scrollTop / grid.rowH);
    renderWindow(first, true);
  };

  // Scroll so that the given view position is visible. center=true centres it.
  grid.scrollToViewPos = function (pos, center) {
    if (!grid.container) return;
    var len = viewLen();
    if (len === 0) return;
    pos = clamp(pos, 0, len - 1);
    applyRowHVar();
    // The sticky #grid-header occupies real flow space above #grid-body, and
    // #grid-rows is top:0 within #grid-body. So a row's true content-top is
    // headerH + pos*rowH — the header offset must be included everywhere a row's
    // absolute content position (or the max scrollTop) is computed.
    var headerH = grid.header ? grid.header.offsetHeight : 0;
    var rowTop = headerH + pos * grid.rowH;
    var rowBottom = rowTop + grid.rowH;
    var viewTop = grid.container.scrollTop;
    var viewH = grid.container.clientHeight;
    // The top headerH px of the viewport are covered by the sticky header, so
    // the first fully-visible content starts at viewTop + headerH.
    var visibleTop = viewTop + headerH;
    var viewBottom = viewTop + viewH;

    var target = viewTop;
    if (center) {
      target = rowTop - viewH / 2 + grid.rowH / 2;
    } else if (rowTop < visibleTop) {
      // Hidden behind (or above) the sticky header — bring it just below it.
      target = rowTop - headerH;
    } else if (rowBottom > viewBottom) {
      // Below the viewport — align its bottom to the viewport bottom.
      target = rowBottom - viewH;
    } else {
      // Already fully visible; nothing to do.
      onScroll();
      return;
    }
    var maxTop = Math.max(0, headerH + len * grid.rowH - viewH);
    grid.container.scrollTop = clamp(Math.round(target), 0, maxTop);
    onScroll();
  };

  // Mark a view position as the current find target (find-match styling) and the
  // active row, then render. Pass a number; null clears the find target.
  grid.setActive = function (viewPos) {
    var s = store();
    if (viewPos == null || viewPos < 0) {
      grid._findTarget = null;
    } else {
      grid._findTarget = viewPos;
      if (typeof s.setSelection === 'function' && (!s.selection || !s.selection.size)) {
        // Do not stomp an existing multi-selection; just track active.
      }
      if ('activeViewPos' in s) s.activeViewPos = viewPos;
      grid.scrollToViewPos(viewPos, true);
    }
    scheduleRefresh();
  };

  // Mirror header horizontal scroll (exposed per contract).
  grid.syncHeaderScroll = syncHeaderScroll;

  CMT.grid = grid;
})();
