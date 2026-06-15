window.CMT = window.CMT || {};

/*
 * CMT.app — application bootstrap & wiring.
 *
 * Responsibilities (per shared contract):
 *  - On DOMContentLoaded: load settings, apply theme, apply CSS vars (row
 *    height + base font size), init grid, init ui, init files wiring.
 *  - Wire EVERY toolbar / empty-state / find-bar button id to its action.
 *  - Install global keyboard shortcuts (ignored while typing in inputs except
 *    Esc and find-bar keys).
 *  - Quick severity toggles (#flt-info/#flt-warn/#flt-error) + #quick-search
 *    drive the store filter live (debounced).
 *  - Rebuild the #tabs row ("All" + one per open file) on store "data".
 *  - Toggle #empty-state visibility on store "data".
 *  - Provide loadSample().
 *
 * This module is deliberately defensive: any sibling module method that might
 * not exist (because a feature is optional or a file failed to load) is called
 * through safe() so the app never hard-crashes during bootstrap.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Small internal helpers
  // ---------------------------------------------------------------------------

  /** document.getElementById shorthand. */
  function byId(id) {
    return document.getElementById(id);
  }

  /**
   * Invoke obj[method](...args) if obj exists and the method is a function.
   * Returns the call result, or undefined when the target is missing.
   * Swallows nothing — errors thrown by real handlers should surface — but it
   * guards purely against "module/method not present" during integration.
   */
  function call(obj, method) {
    if (!obj || typeof obj[method] !== 'function') return undefined;
    var args = Array.prototype.slice.call(arguments, 2);
    return obj[method].apply(obj, args);
  }

  /** Attach a click handler to an element id, if that element exists. */
  function onClick(id, handler) {
    var node = byId(id);
    if (node) node.addEventListener('click', handler);
    return node;
  }

  /** Is the given element a text-entry control we should not steal keys from? */
  function isTypingTarget(target) {
    if (!target) return false;
    var tag = target.tagName;
    if (!tag) return false;
    tag = tag.toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (target.isContentEditable) return true;
    return false;
  }

  /** Platform-aware "primary" modifier (Cmd on macOS, Ctrl elsewhere). */
  function isPrimaryMod(e) {
    return e.ctrlKey || e.metaKey;
  }

  // ---------------------------------------------------------------------------
  // Settings -> CSS variables
  // ---------------------------------------------------------------------------

  /**
   * Reflect persisted settings onto the document: theme, row height CSS var,
   * base font-size and wrap class. Called on boot and after settings changes.
   */
  function applySettingsToDom() {
    var s = (CMT.store && CMT.store.settings) || {};
    var root = document.documentElement;

    // Row height drives the virtual grid geometry (CSS var --row-h).
    var rh = (typeof s.rowHeight === 'number' && s.rowHeight > 0) ? s.rowHeight : 24;
    root.style.setProperty('--row-h', rh + 'px');

    // Base font size for the log grid (CSS reads --grid-font-size).
    var fs = (typeof s.fontSize === 'number' && s.fontSize > 0) ? s.fontSize : 12;
    root.style.setProperty('--grid-font-size', fs + 'px');

    // Wrap toggle expressed as a body/root class for CSS to react to.
    if (s.wrap) {
      root.setAttribute('data-wrap', 'on');
    } else {
      root.removeAttribute('data-wrap');
    }

    // Apply the persisted date format to the util formatter.
    if (CMT.util && typeof CMT.util.setDateFormat === 'function' && s.dateFormat) {
      CMT.util.setDateFormat(s.dateFormat);
    }
  }

  // ---------------------------------------------------------------------------
  // Quick filter (severity toggles + quick search)
  // ---------------------------------------------------------------------------

  /**
   * Build a fresh FilterSpec seeded from the store's current spec so we never
   * clobber filters set via the full filter modal (components/threads/time).
   */
  function cloneSpec(spec) {
    var base;
    if (CMT.filter && typeof CMT.filter.makeSpec === 'function') {
      base = CMT.filter.makeSpec();
    } else {
      base = {
        text: '', textMode: 'contains', caseSensitive: false,
        types: { 1: true, 2: true, 3: true },
        components: null, threads: null, timeFrom: null, timeTo: null
      };
    }
    if (!spec) return base;
    base.text = spec.text || '';
    base.textMode = spec.textMode || 'contains';
    base.caseSensitive = !!spec.caseSensitive;
    base.types = {
      1: spec.types ? spec.types[1] !== false : true,
      2: spec.types ? spec.types[2] !== false : true,
      3: spec.types ? spec.types[3] !== false : true
    };
    base.components = (spec.components instanceof Set) ? spec.components : null;
    base.threads = (spec.threads instanceof Set) ? spec.threads : null;
    base.timeFrom = (spec.timeFrom != null) ? spec.timeFrom : null;
    base.timeTo = (spec.timeTo != null) ? spec.timeTo : null;
    return base;
  }

  /**
   * Read the three severity toggle buttons + the quick-search box, fold them
   * into a copy of the active spec, and push it to the store.
   * Severity buttons use aria-pressed / .active to reflect on/off state.
   */
  function applyQuickFilter() {
    var store = CMT.store;
    if (!store) return;

    var spec = cloneSpec(store.filterSpec);

    var info = byId('flt-info');
    var warn = byId('flt-warn');
    var err = byId('flt-error');

    spec.types[1] = info ? quickToggleOn(info) : true;
    spec.types[2] = warn ? quickToggleOn(warn) : true;
    spec.types[3] = err ? quickToggleOn(err) : true;

    var q = byId('quick-search');
    if (q) {
      var text = q.value || '';
      spec.text = text;
      // The quick box is always a plain "contains" search; the full filter
      // modal owns regex/notcontains semantics.
      if (text) spec.textMode = 'contains';
    }

    call(store, 'setFilter', spec);
  }

  /** A severity quick-toggle is "on" unless explicitly disabled. */
  function quickToggleOn(btn) {
    // Treat aria-pressed="false" or class "off" as disabled; default on.
    if (btn.getAttribute('aria-pressed') === 'false') return false;
    if (btn.classList.contains('off')) return false;
    return true;
  }

  /** Flip a severity quick-toggle button's visual + aria state, then reapply. */
  function toggleSeverity(btn) {
    if (!btn) return;
    var on = quickToggleOn(btn);
    var next = !on;
    btn.setAttribute('aria-pressed', next ? 'true' : 'false');
    btn.classList.toggle('off', !next);
    btn.classList.toggle('active', next);
    // The markup ships the toggles with an .is-on class for the initial "on"
    // look; keep it in lock-step with the real state so a toggled-off button
    // never keeps the "on" styling.
    btn.classList.toggle('is-on', next);
    applyQuickFilter();
  }

  // ---------------------------------------------------------------------------
  // Tabs ("All" + one per open file)
  // ---------------------------------------------------------------------------

  function rebuildTabs() {
    var tabs = byId('tabs');
    var store = CMT.store;
    if (!tabs || !store) return;

    // Clear current contents.
    while (tabs.firstChild) tabs.removeChild(tabs.firstChild);

    var files = store.files;
    var fileCount = files ? files.size : 0;

    // Hide the strip entirely when there are no files (nothing to switch).
    if (fileCount === 0) {
      tabs.setAttribute('hidden', '');
      return;
    }
    tabs.removeAttribute('hidden');

    var active = store.settings ? store.settings.activeFileId : null;

    // The "All" tab is the merged timeline across every open file. Label it so
    // the merge is obvious once more than one file is loaded.
    var allLabel = fileCount > 1 ? 'All (merged)' : 'All';
    var allCount = fileCount > 1 ? (store.entries ? store.entries.length : 0) : -1;
    tabs.appendChild(makeTab(allLabel, null, !active, allCount));

    files.forEach(function (meta) {
      var label = meta.name || meta.id;
      tabs.appendChild(makeTab(label, meta.id, active === meta.id, meta.entryCount));
    });
  }

  function makeTab(label, fileId, isActive, count) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tab' + (isActive ? ' active' : '');
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    if (fileId != null) btn.dataset.fileId = fileId;

    // Color dot matching this file's color in the merged grid.
    if (fileId != null && CMT.store && typeof CMT.store.fileColor === 'function') {
      var color = CMT.store.fileColor(fileId);
      if (color) {
        var dot = document.createElement('span');
        dot.className = 'tab-dot';
        dot.style.setProperty('--tab-color', color);
        btn.appendChild(dot);
      }
    }

    var labelSpan = document.createElement('span');
    labelSpan.className = 'tab-name';
    labelSpan.textContent = label;
    btn.appendChild(labelSpan);

    if (typeof count === 'number' && count >= 0) {
      var cnt = document.createElement('span');
      cnt.className = 'tab-count';
      cnt.textContent = String(count);
      btn.appendChild(cnt);
    }

    // Per-file tabs get a close (×) control that removes that file's entries.
    if (fileId != null) {
      var close = document.createElement('span');
      close.className = 'tab-close';
      close.setAttribute('role', 'button');
      close.setAttribute('aria-label', 'Close ' + label);
      close.title = 'Close ' + label;
      close.textContent = '×';
      close.addEventListener('click', function (ev) {
        ev.stopPropagation();           // don't also switch to this tab
        call(CMT.store, 'removeFile', fileId);
        rebuildTabs();
      });
      btn.appendChild(close);
    }

    btn.addEventListener('click', function () {
      call(CMT.store, 'setActiveFile', fileId);
      // Re-render the strip so the active class follows the selection.
      rebuildTabs();
    });
    return btn;
  }

  // ---------------------------------------------------------------------------
  // Empty-state visibility
  // ---------------------------------------------------------------------------

  function updateEmptyState() {
    var empty = byId('empty-state');
    if (!empty) return;
    var hasData = CMT.store && CMT.store.entries && CMT.store.entries.length > 0;
    if (hasData) {
      empty.setAttribute('hidden', '');
    } else {
      empty.removeAttribute('hidden');
    }
  }

  // ---------------------------------------------------------------------------
  // Tail toggle (button reflects state)
  // ---------------------------------------------------------------------------

  function toggleTail() {
    var store = CMT.store;
    var on = store ? !!store.tail : false;
    if (on) {
      call(CMT.files, 'disableTail');
    } else {
      // enableTail may return a promise; ignore rejection so a missing
      // File System Access API never bubbles an unhandled rejection.
      var p = call(CMT.files, 'enableTail');
      if (p && typeof p.then === 'function') {
        p.then(null, function () {});
      }
    }
  }

  function reflectTailButton() {
    var btn = byId('btn-tail');
    if (!btn) return;
    var on = CMT.store ? !!CMT.store.tail : false;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  // ---------------------------------------------------------------------------
  // Theme toggle (light <-> dark) with persistence
  // ---------------------------------------------------------------------------

  function resolveCurrentTheme() {
    var t = document.documentElement.dataset.theme;
    if (t === 'dark' || t === 'light') return t;
    // Resolve "auto"/unknown via current settings or media query.
    var settingTheme = (CMT.store && CMT.store.settings) ? CMT.store.settings.theme : 'auto';
    if (settingTheme === 'dark' || settingTheme === 'light') return settingTheme;
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
    return 'light';
  }

  function toggleTheme() {
    var next = resolveCurrentTheme() === 'dark' ? 'light' : 'dark';
    call(CMT.ui, 'applyTheme', next);
    if (CMT.store && CMT.store.settings) {
      CMT.store.settings.theme = next;
      call(CMT.store, 'saveSettings');
    }
  }

  // ---------------------------------------------------------------------------
  // File input handling
  // ---------------------------------------------------------------------------

  function openFilePicker() {
    var input = byId('file-input');
    if (input) input.click();
  }

  function handleFileInputChange(e) {
    var input = e.target;
    var files = input && input.files;
    if (files && files.length) {
      var p = call(CMT.files, 'openFileList', files);
      if (p && typeof p.then === 'function') {
        p.then(null, function (err) {
          call(CMT.ui, 'toast', 'Could not open file(s): ' + (err && err.message ? err.message : err), 'error');
        });
      }
    }
    // Reset so selecting the same file again re-triggers change.
    if (input) input.value = '';
  }

  // ---------------------------------------------------------------------------
  // Landing-page handoff (drag-drop / upload performed on index.html)
  // ---------------------------------------------------------------------------

  /**
   * If the landing page handed off file(s) (via CMT.handoff / IndexedDB) or
   * requested the sample (?sample=1), open them now. Best-effort + guarded.
   */
  function consumeHandoff() {
    try {
      var params = new URLSearchParams(window.location.search || '');
      if (params.get('sample') === '1') {
        loadSample();
        // Clean the URL so a reload does not reload the sample.
        if (window.history && window.history.replaceState) {
          window.history.replaceState({}, '', window.location.pathname);
        }
        return;
      }
    } catch (e) { /* ignore */ }

    if (CMT.handoff && typeof CMT.handoff.take === 'function') {
      CMT.handoff.take().then(function (rec) {
        if (rec && rec.files && rec.files.length) {
          call(CMT.files, 'openFileList', rec.files);
        }
      }, function () { /* no handoff / IndexedDB unavailable */ });
    }
  }

  // ---------------------------------------------------------------------------
  // Sample loader
  // ---------------------------------------------------------------------------

  function loadSample() {
    var text = CMT.sampleLog;
    if (text == null) {
      call(CMT.ui, 'toast', 'No sample log available.', 'warn');
      return Promise.resolve();
    }
    var p = call(CMT.files, 'openText', text, 'sample.log');
    if (p && typeof p.then === 'function') {
      return p.then(null, function (err) {
        call(CMT.ui, 'toast', 'Could not load sample: ' + (err && err.message ? err.message : err), 'error');
      });
    }
    return Promise.resolve();
  }

  // ---------------------------------------------------------------------------
  // Find bar helpers
  // ---------------------------------------------------------------------------

  function runFind(dir) {
    call(CMT.ui, 'runFind', dir);
  }

  function closeFind() {
    // Prefer a dedicated closeFind, else fall back to toggling the element.
    if (CMT.ui && typeof CMT.ui.closeFind === 'function') {
      CMT.ui.closeFind();
      return;
    }
    var bar = byId('findbar');
    if (bar) bar.setAttribute('hidden', '');
  }

  /** Is the find bar currently open/visible? */
  function findBarOpen() {
    var bar = byId('findbar');
    return !!(bar && !bar.hasAttribute('hidden'));
  }

  // ---------------------------------------------------------------------------
  // Clipboard open
  // ---------------------------------------------------------------------------

  function openClipboard() {
    var p = call(CMT.files, 'openFromClipboard');
    if (p && typeof p.then === 'function') {
      p.then(null, function (err) {
        call(CMT.ui, 'toast', 'Clipboard read failed: ' + (err && err.message ? err.message : err), 'error');
      });
    }
  }

  function reloadFiles() {
    var p = call(CMT.files, 'reload');
    if (p && typeof p.then === 'function') {
      p.then(null, function (err) {
        call(CMT.ui, 'toast', 'Reload failed: ' + (err && err.message ? err.message : err), 'error');
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Progressive-web-app glue: service worker + OS file-handler launch queue
  // ---------------------------------------------------------------------------

  /**
   * Register the service worker for offline/install support. Failures are
   * swallowed — a missing or failed SW must never break the app at runtime.
   */
  function registerServiceWorker() {
    try {
      if (navigator && navigator.serviceWorker &&
          typeof navigator.serviceWorker.register === 'function') {
        navigator.serviceWorker.register('sw.js').catch(function () { /* noop */ });
      }
    } catch (e) {
      /* no service worker support — ignore */
    }
  }

  /**
   * When launched as an installed PWA to open .log files (file_handlers in the
   * manifest), the OS delivers the file handles via the launch queue. Read each
   * handle into a File and hand the batch to CMT.files.openFileList.
   */
  function setupLaunchQueue() {
    try {
      if (!('launchQueue' in window) || !window.launchQueue ||
          typeof window.launchQueue.setConsumer !== 'function') {
        return;
      }
      window.launchQueue.setConsumer(function (params) {
        if (!params || !params.files || !params.files.length) return;
        var handles = params.files;
        var getters = [];
        for (var i = 0; i < handles.length; i++) {
          var h = handles[i];
          if (h && typeof h.getFile === 'function') {
            getters.push(h.getFile());
          }
        }
        if (getters.length === 0) return;
        Promise.all(getters).then(function (files) {
          var usable = files.filter(function (f) { return !!f; });
          if (usable.length) {
            call(CMT.files, 'openFileList', usable);
          }
        }).catch(function (err) {
          call(CMT.ui, 'toast', 'Could not open launched file(s): ' +
            (err && err.message ? err.message : err), 'error');
        });
      });
    } catch (e) {
      /* launch queue unsupported — ignore */
    }
  }

  // ---------------------------------------------------------------------------
  // Wiring: toolbar + empty-state + find-bar buttons
  // ---------------------------------------------------------------------------

  function wireButtons() {
    // Open (toolbar + empty-state) -> hidden file input.
    onClick('btn-open', openFilePicker);
    onClick('empty-open', openFilePicker);

    // Merge re-uses the same picker (appends rather than replaces — that is
    // handled by files.openFileList which always appends entries).
    onClick('btn-merge', openFilePicker);

    // Hidden file input change.
    var input = byId('file-input');
    if (input) input.addEventListener('change', handleFileInputChange);

    // Clipboard.
    onClick('btn-clipboard', openClipboard);
    onClick('empty-clipboard', openClipboard);

    // Sample.
    onClick('empty-sample', function () { loadSample(); });

    // Reload.
    onClick('btn-reload', reloadFiles);
    onClick('btn-compare', function () { call(CMT.compare, 'open'); });

    // Tail toggle.
    onClick('btn-tail', toggleTail);

    // Modal / panel launchers.
    onClick('btn-find', function () { call(CMT.ui, 'openFind'); });
    onClick('btn-filter', function () { call(CMT.ui, 'openFilter'); });
    onClick('btn-highlight', function () { call(CMT.ui, 'openHighlight'); });
    onClick('btn-errorlookup', function () { call(CMT.ui, 'openErrorLookup'); });
    onClick('btn-goto', function () { call(CMT.ui, 'openGoto'); });
    onClick('btn-stats', function () { call(CMT.ui, 'openStats'); });
    onClick('btn-detail', function () { call(CMT.ui, 'toggleDetailPane'); });
    onClick('btn-settings', function () { call(CMT.ui, 'openSettings'); });
    onClick('btn-palette', function () { call(CMT.ui, 'openPalette'); });
    onClick('btn-about', function () { call(CMT.ui, 'openAbout'); });
    // Smart insights panel toggle.
    onClick('btn-insights', function () { call(CMT.insights, 'toggle'); });

    // Export current view as a .log file.
    onClick('btn-export', function () { call(CMT.files, 'exportView', 'log'); });

    // Clear everything.
    onClick('btn-clear', function () { call(CMT.store, 'clearAll'); });

    // Theme toggle.
    onClick('btn-theme', toggleTheme);

    // Find-bar buttons (find-next / find-prev / find-close) are wired solely by
    // CMT.ui.wireFindBar(), which owns the find bar. Double-wiring them here made
    // each click fire two listeners, advancing the find by two matches.

    // Severity quick toggles.
    onClick('flt-info', function () { toggleSeverity(byId('flt-info')); });
    onClick('flt-warn', function () { toggleSeverity(byId('flt-warn')); });
    onClick('flt-error', function () { toggleSeverity(byId('flt-error')); });

    // Quick search (debounced ~200ms).
    var q = byId('quick-search');
    if (q) {
      var debouncedQuick = (CMT.util && typeof CMT.util.debounce === 'function')
        ? CMT.util.debounce(applyQuickFilter, 200)
        : applyQuickFilter;
      q.addEventListener('input', debouncedQuick);
      // Enter in the quick box applies immediately.
      q.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          applyQuickFilter();
        }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Wiring: global keyboard shortcuts
  // ---------------------------------------------------------------------------

  function wireKeyboard() {
    document.addEventListener('keydown', function (e) {
      var key = e.key;
      var mod = isPrimaryMod(e);
      var typing = isTypingTarget(e.target);

      // ---- Esc: always allowed, closes topmost modal / find bar ----
      if (key === 'Escape') {
        // The compare overlay sits above everything; close it first.
        if (CMT.compare && typeof CMT.compare.isOpen === 'function' && CMT.compare.isOpen()) {
          CMT.compare.close();
          return;
        }
        // closeAll() hides modals + palette but NOT the find bar, so close the
        // find bar explicitly here. This makes Esc dismiss the find bar even
        // when focus is on the grid or elsewhere (ui.js's #find-input handler
        // only covers Esc while focus is in the find input).
        if (CMT.ui && typeof CMT.ui.closeAll === 'function') {
          CMT.ui.closeAll();
        }
        if (findBarOpen()) {
          closeFind();
        }
        return;
      }

      // ---- Find-bar special keys while it is open (even when typing) ----
      // Enter inside the find bar is owned by CMT.ui's #find-input keydown
      // handler; do NOT re-handle it here or the same Enter advances the find
      // twice (the event bubbles from the input to this document listener).
      if (findBarOpen()) {
        if (key === 'F3') {
          e.preventDefault();
          runFind(e.shiftKey ? -1 : 1);
          return;
        }
      }

      // F3 / Shift+F3 work globally (next/prev match) even when not in find bar.
      if (key === 'F3') {
        e.preventDefault();
        runFind(e.shiftKey ? -1 : 1);
        return;
      }

      // ---- When typing in an input/textarea/select, ignore the rest ----
      if (typing) return;

      // ---- Primary-modifier shortcuts ----
      if (mod) {
        var lower = (key || '').toLowerCase();
        switch (lower) {
          case 'o':
            e.preventDefault();
            openFilePicker();
            return;
          case 'f':
            e.preventDefault();
            call(CMT.ui, 'openFind');
            return;
          case 'h':
            e.preventDefault();
            call(CMT.ui, 'openHighlight');
            return;
          case 'r':
            // Contract: Ctrl/Cmd+R opens the filter and MUST preventDefault
            // (do not reload the page).
            e.preventDefault();
            call(CMT.ui, 'openFilter');
            return;
          case 'g':
            e.preventDefault();
            call(CMT.ui, 'openGoto');
            return;
          case 'e':
            e.preventDefault();
            call(CMT.ui, 'openErrorLookup');
            return;
          case 'd':
            // Toggle the detail pane (prevent the browser bookmark dialog).
            e.preventDefault();
            call(CMT.ui, 'toggleDetailPane');
            return;
          case 'k':
            e.preventDefault();
            call(CMT.ui, 'openPalette');
            return;
          case 'l':
            e.preventDefault();
            call(CMT.store, 'clearAll');
            return;
          default:
            break;
        }

        // Ctrl/Cmd+End -> toggle tail.
        if (key === 'End') {
          e.preventDefault();
          toggleTail();
          return;
        }
      }

      // ---- Shift+Delete -> clear (alternative to Ctrl/Cmd+L) ----
      if (e.shiftKey && (key === 'Delete' || key === 'Del')) {
        e.preventDefault();
        call(CMT.store, 'clearAll');
        return;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Wiring: store subscriptions
  // ---------------------------------------------------------------------------

  function wireStore() {
    var store = CMT.store;
    if (!store || typeof store.on !== 'function') return;

    store.on('data', function () {
      updateEmptyState();
      rebuildTabs();
      reflectTailButton();
    });

    // Tail state changes reflect on the toolbar button.
    store.on('tail', reflectTailButton);

    // Keep tab "active" class in sync when the view changes due to active file.
    store.on('view', function () {
      // Lightweight: only restyle tabs; do not rebuild (file set unchanged).
      restyleActiveTab();
    });
  }

  /** Update only the active class of existing tabs (cheap). */
  function restyleActiveTab() {
    var tabs = byId('tabs');
    if (!tabs) return;
    var active = (CMT.store && CMT.store.settings) ? CMT.store.settings.activeFileId : null;
    var children = tabs.children;
    for (var i = 0; i < children.length; i++) {
      var t = children[i];
      var id = (t.dataset && t.dataset.fileId != null && t.dataset.fileId !== '')
        ? t.dataset.fileId
        : null;
      var isActive = (active == null && id == null) || (id != null && id === active);
      t.classList.toggle('active', isActive);
      t.setAttribute('aria-selected', isActive ? 'true' : 'false');
    }
  }

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------

  function init() {
    // 1. Settings first so theme/geometry are correct before first paint.
    call(CMT.store, 'loadSettings');

    var theme = (CMT.store && CMT.store.settings) ? CMT.store.settings.theme : 'auto';
    call(CMT.ui, 'applyTheme', theme);

    // 2. CSS variables derived from settings (row height + font size + wrap).
    applySettingsToDom();

    // 3. Grid bound to its scroll container.
    var gridEl = byId('grid');
    if (gridEl) call(CMT.grid, 'init', gridEl);

    // 4. UI (modals, status bar, find bar, etc.).
    call(CMT.ui, 'init');

    // 5. Files module wiring (drag/drop, paste, tail handles) — optional init.
    if (CMT.files && typeof CMT.files.init === 'function') {
      CMT.files.init();
    }

    // 5b. Optional feature bundles. Each is guarded so a missing/failed module
    // (e.g. its script didn't load) never aborts bootstrap.
    call(CMT.minimap, 'init');
    call(CMT.insights, 'init');
    call(CMT.presets, 'init');
    call(CMT.compare, 'init');

    // 5c. PWA glue: offline service worker + OS file-handler launch queue.
    registerServiceWorker();
    setupLaunchQueue();

    // 6. Wire the DOM.
    wireButtons();
    wireKeyboard();
    wireStore();

    // 7. Initial UI reflection.
    updateEmptyState();
    rebuildTabs();
    reflectTailButton();
    call(CMT.ui, 'updateStatusBar');

    // 7b. Pick up a file (or sample request) handed off from the landing page.
    consumeHandoff();

    // 8. React to OS theme changes when in "auto" mode.
    if (window.matchMedia) {
      try {
        var mq = window.matchMedia('(prefers-color-scheme: dark)');
        var onScheme = function () {
          var t = (CMT.store && CMT.store.settings) ? CMT.store.settings.theme : 'auto';
          if (t === 'auto') call(CMT.ui, 'applyTheme', 'auto');
        };
        if (typeof mq.addEventListener === 'function') {
          mq.addEventListener('change', onScheme);
        } else if (typeof mq.addListener === 'function') {
          // Legacy Safari.
          mq.addListener(onScheme);
        }
      } catch (e) {
        /* matchMedia unsupported — ignore */
      }
    }
  }

  CMT.app = {
    init: init,
    loadSample: loadSample,
    // Exposed for the command palette / tests so they can re-sync the quick UI.
    applyQuickFilter: applyQuickFilter,
    applySettingsToDom: applySettingsToDom
  };

  // Bootstrap on DOMContentLoaded, or immediately if the DOM is already ready.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // DOM already parsed (e.g. script loaded async/deferred at end of body).
    init();
  }
})();
