window.CMT = window.CMT || {};
(function () {
  'use strict';

  /**
   * CMT.errorlookup
   * Resolves Windows / Win32 / HRESULT / SCCM error codes into human-readable
   * descriptions, and finds error-code-like tokens inside arbitrary log text.
   *
   * It uses the lookup table provided by data/errorcodes.js as CMT.errorCodes.
   * That table is consulted by THREE keys derived from the input:
   *   - the 8-digit uppercase 0x hex string (e.g. "0x80004005")
   *   - the unsigned uint32 decimal string  (e.g. "2147500037")
   *   - the signed int32 decimal string     (e.g. "-2147467259")
   * Whatever the stored value shape is, we normalize it to {name, desc, source}.
   */

  // 2^32, used for unsigned/signed wraparound on the 32-bit code space.
  var POW32 = 4294967296; // 0x100000000

  /**
   * HRESULT facility codes (the FACILITY_* enumeration). Only the most common
   * facilities are named; anything else is reported by its numeric value.
   * Reference: winerror.h FACILITY_* definitions.
   */
  var HRESULT_FACILITIES = {
    0: 'NULL',
    1: 'RPC',
    2: 'DISPATCH',
    3: 'STORAGE',
    4: 'ITF',
    7: 'WIN32',
    8: 'WINDOWS',
    9: 'SSPI / SECURITY',
    10: 'CONTROL',
    11: 'CERT',
    12: 'INTERNET',
    13: 'MEDIASERVER',
    14: 'MSMQ',
    15: 'SETUPAPI',
    16: 'SCARD',
    17: 'COMPLUS',
    18: 'AAF',
    19: 'URT',
    20: 'ACS',
    21: 'DPLAY',
    22: 'UMI',
    23: 'SXS',
    24: 'WINDOWS_CE',
    25: 'HTTP',
    26: 'USERMODE_COMMONLOG',
    31: 'USERMODE_FILTER_MANAGER',
    32: 'BACKGROUNDCOPY',
    33: 'CONFIGURATION / WMI',
    34: 'STATE_MANAGEMENT',
    35: 'METADIRECTORY',
    36: 'WINDOWSUPDATE',
    37: 'DIRECTORYSERVICE',
    38: 'GRAPHICS',
    39: 'SHELL / NAP',
    40: 'TPM_SERVICES',
    41: 'TPM_SOFTWARE',
    48: 'PLA',
    49: 'FVE (BitLocker)',
    50: 'FWP',
    51: 'WINRM',
    52: 'NDIS',
    53: 'USERMODE_HYPERVISOR',
    54: 'CMI',
    55: 'USERMODE_VIRTUALIZATION',
    56: 'USERMODE_VOLMGR',
    57: 'BCD',
    58: 'USERMODE_VHD',
    60: 'SDIAG',
    61: 'WEBSERVICES',
    80: 'WINDOWS_DEFENDER',
    81: 'OPC',
    99: 'XPS'
  };

  /**
   * Convert an arbitrary numeric value into the 32-bit code triple.
   * Accepts any finite number; reduces modulo 2^32 to obtain the canonical
   * unsigned representation, then derives the signed view and hex string.
   * @param {number} n
   * @returns {{dec:string, hex:string, signed:number, unsigned:number}}
   */
  function fromNumber(n) {
    // Reduce into the unsigned 32-bit range. Math handles big/negative values.
    var unsigned = ((Math.trunc(n) % POW32) + POW32) % POW32;
    var signed = unsigned >= 0x80000000 ? unsigned - POW32 : unsigned;
    var hex = '0x' + unsigned.toString(16).toUpperCase().padStart(8, '0');
    return {
      dec: String(unsigned),
      hex: hex,
      signed: signed,
      unsigned: unsigned
    };
  }

  /**
   * normalizeCode(input) -> {dec, hex, signed, unsigned} | null
   *
   * Accepts:
   *   - decimal strings/numbers: "5", 5
   *   - hex strings: "0x80004005", "80004005" (bare hex with a-f letters)
   *   - negative decimals: "-2147467259"
   * Returns null when the input cannot be interpreted as a number/code.
   */
  function normalizeCode(input) {
    if (input === null || input === undefined) return null;

    if (typeof input === 'number') {
      if (!isFinite(input)) return null;
      return fromNumber(input);
    }

    var s = String(input).trim();
    if (!s) return null;

    // Strip a trailing/leading "()" or surrounding noise that callers might pass.
    // Keep it conservative: only operate on a single token.
    // Negative sign handling for explicit decimals.
    var neg = false;
    var body = s;
    if (body.charAt(0) === '+') {
      body = body.slice(1);
    } else if (body.charAt(0) === '-') {
      neg = true;
      body = body.slice(1);
    }

    // Explicit hex prefix: 0x / 0X
    var hexMatch = /^0[xX]([0-9A-Fa-f]+)$/.exec(body);
    if (hexMatch) {
      var hv = parseInt(hexMatch[1], 16);
      if (!isFinite(hv)) return null;
      return fromNumber(neg ? -hv : hv);
    }

    // Pure decimal (no hex letters).
    if (/^[0-9]+$/.test(body)) {
      var dv = parseInt(body, 10);
      if (!isFinite(dv)) return null;
      return fromNumber(neg ? -dv : dv);
    }

    // Bare hex (contains a-f letters, all hex digits). Treat as hex.
    // Only accept when 1..8 hex digits so we don't grab arbitrary words.
    if (/^[0-9A-Fa-f]{1,8}$/.test(body) && /[A-Fa-f]/.test(body)) {
      var bv = parseInt(body, 16);
      if (!isFinite(bv)) return null;
      return fromNumber(neg ? -bv : bv);
    }

    return null;
  }

  /**
   * True when `input` is a bare, unsigned, un-prefixed run of 1..8 decimal
   * digits (e.g. "80004005"). Such a token is ambiguous: normalizeCode reads it
   * as decimal, but per contract it may also be a hex HRESULT. lookup() uses this
   * to know when a hex retry is warranted.
   * @param {*} input
   * @returns {boolean}
   */
  function isBareDigitToken(input) {
    if (typeof input !== 'string' && typeof input !== 'number') return false;
    var s = String(input).trim();
    return /^[0-9]{1,8}$/.test(s);
  }

  /**
   * Pull a {name, desc} pair out of whatever shape an errorCodes entry has.
   * The data file may store a plain string (the description) or an object
   * with name/desc/description/message fields. Be tolerant.
   * @param {*} val
   * @returns {{name:string, desc:string, source:string|null}|null}
   */
  function unpackEntry(val) {
    if (val === null || val === undefined) return null;

    if (typeof val === 'string') {
      return { name: '', desc: val, source: null };
    }

    if (typeof val === 'object') {
      var name = val.name || val.symbol || val.constant || '';
      var desc =
        val.desc ||
        val.description ||
        val.message ||
        val.text ||
        (typeof val.value === 'string' ? val.value : '') ||
        '';
      var source = val.source || null;
      // If only a name was provided, surface it as the description too.
      if (!desc && name) desc = name;
      return { name: String(name), desc: String(desc), source: source };
    }

    return null;
  }

  /**
   * Look an entry up in CMT.errorCodes under any of the candidate keys.
   * @param {{dec:string, hex:string, signed:number, unsigned:number}} norm
   * @returns {{name:string, desc:string, source:string|null}|null}
   */
  function lookupInTable(norm) {
    var table = CMT.errorCodes;
    if (!table) return null;

    // Candidate keys, in priority order. Hex first (most explicit), then the
    // unsigned and signed decimal representations. We also try a lowercase hex
    // variant in case the data file stored keys lowercased.
    var keys = [
      norm.hex, // "0x80004005"
      norm.hex.toLowerCase(), // "0x80004005" (lower)
      norm.hex.slice(2), // "80004005" (bare upper)
      norm.hex.slice(2).toLowerCase(), // "80004005" (bare lower)
      norm.dec, // unsigned decimal
      String(norm.signed) // signed decimal
    ];

    var isMap = typeof Map !== 'undefined' && table instanceof Map;

    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var raw;
      if (isMap) {
        raw = table.get(k);
        if (raw === undefined) raw = table.get(Number(k));
      } else {
        raw = Object.prototype.hasOwnProperty.call(table, k) ? table[k] : undefined;
      }
      if (raw !== undefined && raw !== null) {
        var unpacked = unpackEntry(raw);
        if (unpacked) return unpacked;
      }
    }
    return null;
  }

  /**
   * Decode an HRESULT into its bit fields when we have no table entry.
   * Layout: S(1) R(1) C(1) N(1) X(1) Facility(11) Code(16).
   * @param {{dec:string, hex:string, signed:number, unsigned:number}} norm
   * @returns {{dec:string, hex:string, name:string, desc:string, source:string}}
   */
  function decodeHResult(norm) {
    var u = norm.unsigned;
    var severity = (u >>> 31) & 0x1; // 1 = failure, 0 = success
    var customer = (u >>> 29) & 0x1; // 1 = customer-defined
    var ntStatus = (u >>> 28) & 0x1; // N bit: mapped from an NTSTATUS
    var facility = (u >>> 16) & 0x7ff; // 11 bits
    var code = u & 0xffff; // 16 bits

    var facName = HRESULT_FACILITIES[facility];
    var facLabel = facName ? facName + ' (' + facility + ')' : String(facility);

    var parts = [];
    parts.push(severity ? 'Failure' : 'Success');
    parts.push('Facility ' + facLabel);
    parts.push(
      'Code 0x' + code.toString(16).toUpperCase().padStart(4, '0') + ' (' + code + ')'
    );
    if (customer) parts.push('customer-defined');
    if (ntStatus) parts.push('mapped from NTSTATUS');

    return {
      dec: norm.dec,
      hex: norm.hex,
      name: 'HRESULT',
      desc: 'Decoded HRESULT — ' + parts.join(', ') + '.',
      source: 'HRESULT decode'
    };
  }

  /**
   * lookup(input) -> {dec, hex, name, desc, source} | null
   *
   * - Returns null only when `input` is not interpretable as a number/code.
   * - When found in CMT.errorCodes, returns the stored name/desc with the
   *   stored source (defaults to "Win32" when the table did not specify one).
   * - When NOT found but the value is a failure HRESULT (high bit set,
   *   i.e. 0x8xxxxxxx..0xFxxxxxxx), decodes its facility/code generically with
   *   source "HRESULT decode".
   * - Otherwise returns an "Unknown" result (still non-null) so callers can show
   *   the canonical dec/hex even when no description exists.
   */
  function lookup(input) {
    var norm = normalizeCode(input);
    if (!norm) return null;

    var found = lookupInTable(norm);

    // Contract: a bare 1-8 digit token (no 0x, no sign) such as "80004005" is a
    // valid HEX HRESULT input. normalizeCode interprets bare all-digit tokens as
    // DECIMAL, so if the decimal reading missed the table, retry by forcing a hex
    // interpretation of the same token and prefer it when IT hits the table.
    if (!found && isBareDigitToken(input)) {
      var hexNorm = fromNumber(parseInt(String(input).trim(), 16));
      var hexFound = lookupInTable(hexNorm);
      if (hexFound) {
        norm = hexNorm;
        found = hexFound;
      }
    }

    if (found) {
      return {
        dec: norm.dec,
        hex: norm.hex,
        name: found.name || '',
        desc: found.desc || '',
        source: found.source || 'Win32'
      };
    }

    // High bit set => an HRESULT/NTSTATUS-style failure code. Decode generically.
    if ((norm.unsigned & 0x80000000) !== 0) {
      return decodeHResult(norm);
    }

    // Known-but-unlisted plain numeric code: still return a useful shell.
    return {
      dec: norm.dec,
      hex: norm.hex,
      name: '',
      desc: 'No description available for this code.',
      source: 'Unknown'
    };
  }

  // ---- extractCodes ---------------------------------------------------------

  // Hex token: optional 0x prefix then 1..8 hex digits. We capture the prefixed
  // form preferentially. A bare 8-digit hex containing letters also qualifies.
  var RE_HEX_PREFIXED = /\b0[xX][0-9A-Fa-f]{1,8}\b/g;
  // Standalone decimals/negatives that "look like" error codes. We require them
  // to be large (>= 5 digits) or negative, to avoid grabbing line numbers, small
  // counts, thread ids, etc. Negative values are classic signed HRESULTs.
  //
  // A leading '-' is only treated as a sign when it is NOT a separator between
  // characters (e.g. the hyphens in a CMTrace date "06-02-2026" must not be read
  // as a minus sign producing bogus "-02"/"-2026" codes). We therefore require a
  // boundary that is neither a digit, a letter/underscore, nor a hyphen before
  // the optional sign, and capture the numeric token in group 2.
  var RE_DECIMAL = /(^|[^0-9A-Za-z_-])(-?[0-9]{1,10})\b/g;

  /**
   * extractCodes(text) -> string[]
   * Finds error-code-like tokens in free text and de-duplicates them.
   * Order is preserved (first occurrence wins). Returns the original token
   * spellings (e.g. "0x80004005", "-2147467259").
   * @param {string} text
   * @returns {string[]}
   */
  function extractCodes(text) {
    if (text === null || text === undefined) return [];
    var s = String(text);
    if (!s) return [];

    var out = [];
    var seen = Object.create(null);

    function add(tok) {
      if (!tok) return;
      if (seen[tok]) return;
      seen[tok] = true;
      out.push(tok);
    }

    var m;

    // 1) Hex tokens (0x...). These are unambiguous error codes.
    RE_HEX_PREFIXED.lastIndex = 0;
    while ((m = RE_HEX_PREFIXED.exec(s)) !== null) {
      add(m[0]);
    }

    // 2) Decimal / negative tokens that look like codes.
    RE_DECIMAL.lastIndex = 0;
    while ((m = RE_DECIMAL.exec(s)) !== null) {
      var tok = m[2];
      // The leading boundary (group 1) is consumed by the match; rewind
      // lastIndex to its end so an immediately-following token is not skipped.
      RE_DECIMAL.lastIndex = m.index + m[1].length + tok.length;
      var neg = tok.charAt(0) === '-';
      var digits = neg ? tok.slice(1) : tok;

      // Reject leading-zero-padded values like dates "06" handled by length,
      // but a code like 0x00000005 was already captured above.
      // Heuristic: keep negatives (signed HRESULTs) and large positives.
      if (neg) {
        // Negative numbers that fit a 32-bit signed range are very likely codes.
        var nval = parseInt(tok, 10);
        if (isFinite(nval) && nval < 0 && nval >= -2147483648) {
          add(tok);
        }
        continue;
      }

      // Positive: only treat sufficiently large numbers as candidate codes.
      // 5+ digits avoids most line numbers/counts; cap at the uint32 max.
      if (digits.length >= 5) {
        var pval = parseInt(digits, 10);
        if (isFinite(pval) && pval <= 4294967295) {
          add(tok);
        }
      }
    }

    return out;
  }

  CMT.errorlookup = {
    normalizeCode: normalizeCode,
    lookup: lookup,
    extractCodes: extractCodes
  };
})();
