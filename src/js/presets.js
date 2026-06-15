window.CMT = window.CMT || {};

/*
 * CMT.presets — recognize well-known ConfigMgr / Intune log files by their
 * file name and auto-apply a tailored set of highlight rules plus a one-line
 * hint to help triage that log type.
 *
 * It is purely additive: it never parses, never mutates entries, and never
 * touches the view. When a file with a recognized base name first appears it
 * adds 2–4 highlight rules (via CMT.store.addHighlight, deduplicating against
 * existing rules) and surfaces a hint toast. Each file is handled at most once.
 *
 * Contract guarantees:
 *  - init() is self-contained and never throws on empty / partial state.
 *  - Matching is case-insensitive on the file BASE name (path + extension are
 *    stripped before matching).
 *  - Highlight rule ids always come from CMT.util.uid() (never time/random).
 */
(function () {
  'use strict';

  // ---- short-hands (resolved lazily so load-order quirks never throw) ----
  function store() { return CMT.store; }
  function util() { return CMT.util; }
  function ui() { return CMT.ui; }

  // Fallback id generator: only used if CMT.util.uid is somehow unavailable
  // during early bootstrap. Stays deterministic-ish without Date/Math.random
  // to honor the "no time/random ids" rule.
  var _idSeq = 0;
  function newId() {
    var u = util();
    if (u && typeof u.uid === 'function') return u.uid();
    return 'preset-hl-' + (++_idSeq);
  }

  // -------------------------------------------------------------------------
  //  PRESET DEFINITIONS
  //
  //  Each preset:
  //    key        : stable identifier for the preset
  //    label      : human-readable name
  //    match      : function(baseLower) -> boolean (already lowercased basename)
  //    hint       : one-line triage hint shown as an info toast
  //    highlights : [{term, color}] — 2..4 distinct, useful highlight terms
  //
  //  Colors are picked to be visually distinct within a single preset and read
  //  well against both light and dark themes (the highlight system tints the
  //  row text / background with these).
  // -------------------------------------------------------------------------

  // A small, readable palette reused across presets.
  var C = {
    red: '#ff6b6b',     // failure / errors
    amber: '#ffb454',   // warnings / exit codes
    green: '#5fd17a',   // success
    blue: '#5ac8ff',    // accent
    purple: '#c08bff',  // identity / policy
    cyan: '#56ccd6',    // content / transfer
    pink: '#ff8ad1'     // download / install
  };

  /**
   * The ordered list of known presets. The FIRST matching preset wins, so the
   * more specific matchers are placed before the broader ones (e.g. CCMSetup
   * before the generic CcmExec).
   * @returns {Array<object>}
   */
  function presetList() {
    return [
      {
        key: 'appenforce',
        label: 'AppEnforce.log',
        match: function (b) { return b.indexOf('appenforce') !== -1; },
        hint: 'AppEnforce.log: look for "Process completed with exit code" and 1603 / 0x87D0xxxx app-deployment failures.',
        highlights: [
          { term: 'Process completed with exit code', color: C.green },
          { term: 'Failed', color: C.red },
          { term: 'exit code', color: C.amber },
          { term: '1603', color: C.red }
        ]
      },
      {
        key: 'appdiscovery',
        label: 'AppDiscovery.log',
        match: function (b) { return b.indexOf('appdiscovery') !== -1; },
        hint: 'AppDiscovery.log: detection results — search "detected", "not detected" and rule evaluation lines.',
        highlights: [
          { term: 'detected', color: C.green },
          { term: 'not detected', color: C.amber },
          { term: 'Failed', color: C.red }
        ]
      },
      {
        key: 'execmgr',
        label: 'execmgr.log',
        match: function (b) { return b.indexOf('execmgr') !== -1; },
        hint: 'execmgr.log: program / package execution — track "Execution Request", exit codes and "Failed".',
        highlights: [
          { term: 'Execution Request', color: C.blue },
          { term: 'exit code', color: C.amber },
          { term: 'Failed', color: C.red },
          { term: 'succeeded', color: C.green }
        ]
      },
      {
        key: 'intune-ime',
        label: 'IntuneManagementExtension.log',
        match: function (b) {
          return b.indexOf('intunemanagementextension') !== -1 ||
                 b.indexOf('agentexecutor') !== -1 ||
                 b === 'ime' || b === 'ime.log' ||
                 /(^|[^a-z])ime(\.|$)/.test(b) ||
                 (b.indexOf('ime') !== -1 && b.indexOf('intune') !== -1);
        },
        hint: 'Intune IME: Win32/PowerShell delivery — look for exit codes, "ESPApp", and 0x87D0xxxx / 0x80070005 errors.',
        highlights: [
          { term: 'exit code', color: C.amber },
          { term: 'error', color: C.red },
          { term: 'Win32App', color: C.blue },
          { term: 'Success', color: C.green }
        ]
      },
      {
        key: 'ccmsetup',
        label: 'ccmsetup.log',
        match: function (b) { return b.indexOf('ccmsetup') !== -1; },
        hint: 'ccmsetup.log: client install — watch "Installation succeeded" / "failed with error code" and 0x8024xxxx.',
        highlights: [
          { term: 'Installation succeeded', color: C.green },
          { term: 'failed with error code', color: C.red },
          { term: 'error code', color: C.amber },
          { term: 'MSI', color: C.blue }
        ]
      },
      {
        key: 'wuahandler',
        label: 'WUAHandler / UpdatesDeployment',
        match: function (b) {
          return b.indexOf('wuahandler') !== -1 ||
                 b.indexOf('updatesdeployment') !== -1 ||
                 b.indexOf('updateshandler') !== -1;
        },
        hint: 'WUAHandler / UpdatesDeployment: Windows Update agent — search "0x8024" WU codes and "Failed to".',
        highlights: [
          { term: '0x8024', color: C.red },
          { term: 'Failed', color: C.amber },
          { term: 'WARNING', color: C.amber },
          { term: 'Installed update', color: C.green }
        ]
      },
      {
        key: 'content-transfer',
        label: 'ContentTransferManager / DataTransferService / CAS',
        match: function (b) {
          return b.indexOf('contenttransfermanager') !== -1 ||
                 b.indexOf('datatransferservice') !== -1 ||
                 b.indexOf('cas.log') !== -1 ||
                 b === 'cas';
        },
        hint: 'Content transfer (CTM / DTS / CAS): download path — look for "job", "BITS" state changes and failures.',
        highlights: [
          { term: 'job', color: C.cyan },
          { term: 'BITS', color: C.blue },
          { term: 'Failed', color: C.red },
          { term: 'complete', color: C.green }
        ]
      },
      {
        key: 'locationservices',
        label: 'LocationServices.log',
        match: function (b) { return b.indexOf('locationservices') !== -1; },
        hint: 'LocationServices.log: MP / DP / boundary resolution — search "Distribution Point", "MP" and failures.',
        highlights: [
          { term: 'Distribution Point', color: C.cyan },
          { term: 'Management Point', color: C.blue },
          { term: 'Failed', color: C.red },
          { term: 'boundary', color: C.purple }
        ]
      },
      {
        key: 'policyagent',
        label: 'PolicyAgent.log',
        match: function (b) { return b.indexOf('policyagent') !== -1; },
        hint: 'PolicyAgent.log: policy retrieval — track "policy", request assignments and "Failed to" lines.',
        highlights: [
          { term: 'policy', color: C.purple },
          { term: 'assignment', color: C.blue },
          { term: 'Failed', color: C.red }
        ]
      },
      {
        key: 'clientidmanager',
        label: 'ClientIDManagerStartup.log',
        match: function (b) { return b.indexOf('clientidmanagerstartup') !== -1; },
        hint: 'ClientIDManagerStartup.log: client GUID / registration — look for "GUID", "registration" and errors.',
        highlights: [
          { term: 'GUID', color: C.purple },
          { term: 'registration', color: C.blue },
          { term: 'error', color: C.red }
        ]
      },
      {
        // Generic CcmExec last so more specific ConfigMgr logs match first.
        key: 'ccmexec',
        label: 'CcmExec.log',
        match: function (b) { return b.indexOf('ccmexec') !== -1; },
        hint: 'CcmExec.log: SMS Agent Host service — watch service start/stop, "Failed" and "Phase" transitions.',
        highlights: [
          { term: 'Failed', color: C.red },
          { term: 'Phase', color: C.blue },
          { term: 'shutdown', color: C.amber },
          { term: 'started', color: C.green }
        ]
      }
    ];
  }

  // -------------------------------------------------------------------------
  //  Internal state — which fileIds have already been processed.
  // -------------------------------------------------------------------------
  var handledFiles = Object.create(null);
  var subscribed = false;

  /**
   * Strip directory components and return the lowercased base file name.
   * Handles both forward and back slashes (logs often carry Windows paths).
   * @param {string} fileName
   * @returns {string}
   */
  function baseName(fileName) {
    var name = String(fileName == null ? '' : fileName);
    // Take the part after the last slash (either separator).
    var slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
    if (slash >= 0) name = name.slice(slash + 1);
    return name.toLowerCase();
  }

  // -------------------------------------------------------------------------
  //  PUBLIC: detect
  // -------------------------------------------------------------------------

  /**
   * Detect whether a file name matches a known ConfigMgr / Intune log preset.
   * @param {string} fileName
   * @returns {{key:string,label:string,hint:string,highlights:Array<{term:string,color:string}>}|null}
   */
  function detect(fileName) {
    var base = baseName(fileName);
    if (!base) return null;
    var list = presetList();
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      try {
        if (p.match(base)) {
          return {
            key: p.key,
            label: p.label,
            hint: p.hint,
            highlights: p.highlights.slice()
          };
        }
      } catch (e) {
        // A faulty matcher must never break detection of other presets.
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('CMT.presets: matcher "' + p.key + '" threw:', e);
        }
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  //  PUBLIC: apply
  // -------------------------------------------------------------------------

  /**
   * Build a normalized comparison key for an existing highlight rule so we can
   * skip adding duplicates (same term, case-insensitively).
   * @param {object} rule
   * @returns {string}
   */
  function ruleKey(rule) {
    return String(rule && rule.term != null ? rule.term : '').toLowerCase();
  }

  /**
   * Apply a preset: add each of its highlight rules (skipping any whose term
   * already exists) and surface its hint as an info toast.
   * @param {{hint:string,highlights:Array<{term:string,color:string}>}} preset
   * @returns {number} count of rules actually added
   */
  function apply(preset) {
    if (!preset) return 0;
    var s = store();
    var added = 0;

    if (s && typeof s.addHighlight === 'function') {
      // Snapshot existing rule terms for duplicate suppression.
      var existing = Object.create(null);
      var current = (s.state && Array.isArray(s.state.highlightRules))
        ? s.state.highlightRules : [];
      for (var e = 0; e < current.length; e++) {
        existing[ruleKey(current[e])] = true;
      }

      var hl = preset.highlights || [];
      for (var i = 0; i < hl.length; i++) {
        var term = hl[i] && hl[i].term != null ? String(hl[i].term) : '';
        if (!term) continue;
        var key = term.toLowerCase();
        if (existing[key]) continue; // already highlighted
        existing[key] = true;        // also dedupe within this preset
        s.addHighlight({
          id: newId(),
          term: term,
          color: hl[i].color || '#ffd54f',
          caseSensitive: false,
          regex: false,
          enabled: true
        });
        added++;
      }
    }

    // Surface the hint regardless of how many rules were added so the user
    // always learns what to look for in this log type.
    if (preset.hint && ui() && typeof ui().toast === 'function') {
      ui().toast(preset.hint, 'info');
    }

    return added;
  }

  // -------------------------------------------------------------------------
  //  Wiring — process newly-loaded files exactly once.
  // -------------------------------------------------------------------------

  /**
   * Scan store.files for any file not yet handled; detect + apply its preset.
   * Safe to call repeatedly (idempotent per fileId).
   */
  function processFiles() {
    var s = store();
    if (!s || !s.state || !(s.state.files instanceof Map)) return;
    s.state.files.forEach(function (meta) {
      if (!meta || !meta.id) return;
      if (handledFiles[meta.id]) return;
      handledFiles[meta.id] = true; // mark first so a throw cannot re-trigger
      var preset = detect(meta.name);
      if (preset) {
        try {
          apply(preset);
        } catch (err) {
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('CMT.presets: failed applying preset for "' +
              meta.name + '":', err);
          }
        }
      }
    });
  }

  // -------------------------------------------------------------------------
  //  PUBLIC: init
  // -------------------------------------------------------------------------

  /**
   * Subscribe to the store's "data" event and process any already-loaded files
   * once. Each known file is handled a single time across the session.
   */
  function init() {
    var s = store();
    if (s && typeof s.on === 'function' && !subscribed) {
      subscribed = true;
      s.on('data', processFiles);
    }
    // Handle files that may already be present at init time.
    processFiles();
  }

  // =======================================================================
  //  PUBLIC API
  // =======================================================================
  CMT.presets = {
    init: init,
    detect: detect,
    apply: apply
  };
})();
