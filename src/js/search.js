window.CMT = window.CMT || {};
(function () {
  'use strict';

  /**
   * CMT.search — incremental find within the FILTERED view.
   *
   * Spec shape: { text:string, caseSensitive?:boolean, regex?:boolean }
   *
   * Matching target for a single entry is `message + " " + component`,
   * which keeps component text searchable alongside the log message.
   */

  /**
   * Compile a search spec into a fast predicate over a haystack string.
   * The (expensive) regex compilation / case normalization happens ONCE here,
   * never inside the per-entry loops.
   *
   * @param {{text:string,caseSensitive?:boolean,regex?:boolean}} spec
   * @returns {((haystack:string)=>boolean)|null} predicate, or null if the
   *          spec has no searchable text or the regex is invalid.
   */
  function compile(spec) {
    if (!spec) return null;
    var text = spec.text == null ? '' : String(spec.text);
    if (text === '') return null;

    var caseSensitive = !!spec.caseSensitive;

    if (spec.regex) {
      var re;
      try {
        re = new RegExp(text, caseSensitive ? 'g' : 'gi');
      } catch (e) {
        // Invalid regex => never matches (callers treat this as "no match").
        return null;
      }
      return function (haystack) {
        // Reset lastIndex because the regex is reused across many calls.
        re.lastIndex = 0;
        return re.test(haystack);
      };
    }

    if (caseSensitive) {
      var needle = text;
      return function (haystack) {
        return haystack.indexOf(needle) !== -1;
      };
    }

    var needleLc = text.toLowerCase();
    return function (haystack) {
      return haystack.toLowerCase().indexOf(needleLc) !== -1;
    };
  }

  /**
   * Build the searchable haystack for one entry.
   * @param {object} entry
   * @returns {string}
   */
  function haystackOf(entry) {
    if (!entry) return '';
    var message = entry.message == null ? '' : entry.message;
    var component = entry.component == null ? '' : entry.component;
    return message + ' ' + component;
  }

  /**
   * Does a single entry match the spec?
   * @param {object} entry
   * @param {{text:string,caseSensitive?:boolean,regex?:boolean}} spec
   * @returns {boolean}
   */
  function matches(entry, spec) {
    var pred = compile(spec);
    if (!pred) return false;
    return pred(haystackOf(entry));
  }

  /**
   * Find the next matching VIEW POSITION starting just past `fromViewPos`,
   * moving in direction `dir` (+1/-1), wrapping around the whole view exactly
   * once.
   *
   * @param {object[]} entries     full merged entry array
   * @param {number[]} viewIndices indices into `entries` that form the view
   * @param {{text:string,caseSensitive?:boolean,regex?:boolean}} spec
   * @param {number} fromViewPos   current view position (search starts past it)
   * @param {number} dir           +1 forward, -1 backward
   * @returns {number} the view position of the next match, or -1
   */
  function find(entries, viewIndices, spec, fromViewPos, dir) {
    if (!entries || !viewIndices) return -1;
    var n = viewIndices.length;
    if (n === 0) return -1;

    var pred = compile(spec);
    if (!pred) return -1;

    var step = dir < 0 ? -1 : 1;

    // Normalize the starting position. If fromViewPos is out of range we treat
    // it as if the cursor sat just before the first / after the last position
    // so the very first probe lands on a valid slot.
    var start = fromViewPos;
    if (typeof start !== 'number' || isNaN(start)) {
      start = step > 0 ? -1 : 0;
    }

    // Probe each of the n positions exactly once, beginning one step away from
    // the start and wrapping with modular arithmetic.
    for (var k = 1; k <= n; k++) {
      // Positive modulo so backward search wraps correctly.
      var pos = (((start + step * k) % n) + n) % n;
      var entry = entries[viewIndices[pos]];
      if (entry && pred(haystackOf(entry))) {
        return pos;
      }
    }
    return -1;
  }

  /**
   * Return the view positions of ALL matches in the filtered view.
   * Used for the find match count.
   *
   * @param {object[]} entries
   * @param {number[]} viewIndices
   * @param {{text:string,caseSensitive?:boolean,regex?:boolean}} spec
   * @returns {number[]} ascending view positions that match
   */
  function allMatches(entries, viewIndices, spec) {
    var out = [];
    if (!entries || !viewIndices) return out;

    var pred = compile(spec);
    if (!pred) return out;

    for (var pos = 0; pos < viewIndices.length; pos++) {
      var entry = entries[viewIndices[pos]];
      if (entry && pred(haystackOf(entry))) {
        out.push(pos);
      }
    }
    return out;
  }

  CMT.search = {
    matches: matches,
    find: find,
    allMatches: allMatches
  };
})();
