window.CMT = window.CMT || {};

/*
 * CMT.ui — manages all modals, panels, toasts, status bar, find bar,
 * detail view, filter/highlight/error-lookup/goto/stats/settings modals and
 * the command palette.
 *
 * It is the glue between the user-facing chrome and the data store / grid:
 * it reads/writes CMT.store, drives CMT.grid where navigation is needed, and
 * formats values via CMT.util. It performs NO parsing or file IO itself.
 */
(function () {
  'use strict';

  // ---- short-hands (resolved lazily so load-order quirks never throw) ----
  function util() { return CMT.util; }
  function store() { return CMT.store; }
  function grid() { return CMT.grid; }
  function filter() { return CMT.filter; }
  function search() { return CMT.search; }
  function errorlookup() { return CMT.errorlookup; }

  function $(id) { return document.getElementById(id); }

  /**
   * Set textContent safely (no-op when the node is absent).
   * @param {string} id
   * @param {string} text
   */
  function setText(id, text) {
    var node = $(id);
    if (node) node.textContent = text == null ? '' : String(text);
  }

  // -----------------------------------------------------------------------
  //  Module-local find state. Tracks the current match position and the
  //  cached list of all matches so the count can be shown without rescanning
  //  on every keypress where the spec is unchanged.
  // -----------------------------------------------------------------------
  var findState = {
    matches: [],     // view positions of all matches for the last spec
    current: -1,     // index into findState.matches of the current target
    specKey: null    // serialized spec the cache belongs to
  };

  // Command palette navigation state.
  var paletteState = {
    items: [],       // currently rendered {label, run}
    active: 0        // highlighted index
  };

  // The entry currently shown in the detail modal (for prev/next + copy).
  var detailViewPos = -1;

  // =======================================================================
  //  MODALS
  // =======================================================================

  /**
   * Show a modal backdrop by id and focus its first sensible control.
   * @param {string} id
   */
  function openModal(id) {
    var node = $(id);
    if (!node) return;
    node.hidden = false;
    node.classList.add('open');
    // Focus the first focusable control inside the modal for accessibility.
    var focusable = node.querySelector(
      'input, select, textarea, button, [tabindex]:not([tabindex="-1"])'
    );
    if (focusable) {
      try { focusable.focus(); } catch (e) { /* ignore */ }
    }
  }

  /**
   * Hide a modal backdrop by id.
   * @param {string} id
   */
  function closeModal(id) {
    var node = $(id);
    if (!node) return;
    node.hidden = true;
    node.classList.remove('open');
  }

  /**
   * Close every open modal and the command palette.
   */
  function closeAll() {
    var backdrops = document.querySelectorAll('.modal-backdrop');
    for (var i = 0; i < backdrops.length; i++) {
      backdrops[i].hidden = true;
      backdrops[i].classList.remove('open');
    }
    var palette = $('palette');
    if (palette) palette.hidden = true;
  }

  /**
   * True when at least one modal (or the palette) is currently open.
   * Used by the app-level Esc handler to know whether to close chrome.
   * @returns {boolean}
   */
  function anyOpen() {
    var backdrops = document.querySelectorAll('.modal-backdrop');
    for (var i = 0; i < backdrops.length; i++) {
      if (!backdrops[i].hidden) return true;
    }
    var palette = $('palette');
    if (palette && !palette.hidden) return true;
    return false;
  }

  // =======================================================================
  //  TOASTS
  // =======================================================================

  /**
   * Show a transient toast notification.
   * @param {string} msg
   * @param {"info"|"success"|"warn"|"error"} [kind="info"]
   */
  function toast(msg, kind) {
    var container = $('toasts');
    if (!container) return;
    kind = kind || 'info';

    var node = util().el('div', {
      className: 'toast toast-' + kind,
      role: 'status',
      text: msg == null ? '' : String(msg)
    });
    container.appendChild(node);

    // Trigger the enter transition on the next frame.
    requestAnimationFrame(function () {
      node.classList.add('show');
    });

    var removed = false;
    function remove() {
      if (removed) return;
      removed = true;
      node.classList.remove('show');
      node.classList.add('hide');
      setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, 300);
    }

    // Auto-dismiss after ~3.5s; click dismisses immediately.
    var timer = setTimeout(remove, 3500);
    node.addEventListener('click', function () {
      clearTimeout(timer);
      remove();
    });
  }

  // =======================================================================
  //  PROGRESS
  // =======================================================================

  /**
   * Drive the progress overlay and the status-bar progress mirror.
   * @param {number} frac 0..1
   * @param {string} [text]
   */
  function showProgress(frac, text) {
    var overlay = $('progress');
    var bar = $('progress-bar');
    var label = $('progress-text');
    var statusProgress = $('status-progress');

    var pct = util().clamp(frac == null ? 0 : frac, 0, 1) * 100;
    var pctStr = pct.toFixed(0) + '%';

    if (overlay) overlay.hidden = false;
    if (bar) bar.style.width = pctStr;
    if (label) label.textContent = text != null ? text : ('Loading… ' + pctStr);
    if (statusProgress) {
      statusProgress.textContent = (text != null ? text + ' ' : '') + pctStr;
      statusProgress.hidden = false;
    }
  }

  /**
   * Hide the progress overlay and clear the status-bar mirror.
   */
  function hideProgress() {
    var overlay = $('progress');
    var bar = $('progress-bar');
    var statusProgress = $('status-progress');
    if (overlay) overlay.hidden = true;
    if (bar) bar.style.width = '0%';
    if (statusProgress) {
      statusProgress.textContent = '';
      statusProgress.hidden = true;
    }
  }

  // =======================================================================
  //  STATUS BAR
  // =======================================================================

  /**
   * Read store.stats() and reflect it across the status bar + quick filters.
   */
  function updateStatusBar() {
    var s = store();
    if (!s || typeof s.stats !== 'function') return;
    var st = s.stats();
    var u = util();

    // --- main counts (total / errors / warnings / info), colored ---
    var counts = $('status-counts');
    if (counts) {
      counts.innerHTML = '';
      counts.appendChild(u.el('span', {
        className: 'sc sc-total',
        text: fmtNum(st.total) + ' lines'
      }));
      counts.appendChild(u.el('span', {
        className: 'sc sc-error',
        text: fmtNum(st.errors) + ' err'
      }));
      counts.appendChild(u.el('span', {
        className: 'sc sc-warn',
        text: fmtNum(st.warnings) + ' warn'
      }));
      counts.appendChild(u.el('span', {
        className: 'sc sc-info',
        text: fmtNum(st.info) + ' info'
      }));
    }

    // --- quick-toggle counts ---
    setText('cnt-error', fmtNum(st.errors));
    setText('cnt-warn', fmtNum(st.warnings));
    setText('cnt-info', fmtNum(st.info));

    // --- format(s) of the open files ---
    var format = '—';
    if (st.fileCount > 0 && s.state && s.state.files instanceof Map) {
      var formats = {};
      s.state.files.forEach(function (f) {
        if (f && f.format) formats[f.format] = true;
      });
      var keys = Object.keys(formats);
      if (keys.length) format = keys.join(', ');
    }
    setText('status-format', format);

    // --- time range ---
    var range = '—';
    if (st.timeFrom != null && st.timeTo != null) {
      range = u.formatDateTime(st.timeFrom) + '  →  ' + u.formatDateTime(st.timeTo);
    } else if (st.timeFrom != null) {
      range = u.formatDateTime(st.timeFrom);
    }
    setText('status-range', range);

    // --- selection size ---
    var selSize = 0;
    if (s.state && s.state.selection instanceof Set) selSize = s.state.selection.size;
    setText('status-selection', selSize + ' selected');

    // --- tail indicator ---
    var tailOn = !!(s.state && s.state.tail);
    var tailNode = $('status-tail');
    if (tailNode) {
      tailNode.textContent = 'Tail: ' + (tailOn ? 'ON' : 'OFF');
      tailNode.classList.toggle('on', tailOn);
    }
  }

  function fmtNum(n) {
    if (n == null || isNaN(n)) return '0';
    return Number(n).toLocaleString();
  }

  // =======================================================================
  //  DETAIL MODAL
  // =======================================================================

  /**
   * Render a clean key/value view of every entry field, plus the raw block and
   * any detected error codes (clickable to open the error-lookup modal).
   * @param {object} entry
   */
  function showDetail(entry) {
    var content = $('detail-content');
    if (!content || !entry) return;
    // Track the view position so prev/next can navigate.
    detailViewPos = viewPosOfEntry(entry);
    renderEntryInto(content, entry);
    openModal('modal-detail');
  }

  /**
   * Render the full content of a log entry (fields, message, detected codes,
   * raw) into a container. Shared by the detail modal and the docked detail
   * pane so both stay identical.
   * @param {Element} content
   * @param {object} entry
   */
  function renderEntryInto(content, entry) {
    if (!content || !entry) return;
    var u = util();

    content.innerHTML = '';

    var typeName = entry.type === 3 ? 'Error'
      : entry.type === 2 ? 'Warning' : 'Information';

    // --- message block (the most important content — shown FIRST so it is
    //     never pushed out of view in the short docked pane) ---
    content.appendChild(u.el('h4', { className: 'detail-h', text: 'Message' }));
    content.appendChild(u.el('pre', {
      className: 'detail-message',
      text: entry.message == null ? '' : entry.message
    }));

    // --- detected error codes (+ knowledge base) ---
    var lk = errorlookup();
    if (lk && typeof lk.extractCodes === 'function') {
      var haystack = (entry.message || '') + '\n' + (entry.raw || '');
      var codes = lk.extractCodes(haystack);
      if (codes && codes.length) {
        content.appendChild(u.el('h4', { className: 'detail-h', text: 'Detected codes' }));
        var list = u.el('div', { className: 'detail-codes' });
        for (var c = 0; c < codes.length; c++) {
          list.appendChild(buildCodeChip(codes[c]));
        }
        content.appendChild(list);

        // For any detected code with a curated KB entry, show cause/fix + a
        // Microsoft Learn link beneath the chips. Dedupe so each code shows once.
        var kbSeen = Object.create(null);
        for (var d = 0; d < codes.length; d++) {
          if (kbSeen[codes[d]]) continue;
          kbSeen[codes[d]] = true;
          appendKnowledgeBase(content, codes[d]);
        }
      }
    }

    // --- compact metadata chips (wrap horizontally instead of a tall list,
    //     so they do not crowd out the Message / Raw blocks) ---
    var fileName = (store() && typeof store().fileName === 'function')
      ? store().fileName(entry.fileId) : (entry.fileId || '');
    var rows = [
      ['Severity', typeName],
      ['File', fileName || '—'],
      ['Component', entry.component || '—'],
      ['Thread', entry.thread || '—'],
      ['Context', entry.context || '—'],
      ['Source', entry.source || '—'],
      ['Date', entry.dateText || '—'],
      ['Time', entry.timeText || '—'],
      ['Timestamp', entry.time != null ? u.formatDateTime(entry.time) : '—'],
      ['Index', String(entry.idx)]
    ];
    var meta = u.el('div', { className: 'detail-meta' });
    for (var i = 0; i < rows.length; i++) {
      meta.appendChild(u.el('span', { className: 'meta-item' }, [
        u.el('span', { className: 'meta-k', text: rows[i][0] }),
        u.el('span', { className: 'meta-v', text: rows[i][1] })
      ]));
    }
    content.appendChild(meta);

    // --- raw block ---
    content.appendChild(u.el('h4', { className: 'detail-h', text: 'Raw' }));
    content.appendChild(u.el('pre', {
      className: 'detail-raw',
      text: entry.raw == null ? '' : entry.raw
    }));
  }

  /* ----------------------------------------------------------------------
   * Detail pane — docked under the grid; updates on a single row click so
   * you can read the full (untruncated) content of the selected log line.
   * -------------------------------------------------------------------- */

  function isDetailPaneOpen() {
    var s = store();
    return !!(s && s.state && s.state.settings && s.state.settings.detailPaneOpen);
  }

  function paneHasData() {
    var s = store();
    return !!(s && s.state && s.state.entries && s.state.entries.length);
  }

  /** The entry the pane should show: the active row, else first selected. */
  function activePaneEntry() {
    var s = store();
    if (!s || !s.state) return null;
    var pos = s.state.activeViewPos;
    if ((typeof pos !== 'number' || pos < 0) && s.state.selection && s.state.selection.size) {
      pos = Math.min.apply(null, Array.prototype.slice.call(s.state.selection));
    }
    if (typeof pos !== 'number' || pos < 0) return null;
    return typeof s.getEntry === 'function' ? s.getEntry(pos) : null;
  }

  /** Show/hide + repopulate the docked detail pane from current state. */
  function updateDetailPane() {
    var pane = $('detail-pane');
    if (!pane) return;
    var show = isDetailPaneOpen() && paneHasData();
    pane.hidden = !show;
    var btn = $('btn-detail');
    if (btn) btn.setAttribute('aria-pressed', isDetailPaneOpen() ? 'true' : 'false');
    // Grid height changed when the pane shows/hides; nudge it to re-render.
    if (grid() && typeof grid().refresh === 'function') grid().refresh();
    if (!show) return;

    var content = $('detail-pane-content');
    var titleEl = $('detail-pane-title');
    var entry = activePaneEntry();
    if (!entry) {
      if (content) content.innerHTML = '<p class="detail-pane-empty">Select a log line to see its full content.</p>';
      if (titleEl) titleEl.textContent = 'Entry detail';
      return;
    }
    if (titleEl) {
      var u = util();
      var t = entry.type === 3 ? 'Error' : entry.type === 2 ? 'Warning' : 'Info';
      titleEl.innerHTML = '';
      titleEl.appendChild(u.el('span', { className: 'dp-sev t' + entry.type, text: t }));
      var meta = (entry.component || 'entry')
        + '  ·  ' + (entry.time != null ? u.formatDateTime(entry.time) : (entry.timeText || ''))
        + (entry.thread ? '  ·  thread ' + entry.thread : '');
      titleEl.appendChild(document.createTextNode(meta));
    }
    renderEntryInto(content, entry);
  }

  function setDetailPaneOpen(open, persist) {
    var s = store();
    if (s && s.state && s.state.settings) s.state.settings.detailPaneOpen = !!open;
    if (persist && s && typeof s.saveSettings === 'function') s.saveSettings();
    updateDetailPane();
  }

  function toggleDetailPane() { setDetailPaneOpen(!isDetailPaneOpen(), true); }

  /** Drag the top edge of the pane to resize its height (persisted). */
  function wireDetailPane() {
    var pane = $('detail-pane');
    if (!pane) return;

    var s = store();
    var saved = s && s.state && s.state.settings && s.state.settings.detailPaneHeight;
    if (saved) pane.style.setProperty('--detail-pane-h', saved + 'px');

    bindClick('detail-pane-close', function () { setDetailPaneOpen(false, true); });
    bindClick('detail-pane-expand', function () {
      var e = activePaneEntry();
      if (e) showDetail(e);
    });

    var rez = $('detail-pane-resizer');
    if (rez) {
      var dragging = false, startY = 0, startH = 0;
      var onMove = function (e) {
        if (!dragging) return;
        var main = $('main');
        var maxH = main ? main.clientHeight * 0.75 : 600;
        var h = Math.max(88, Math.min(maxH, startH + (startY - e.clientY)));
        pane.style.setProperty('--detail-pane-h', h + 'px');
      };
      var onUp = function () {
        if (!dragging) return;
        dragging = false;
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.body.style.userSelect = '';
        var h = parseInt(pane.getBoundingClientRect().height, 10);
        var st = store();
        if (h && st && st.state && st.state.settings) {
          st.state.settings.detailPaneHeight = h;
          if (typeof st.saveSettings === 'function') st.saveSettings();
        }
        if (grid() && typeof grid().refresh === 'function') grid().refresh();
      };
      rez.addEventListener('pointerdown', function (e) {
        dragging = true;
        startY = e.clientY;
        startH = pane.getBoundingClientRect().height;
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        document.body.style.userSelect = 'none';
        e.preventDefault();
      });
    }
  }

  /**
   * Build a clickable chip for a detected error code, annotated with its
   * resolved name when available. Clicking opens the error-lookup modal.
   * @param {string} code
   * @param {string} code
   * @returns {Element}
   */
  function buildCodeChip(code) {
    var u = util();
    var lk = errorlookup();
    var label = code;
    if (lk && typeof lk.lookup === 'function') {
      var res = lk.lookup(code);
      if (res && res.name) label = code + ' — ' + res.name;
    }
    return u.el('button', {
      className: 'code-chip',
      type: 'button',
      title: 'Look up ' + code,
      text: label,
      onClick: function () { openErrorLookup(code); }
    });
  }

  /**
   * Find the view position of a given entry (by idx) within the current view.
   * @param {object} entry
   * @returns {number} view position or -1
   */
  function viewPosOfEntry(entry) {
    var s = store();
    if (!s || !s.state || !Array.isArray(s.state.view)) return -1;
    var view = s.state.view;
    for (var i = 0; i < view.length; i++) {
      if (view[i] === entry.idx) return i;
    }
    return -1;
  }

  /**
   * Move the detail view to the previous/next entry in the filtered view.
   * @param {number} delta -1 or +1
   */
  function moveDetail(delta) {
    var s = store();
    if (!s || !s.state || !Array.isArray(s.state.view)) return;
    var view = s.state.view;
    if (view.length === 0) return;

    var next = detailViewPos + delta;
    next = util().clamp(next, 0, view.length - 1);
    if (next === detailViewPos) return;

    var entry = typeof s.entryAt === 'function'
      ? s.entryAt(next)
      : (typeof s.getEntry === 'function' ? s.getEntry(next) : null);
    if (!entry) return;

    // Keep grid selection in sync with what we are inspecting.
    if (typeof s.setSelection === 'function') {
      s.setSelection(new Set([next]), next);
    }
    if (grid() && typeof grid().scrollToViewPos === 'function') {
      grid().scrollToViewPos(next, true);
    }
    showDetail(entry);
  }

  /**
   * Copy the current detail entry's message to the clipboard.
   */
  function copyDetail() {
    var s = store();
    if (!s) return;
    var entry = null;
    if (detailViewPos >= 0) {
      entry = typeof s.entryAt === 'function'
        ? s.entryAt(detailViewPos)
        : (typeof s.getEntry === 'function' ? s.getEntry(detailViewPos) : null);
    }
    var text = entry ? (entry.message == null ? '' : entry.message) : '';
    copyText(text, 'Message copied');
  }

  /**
   * Clipboard helper with a graceful fallback for file:// / no-permission.
   * @param {string} text
   * @param {string} okMsg
   */
  function copyText(text, okMsg) {
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        toast(okMsg, 'success');
      } catch (e) {
        toast('Could not copy to clipboard', 'error');
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast(okMsg, 'success');
      }, fallback);
    } else {
      fallback();
    }
  }

  // =======================================================================
  //  FILTER MODAL
  // =======================================================================

  /**
   * Populate the filter modal from the current store + filterSpec and show it.
   */
  function openFilter() {
    var s = store();
    if (!s || !s.state) { openModal('modal-filter'); return; }
    var spec = s.state.filterSpec || filter().makeSpec();
    var entries = s.state.entries || [];

    // --- text fields ---
    var textInput = $('filter-text');
    if (textInput) textInput.value = spec.text || '';
    var modeSel = $('filter-mode');
    if (modeSel) modeSel.value = spec.textMode || 'contains';
    var caseChk = $('filter-case');
    if (caseChk) caseChk.checked = !!spec.caseSensitive;

    // --- type checkboxes ---
    setChecked('filter-type-1', spec.types ? spec.types[1] !== false : true);
    setChecked('filter-type-2', spec.types ? spec.types[2] !== false : true);
    setChecked('filter-type-3', spec.types ? spec.types[3] !== false : true);

    // --- time range ---
    var fromInput = $('filter-time-from');
    if (fromInput) fromInput.value = spec.timeFrom != null ? toLocalInput(spec.timeFrom) : '';
    var toInput = $('filter-time-to');
    if (toInput) toInput.value = spec.timeTo != null ? toLocalInput(spec.timeTo) : '';

    // --- distinct component + thread checkbox lists ---
    var comps = distinctValues(entries, 'component');
    var threads = distinctValues(entries, 'thread');
    renderCheckList($('filter-components'), comps, spec.components, 'comp');
    renderCheckList($('filter-threads'), threads, spec.threads, 'thread');

    openModal('modal-filter');
  }

  function setChecked(id, val) {
    var node = $(id);
    if (node) node.checked = !!val;
  }

  /**
   * Collect distinct non-empty values of a field across entries.
   * Capped to keep the modal responsive on very large logs.
   * @param {object[]} entries
   * @param {string} field
   * @returns {string[]} sorted distinct values
   */
  function distinctValues(entries, field) {
    var set = new Set();
    var MAX = 2000; // safety cap on distinct values rendered
    for (var i = 0; i < entries.length; i++) {
      var v = entries[i][field];
      if (v) set.add(v);
      if (set.size >= MAX) break;
    }
    var arr = Array.from(set);
    arr.sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; });
    return arr;
  }

  /**
   * Render a list of value checkboxes. When `selectedSet` is null every box is
   * checked (meaning "all allowed"); otherwise only members of the set are.
   * @param {Element} container
   * @param {string[]} values
   * @param {Set<string>|null} selectedSet
   * @param {string} kind used for data attribute / input name
   */
  function renderCheckList(container, values, selectedSet, kind) {
    if (!container) return;
    var u = util();
    container.innerHTML = '';

    if (values.length === 0) {
      container.appendChild(u.el('div', { className: 'check-empty', text: '(none)' }));
      return;
    }

    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      var checked = selectedSet == null ? true : selectedSet.has(v);
      var label = u.el('label', { className: 'check-row' });
      var box = u.el('input', {
        type: 'checkbox',
        value: v,
        dataset: { kind: kind }
      });
      box.checked = checked;
      label.appendChild(box);
      label.appendChild(u.el('span', { className: 'check-label', text: v }));
      container.appendChild(label);
    }
  }

  /**
   * Read all selected values from a check-list container.
   * Returns null when every box is checked (== "all allowed").
   * @param {Element} container
   * @returns {Set<string>|null}
   */
  function readCheckList(container) {
    if (!container) return null;
    var boxes = container.querySelectorAll('input[type="checkbox"]');
    if (boxes.length === 0) return null;
    var set = new Set();
    var all = true;
    for (var i = 0; i < boxes.length; i++) {
      if (boxes[i].checked) set.add(boxes[i].value);
      else all = false;
    }
    return all ? null : set;
  }

  /**
   * Read the filter modal fields into a FilterSpec and apply it.
   */
  function applyFilterFromUI() {
    var spec = filter().makeSpec();

    var textInput = $('filter-text');
    spec.text = textInput ? textInput.value : '';
    var modeSel = $('filter-mode');
    spec.textMode = modeSel ? modeSel.value : 'contains';
    var caseChk = $('filter-case');
    spec.caseSensitive = caseChk ? !!caseChk.checked : false;

    spec.types = {
      1: isChecked('filter-type-1'),
      2: isChecked('filter-type-2'),
      3: isChecked('filter-type-3')
    };

    spec.components = readCheckList($('filter-components'));
    spec.threads = readCheckList($('filter-threads'));

    spec.timeFrom = parseLocalInput($('filter-time-from'));
    spec.timeTo = parseLocalInput($('filter-time-to'));

    var s = store();
    if (s && typeof s.setFilter === 'function') s.setFilter(spec);
    closeModal('modal-filter');
    toast('Filter applied', 'success');
  }

  function isChecked(id) {
    var node = $(id);
    return node ? !!node.checked : true;
  }

  /**
   * Reset the filter to the empty spec (everything visible).
   */
  function resetFilter() {
    var s = store();
    if (s && typeof s.setFilter === 'function') s.setFilter(filter().makeSpec());
    // Re-render the modal to reflect the cleared state if it is still open.
    if ($('modal-filter') && !$('modal-filter').hidden) openFilter();
    toast('Filter reset', 'info');
  }

  /**
   * Convert epoch ms to a value usable by <input type="datetime-local">.
   * @param {number} epochMs
   * @returns {string}
   */
  function toLocalInput(epochMs) {
    var d = new Date(epochMs);
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  /**
   * Parse a datetime-local / free-text time input into epoch ms.
   * @param {Element} node
   * @returns {number|null}
   */
  function parseLocalInput(node) {
    if (!node) return null;
    var v = (node.value || '').trim();
    if (!v) return null;
    var ms = Date.parse(v);
    return isNaN(ms) ? null : ms;
  }

  // =======================================================================
  //  HIGHLIGHT MODAL
  // =======================================================================

  /**
   * Open the highlight rules modal and render the current rules.
   */
  function openHighlight() {
    renderHighlightList();
    openModal('modal-highlight');
  }

  /**
   * Render the list of highlight rules with color swatch + toggle + remove.
   */
  function renderHighlightList() {
    var listEl = $('hl-list');
    if (!listEl) return;
    var s = store();
    var u = util();
    listEl.innerHTML = '';

    var rules = (s && s.state && Array.isArray(s.state.highlightRules))
      ? s.state.highlightRules : [];

    if (rules.length === 0) {
      listEl.appendChild(u.el('div', { className: 'hl-empty', text: 'No highlight rules yet.' }));
      return;
    }

    for (var i = 0; i < rules.length; i++) {
      listEl.appendChild(buildHighlightRow(rules[i]));
    }
  }

  function buildHighlightRow(rule) {
    var u = util();
    var s = store();

    var swatch = u.el('span', {
      className: 'hl-swatch',
      style: { backgroundColor: rule.color || '#ffd54f' }
    });

    var toggle = u.el('input', { type: 'checkbox', className: 'hl-toggle' });
    toggle.checked = rule.enabled !== false;
    toggle.addEventListener('change', function () {
      if (s && typeof s.toggleHighlight === 'function') s.toggleHighlight(rule.id);
    });

    var meta = [];
    if (rule.regex) meta.push('regex');
    if (rule.caseSensitive) meta.push('case');
    var metaStr = meta.length ? ' (' + meta.join(', ') + ')' : '';

    var term = u.el('span', {
      className: 'hl-term',
      text: rule.term + metaStr
    });

    var remove = u.el('button', {
      className: 'hl-remove',
      type: 'button',
      title: 'Remove rule',
      text: '✕',
      onClick: function () {
        if (s && typeof s.removeHighlight === 'function') s.removeHighlight(rule.id);
        renderHighlightList();
      }
    });

    return u.el('div', { className: 'hl-row' }, [toggle, swatch, term, remove]);
  }

  /**
   * Read the highlight inputs and add a new rule.
   */
  function addHighlightFromUI() {
    var termInput = $('hl-term');
    var term = termInput ? termInput.value.trim() : '';
    if (!term) {
      toast('Enter a term to highlight', 'warn');
      return;
    }
    var colorInput = $('hl-color');
    var color = colorInput && colorInput.value ? colorInput.value : '#ffd54f';
    var rule = {
      id: util().uid(),
      term: term,
      color: color,
      caseSensitive: isChecked2('hl-case'),
      regex: isChecked2('hl-regex'),
      enabled: true
    };
    var s = store();
    if (s && typeof s.addHighlight === 'function') s.addHighlight(rule);
    if (termInput) termInput.value = '';
    renderHighlightList();
    toast('Highlight added', 'success');
  }

  function isChecked2(id) {
    var node = $(id);
    return node ? !!node.checked : false;
  }

  // =======================================================================
  //  ERROR LOOKUP MODAL
  // =======================================================================

  /**
   * Open the error-lookup modal, optionally prefilled, and run the lookup.
   * @param {string} [prefill]
   */
  function openErrorLookup(prefill) {
    var input = $('err-input');
    if (input && prefill != null) input.value = String(prefill);
    openModal('modal-errorlookup');
    if (prefill != null) runErrorLookup();
    else if (input && input.value) runErrorLookup();
  }

  /**
   * Run the lookup against CMT.errorlookup and render the result.
   */
  function runErrorLookup() {
    var input = $('err-input');
    var resultEl = $('err-result');
    if (!resultEl) return;
    var u = util();
    var lk = errorlookup();

    var raw = input ? input.value.trim() : '';
    resultEl.innerHTML = '';

    if (!raw) {
      resultEl.appendChild(u.el('div', { className: 'err-hint', text: 'Enter a decimal, hex (0x…) or negative error code.' }));
      return;
    }

    var res = lk && typeof lk.lookup === 'function' ? lk.lookup(raw) : null;
    if (!res) {
      resultEl.appendChild(u.el('div', { className: 'err-none', text: 'Not a recognizable error code.' }));
      return;
    }

    var dl = u.el('dl', { className: 'err-fields' });
    var rows = [
      ['Decimal', res.dec != null ? String(res.dec) : '—'],
      ['Hex', res.hex || '—'],
      ['Name', res.name || '—'],
      ['Source', res.source || '—']
    ];
    for (var i = 0; i < rows.length; i++) {
      dl.appendChild(u.el('dt', { text: rows[i][0] }));
      dl.appendChild(u.el('dd', { text: rows[i][1] }));
    }
    resultEl.appendChild(dl);

    resultEl.appendChild(u.el('div', {
      className: 'err-desc',
      text: res.desc || '(no description available)'
    }));

    // --- curated knowledge base: cause / fix / Microsoft Learn link ---
    appendKnowledgeBase(resultEl, raw);
  }

  /**
   * When CMT.errorKB has a curated entry for `code`, append a cause/fix block
   * and a "Microsoft Learn" link to `container`. Graceful no-op otherwise.
   * @param {Element} container
   * @param {string} code
   */
  function appendKnowledgeBase(container, code) {
    if (!container || code == null) return;
    var u = util();
    var kb = CMT.errorKB;
    if (!kb || typeof kb.lookup !== 'function') return;
    var info = kb.lookup(code);
    if (!info) return;

    // Use the .kb-block / .kb-row / .kb-key / .kb-val / .kb-learn structure that
    // css/styles.css styles for this curated help block.
    var block = u.el('div', { className: 'kb-block' });
    if (info.cause) {
      block.appendChild(u.el('div', { className: 'kb-row' }, [
        u.el('span', { className: 'kb-key', text: 'Likely cause' }),
        u.el('span', { className: 'kb-val', text: info.cause })
      ]));
    }
    if (info.fix) {
      block.appendChild(u.el('div', { className: 'kb-row' }, [
        u.el('span', { className: 'kb-key', text: 'How to fix' }),
        u.el('span', { className: 'kb-val', text: info.fix })
      ]));
    }

    var url = typeof kb.learnUrl === 'function' ? kb.learnUrl(code) : info.learn;
    if (url) {
      block.appendChild(u.el('a', {
        className: 'kb-learn',
        text: 'Microsoft Learn ↗',
        href: url,
        target: '_blank',
        rel: 'noopener'
      }));
    }
    container.appendChild(block);
  }

  // =======================================================================
  //  GOTO MODAL
  // =======================================================================

  /**
   * Open the goto-line modal.
   */
  function openGoto() {
    var input = $('goto-input');
    if (input) input.value = '';
    openModal('modal-goto');
  }

  /**
   * Parse the goto input as a 1-based line number and navigate there.
   */
  function runGoto() {
    var input = $('goto-input');
    var s = store();
    if (!input || !s || !s.state) return;
    var raw = input.value.trim();
    var n = parseInt(raw, 10);
    if (isNaN(n)) {
      toast('Enter a line number', 'warn');
      return;
    }
    var view = s.state.view || [];
    if (view.length === 0) {
      toast('Nothing to navigate', 'warn');
      return;
    }
    var pos = util().clamp(n - 1, 0, view.length - 1);
    if (grid() && typeof grid().scrollToViewPos === 'function') {
      grid().scrollToViewPos(pos, true);
    }
    if (typeof s.setSelection === 'function') {
      s.setSelection(new Set([pos]), pos);
    }
    closeModal('modal-goto');
  }

  // =======================================================================
  //  STATS MODAL
  // =======================================================================

  /**
   * Render store.stats() plus a per-component breakdown and the top errors.
   */
  function openStats() {
    var content = $('stats-content');
    if (!content) return;
    var s = store();
    var u = util();
    content.innerHTML = '';

    if (!s || typeof s.stats !== 'function') {
      content.appendChild(u.el('div', { text: 'No data.' }));
      openModal('modal-stats');
      return;
    }

    var st = s.stats();

    // --- summary grid ---
    var summary = u.el('dl', { className: 'stats-summary' });
    var rows = [
      ['Total lines', fmtNum(st.total)],
      ['Errors', fmtNum(st.errors)],
      ['Warnings', fmtNum(st.warnings)],
      ['Information', fmtNum(st.info)],
      ['Components', fmtNum(st.components)],
      ['Threads', fmtNum(st.threads)],
      ['Files', fmtNum(st.fileCount)],
      ['Time range', (st.timeFrom != null && st.timeTo != null)
        ? (u.formatDateTime(st.timeFrom) + ' → ' + u.formatDateTime(st.timeTo))
        : '—']
    ];
    for (var i = 0; i < rows.length; i++) {
      summary.appendChild(u.el('dt', { text: rows[i][0] }));
      summary.appendChild(u.el('dd', { text: rows[i][1] }));
    }
    content.appendChild(summary);

    var entries = (s.state && s.state.entries) || [];

    // --- per-component breakdown ---
    content.appendChild(u.el('h4', { className: 'stats-h', text: 'Top components' }));
    content.appendChild(buildComponentTable(entries));

    // --- top error messages ---
    content.appendChild(u.el('h4', { className: 'stats-h', text: 'Top errors' }));
    content.appendChild(buildTopErrors(entries));

    openModal('modal-stats');
  }

  /**
   * Build a table of components ranked by line count (top 20).
   * @param {object[]} entries
   * @returns {Element}
   */
  function buildComponentTable(entries) {
    var u = util();
    var counts = Object.create(null);
    for (var i = 0; i < entries.length; i++) {
      var c = entries[i].component || '(none)';
      counts[c] = (counts[c] || 0) + 1;
    }
    var arr = Object.keys(counts).map(function (k) {
      return { name: k, count: counts[k] };
    });
    arr.sort(function (a, b) { return b.count - a.count; });
    arr = arr.slice(0, 20);

    var table = u.el('table', { className: 'stats-table' });
    var thead = u.el('thead', {}, u.el('tr', {}, [
      u.el('th', { text: 'Component' }),
      u.el('th', { text: 'Lines' })
    ]));
    table.appendChild(thead);
    var tbody = u.el('tbody');
    if (arr.length === 0) {
      tbody.appendChild(u.el('tr', {}, u.el('td', { colspan: '2', text: 'No data' })));
    }
    for (var j = 0; j < arr.length; j++) {
      tbody.appendChild(u.el('tr', {}, [
        u.el('td', { text: arr[j].name }),
        u.el('td', { className: 'num', text: fmtNum(arr[j].count) })
      ]));
    }
    table.appendChild(tbody);
    return table;
  }

  /**
   * Build a table of the most frequent error messages (top 15).
   * @param {object[]} entries
   * @returns {Element}
   */
  function buildTopErrors(entries) {
    var u = util();
    var counts = Object.create(null);
    var total = 0;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].type !== 3) continue;
      var msg = (entries[i].message || '').split('\n')[0].trim();
      if (!msg) continue;
      if (msg.length > 160) msg = msg.slice(0, 157) + '…';
      counts[msg] = (counts[msg] || 0) + 1;
      total++;
    }
    if (total === 0) {
      return u.el('div', { className: 'stats-empty', text: 'No errors logged.' });
    }
    var arr = Object.keys(counts).map(function (k) {
      return { msg: k, count: counts[k] };
    });
    arr.sort(function (a, b) { return b.count - a.count; });
    arr = arr.slice(0, 15);

    var table = u.el('table', { className: 'stats-table' });
    var thead = u.el('thead', {}, u.el('tr', {}, [
      u.el('th', { text: 'Count' }),
      u.el('th', { text: 'Error message' })
    ]));
    table.appendChild(thead);
    var tbody = u.el('tbody');
    for (var j = 0; j < arr.length; j++) {
      tbody.appendChild(u.el('tr', {}, [
        u.el('td', { className: 'num', text: fmtNum(arr[j].count) }),
        u.el('td', { text: arr[j].msg })
      ]));
    }
    table.appendChild(tbody);
    return table;
  }

  // =======================================================================
  //  SETTINGS MODAL
  // =======================================================================

  /**
   * Prefill the settings modal from store.settings and show it.
   */
  function openSettings() {
    var s = store();
    var settings = (s && s.state && s.state.settings) ? s.state.settings : {};

    var themeSel = $('set-theme');
    if (themeSel) themeSel.value = settings.theme || 'auto';
    var fontInput = $('set-fontsize');
    if (fontInput) fontInput.value = settings.fontSize != null ? settings.fontSize : 13;
    var wrapChk = $('set-wrap');
    if (wrapChk) wrapChk.checked = !!settings.wrap;
    var rowInput = $('set-rowheight');
    if (rowInput) rowInput.value = settings.rowHeight != null ? settings.rowHeight : 24;
    var dateFmtSel = $('set-dateformat');
    if (dateFmtSel) dateFmtSel.value = settings.dateFormat || 'YYYY-MM-DD';

    openModal('modal-settings');
  }

  /**
   * Read settings inputs back into store.settings, persist, and apply them.
   */
  function applySettings() {
    var s = store();
    if (!s || !s.state) { closeModal('modal-settings'); return; }
    var settings = s.state.settings || (s.state.settings = {});

    var themeSel = $('set-theme');
    if (themeSel) settings.theme = themeSel.value;
    var fontInput = $('set-fontsize');
    if (fontInput) {
      var fs = parseInt(fontInput.value, 10);
      if (!isNaN(fs)) settings.fontSize = util().clamp(fs, 9, 28);
    }
    var wrapChk = $('set-wrap');
    if (wrapChk) settings.wrap = !!wrapChk.checked;
    var rowInput = $('set-rowheight');
    if (rowInput) {
      var rh = parseInt(rowInput.value, 10);
      if (!isNaN(rh)) settings.rowHeight = util().clamp(rh, 16, 60);
    }
    var dateFmtSel = $('set-dateformat');
    if (dateFmtSel) {
      settings.dateFormat = dateFmtSel.value;
      if (util() && typeof util().setDateFormat === 'function') {
        util().setDateFormat(settings.dateFormat);
      }
    }

    if (typeof s.saveSettings === 'function') s.saveSettings();

    applyTheme(settings.theme);
    applyCssVars(settings);

    if (grid() && typeof grid().refresh === 'function') grid().refresh();
    closeModal('modal-settings');
    toast('Settings saved', 'success');
  }

  /**
   * Push font-size / row-height settings onto the document as CSS variables.
   * @param {object} settings
   */
  function applyCssVars(settings) {
    var root = document.documentElement;
    if (settings.rowHeight != null) {
      root.style.setProperty('--row-h', settings.rowHeight + 'px');
    }
    if (settings.fontSize != null) {
      // The grid font is driven by --grid-font-size in css/styles.css.
      root.style.setProperty('--grid-font-size', settings.fontSize + 'px');
    }
    if (document.getElementById('app')) {
      document.getElementById('app').classList.toggle('wrap', !!settings.wrap);
    }
  }

  /**
   * Resolve and apply a theme. "auto" follows the OS preference.
   * @param {"auto"|"light"|"dark"} theme
   */
  function applyTheme(theme) {
    var resolved = theme;
    if (theme === 'auto' || theme == null) {
      var prefersDark = window.matchMedia &&
        window.matchMedia('(prefers-color-scheme: dark)').matches;
      resolved = prefersDark ? 'dark' : 'light';
    }
    document.documentElement.dataset.theme = resolved;
  }

  // =======================================================================
  //  COMMAND PALETTE
  // =======================================================================

  /**
   * The full, hardcoded list of palette commands. Each {label, run}.
   * @returns {Array<{label:string, run:Function}>}
   */
  function paletteCommands() {
    var files = function () { return CMT.files; };
    var app = function () { return CMT.app; };
    return [
      { label: 'Open file…', run: function () { var i = $('file-input'); if (i) i.click(); } },
      { label: 'Open from clipboard', run: function () { if (files()) files().openFromClipboard(); } },
      { label: 'Load sample log', run: function () { if (app() && app().loadSample) app().loadSample(); } },
      { label: 'Reload files', run: function () { if (files()) files().reload(); } },
      { label: 'Compare two logs…', run: function () { if (CMT.compare) CMT.compare.open(); } },
      { label: 'Find…', run: function () { openFind(); } },
      { label: 'Filter…', run: function () { openFilter(); } },
      { label: 'Highlight rules…', run: function () { openHighlight(); } },
      { label: 'Error code lookup…', run: function () { openErrorLookup(); } },
      { label: 'Go to line…', run: function () { openGoto(); } },
      { label: 'Statistics…', run: function () { openStats(); } },
      { label: 'Toggle detail pane', run: toggleDetailPane },
      { label: 'Export view as .log', run: function () { if (files()) files().exportView('log'); } },
      { label: 'Export view as .csv', run: function () { if (files()) files().exportView('csv'); } },
      { label: 'Toggle tail (live follow)', run: toggleTail },
      { label: 'Clear all', run: function () { if (store()) store().clearAll(); } },
      { label: 'Toggle theme (light/dark)', run: toggleTheme },
      { label: 'Settings…', run: function () { openSettings(); } },
      { label: 'About CMTrace Web', run: function () { openAbout(); } }
    ];
  }

  function toggleTail() {
    var s = store();
    if (!s || !s.state) return;
    var on = !s.state.tail;
    var files = CMT.files;
    if (on && files && typeof files.enableTail === 'function') files.enableTail();
    else if (!on && files && typeof files.disableTail === 'function') files.disableTail();
    else if (typeof s.setTail === 'function') s.setTail(on);
  }

  function toggleTheme() {
    var s = store();
    var settings = (s && s.state && s.state.settings) ? s.state.settings : {};
    var current = document.documentElement.dataset.theme || 'light';
    var next = current === 'dark' ? 'light' : 'dark';
    settings.theme = next;
    if (s && typeof s.saveSettings === 'function') s.saveSettings();
    applyTheme(next);
  }

  /**
   * Show the command palette and render the full list.
   */
  function openPalette() {
    var palette = $('palette');
    if (!palette) return;
    palette.hidden = false;
    var input = $('palette-input');
    if (input) {
      input.value = '';
      try { input.focus(); } catch (e) { /* ignore */ }
    }
    renderPalette('');
  }

  function closePalette() {
    var palette = $('palette');
    if (palette) palette.hidden = true;
  }

  /**
   * Fuzzy-filter the palette commands by query and render them.
   * @param {string} query
   */
  function renderPalette(query) {
    var listEl = $('palette-list');
    if (!listEl) return;
    var u = util();

    var all = paletteCommands();
    var q = (query || '').trim().toLowerCase();
    var items;
    if (!q) {
      items = all.slice();
    } else {
      items = all
        .map(function (cmd) { return { cmd: cmd, score: fuzzyScore(cmd.label.toLowerCase(), q) }; })
        .filter(function (x) { return x.score >= 0; })
        .sort(function (a, b) { return a.score - b.score; })
        .map(function (x) { return x.cmd; });
    }

    paletteState.items = items;
    paletteState.active = items.length ? 0 : -1;

    listEl.innerHTML = '';
    if (items.length === 0) {
      listEl.appendChild(u.el('div', { className: 'palette-empty', text: 'No matching commands' }));
      return;
    }
    for (var i = 0; i < items.length; i++) {
      (function (idx) {
        var row = u.el('div', {
          className: 'palette-item' + (idx === paletteState.active ? ' active' : ''),
          dataset: { idx: String(idx) },
          text: items[idx].label,
          onClick: function () { runPaletteItem(idx); }
        });
        row.addEventListener('mousemove', function () { setPaletteActive(idx); });
        listEl.appendChild(row);
      })(i);
    }
  }

  /**
   * Simple subsequence fuzzy match. Lower score = better; -1 = no match.
   * @param {string} text lowercase
   * @param {string} q lowercase
   * @returns {number}
   */
  function fuzzyScore(text, q) {
    var ti = 0;
    var qi = 0;
    var score = 0;
    var lastMatch = -1;
    while (qi < q.length && ti < text.length) {
      if (text[ti] === q[qi]) {
        if (lastMatch >= 0) score += (ti - lastMatch); // reward adjacency
        lastMatch = ti;
        qi++;
      }
      ti++;
    }
    if (qi < q.length) return -1; // not all query chars matched
    return score + (text.length - q.length) * 0.01; // slight bias to shorter
  }

  function setPaletteActive(idx) {
    var listEl = $('palette-list');
    if (!listEl) return;
    paletteState.active = idx;
    var rows = listEl.querySelectorAll('.palette-item');
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('active', i === idx);
    }
    if (rows[idx] && rows[idx].scrollIntoView) {
      rows[idx].scrollIntoView({ block: 'nearest' });
    }
  }

  function movePaletteActive(delta) {
    var n = paletteState.items.length;
    if (n === 0) return;
    var next = paletteState.active + delta;
    if (next < 0) next = n - 1;
    if (next >= n) next = 0;
    setPaletteActive(next);
  }

  function runPaletteItem(idx) {
    var item = paletteState.items[idx];
    closePalette();
    if (item && typeof item.run === 'function') {
      try { item.run(); } catch (e) { toast('Command failed', 'error'); }
    }
  }

  // =======================================================================
  //  ABOUT MODAL
  // =======================================================================

  function openAbout() {
    openModal('modal-about');
  }

  // =======================================================================
  //  FIND BAR
  // =======================================================================

  /**
   * Build the current search spec from the find-bar controls.
   * @returns {{text:string, caseSensitive:boolean, regex:boolean}}
   */
  function findSpec() {
    var input = $('find-input');
    return {
      text: input ? input.value : '',
      caseSensitive: isToggleOn('find-case'),
      regex: isToggleOn('find-regex')
    };
  }

  /**
   * Read the on/off state of a <button>-based toggle (find-case / find-regex).
   * These are buttons in the find bar (not checkboxes), so their state lives in
   * aria-pressed + the .active class rather than .checked.
   * @param {string} id
   * @returns {boolean}
   */
  function isToggleOn(id) {
    var node = $(id);
    if (!node) return false;
    if (node.getAttribute('aria-pressed') === 'true') return true;
    return node.classList && node.classList.contains('active');
  }

  /**
   * Flip a <button>-based toggle's on/off state (aria-pressed + .active class).
   * @param {string} id
   * @returns {boolean} the new state
   */
  function flipToggle(id) {
    var node = $(id);
    if (!node) return false;
    var now = isToggleOn(id);
    var next = !now;
    node.setAttribute('aria-pressed', next ? 'true' : 'false');
    if (node.classList) node.classList.toggle('active', next);
    return next;
  }

  function specKeyOf(spec) {
    return (spec.regex ? 'R' : '_') + (spec.caseSensitive ? 'C' : '_') + '|' + spec.text;
  }

  /**
   * Show the find bar and focus the input (selecting any existing text).
   */
  function openFind() {
    var bar = $('findbar');
    if (!bar) return;
    bar.hidden = false;
    var input = $('find-input');
    if (input) {
      try { input.focus(); input.select(); } catch (e) { /* ignore */ }
    }
    // Refresh the match count for whatever is already typed.
    recomputeFindMatches();
    updateFindCount();
  }

  /**
   * Hide the find bar.
   */
  function closeFind() {
    var bar = $('findbar');
    if (bar) bar.hidden = true;
    // Clear the find-match marker so the orange find highlight does not linger.
    if (grid() && typeof grid().setActive === 'function') grid().setActive(null);
  }

  /**
   * Recompute the cached list of all match positions for the current spec.
   */
  function recomputeFindMatches() {
    var s = store();
    var spec = findSpec();
    var key = specKeyOf(spec);
    findState.specKey = key;
    if (!s || !s.state || !spec.text) {
      findState.matches = [];
      findState.current = -1;
      return;
    }
    findState.matches = search().allMatches(s.state.entries, s.state.view, spec) || [];
    // Reset current pointer to the match at/after the active view position.
    var active = typeof s.state.activeViewPos === 'number' ? s.state.activeViewPos : -1;
    findState.current = -1;
    for (var i = 0; i < findState.matches.length; i++) {
      if (findState.matches[i] >= active) { findState.current = i; break; }
    }
  }

  /**
   * Run a find in the given direction, scroll/select the match, update count.
   * @param {number} dir +1 forward, -1 backward
   */
  function runFind(dir) {
    var s = store();
    if (!s || !s.state) return;
    var spec = findSpec();

    // Re-cache match list when the spec changed since last run.
    if (findState.specKey !== specKeyOf(spec)) recomputeFindMatches();

    if (!spec.text) {
      updateFindCount();
      return;
    }

    var view = s.state.view || [];
    var from = typeof s.state.activeViewPos === 'number' ? s.state.activeViewPos : -1;
    var pos = search().find(s.state.entries, view, spec, from, dir);

    if (pos < 0) {
      toast('No matches', 'warn');
      updateFindCount();
      return;
    }

    // Track which match number we landed on for the "n of m" display.
    findState.current = findState.matches.indexOf(pos);

    if (typeof s.setSelection === 'function') s.setSelection(new Set([pos]), pos);
    // setActive() marks pos as the find target (distinct .find-match styling) AND
    // scrolls it into view; fall back to a plain scroll if unavailable.
    if (grid() && typeof grid().setActive === 'function') grid().setActive(pos);
    else if (grid() && typeof grid().scrollToViewPos === 'function') grid().scrollToViewPos(pos, true);

    updateFindCount();
  }

  /**
   * Update the #find-count label ("n of m" / "No results").
   */
  function updateFindCount() {
    var label = $('find-count');
    if (!label) return;
    var spec = findSpec();
    if (!spec.text) {
      label.textContent = '';
      return;
    }
    // Ensure the cache matches the current spec before reading it.
    if (findState.specKey !== specKeyOf(spec)) recomputeFindMatches();
    var total = findState.matches.length;
    if (total === 0) {
      label.textContent = 'No results';
      return;
    }
    var cur = findState.current >= 0 ? findState.current + 1 : 0;
    label.textContent = (cur > 0 ? cur + ' of ' : '') + total;
  }

  // =======================================================================
  //  INIT — wiring of generic + per-modal controls and store subscriptions
  // =======================================================================

  /**
   * Wire all modal/find-bar/palette controls and subscribe to store events.
   */
  function init() {
    wireGenericModalClose();
    wireFilterModal();
    wireHighlightModal();
    wireErrorLookupModal();
    wireGotoModal();
    wireDetailModal();
    wireSettingsModal();
    wirePalette();
    wireFindBar();
    wireDetailPane();
    subscribeStore();

    // Reflect the current state once on init.
    updateStatusBar();
    updateDetailPane();
  }

  /**
   * Generic: any .modal-close button closes its enclosing backdrop; clicking
   * the backdrop itself (outside the .modal card) closes it too.
   */
  function wireGenericModalClose() {
    var closeButtons = document.querySelectorAll('.modal-close');
    for (var i = 0; i < closeButtons.length; i++) {
      closeButtons[i].addEventListener('click', function (ev) {
        var backdrop = ev.currentTarget.closest('.modal-backdrop');
        if (backdrop) {
          backdrop.hidden = true;
          backdrop.classList.remove('open');
        }
      });
    }

    var backdrops = document.querySelectorAll('.modal-backdrop');
    for (var j = 0; j < backdrops.length; j++) {
      backdrops[j].addEventListener('mousedown', function (ev) {
        // Only close when the backdrop itself (not a child card) is pressed.
        if (ev.target === ev.currentTarget) {
          ev.currentTarget.hidden = true;
          ev.currentTarget.classList.remove('open');
        }
      });
    }
  }

  function wireFilterModal() {
    bindClick('filter-apply', applyFilterFromUI);
    bindClick('filter-reset', resetFilter);
    // Enter inside the text field applies.
    var text = $('filter-text');
    if (text) {
      text.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); applyFilterFromUI(); }
      });
    }
  }

  function wireHighlightModal() {
    bindClick('hl-add', addHighlightFromUI);
    var term = $('hl-term');
    if (term) {
      term.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); addHighlightFromUI(); }
      });
    }
  }

  function wireErrorLookupModal() {
    bindClick('err-go', runErrorLookup);
    var input = $('err-input');
    if (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); runErrorLookup(); }
      });
    }
  }

  function wireGotoModal() {
    bindClick('goto-go', runGoto);
    var input = $('goto-input');
    if (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); runGoto(); }
      });
    }
  }

  function wireDetailModal() {
    bindClick('detail-prev', function () { moveDetail(-1); });
    bindClick('detail-next', function () { moveDetail(1); });
    bindClick('detail-copy', copyDetail);
  }

  function wireSettingsModal() {
    // Optional explicit apply button (not in the DOM contract; harmless no-op
    // when absent). Settings otherwise commit on any control change below.
    bindClick('set-apply', applySettings);
    // Changing the theme select both previews AND persists the choice, because
    // the settings modal has no dedicated apply button — closing it via the X
    // must not silently drop the user's selection.
    var themeSel = $('set-theme');
    if (themeSel) {
      themeSel.addEventListener('change', applySettings);
    }
    // Many settings modals submit on any change; support an explicit apply via
    // the modal-close as a "done" affordance too.
    var fontInput = $('set-fontsize');
    if (fontInput) fontInput.addEventListener('change', applySettings);
    var rowInput = $('set-rowheight');
    if (rowInput) rowInput.addEventListener('change', applySettings);
    var wrapChk = $('set-wrap');
    if (wrapChk) wrapChk.addEventListener('change', applySettings);
  }

  function wirePalette() {
    var input = $('palette-input');
    if (input) {
      input.addEventListener('input', function () { renderPalette(input.value); });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); movePaletteActive(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); movePaletteActive(-1); }
        else if (e.key === 'Enter') {
          e.preventDefault();
          if (paletteState.active >= 0) runPaletteItem(paletteState.active);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closePalette();
        }
      });
    }
    // Clicking the palette backdrop (outside the inner card) closes it.
    var palette = $('palette');
    if (palette) {
      palette.addEventListener('mousedown', function (ev) {
        if (ev.target === ev.currentTarget) closePalette();
      });
    }
  }

  function wireFindBar() {
    var input = $('find-input');
    if (input) {
      var debouncedCount = util().debounce(function () {
        recomputeFindMatches();
        updateFindCount();
      }, 150);
      input.addEventListener('input', debouncedCount);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          runFind(e.shiftKey ? -1 : 1);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closeFind();
        }
      });
    }
    bindClick('find-next', function () { runFind(1); });
    bindClick('find-prev', function () { runFind(-1); });
    bindClick('find-close', closeFind);

    // find-case / find-regex are <button> toggles (not checkboxes): toggle their
    // pressed state on click, then recompute the match cache + count.
    var caseToggle = $('find-case');
    if (caseToggle) caseToggle.addEventListener('click', function () {
      flipToggle('find-case');
      recomputeFindMatches(); updateFindCount();
    });
    var regexToggle = $('find-regex');
    if (regexToggle) regexToggle.addEventListener('click', function () {
      flipToggle('find-regex');
      recomputeFindMatches(); updateFindCount();
    });
  }

  /**
   * Subscribe to store events to keep status bar + find cache fresh.
   */
  function subscribeStore() {
    var s = store();
    if (!s || typeof s.on !== 'function') return;
    s.on('view', function () {
      // View changed => any find/match cache is stale.
      findState.specKey = null;
      updateStatusBar();
      updateDetailPane();
      var bar = $('findbar');
      if (bar && !bar.hidden) { recomputeFindMatches(); updateFindCount(); }
    });
    s.on('data', function () { updateStatusBar(); updateDetailPane(); });
    s.on('selection', function () { updateStatusBar(); updateDetailPane(); });
    s.on('tail', updateStatusBar);
    // Re-resolve "auto" theme when the OS preference flips.
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var handler = function () {
        var settings = (s.state && s.state.settings) ? s.state.settings : {};
        if (!settings.theme || settings.theme === 'auto') applyTheme('auto');
      };
      if (mq.addEventListener) mq.addEventListener('change', handler);
      else if (mq.addListener) mq.addListener(handler);
    }
  }

  /**
   * Bind a click handler to an element by id (no-op when absent).
   * @param {string} id
   * @param {Function} fn
   */
  function bindClick(id, fn) {
    var node = $(id);
    if (node) node.addEventListener('click', fn);
  }

  // =======================================================================
  //  PUBLIC API
  // =======================================================================
  CMT.ui = {
    init: init,
    openModal: openModal,
    closeModal: closeModal,
    closeAll: closeAll,
    anyOpen: anyOpen,
    toast: toast,
    showProgress: showProgress,
    hideProgress: hideProgress,
    updateStatusBar: updateStatusBar,
    showDetail: showDetail,
    updateDetailPane: updateDetailPane,
    setDetailPaneOpen: setDetailPaneOpen,
    toggleDetailPane: toggleDetailPane,
    openFilter: openFilter,
    applyFilterFromUI: applyFilterFromUI,
    resetFilter: resetFilter,
    openHighlight: openHighlight,
    renderHighlightList: renderHighlightList,
    openErrorLookup: openErrorLookup,
    runErrorLookup: runErrorLookup,
    openGoto: openGoto,
    runGoto: runGoto,
    openStats: openStats,
    openSettings: openSettings,
    applySettings: applySettings,
    openPalette: openPalette,
    renderPalette: renderPalette,
    openAbout: openAbout,
    applyTheme: applyTheme,
    openFind: openFind,
    closeFind: closeFind,
    runFind: runFind,
    updateFindCount: updateFindCount
  };
})();
