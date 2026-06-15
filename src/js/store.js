window.CMT = window.CMT || {};

/*
 * CMT.store — singleton application state container + tiny event emitter.
 *
 * Holds the merged Entry[] (sorted by time, stable), the current filtered
 * view (number[] of entry indices), the active filter spec, highlight rules,
 * selection, settings, and tail state. Emits coarse-grained events that the
 * grid + ui modules subscribe to: "data", "view", "selection", "highlight",
 * "tail", "status".
 *
 * Contract guarantees:
 *  - Never throws on empty state.
 *  - addEntries: STABLE sort by time (null times sink to the end preserving
 *    their prior relative order), idx reassigned to array position.
 *  - selection holds VIEW positions (indices into store.view), NOT entry idx.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'cmtrace.settings';

  function defaultSettings() {
    return {
      theme: 'dark',
      fontSize: 12,
      wrap: false,
      rowHeight: 24,
      columns: null,
      activeFileId: null,
      detailPaneOpen: true,
      detailPaneHeight: 300,
      dateFormat: 'YYYY-MM-DD'
    };
  }

  // Safe access to a filter spec factory even if filter.js loads after store
  // is *constructed* (script order guarantees filter loads before store, but
  // we stay defensive so store never throws during early bootstrap).
  function makeFilterSpec() {
    if (CMT.filter && typeof CMT.filter.makeSpec === 'function') {
      return CMT.filter.makeSpec();
    }
    if (CMT.filter && CMT.filter.EMPTY_SPEC) {
      // Shallow clone of the shared empty spec so callers cannot mutate it.
      var src = CMT.filter.EMPTY_SPEC;
      return {
        text: src.text || '',
        textMode: src.textMode || 'contains',
        caseSensitive: !!src.caseSensitive,
        types: { 1: true, 2: true, 3: true },
        components: null,
        threads: null,
        timeFrom: null,
        timeTo: null
      };
    }
    // Last-resort fallback identical in shape to the contract FilterSpec.
    return {
      text: '',
      textMode: 'contains',
      caseSensitive: false,
      types: { 1: true, 2: true, 3: true },
      components: null,
      threads: null,
      timeFrom: null,
      timeTo: null
    };
  }

  var store = {
    // ---- State ----
    files: new Map(),          // fileId -> {id,name,size,format,entryCount}
    entries: [],               // merged, idx-ordered Entry[]
    view: [],                  // entry idx passing current filter (+ active file)
    filterSpec: makeFilterSpec(),
    highlightRules: [],        // [{id,term,color,caseSensitive,regex,enabled}]
    selection: new Set(),      // VIEW positions
    activeViewPos: -1,
    tail: false,
    settings: defaultSettings(),

    // ---- internal ----
    _listeners: Object.create(null),
    _hlSeq: 0
  };

  // -------------------------------------------------------------------------
  // Event emitter
  // -------------------------------------------------------------------------
  store.on = function (evt, cb) {
    if (typeof cb !== 'function') return function () {};
    var list = this._listeners[evt];
    if (!list) {
      list = this._listeners[evt] = [];
    }
    list.push(cb);
    var self = this;
    // Returns an off() handle.
    return function off() {
      var arr = self._listeners[evt];
      if (!arr) return;
      var i = arr.indexOf(cb);
      if (i !== -1) arr.splice(i, 1);
    };
  };

  store.emit = function (evt) {
    var list = this._listeners[evt];
    if (!list || !list.length) return;
    var args = Array.prototype.slice.call(arguments, 1);
    // Iterate over a copy so handlers may unsubscribe during dispatch.
    var snapshot = list.slice();
    for (var i = 0; i < snapshot.length; i++) {
      try {
        snapshot[i].apply(null, args);
      } catch (e) {
        // A misbehaving listener must never break the store or sibling
        // listeners. Surface it to the console for debugging.
        if (typeof console !== 'undefined' && console.error) {
          console.error('CMT.store listener error for "' + evt + '":', e);
        }
      }
    }
  };

  // -------------------------------------------------------------------------
  // Entry management
  // -------------------------------------------------------------------------

  /**
   * Stable sort the merged entries by time ascending. Entries with a null
   * time sink to the end while preserving their prior relative (insertion)
   * order. Entries with equal time also keep their prior relative order.
   *
   * We achieve stability across all engines by sorting on a decorated key
   * that carries the original position as a tiebreaker.
   */
  function stableSortByTime(arr) {
    var n = arr.length;
    var decorated = new Array(n);
    for (var i = 0; i < n; i++) {
      decorated[i] = { e: arr[i], i: i };
    }
    decorated.sort(function (a, b) {
      var ta = a.e.time;
      var tb = b.e.time;
      var aNull = (ta === null || ta === undefined);
      var bNull = (tb === null || tb === undefined);
      if (aNull && bNull) {
        return a.i - b.i;           // both null -> keep insertion order
      }
      if (aNull) return 1;          // null sinks below any real time
      if (bNull) return -1;
      if (ta < tb) return -1;
      if (ta > tb) return 1;
      return a.i - b.i;             // equal time -> keep insertion order
    });
    for (var j = 0; j < n; j++) {
      arr[j] = decorated[j].e;
    }
    return arr;
  }

  function reindex(arr) {
    for (var i = 0; i < arr.length; i++) {
      arr[i].idx = i;
    }
  }

  /**
   * Append new entries, re-sort the whole set by time (stable), reassign idx,
   * recompute the view, and notify listeners ("data" then "view").
   */
  store.addEntries = function (entries) {
    if (!entries || !entries.length) {
      // Still emit so progress/UI can settle; cheap no-op otherwise.
      return;
    }
    for (var i = 0; i < entries.length; i++) {
      this.entries.push(entries[i]);
    }
    stableSortByTime(this.entries);
    reindex(this.entries);
    this.recomputeView();
    this.emit('data');
    this.emit('view');
    this.emit('status');
  };

  // Distinct, dark-bg-friendly colors assigned per open file so the merged
  // ("All") view can show which log each row came from.
  var FILE_COLORS = [
    '#39a751', '#4f9dde', '#e0a13a', '#c97bd6', '#e36b6b',
    '#46c9b0', '#d98b4a', '#8a9bf0', '#9bc24a', '#e072a8'
  ];

  store.setFile = function (meta) {
    if (!meta || !meta.id) return;
    var existing = this.files.get(meta.id) || {};
    this.files.set(meta.id, {
      id: meta.id,
      name: meta.name !== undefined ? meta.name : (existing.name || meta.id),
      size: meta.size !== undefined ? meta.size : (existing.size || 0),
      format: meta.format !== undefined ? meta.format : (existing.format || 'plain'),
      entryCount: meta.entryCount !== undefined
        ? meta.entryCount
        : (existing.entryCount || 0),
      // Keep a stable color across updates; assign the next palette color to a
      // genuinely new file (index = how many files existed before this one).
      color: existing.color || meta.color || FILE_COLORS[this.files.size % FILE_COLORS.length]
    });
    this.emit('status');
  };

  /** The display color assigned to a file (or null). */
  store.fileColor = function (id) {
    var f = this.files.get(id);
    return f && f.color ? f.color : null;
  };

  /** The display name of a file (falls back to its id). */
  store.fileName = function (id) {
    var f = this.files.get(id);
    return f ? (f.name || id) : (id || '');
  };

  /**
   * Remove a single file and all its entries, then reindex + recompute.
   * Used when a tab is closed. Emits "data"/"view"/"selection"/"status".
   */
  store.removeFile = function (id) {
    if (!id || !this.files.has(id)) return;
    this.files.delete(id);
    var kept = [];
    for (var i = 0; i < this.entries.length; i++) {
      if (this.entries[i].fileId !== id) kept.push(this.entries[i]);
    }
    this.entries = kept;
    reindex(this.entries);
    if (this.settings.activeFileId === id) this.settings.activeFileId = null;
    this.selection = new Set();
    this.activeViewPos = -1;
    this.recomputeView();
    this.emit('data');
    this.emit('view');
    this.emit('selection');
    this.emit('status');
  };

  store.clearAll = function () {
    this.files = new Map();
    this.entries = [];
    this.view = [];
    this.selection = new Set();
    this.activeViewPos = -1;
    this.tail = false;
    // Keep filterSpec + highlightRules? Contract: clearAll emits "data".
    // We reset filterSpec's per-file restriction so a stale active file does
    // not hide future data, but preserve the user's text/type filters.
    this.settings.activeFileId = null;
    this.recomputeView();
    this.emit('data');
    this.emit('view');
    this.emit('selection');
    this.emit('tail');
    this.emit('status');
  };

  // -------------------------------------------------------------------------
  // Filtering / view
  // -------------------------------------------------------------------------

  store.setFilter = function (spec) {
    this.filterSpec = spec || makeFilterSpec();
    this.recomputeView();
    this.emit('view');
    this.emit('status');
  };

  /**
   * Recompute store.view from store.entries using CMT.filter.apply, then
   * additionally restrict to settings.activeFileId when one is set.
   * Keeps selection/activeViewPos within bounds.
   */
  store.recomputeView = function () {
    var base;
    if (CMT.filter && typeof CMT.filter.apply === 'function') {
      base = CMT.filter.apply(this.entries, this.filterSpec);
    } else {
      // Defensive fallback: identity view if filter module not present.
      base = [];
      for (var k = 0; k < this.entries.length; k++) base.push(k);
    }

    var activeId = this.settings.activeFileId;
    if (activeId) {
      var restricted = [];
      var ents = this.entries;
      for (var i = 0; i < base.length; i++) {
        var entry = ents[base[i]];
        if (entry && entry.fileId === activeId) {
          restricted.push(base[i]);
        }
      }
      this.view = restricted;
    } else {
      this.view = base;
    }

    // Clamp selection/active to the new view length.
    var len = this.view.length;
    if (len === 0) {
      if (this.selection.size) this.selection = new Set();
      this.activeViewPos = -1;
    } else {
      if (this.selection.size) {
        var pruned = new Set();
        var it = this.selection.values();
        var cur = it.next();
        while (!cur.done) {
          var p = cur.value;
          if (p >= 0 && p < len) pruned.add(p);
          cur = it.next();
        }
        this.selection = pruned;
      }
      if (this.activeViewPos >= len) this.activeViewPos = len - 1;
      if (this.activeViewPos < 0 && this.selection.size) {
        // Point active at the lowest selected position for sanity.
        var min = Infinity;
        this.selection.forEach(function (v) { if (v < min) min = v; });
        this.activeViewPos = (min === Infinity) ? -1 : min;
      }
    }
  };

  store.setActiveFile = function (id) {
    // Normalize empty / "all" sentinels to null (all files).
    if (!id || id === 'all' || id === '__all__') {
      id = null;
    }
    this.settings.activeFileId = id;
    this.recomputeView();
    this.emit('view');
    this.emit('status');
  };

  // -------------------------------------------------------------------------
  // Highlight rules
  // -------------------------------------------------------------------------

  store.addHighlight = function (rule) {
    rule = rule || {};
    var id = rule.id || ('hl-' + (++this._hlSeq));
    var normalized = {
      id: id,
      term: rule.term !== undefined ? String(rule.term) : '',
      color: rule.color || '#ffd54a',
      caseSensitive: !!rule.caseSensitive,
      regex: !!rule.regex,
      enabled: rule.enabled !== undefined ? !!rule.enabled : true
    };
    this.highlightRules.push(normalized);
    this.emit('highlight');
    return normalized;
  };

  store.updateHighlight = function (id, patch) {
    if (!patch) return;
    for (var i = 0; i < this.highlightRules.length; i++) {
      if (this.highlightRules[i].id === id) {
        var r = this.highlightRules[i];
        if (patch.term !== undefined) r.term = String(patch.term);
        if (patch.color !== undefined) r.color = patch.color;
        if (patch.caseSensitive !== undefined) r.caseSensitive = !!patch.caseSensitive;
        if (patch.regex !== undefined) r.regex = !!patch.regex;
        if (patch.enabled !== undefined) r.enabled = !!patch.enabled;
        this.emit('highlight');
        return;
      }
    }
  };

  store.removeHighlight = function (id) {
    for (var i = 0; i < this.highlightRules.length; i++) {
      if (this.highlightRules[i].id === id) {
        this.highlightRules.splice(i, 1);
        this.emit('highlight');
        return;
      }
    }
  };

  store.toggleHighlight = function (id) {
    for (var i = 0; i < this.highlightRules.length; i++) {
      if (this.highlightRules[i].id === id) {
        this.highlightRules[i].enabled = !this.highlightRules[i].enabled;
        this.emit('highlight');
        return;
      }
    }
  };

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  store.setSelection = function (set, active) {
    if (set instanceof Set) {
      this.selection = set;
    } else if (Array.isArray(set)) {
      this.selection = new Set(set);
    } else if (set == null) {
      this.selection = new Set();
    } else {
      this.selection = new Set([set]);
    }
    if (active !== undefined && active !== null) {
      this.activeViewPos = active;
    } else if (this.selection.size === 0) {
      this.activeViewPos = -1;
    }
    this.emit('selection');
    this.emit('status');
  };

  /**
   * Selection helper driven by grid clicks/keyboard.
   *  - additive (ctrl/cmd): toggle this pos in/out of the set.
   *  - range (shift): select the inclusive span from the anchor (current
   *    activeViewPos, or 0 if none) to pos.
   *  - neither: replace selection with just this pos.
   * Always updates activeViewPos to pos and emits "selection".
   */
  store.selectViewPos = function (pos, additive, range) {
    var len = this.view.length;
    if (len === 0) {
      this.selection = new Set();
      this.activeViewPos = -1;
      this.emit('selection');
      this.emit('status');
      return;
    }
    if (pos < 0) pos = 0;
    if (pos > len - 1) pos = len - 1;

    if (range) {
      var anchor = this.activeViewPos;
      if (anchor < 0 || anchor > len - 1) anchor = 0;
      var lo = Math.min(anchor, pos);
      var hi = Math.max(anchor, pos);
      if (!additive) this.selection = new Set();
      for (var i = lo; i <= hi; i++) {
        this.selection.add(i);
      }
      // Keep anchor stable; move only the active cursor.
      this.activeViewPos = pos;
    } else if (additive) {
      if (this.selection.has(pos)) {
        this.selection.delete(pos);
      } else {
        this.selection.add(pos);
      }
      this.activeViewPos = pos;
    } else {
      this.selection = new Set([pos]);
      this.activeViewPos = pos;
    }

    this.emit('selection');
    this.emit('status');
  };

  // -------------------------------------------------------------------------
  // Entry access via the view
  // -------------------------------------------------------------------------

  store.getEntry = function (viewPos) {
    if (viewPos < 0 || viewPos >= this.view.length) return null;
    var idx = this.view[viewPos];
    return this.entries[idx] || null;
  };

  // Alias per contract.
  store.entryAt = function (viewPos) {
    return this.getEntry(viewPos);
  };

  // -------------------------------------------------------------------------
  // Tail
  // -------------------------------------------------------------------------

  store.setTail = function (bool) {
    var v = !!bool;
    if (this.tail === v) {
      // Still emit so UI stays consistent if called redundantly.
      this.emit('tail');
      return;
    }
    this.tail = v;
    this.emit('tail');
    this.emit('status');
  };

  // -------------------------------------------------------------------------
  // Settings persistence
  // -------------------------------------------------------------------------

  function safeLocalStorage() {
    try {
      if (typeof localStorage !== 'undefined' && localStorage) {
        // Touch to confirm it is usable (private-mode/file:// may throw).
        var t = '__cmt_test__';
        localStorage.setItem(t, '1');
        localStorage.removeItem(t);
        return localStorage;
      }
    } catch (e) {
      /* ignored — fall through to null */
    }
    return null;
  }

  store.saveSettings = function () {
    var ls = safeLocalStorage();
    if (!ls) return;
    try {
      ls.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch (e) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('CMT.store: could not save settings:', e);
      }
    }
  };

  store.loadSettings = function () {
    var ls = safeLocalStorage();
    var defaults = defaultSettings();
    if (!ls) {
      this.settings = defaults;
      return this.settings;
    }
    var raw = null;
    try {
      raw = ls.getItem(STORAGE_KEY);
    } catch (e) {
      raw = null;
    }
    if (!raw) {
      this.settings = defaults;
      return this.settings;
    }
    var parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      parsed = null;
    }
    if (!parsed || typeof parsed !== 'object') {
      this.settings = defaults;
      return this.settings;
    }
    // Merge over defaults so newly-added settings keys always exist.
    var merged = defaults;
    if (parsed.theme === 'auto' || parsed.theme === 'light' || parsed.theme === 'dark') {
      merged.theme = parsed.theme;
    }
    if (typeof parsed.fontSize === 'number' && isFinite(parsed.fontSize)) {
      merged.fontSize = parsed.fontSize;
    }
    if (typeof parsed.wrap === 'boolean') {
      merged.wrap = parsed.wrap;
    }
    if (typeof parsed.rowHeight === 'number' && isFinite(parsed.rowHeight) && parsed.rowHeight > 0) {
      merged.rowHeight = parsed.rowHeight;
    }
    if (parsed.columns && typeof parsed.columns === 'object') {
      merged.columns = parsed.columns;
    }
    if (parsed.dateFormat === 'YYYY-MM-DD' || parsed.dateFormat === 'DD-MM-YYYY' || parsed.dateFormat === 'MM-DD-YYYY') {
      merged.dateFormat = parsed.dateFormat;
    }
    // activeFileId is session state; do not restore a stale file restriction.
    merged.activeFileId = null;
    this.settings = merged;
    return this.settings;
  };

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  store.stats = function () {
    var total = this.entries.length;
    var errors = 0;
    var warnings = 0;
    var info = 0;
    var components = new Set();
    var threads = new Set();
    var timeFrom = null;
    var timeTo = null;

    for (var i = 0; i < total; i++) {
      var e = this.entries[i];
      switch (e.type) {
        case 3: errors++; break;
        case 2: warnings++; break;
        default: info++; break;
      }
      if (e.component) components.add(e.component);
      if (e.thread) threads.add(e.thread);
      var t = e.time;
      if (t !== null && t !== undefined) {
        if (timeFrom === null || t < timeFrom) timeFrom = t;
        if (timeTo === null || t > timeTo) timeTo = t;
      }
    }

    return {
      total: total,
      errors: errors,
      warnings: warnings,
      info: info,
      components: components.size,
      threads: threads.size,
      timeFrom: timeFrom,
      timeTo: timeTo,
      fileCount: this.files.size
    };
  };

  // Self-referential alias: some modules (ui.js) access state via store.state.*
  // (e.g. store.state.entries, store.state.view, store.state.settings). The
  // store keeps its state fields directly on itself, so `state` points back at
  // the store object — store.state.entries === store.entries, and assignments
  // like store.state.settings = {} mutate the real store. This keeps the two
  // access styles (direct and .state.*) interchangeable.
  store.state = store;

  CMT.store = store;
})();
