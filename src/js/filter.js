window.CMT = window.CMT || {};

/*
 * CMT.filter — entry filtering for the CMTrace grid view.
 *
 * A FilterSpec drives which entries are visible. apply() does a single
 * efficient pass over the entries and returns the entry indices (entry.idx,
 * which equals the array position in store.entries) that PASS the filter,
 * preserving order.
 *
 * FilterSpec = {
 *   text:        string,                       // text to match (empty = no text filter)
 *   textMode:    "contains"|"notcontains"|"regex",
 *   caseSensitive: boolean,
 *   types:       { 1:boolean, 2:boolean, 3:boolean },
 *   components:  null | Set<string>,           // null = all components allowed
 *   threads:     null | Set<string>,           // null = all threads allowed
 *   timeFrom:    null | number,                // epoch ms, inclusive lower bound
 *   timeTo:      null | number                 // epoch ms, inclusive upper bound
 * }
 */
(function () {
  'use strict';

  /**
   * Build a fresh FilterSpec that passes everything (the "empty" spec).
   * @returns {Object} a new FilterSpec
   */
  function makeSpec() {
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

  /**
   * True when the spec would pass every entry (no effective filtering).
   * @param {Object} spec a FilterSpec (may be partial / undefined)
   * @returns {boolean}
   */
  function isEmpty(spec) {
    if (!spec) return true;

    // Any text filter (after trimming nothing — empty string means "no filter").
    if (spec.text) return false;

    // All three severities must be allowed.
    var types = spec.types;
    if (types) {
      if (types[1] === false || types[2] === false || types[3] === false) {
        return false;
      }
    }

    // Component / thread constraints make it non-empty.
    if (spec.components instanceof Set) return false;
    if (spec.threads instanceof Set) return false;

    // Time-range constraints make it non-empty.
    if (spec.timeFrom != null) return false;
    if (spec.timeTo != null) return false;

    return true;
  }

  /**
   * Compile the text matcher for a spec ONCE. Returns a predicate that takes
   * the (already case-normalized when needed) haystack string and returns
   * whether it passes the text portion of the filter.
   *
   * For regex mode an invalid pattern is treated as "no text filter" (always
   * passes) so a half-typed regex never empties the view unexpectedly.
   *
   * @param {Object} spec FilterSpec
   * @returns {{test:function(string):boolean, normalize:function(string):string}|null}
   *   null when there is no text filter at all.
   */
  function compileText(spec) {
    var raw = spec.text;
    if (!raw) return null; // no text filter

    var caseSensitive = !!spec.caseSensitive;
    var mode = spec.textMode || 'contains';

    if (mode === 'regex') {
      var flags = caseSensitive ? '' : 'i';
      var re;
      try {
        re = new RegExp(raw, flags);
      } catch (e) {
        // Invalid regex -> no text filter (pass everything text-wise).
        return null;
      }
      return {
        // Regex carries its own case handling via the 'i' flag, so the
        // haystack is passed through unchanged.
        normalize: identity,
        test: function (hay) {
          // Reset lastIndex defensively in case a global flag sneaks in.
          re.lastIndex = 0;
          return re.test(hay);
        }
      };
    }

    // contains / notcontains: do a substring search. Pre-normalize the needle
    // once; the haystack is normalized per-call by normalize().
    var needle = caseSensitive ? raw : raw.toLowerCase();
    var normalize = caseSensitive ? identity : toLower;

    if (mode === 'notcontains') {
      return {
        normalize: normalize,
        test: function (hay) {
          return hay.indexOf(needle) === -1;
        }
      };
    }

    // default: contains
    return {
      normalize: normalize,
      test: function (hay) {
        return hay.indexOf(needle) !== -1;
      }
    };
  }

  function identity(s) {
    return s;
  }

  function toLower(s) {
    return s.toLowerCase();
  }

  /**
   * Apply a FilterSpec to a list of entries in a single pass.
   *
   * @param {Array} entries array of Entry objects (entry.idx === array index)
   * @param {Object} spec FilterSpec
   * @returns {number[]} entry.idx values that PASS, in original order
   */
  function apply(entries, spec) {
    var out = [];
    if (!entries || entries.length === 0) return out;

    // Fast path: nothing to filter -> every entry passes, in order.
    if (isEmpty(spec)) {
      for (var k = 0; k < entries.length; k++) {
        out.push(entries[k].idx);
      }
      return out;
    }

    var types = spec.types || { 1: true, 2: true, 3: true };
    var allowType1 = types[1] !== false;
    var allowType2 = types[2] !== false;
    var allowType3 = types[3] !== false;

    var components = spec.components instanceof Set ? spec.components : null;
    var threads = spec.threads instanceof Set ? spec.threads : null;

    var timeFrom = spec.timeFrom != null ? spec.timeFrom : null;
    var timeTo = spec.timeTo != null ? spec.timeTo : null;
    var hasTime = timeFrom !== null || timeTo !== null;

    // Precompile the text matcher exactly once.
    var matcher = compileText(spec);

    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];

      // --- type filter ---
      var t = e.type;
      if (t === 1) {
        if (!allowType1) continue;
      } else if (t === 2) {
        if (!allowType2) continue;
      } else if (t === 3) {
        if (!allowType3) continue;
      } else {
        // Unknown/legacy type: treat as info (type 1) for filtering purposes.
        if (!allowType1) continue;
      }

      // --- component filter ---
      if (components !== null && !components.has(e.component)) continue;

      // --- thread filter ---
      if (threads !== null && !threads.has(e.thread)) continue;

      // --- time-range filter ---
      if (hasTime) {
        var tm = e.time;
        // Entries without a parseable time are excluded when a range is set.
        if (tm == null) continue;
        if (timeFrom !== null && tm < timeFrom) continue;
        if (timeTo !== null && tm > timeTo) continue;
      }

      // --- text filter (against message only, per contract) ---
      if (matcher !== null) {
        var msg = e.message;
        if (msg == null) msg = '';
        if (!matcher.test(matcher.normalize(msg))) continue;
      }

      out.push(e.idx);
    }

    return out;
  }

  CMT.filter = {
    makeSpec: makeSpec,
    // Backwards/forwards-compatible alias used elsewhere in the contract.
    EMPTY_SPEC: makeSpec(),
    apply: apply,
    isEmpty: isEmpty
  };
})();
