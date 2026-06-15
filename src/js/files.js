window.CMT = window.CMT || {};
(function () {
  'use strict';

  // Convenience references resolved lazily inside functions so load order
  // (this file sits after util/parser/store but before ui) cannot bite us.
  function U() { return CMT.util; }
  function P() { return CMT.parser; }
  function S() { return CMT.store; }
  function UI() { return CMT.ui; }

  // ---- Module-local state ------------------------------------------------
  // Keep the last-loaded File objects so reload() can re-read them.
  var lastFiles = [];
  // Live-tail bookkeeping (File System Access API based).
  var tailHandle = null;     // FileSystemFileHandle
  var tailTimer = null;      // setInterval id
  var tailLength = 0;        // last byte/char length we have parsed
  var tailFileId = null;     // fileId associated with the tailed file
  var tailReading = false;   // re-entrancy guard for the async poll

  // Default poll interval for live tail (ms). Overridable via settings.
  var DEFAULT_TAIL_INTERVAL = 2000;

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  // Safe toast — ui may not have wired yet during very early calls.
  function toast(msg, kind) {
    try {
      if (UI() && typeof UI().toast === 'function') {
        UI().toast(msg, kind || 'info');
      }
    } catch (e) { /* never let a toast crash a load */ }
  }

  function showProgress(frac, text) {
    try {
      if (UI() && typeof UI().showProgress === 'function') {
        UI().showProgress(frac, text);
      }
    } catch (e) { /* ignore */ }
  }

  function hideProgress() {
    try {
      if (UI() && typeof UI().hideProgress === 'function') {
        UI().hideProgress();
      }
    } catch (e) { /* ignore */ }
  }

  // Hide the empty-state once we have data (also driven by app via "data"
  // event, but do it here defensively so the first load is snappy).
  function hideEmptyState() {
    try {
      var es = document.getElementById('empty-state');
      // Only toggle the [hidden] attribute — never set inline display:none here,
      // or app.js's removeAttribute('hidden') on Clear All could not re-show it
      // (the inline display would win over the CSS rules).
      if (es) { es.hidden = true; }
    } catch (e) { /* ignore */ }
  }

  // Read a File/Blob as text with a graceful fallback for very old engines.
  function readFileText(file) {
    if (file && typeof file.text === 'function') {
      return file.text();
    }
    // Fallback via FileReader.
    return new Promise(function (resolve, reject) {
      try {
        var fr = new FileReader();
        fr.onload = function () { resolve(String(fr.result == null ? '' : fr.result)); };
        fr.onerror = function () { reject(fr.error || new Error('Read failed')); };
        fr.readAsText(file);
      } catch (e) { reject(e); }
    });
  }

  // Ingest one chunk of text as a named "file". Used by openFileList,
  // openText and the live-tail appender (with merge=true for tail).
  function ingestText(text, name, size, fileId, opts) {
    opts = opts || {};
    var parser = P();
    var store = S();
    var format = 'plain';
    try {
      format = parser.detectFormat(text);
    } catch (e) {
      format = 'plain';
    }

    var fileMsg = name || 'log';

    return parser.parseChunked(text, { fileId: fileId }, function (frac, partial) {
      var pct = Math.round((frac || 0) * 100);
      showProgress(frac || 0, 'Parsing ' + fileMsg + '  ' + pct + '%' +
        (partial ? ' (' + partial.toLocaleString() + ' lines)' : ''));
    }).then(function (entries) {
      entries = entries || [];

      if (opts.appendToFile && store.files && store.files.get) {
        // Live-tail append: update the existing file meta's entryCount.
        var existing = store.files.get(fileId);
        var prevCount = existing ? (existing.entryCount || 0) : 0;
        store.setFile({
          id: fileId,
          name: name,
          size: size,
          format: existing ? existing.format : format,
          entryCount: prevCount + entries.length
        });
      } else {
        store.setFile({
          id: fileId,
          name: name,
          size: size,
          format: format,
          entryCount: entries.length
        });
      }

      store.addEntries(entries);

      if (entries.length > 0) {
        hideEmptyState();
      }
      return { fileId: fileId, format: format, count: entries.length };
    });
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  // Open a FileList or array of File objects. Reads + parses each in turn.
  function openFileList(fileListOrArray) {
    var files = [];
    if (fileListOrArray) {
      // FileList is array-like; copy into a real array.
      for (var i = 0; i < fileListOrArray.length; i++) {
        var f = fileListOrArray[i];
        if (f) files.push(f);
      }
    }

    if (files.length === 0) {
      return Promise.resolve([]);
    }

    // Remember for reload().
    lastFiles = files.slice();

    var results = [];
    var total = files.length;

    // Process sequentially so progress is meaningful and memory stays bounded.
    var chain = Promise.resolve();
    files.forEach(function (file, index) {
      chain = chain.then(function () {
        var baseText = 'Loading ' + (file.name || 'file') +
          ' (' + (index + 1) + '/' + total + ')';
        showProgress(0, baseText);
        // Transparently decompress .gz/.zip via the native DecompressionStream
        // when the optional CMT.decompress module is present; otherwise read the
        // file as plain text. Both paths resolve to a text string the parser can
        // ingest. Any failure here is caught by the per-file .catch below, which
        // toasts and continues with the next file.
        var textPromise = (CMT.decompress &&
            typeof CMT.decompress.isCompressed === 'function' &&
            CMT.decompress.isCompressed(file))
          ? CMT.decompress.toText(file)
          : readFileText(file);
        return Promise.resolve(textPromise).then(function (text) {
          var fileId = U().uid();
          var size = (typeof file.size === 'number')
            ? file.size
            : (text ? text.length : 0);
          return ingestText(text, file.name || ('file-' + (index + 1)), size, fileId);
        }).then(function (res) {
          results.push(res);
        }).catch(function (err) {
          // Per-file failure shouldn't abort the whole batch.
          toast('Failed to read "' + (file.name || 'file') + '": ' +
            (err && err.message ? err.message : err), 'error');
        });
      });
    });

    return chain.then(function () {
      hideProgress();
      var totalLines = results.reduce(function (a, r) { return a + (r ? r.count : 0); }, 0);
      if (results.length > 0) {
        toast('Loaded ' + results.length + ' file' + (results.length === 1 ? '' : 's') +
          ' (' + totalLines.toLocaleString() + ' lines)', 'success');
      }
      return results;
    }).catch(function (err) {
      hideProgress();
      toast('Open failed: ' + (err && err.message ? err.message : err), 'error');
      return results;
    });
  }

  // Read clipboard text (requires async clipboard API + secure context).
  function openFromClipboard() {
    if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
      toast('Clipboard read needs a browser served over http(s)', 'warn');
      return Promise.resolve(null);
    }
    return navigator.clipboard.readText().then(function (text) {
      if (!text || !text.trim()) {
        toast('Clipboard is empty', 'warn');
        return null;
      }
      return openText(text, 'clipboard.log');
    }).catch(function (err) {
      toast('Could not read clipboard: ' +
        (err && err.message ? err.message : err), 'error');
      return null;
    });
  }

  // Open a raw text string as a synthetic file.
  function openText(text, name) {
    text = (text == null) ? '' : String(text);
    name = name || 'pasted.log';
    var fileId = U().uid();
    showProgress(0, 'Parsing ' + name);
    return ingestText(text, name, text.length, fileId).then(function (res) {
      hideProgress();
      toast('Loaded ' + name + ' (' + (res ? res.count.toLocaleString() : '0') +
        ' lines)', 'success');
      return res;
    }).catch(function (err) {
      hideProgress();
      toast('Open failed: ' + (err && err.message ? err.message : err), 'error');
      return null;
    });
  }

  // Re-read the last loaded files (or the tailed handle) from scratch.
  function reload() {
    if (lastFiles && lastFiles.length > 0) {
      // Clear and re-open the previously loaded files.
      try { S().clearAll(); } catch (e) { /* ignore */ }
      return openFileList(lastFiles.slice());
    }
    if (tailHandle && typeof tailHandle.getFile === 'function') {
      return tailHandle.getFile().then(function (file) {
        try { S().clearAll(); } catch (e) { /* ignore */ }
        tailLength = 0;
        return readFileText(file).then(function (text) {
          var fileId = tailFileId || U().uid();
          tailFileId = fileId;
          tailLength = text.length;
          return ingestText(text, file.name || 'tail.log', file.size || text.length, fileId);
        });
      }).then(function () {
        hideProgress();
        toast('Reloaded', 'success');
      }).catch(function (err) {
        hideProgress();
        toast('Reload failed: ' + (err && err.message ? err.message : err), 'error');
      });
    }
    toast('Nothing to reload', 'warn');
    return Promise.resolve(null);
  }

  // -----------------------------------------------------------------------
  // Live tail (File System Access API)
  // -----------------------------------------------------------------------

  function tailInterval() {
    try {
      var s = S().settings || {};
      var v = s.tailInterval;
      if (typeof v === 'number' && v >= 250) return v;
    } catch (e) { /* ignore */ }
    return DEFAULT_TAIL_INTERVAL;
  }

  function pollTail() {
    if (tailReading || !tailHandle || typeof tailHandle.getFile !== 'function') {
      return;
    }
    tailReading = true;
    tailHandle.getFile().then(function (file) {
      return readFileText(file).then(function (text) {
        if (text.length > tailLength) {
          // Only parse complete lines: consume up to (and including) the last
          // newline of the new content and leave any trailing partial line for
          // the next poll. Parsing a mid-line slice would split tokens/records
          // and emit garbled "plain" entries.
          var nl = text.lastIndexOf('\n', text.length - 1);
          if (nl < tailLength) {
            // No newline since the last consumed offset — the new content is a
            // single still-incomplete line. Wait for it to finish.
            return null;
          }
          var cut = nl + 1; // include the newline so we advance past it

          // Avoid splitting a multi-line CMTrace/SCCM record across polls: if a
          // record START marker appears after the last record CLOSE trailer
          // within the slice, that record is still being written. Defer from
          // that marker so it is re-read (whole) once its trailer is flushed.
          var slice = text.slice(tailLength, cut);
          var lastStart = slice.lastIndexOf('<![LOG[');
          if (lastStart !== -1) {
            var afterStart = slice.slice(lastStart);
            if (afterStart.indexOf(']LOG]!>') === -1) {
              // Unterminated record start in this slice — hold it back.
              cut = tailLength + lastStart;
            }
          }
          if (cut <= tailLength) {
            // Nothing complete to consume yet.
            return null;
          }

          var appended = text.slice(tailLength, cut);
          tailLength = cut;
          var fid = tailFileId;
          return ingestText(appended, file.name || 'tail.log',
            cut, fid, { appendToFile: true });
        } else if (text.length < tailLength) {
          // File was truncated/rotated — resync to its current length.
          tailLength = text.length;
        }
        return null;
      });
    }).catch(function (err) {
      // A transient read error during tailing shouldn't kill the loop, but
      // a permission revocation should. Surface once and keep going softly.
      toast('Tail read error: ' + (err && err.message ? err.message : err), 'warn');
    }).then(function () {
      tailReading = false;
    });
  }

  // Begin live-tailing a user-picked file. Chromium + secure context only.
  function enableTail() {
    if (typeof window.showOpenFilePicker !== 'function') {
      toast('Live tail needs a Chromium browser served over http(s)', 'warn');
      return Promise.resolve(false);
    }

    return window.showOpenFilePicker({
      multiple: false,
      types: [{
        description: 'Log files',
        accept: { 'text/plain': ['.log', '.lo_', '.txt'] }
      }],
      excludeAcceptAllOption: false
    }).then(function (handles) {
      var handle = handles && handles[0];
      if (!handle) return false;

      tailHandle = handle;
      tailFileId = U().uid();

      return handle.getFile().then(function (file) {
        return readFileText(file).then(function (text) {
          tailLength = text.length;
          return ingestText(text, file.name || 'tail.log',
            file.size || text.length, tailFileId).then(function () {
            hideProgress();
            // Start polling.
            if (tailTimer) { clearInterval(tailTimer); }
            tailTimer = setInterval(pollTail, tailInterval());
            try { S().setTail(true); } catch (e) { /* ignore */ }
            toast('Live tail enabled — watching ' + (file.name || 'file'), 'success');
            return true;
          });
        });
      });
    }).catch(function (err) {
      hideProgress();
      // User cancelling the picker throws AbortError — treat as a no-op.
      if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) {
        return false;
      }
      toast('Could not start live tail: ' +
        (err && err.message ? err.message : err), 'error');
      return false;
    });
  }

  // Stop live-tailing.
  function disableTail() {
    if (tailTimer) {
      clearInterval(tailTimer);
      tailTimer = null;
    }
    tailReading = false;
    try { S().setTail(false); } catch (e) { /* ignore */ }
    toast('Live tail disabled', 'info');
  }

  // -----------------------------------------------------------------------
  // Export
  // -----------------------------------------------------------------------

  function csvEscape(value) {
    var s = (value == null) ? '' : String(value);
    if (/[",\r\n]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function typeLabel(t) {
    if (t === 3) return 'Error';
    if (t === 2) return 'Warning';
    return 'Info';
  }

  // Export the CURRENT filtered view to a .log or .csv download.
  function exportView(kind) {
    var store = S();
    var util = U();
    var view = store.view || [];
    var entries = store.entries || [];

    if (view.length === 0) {
      toast('Nothing to export — the view is empty', 'warn');
      return;
    }

    kind = (kind === 'csv') ? 'csv' : 'log';
    var stamp = new Date();
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var nameStamp = stamp.getFullYear() + pad(stamp.getMonth() + 1) + pad(stamp.getDate()) +
      '-' + pad(stamp.getHours()) + pad(stamp.getMinutes()) + pad(stamp.getSeconds());

    var i, idx, e;

    if (kind === 'log') {
      var parts = [];
      for (i = 0; i < view.length; i++) {
        idx = view[i];
        e = entries[idx];
        if (!e) continue;
        // Prefer the original raw record; fall back to the message.
        parts.push(e.raw != null && e.raw !== '' ? e.raw : (e.message || ''));
      }
      util.download('cmtrace-export-' + nameStamp + '.log',
        parts.join('\n') + '\n', 'text/plain');
      toast('Exported ' + view.length.toLocaleString() + ' lines to .log', 'success');
      return;
    }

    // CSV export.
    var rows = ['Time,Type,Component,Thread,Message'];
    for (i = 0; i < view.length; i++) {
      idx = view[i];
      e = entries[idx];
      if (!e) continue;
      var timeStr;
      if (typeof e.time === 'number' && !isNaN(e.time)) {
        timeStr = util.formatDateTime(e.time);
      } else {
        timeStr = ((e.dateText || '') + ' ' + (e.timeText || '')).trim();
      }
      rows.push([
        csvEscape(timeStr),
        csvEscape(typeLabel(e.type)),
        csvEscape(e.component || ''),
        csvEscape(e.thread || ''),
        csvEscape(e.message || '')
      ].join(','));
    }
    util.download('cmtrace-export-' + nameStamp + '.csv',
      rows.join('\r\n') + '\r\n', 'text/csv');
    toast('Exported ' + view.length.toLocaleString() + ' rows to .csv', 'success');
  }

  // -----------------------------------------------------------------------
  // Drag & drop + paste wiring
  // -----------------------------------------------------------------------

  var dragDepth = 0; // track nested dragenter/leave so we don't flicker

  function appEl() { return document.getElementById('app'); }

  function setDragging(on) {
    var app = appEl();
    if (!app) return;
    if (on) { app.classList.add('dragging'); }
    else { app.classList.remove('dragging'); }
  }

  function wireDragAndDrop() {
    // Allow drops by preventing the browser's default file-open behaviour.
    document.addEventListener('dragenter', function (e) {
      if (e.dataTransfer && hasFiles(e.dataTransfer)) {
        e.preventDefault();
        dragDepth++;
        setDragging(true);
      }
    });

    document.addEventListener('dragover', function (e) {
      if (e.dataTransfer && hasFiles(e.dataTransfer)) {
        e.preventDefault();
        try { e.dataTransfer.dropEffect = 'copy'; } catch (ex) { /* ignore */ }
        setDragging(true);
      }
    });

    document.addEventListener('dragleave', function () {
      // Do NOT gate on hasFiles(): several browsers expose an empty
      // dataTransfer.types on dragleave (types are only guaranteed on drop), so
      // gating here can skip the decrement and strand the .dragging overlay. The
      // dragenter increment is already file-gated, so the counter stays balanced.
      if (dragDepth > 0) dragDepth--;
      if (dragDepth <= 0) {
        dragDepth = 0;
        setDragging(false);
      }
    });

    document.addEventListener('drop', function (e) {
      // Always prevent the default (which would navigate to the file).
      e.preventDefault();
      dragDepth = 0;
      setDragging(false);
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        openFileList(e.dataTransfer.files);
      } else if (e.dataTransfer) {
        // Fallback: dropped plain text.
        var text = '';
        try { text = e.dataTransfer.getData('text/plain'); } catch (ex) { text = ''; }
        if (text && text.trim()) {
          openText(text, 'dropped.log');
        }
      }
    });

    // Some browsers fire dragend instead of a final dragleave.
    document.addEventListener('dragend', function () {
      dragDepth = 0;
      setDragging(false);
    });

    // An explicit drop-zone overlay (optional element) mirrors the doc handlers.
    var dz = document.getElementById('drop-zone');
    if (dz) {
      dz.addEventListener('dragover', function (e) { e.preventDefault(); });
      dz.addEventListener('drop', function (e) {
        e.preventDefault();
        dragDepth = 0;
        setDragging(false);
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          openFileList(e.dataTransfer.files);
        }
      });
    }
  }

  function hasFiles(dt) {
    if (!dt) return false;
    // dt.types may be a DOMStringList or array depending on the browser.
    if (dt.types) {
      for (var i = 0; i < dt.types.length; i++) {
        if (dt.types[i] === 'Files') return true;
      }
    }
    return false;
  }

  function isEditableTarget(target) {
    if (!target) return false;
    var tag = (target.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (target.isContentEditable) return true;
    return false;
  }

  function wirePaste() {
    document.addEventListener('paste', function (e) {
      // Don't hijack paste while the user is typing in a field/search box.
      if (isEditableTarget(e.target || document.activeElement)) {
        return;
      }
      var text = '';
      try {
        if (e.clipboardData && typeof e.clipboardData.getData === 'function') {
          text = e.clipboardData.getData('text/plain') ||
            e.clipboardData.getData('text') || '';
        }
      } catch (ex) { text = ''; }

      if (text && text.trim()) {
        e.preventDefault();
        openText(text, 'clipboard.log');
      }
    });
  }

  // Wire all global listeners once.
  var wired = false;
  function wire() {
    if (wired) return;
    wired = true;
    wireDragAndDrop();
    wirePaste();
  }

  // Auto-wire on DOM ready (app.js also boots, but doing this here keeps
  // drag/drop + paste working even before app wiring runs).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }

  // -----------------------------------------------------------------------
  // Export module
  // -----------------------------------------------------------------------
  CMT.files = {
    openFileList: openFileList,
    openFromClipboard: openFromClipboard,
    openText: openText,
    reload: reload,
    enableTail: enableTail,
    disableTail: disableTail,
    exportView: exportView,
    // exposed for app.js wiring / tests. `wire` is idempotent (guarded by the
    // module-local `wired` flag), so app.js calling files.init() after the
    // DOMContentLoaded auto-wire is a harmless no-op. `init` is an alias so the
    // bootstrap in app.js ("files wiring") resolves to a real function.
    wire: wire,
    init: wire
  };
})();
