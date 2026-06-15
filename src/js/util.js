window.CMT = window.CMT || {};

(function () {
  'use strict';

  // Module-local incrementing counter for uid()
  var _uidCounter = 0;

  /**
   * Escape a string for safe insertion into HTML text content.
   * @param {string} s
   * @returns {string}
   */
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Escape a string for safe use inside an HTML attribute value (double-quoted).
   * @param {string} s
   * @returns {string}
   */
  function escapeAttr(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Return a debounced version of fn that fires after ms of inactivity.
   * @param {Function} fn
   * @param {number} ms
   * @returns {Function}
   */
  function debounce(fn, ms) {
    var timer = null;
    return function () {
      var self = this;
      var args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        fn.apply(self, args);
      }, ms);
    };
  }

  /**
   * Return a throttled version of fn that fires at most once per ms.
   * @param {Function} fn
   * @param {number} ms
   * @returns {Function}
   */
  function throttle(fn, ms) {
    var lastTime = 0;
    var timer = null;
    return function () {
      var self = this;
      var args = arguments;
      var now = Date.now();
      var remaining = ms - (now - lastTime);
      if (remaining <= 0) {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        lastTime = now;
        fn.apply(self, args);
      } else if (timer === null) {
        timer = setTimeout(function () {
          lastTime = Date.now();
          timer = null;
          fn.apply(self, args);
        }, remaining);
      }
    };
  }

  /**
   * Clamp n between lo and hi (inclusive).
   * @param {number} n
   * @param {number} lo
   * @param {number} hi
   * @returns {number}
   */
  function clamp(n, lo, hi) {
    return n < lo ? lo : n > hi ? hi : n;
  }

  /**
   * Format epoch ms as "HH:MM:SS.mmm".
   * @param {number} epochMs
   * @returns {string}
   */
  function formatTime(epochMs) {
    var d = new Date(epochMs);
    var hh = String(d.getHours()).padStart(2, '0');
    var mm = String(d.getMinutes()).padStart(2, '0');
    var ss = String(d.getSeconds()).padStart(2, '0');
    var ms = String(d.getMilliseconds()).padStart(3, '0');
    return hh + ':' + mm + ':' + ss + '.' + ms;
  }

  // Active date format. Changed via setDateFormat() when settings are applied.
  var _dateFormat = 'YYYY-MM-DD';

  /** @param {'YYYY-MM-DD'|'DD-MM-YYYY'|'MM-DD-YYYY'} fmt */
  function setDateFormat(fmt) {
    if (fmt === 'YYYY-MM-DD' || fmt === 'DD-MM-YYYY' || fmt === 'MM-DD-YYYY') {
      _dateFormat = fmt;
    }
  }

  /**
   * Format epoch ms as "<date> HH:MM:SS.mmm" using the active date format.
   * @param {number} epochMs
   * @returns {string}
   */
  function formatDateTime(epochMs) {
    var d = new Date(epochMs);
    var yyyy = String(d.getFullYear()).padStart(4, '0');
    var mo = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    var hh = String(d.getHours()).padStart(2, '0');
    var mm = String(d.getMinutes()).padStart(2, '0');
    var ss = String(d.getSeconds()).padStart(2, '0');
    var ms = String(d.getMilliseconds()).padStart(3, '0');
    var datePart;
    if (_dateFormat === 'DD-MM-YYYY') {
      datePart = dd + '-' + mo + '-' + yyyy;
    } else if (_dateFormat === 'MM-DD-YYYY') {
      datePart = mo + '-' + dd + '-' + yyyy;
    } else {
      datePart = yyyy + '-' + mo + '-' + dd;
    }
    return datePart + ' ' + hh + ':' + mm + ':' + ss + '.' + ms;
  }

  /**
   * Parse a CMTrace time string and date string into epoch ms (local time).
   *
   * timeStr format: "HH:MM:SS.mmm+zzz" or "HH:MM:SS.mmm-zzz"
   *   where zzz is UTC offset in minutes (we strip it and treat all as local time).
   *   Tolerates missing ms, missing offset.
   * dateStr format: "MM-DD-YYYY"
   *
   * Returns null if dateStr is missing/unparseable or timeStr is absent/unparseable.
   *
   * @param {string} timeStr
   * @param {string} dateStr
   * @returns {number|null}
   */
  function parseCmTime(timeStr, dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return null;
    if (!timeStr || typeof timeStr !== 'string') return null;

    // Parse date "MM-DD-YYYY"
    var dateMatch = dateStr.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
    if (!dateMatch) return null;
    var month = parseInt(dateMatch[1], 10);
    var day   = parseInt(dateMatch[2], 10);
    var year  = parseInt(dateMatch[3], 10);
    if (isNaN(month) || isNaN(day) || isNaN(year)) return null;

    // Parse time "HH:MM:SS[.mmm][+/-zzz]"
    // Strip trailing UTC offset (+zzz or -zzz) — keep the sign only to detect it
    var timeCore = timeStr.replace(/[+-]\d+$/, '');
    var timeParts = timeCore.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
    if (!timeParts) return null;

    var hours   = parseInt(timeParts[1], 10);
    var minutes = parseInt(timeParts[2], 10);
    var seconds = parseInt(timeParts[3], 10);
    var msRaw   = timeParts[4] != null ? timeParts[4] : '0';
    // Pad/truncate to 3 digits for ms
    while (msRaw.length < 3) msRaw += '0';
    var ms = parseInt(msRaw.substring(0, 3), 10);

    if (isNaN(hours) || isNaN(minutes) || isNaN(seconds) || isNaN(ms)) return null;

    // Construct as local Date
    var d = new Date(year, month - 1, day, hours, minutes, seconds, ms);
    var epoch = d.getTime();
    if (isNaN(epoch)) return null;
    return epoch;
  }

  /**
   * Trigger a browser file download.
   * @param {string} filename
   * @param {string} text
   * @param {string} [mime="text/plain"]
   */
  function download(filename, text, mime) {
    mime = mime || 'text/plain';
    var blob = new Blob([text], { type: mime });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    // Clean up asynchronously so the click can fire
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  /**
   * Format a byte count as a human-readable string (B, KB, MB, GB, TB).
   * @param {number} n
   * @returns {string}
   */
  function fmtBytes(n) {
    if (n == null || isNaN(n)) return '0 B';
    if (n < 1024) return n + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'];
    var value = n;
    var unit  = 'B';
    for (var i = 0; i < units.length; i++) {
      if (value < 1024 * 1024 || i === units.length - 1) {
        value = value / 1024;
        unit  = units[i];
        break;
      }
      value = value / 1024;
    }
    return value.toFixed(value < 10 ? 2 : value < 100 ? 1 : 0) + ' ' + unit;
  }

  /**
   * Tiny DOM builder.
   * attrs may include:
   *   className, id, dataset (object), style (object), text, html,
   *   on<Event> handlers (e.g. onClick, onChange),
   *   any other key -> setAttribute
   * children: string | Node | Array (recursive) — appended after attrs.
   *
   * @param {string} tag
   * @param {Object} [attrs]
   * @param {string|Node|Array} [children]
   * @returns {Element}
   */
  function el(tag, attrs, children) {
    var elem = document.createElement(tag);

    if (attrs) {
      var keys = Object.keys(attrs);
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var val = attrs[key];

        if (key === 'className') {
          elem.className = val;
        } else if (key === 'id') {
          elem.id = val;
        } else if (key === 'text') {
          elem.textContent = val;
        } else if (key === 'html') {
          elem.innerHTML = val;
        } else if (key === 'style' && typeof val === 'object') {
          var styleKeys = Object.keys(val);
          for (var j = 0; j < styleKeys.length; j++) {
            elem.style[styleKeys[j]] = val[styleKeys[j]];
          }
        } else if (key === 'dataset' && typeof val === 'object') {
          var dataKeys = Object.keys(val);
          for (var k = 0; k < dataKeys.length; k++) {
            elem.dataset[dataKeys[k]] = val[dataKeys[k]];
          }
        } else if (key.length > 2 && key.substring(0, 2) === 'on' && key[2] === key[2].toUpperCase()) {
          // onXxx handler
          var eventName = key[2].toLowerCase() + key.substring(3);
          elem.addEventListener(eventName, val);
        } else {
          // Generic attribute
          elem.setAttribute(key, val);
        }
      }
    }

    if (children != null) {
      appendChildren(elem, children);
    }

    return elem;
  }

  /**
   * Recursively append children to a parent element.
   * @param {Element} parent
   * @param {string|Node|Array} children
   */
  function appendChildren(parent, children) {
    if (Array.isArray(children)) {
      for (var i = 0; i < children.length; i++) {
        appendChildren(parent, children[i]);
      }
    } else if (children instanceof Node) {
      parent.appendChild(children);
    } else if (children != null) {
      parent.appendChild(document.createTextNode(String(children)));
    }
  }

  /**
   * Return a unique, incrementing string id.
   * Uses a module-local counter, NOT a random or time source.
   * @returns {string}
   */
  function uid() {
    return 'cmt-' + (++_uidCounter);
  }

  // Attach to global namespace
  CMT.util = {
    escapeHtml:    escapeHtml,
    escapeAttr:    escapeAttr,
    debounce:      debounce,
    throttle:      throttle,
    clamp:         clamp,
    formatTime:    formatTime,
    formatDateTime: formatDateTime,
    setDateFormat: setDateFormat,
    parseCmTime:   parseCmTime,
    download:      download,
    fmtBytes:      fmtBytes,
    el:            el,
    uid:           uid
  };

})();
