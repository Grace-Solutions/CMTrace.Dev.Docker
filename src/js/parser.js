window.CMT = window.CMT || {};
(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // CMT.parser
  // Parses three log formats into the shared Entry shape:
  //   (A) CMTrace NEW   : <![LOG[MSG]LOG]!><time="..." date="..." type="N" ...>
  //   (B) SCCM OLD      : MSG $$<COMPONENT><MM-DD-YYYY HH:MM:SS.mmm+zzz><thread=NNNN (0x..)>
  //   (C) PLAIN         : one line per entry, with best-effort timestamp/severity
  //
  // The parser is a line-oriented state machine. Multi-line CMTrace/SCCM
  // records are handled by recognizing a record START marker; any line that is
  // NOT a new record start is treated as a continuation and appended to the
  // previous entry's message + raw with a newline.
  // -------------------------------------------------------------------------

  // util may not yet be attached at file-eval time in odd load orders; resolve
  // lazily so we always pick up the real implementation when parsing runs.
  function util() {
    return (window.CMT && window.CMT.util) || null;
  }

  // ---- Regexes -------------------------------------------------------------

  // Start of a CMTrace record. The full record is "<![LOG[ ... ]LOG]!>" followed
  // by an attribute tag. A record may span multiple physical lines, so we only
  // require the opening marker to flag a line as a record start.
  var RE_CM_START = /<!\[LOG\[/;

  // The attribute trailer that closes a CMTrace record:
  //   ]LOG]!><time="..." date="..." component="..." context="..." type="N"
  //          thread="..." file="...">
  // Captured as: [1] = message body, [2] = raw attribute string (without < >).
  var RE_CM_FULL = /<!\[LOG\[([\s\S]*?)\]LOG\]!>\s*<([^>]*)>/;
  // Global variant used to walk EVERY record packed onto one physical line.
  // ConfigMgr writers commonly emit several records back-to-back with no
  // newline between them; a single exec would only return the first.
  var RE_CM_FULL_G = /<!\[LOG\[([\s\S]*?)\]LOG\]!>\s*<([^>]*)>/g;

  // Tail of a record line — used to know whether a started record is "closed"
  // on the current accumulated text (the ]LOG]!><...> trailer is present).
  var RE_CM_CLOSE = /\]LOG\]!>\s*<[^>]*>/;

  // SCCM old format trailer:  $$<COMPONENT><DATE TIME><thread=NNNN (0x...)>
  // The presence of "$$<" + a "<thread=" group identifies an SCCM record.
  var RE_SCCM_START = /\$\$<[^>]*><[^>]*><thread=/;
  // Full SCCM capture: [1]=message, [2]=component, [3]=date+time, [4]=thread block
  var RE_SCCM_FULL =
    /^([\s\S]*?)\$\$<([^>]*)><([^>]*)><(thread=[^>]*)>\s*$/;
  // Unanchored SCCM trailer detector. The closing "$$<..><..><thread=..>" always
  // lands on a single physical line, so this lets us cheaply test ONLY the newly
  // appended line for closure instead of re-scanning the whole pending buffer.
  var RE_SCCM_CLOSE = /\$\$<[^>]*><[^>]*><thread=[^>]*>\s*$/;

  // Individual attribute extraction from the CMTrace tag, any order, optional.
  // The name is anchored to an attribute boundary (start-of-tag or preceding
  // whitespace) and regex-escaped so a requested name cannot match as a suffix
  // of another attribute (e.g. attr(tag,'time') must not match 'uptime="99"').
  function attr(tag, name) {
    var re = new RegExp('(?:^|\\s)' + escapeRe(name) + '="([^"]*)"');
    var m = re.exec(tag);
    return m ? m[1] : null;
  }

  // Escape regex metacharacters in a literal string.
  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Plain-text leading-timestamp detectors. Each returns {time,timeText,
  // dateText} or null. Order matters (most specific first).
  var MONTHS = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
  };

  // ISO "YYYY-MM-DD HH:MM:SS(.mmm)?" or with 'T' or '/'.
  var RE_PLAIN_ISO =
    /^\s*(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?/;
  // Bracketed "[HH:MM:SS(.mmm)?]"
  var RE_PLAIN_BRACKET = /^\s*\[(\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?\]/;
  // Syslog "Mon DD HH:MM:SS"
  var RE_PLAIN_SYSLOG =
    /^\s*([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})/;

  // Severity keyword heuristics for plain / SCCM upgrade.
  var RE_SEV_ERROR = /\b(error|fatal|fail(ed|ure)?)\b/i;
  var RE_SEV_WARN = /\b(warn(ing)?)\b/i;
  // Conservative SCCM error signal (hex error code anywhere or explicit words).
  var RE_SCCM_ERR = /error|fail|0x[0-9a-f]{8}/i;

  // ---- Entry factory -------------------------------------------------------

  function newEntry(fileId) {
    return {
      idx: 0, // assigned by store later
      fileId: fileId || '',
      message: '',
      component: '',
      type: 1,
      time: null,
      timeText: '',
      dateText: '',
      thread: '',
      context: '',
      source: '',
      raw: ''
    };
  }

  // Map a type attribute string to 1|2|3, default 1.
  function toType(v) {
    var n = parseInt(v, 10);
    if (n === 2) return 2;
    if (n === 3) return 3;
    return 1;
  }

  // ---- Format detection ----------------------------------------------------

  // Unanchored "a complete SCCM record exists" detector for format sniffing.
  // (RE_SCCM_FULL is ^...$ anchored and so cannot be used against a multi-line
  // head slice with .test.)
  var RE_SCCM_FULL_ANY = /\$\$<[^>]*><[^>]*><thread=[^>]*>/;

  function detectFormat(sampleText) {
    if (!sampleText) return 'plain';
    // Only scan a leading slice for speed on huge inputs.
    var head = sampleText.length > 65536 ? sampleText.slice(0, 65536) : sampleText;
    // Require a FULL record (open marker + closing trailer), not just the
    // opening marker. A lone stray "<![LOG[" embedded in some quoted message
    // must not flip the whole file into the record-aware parse path (which can
    // otherwise accumulate the rest of the file into one never-closing record).
    if (RE_CM_FULL.test(head)) return 'cmtrace';
    if (RE_SCCM_FULL_ANY.test(head)) return 'sccm';
    return 'plain';
  }

  // ---- Per-record builders -------------------------------------------------

  // Build an Entry from a complete CMTrace record (message + attribute tag).
  function buildCmEntry(message, tag, raw, fileId) {
    var e = newEntry(fileId);
    e.message = message;
    e.raw = raw;
    var u = util();
    var timeText = attr(tag, 'time') || '';
    var dateText = attr(tag, 'date') || '';
    e.timeText = timeText;
    e.dateText = dateText;
    e.component = attr(tag, 'component') || '';
    e.context = attr(tag, 'context') || '';
    e.thread = attr(tag, 'thread') || '';
    e.source = attr(tag, 'file') || '';
    var typeAttr = attr(tag, 'type');
    e.type = typeAttr == null ? 1 : toType(typeAttr);
    e.time = u && u.parseCmTime ? u.parseCmTime(timeText, dateText) : null;
    return e;
  }

  // Build an Entry from a complete SCCM record line.
  function buildSccmEntry(m, raw, fileId) {
    var e = newEntry(fileId);
    e.message = m[1].replace(/\s+$/, '');
    e.raw = raw;
    e.component = (m[2] || '').trim();
    // m[3] is "MM-DD-YYYY HH:MM:SS.mmm+zzz" — split into date + time.
    var stamp = (m[3] || '').trim();
    var sp = stamp.split(/\s+/);
    var dateText = '';
    var timeText = '';
    if (sp.length >= 2) {
      dateText = sp[0];
      timeText = sp.slice(1).join(' ');
    } else if (sp.length === 1) {
      // Some variants put the whole thing as time only.
      timeText = sp[0];
    }
    e.dateText = dateText;
    e.timeText = timeText;
    // thread=NNNN (0xHEX) -> keep the numeric thread id.
    var tm = /thread=(\d+)/.exec(m[4] || '');
    e.thread = tm ? tm[1] : '';
    var u = util();
    e.time = u && u.parseCmTime ? u.parseCmTime(timeText, dateText) : null;
    // type defaults 1; conservative upgrade to error only on clear signals.
    e.type = 1;
    if (RE_SCCM_ERR.test(e.message)) {
      // Keep it conservative: explicit "error"/"fail" -> error, else leave 1.
      if (RE_SEV_ERROR.test(e.message)) e.type = 3;
    }
    return e;
  }

  // Build a plain-text Entry from a single line.
  function buildPlainEntry(line, fileId) {
    var e = newEntry(fileId);
    e.message = line;
    e.raw = line;
    var u = util();
    var m;

    if ((m = RE_PLAIN_ISO.exec(line))) {
      var dateText = m[1] + '-' + m[2] + '-' + m[3]; // YYYY-MM-DD
      var ms = m[7] ? m[7] : '000';
      while (ms.length < 3) ms += '0';
      var timeText = m[4] + ':' + m[5] + ':' + m[6] + '.' + ms;
      e.dateText = dateText;
      e.timeText = timeText;
      // Build epoch via local Date (ISO date order, not CMTrace MM-DD-YYYY).
      e.time = isoToEpoch(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6], +ms);
    } else if ((m = RE_PLAIN_BRACKET.exec(line))) {
      var ms2 = m[4] ? m[4] : '000';
      while (ms2.length < 3) ms2 += '0';
      e.timeText = m[1] + ':' + m[2] + ':' + m[3] + '.' + ms2;
      // No date present; leave time null (cannot anchor a day reliably).
      e.time = null;
    } else if ((m = RE_PLAIN_SYSLOG.exec(line))) {
      var mon = MONTHS[m[1].toLowerCase()];
      if (mon != null) {
        var year = new Date().getFullYear(); // syslog omits year
        e.dateText = m[1] + ' ' + m[2];
        e.timeText = m[3] + ':' + m[4] + ':' + m[5];
        e.time = isoToEpoch(year, mon + 1, +m[2], +m[3], +m[4], +m[5], 0);
      }
    }

    // Severity by keyword.
    if (RE_SEV_ERROR.test(line)) e.type = 3;
    else if (RE_SEV_WARN.test(line)) e.type = 2;
    else e.type = 1;

    return e;
  }

  // Local-time epoch from explicit Y/M/D H:M:S.ms components.
  function isoToEpoch(y, mo, d, h, mi, s, ms) {
    var t = new Date(y, mo - 1, d, h, mi, s, ms).getTime();
    return isNaN(t) ? null : t;
  }

  // ---- Core synchronous parse ---------------------------------------------

  // Internal incremental parser used by both parse() and parseChunked().
  // It exposes feed(lines, start, end, out) over a slice of the line array and
  // keeps boundary state (the in-progress record) across slices.
  function createMachine(fileId, format) {
    // pending holds a record that has started but whose closing trailer has not
    // yet been seen (multi-line CMTrace/SCCM record).
    var pending = null; // { kind:'cm'|'sccm', buf:string }

    // Cap how large an unterminated record may grow before we give up waiting
    // for a trailer and flush it as plain text. This bounds memory and, more
    // importantly, prevents a single never-closing record (e.g. caused by a
    // stray "<![LOG[" marker in a non-CMTrace file) from accumulating the whole
    // remainder of the input into one buffer.
    var MAX_PENDING_LINES = 1000;
    var MAX_PENDING_CHARS = 1 << 20; // 1 MiB

    // Flush the in-progress record. `carryStart` is true when called because a
    // brand-new record start was seen on the SAME physical line that is being
    // flushed (so an unterminated trailing record-start should be carried over
    // as the next pending rather than emitted as plain).
    function flushPending(out) {
      if (!pending) return;
      var next = null;
      if (pending.kind === 'cm') {
        var buf = pending.buf;
        // Walk EVERY complete record in the buffer (several may be packed onto
        // one physical line with no separator), not just the first.
        RE_CM_FULL_G.lastIndex = 0;
        var fm;
        var lastEnd = 0;
        var matched = false;
        while ((fm = RE_CM_FULL_G.exec(buf)) !== null) {
          matched = true;
          // The raw for this record is its own slice, not the whole buffer.
          out.push(buildCmEntry(fm[1], fm[2], buf.slice(fm.index, RE_CM_FULL_G.lastIndex), fileId));
          lastEnd = RE_CM_FULL_G.lastIndex;
          // Guard against a zero-width match (cannot happen here, but safe).
          if (RE_CM_FULL_G.lastIndex === fm.index) RE_CM_FULL_G.lastIndex++;
        }
        if (!matched) {
          // Unterminated CMTrace record: salvage as plain so nothing is lost.
          out.push(buildPlainEntry(buf, fileId));
        } else if (lastEnd < buf.length) {
          // Trailing remainder after the last complete record.
          var tail = buf.slice(lastEnd).replace(/^\n+/, '');
          if (RE_CM_START.test(tail)) {
            // The remainder opens a new (so-far unterminated) record. Keep it
            // pending so it can continue on the next physical line(s).
            next = { kind: 'cm', buf: tail, lines: 1 };
          } else if (tail.replace(/^\s+/, '').length > 0) {
            // Genuine trailing content that is not a record start -> plain.
            out.push(buildPlainEntry(tail, fileId));
          }
        }
      } else if (pending.kind === 'sccm') {
        var sm = RE_SCCM_FULL.exec(pending.buf);
        if (sm) {
          out.push(buildSccmEntry(sm, pending.buf, fileId));
        } else {
          out.push(buildPlainEntry(pending.buf, fileId));
        }
      }
      pending = next;
    }

    // Process one physical line in cmtrace/sccm aware mode.
    function feedRecordLine(line, out) {
      if (format === 'plain') {
        // Plain mode: each non-empty line is its own entry.
        if (line.length === 0) return;
        out.push(buildPlainEntry(line, fileId));
        return;
      }

      var isCmStart = RE_CM_START.test(line);
      var isSccmStart = !isCmStart && RE_SCCM_START.test(line);

      if (isCmStart || isSccmStart) {
        // A new record begins -> flush any record in progress first.
        flushPending(out);
        pending = { kind: isCmStart ? 'cm' : 'sccm', buf: line, lines: 1 };
        // If this single line already contains the closing trailer, it is a
        // complete one-line record and can be flushed immediately.
        if (pending.kind === 'cm' && RE_CM_CLOSE.test(line)) {
          flushPending(out);
        } else if (pending.kind === 'sccm' && RE_SCCM_CLOSE.test(line)) {
          flushPending(out);
        }
        return;
      }

      // Not a record start.
      if (pending) {
        // Continuation line -> append to the in-progress record.
        pending.buf += '\n' + line;
        pending.lines++;
        // Re-check whether the trailer has now arrived (multi-line record end).
        // The closing trailer always lands on a SINGLE physical line, so test
        // only the newly-appended `line` rather than re-scanning the whole
        // (growing) buffer — that O(n) per-line rescan made tailing an
        // unclosed record O(n^2) and froze the UI.
        if (pending.kind === 'cm' && RE_CM_CLOSE.test(line)) {
          flushPending(out);
        } else if (pending.kind === 'sccm' && RE_SCCM_CLOSE.test(line)) {
          flushPending(out);
        } else if (pending.lines >= MAX_PENDING_LINES ||
                   pending.buf.length >= MAX_PENDING_CHARS) {
          // The record never closed within a sane bound; stop accumulating and
          // salvage what we have as plain so one stray marker cannot swallow
          // (and quadratically rescan) the rest of the file.
          out.push(buildPlainEntry(pending.buf, fileId));
          pending = null;
        }
        return;
      }

      // No pending record and not a start marker -> standalone line.
      if (line.length === 0) return; // skip blank separators
      out.push(buildPlainEntry(line, fileId));
    }

    return {
      feedRange: function (lines, start, end, out) {
        for (var i = start; i < end; i++) {
          feedRecordLine(lines[i], out);
        }
      },
      finish: function (out) {
        flushPending(out);
      }
    };
  }

  function splitLines(text) {
    // Normalize CRLF/CR to LF then split. Avoids stray \r at line ends.
    if (text.indexOf('\r') !== -1) {
      text = text.replace(/\r\n?/g, '\n');
    }
    return text.split('\n');
  }

  function parse(text, opts) {
    opts = opts || {};
    var fileId = opts.fileId || '';
    try {
      if (!text) return [];
      var format = detectFormat(text);
      var lines = splitLines(text);
      var machine = createMachine(fileId, format);
      var out = [];
      machine.feedRange(lines, 0, lines.length, out);
      machine.finish(out);
      return out;
    } catch (err) {
      // Never throw: fall back to a naive plain parse of the raw text.
      return plainFallback(text, fileId);
    }
  }

  // Absolute last-resort fallback (used only if something unexpected throws).
  function plainFallback(text, fileId) {
    var out = [];
    if (!text) return out;
    var lines = splitLines(text);
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].length === 0) continue;
      out.push(buildPlainEntry(lines[i], fileId));
    }
    return out;
  }

  // ---- Chunked (non-blocking) parse ---------------------------------------

  function parseChunked(text, opts, onProgress) {
    opts = opts || {};
    var fileId = opts.fileId || '';

    return new Promise(function (resolve) {
      // Empty / trivial input resolves immediately.
      if (!text) {
        if (typeof onProgress === 'function') onProgress(1, 0);
        resolve([]);
        return;
      }

      var format;
      var lines;
      try {
        format = detectFormat(text);
        lines = splitLines(text);
      } catch (e) {
        // Detection/split failure -> plain fallback, still async-friendly.
        var fb = plainFallback(text, fileId);
        if (typeof onProgress === 'function') onProgress(1, fb.length);
        resolve(fb);
        return;
      }

      var machine = createMachine(fileId, format);
      var out = [];
      var total = lines.length || 1;
      var pos = 0;
      // Process a moderate batch then re-check the clock; this keeps each
      // synchronous slice well under one frame on typical hardware.
      var BATCH = 2000;
      var SLICE_MS = 14; // yield roughly every ~12-16ms of work

      function step() {
        var sliceStart = (typeof performance !== 'undefined' && performance.now)
          ? performance.now()
          : Date.now();
        try {
          while (pos < lines.length) {
            var end = pos + BATCH;
            if (end > lines.length) end = lines.length;
            machine.feedRange(lines, pos, end, out);
            pos = end;

            var now = (typeof performance !== 'undefined' && performance.now)
              ? performance.now()
              : Date.now();
            if (now - sliceStart >= SLICE_MS) break; // time slice exhausted
          }
        } catch (loopErr) {
          // Any mid-parse error: finalize what we have plus a plain fallback of
          // the remaining lines so we never lose data or hang.
          try {
            machine.finish(out);
          } catch (ignore) { /* noop */ }
          for (var r = pos; r < lines.length; r++) {
            if (lines[r] && lines[r].length) out.push(buildPlainEntry(lines[r], fileId));
          }
          if (typeof onProgress === 'function') onProgress(1, out.length);
          resolve(out);
          return;
        }

        if (typeof onProgress === 'function') {
          onProgress(pos / total, out.length);
        }

        if (pos < lines.length) {
          // Yield to the event loop so the UI can paint/respond.
          setTimeout(step, 0);
        } else {
          machine.finish(out);
          if (typeof onProgress === 'function') onProgress(1, out.length);
          resolve(out);
        }
      }

      // Kick off asynchronously so callers can wire progress UI first.
      setTimeout(step, 0);
    });
  }

  window.CMT.parser = {
    detectFormat: detectFormat,
    parse: parse,
    parseChunked: parseChunked
  };
})();
