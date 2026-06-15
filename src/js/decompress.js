window.CMT = window.CMT || {};

/*
 * CMT.decompress — open compressed logs with ZERO dependencies using the
 * browser's native DecompressionStream.
 *
 * Supports:
 *   - .gz / .gzip : a single gzip member, inflated as one UTF-8 text stream.
 *   - .zip        : a real (small) ZIP archive — End Of Central Directory is
 *                   located, central-directory headers are walked, and each
 *                   contained file entry is inflated (stored=0 or deflate=8).
 *                   The decoded text of every text/log-like entry is
 *                   concatenated, each prefixed by a "===== <name> =====" line.
 *
 * Design goals (per the feature contract):
 *   - 100% client-side, classic script, no external/CDN deps.
 *   - Never hang on malformed input: every code path either resolves or
 *     rejects with a clear Error.
 *   - If DecompressionStream is unavailable, reject with a clear Error so the
 *     caller can surface a useful toast and fall back.
 */
(function () {
  'use strict';

  // -------------------------------------------------------------------------
  //  Feature detection
  // -------------------------------------------------------------------------

  /**
   * True when the native DecompressionStream API is usable in this runtime.
   * @returns {boolean}
   */
  function hasDecompressionStream() {
    return (typeof DecompressionStream === 'function');
  }

  /**
   * Lower-cased file name (or empty string) for extension sniffing.
   * @param {File|{name?:string}} file
   * @returns {string}
   */
  function nameOf(file) {
    if (!file) return '';
    var n = file.name != null ? String(file.name) : '';
    return n.toLowerCase();
  }

  /**
   * Detect whether a file looks compressed purely by its extension.
   * @param {File|{name?:string}} file
   * @returns {boolean}
   */
  function isCompressed(file) {
    var n = nameOf(file);
    if (!n) return false;
    return /\.(gz|gzip|zip)$/.test(n);
  }

  // -------------------------------------------------------------------------
  //  Low-level helpers
  // -------------------------------------------------------------------------

  /**
   * Decode a stream produced by a DecompressionStream pipe into a UTF-8
   * string. Prefers Response(stream).text() (fast, handles UTF-8 + BOM); falls
   * back to a manual reader loop + TextDecoder where Response is unavailable.
   * @param {ReadableStream} stream
   * @returns {Promise<string>}
   */
  function streamToText(stream) {
    if (typeof Response === 'function') {
      // Response.text() consumes the whole stream and decodes as UTF-8.
      return new Response(stream).text();
    }
    // Manual fallback — read chunks and decode incrementally.
    var reader = stream.getReader();
    var decoder = new TextDecoder('utf-8');
    var out = '';
    function pump() {
      return reader.read().then(function (result) {
        if (result.done) {
          out += decoder.decode(); // flush any trailing bytes
          return out;
        }
        out += decoder.decode(result.value, { stream: true });
        return pump();
      });
    }
    return pump();
  }

  /**
   * Inflate a raw-deflate (no zlib/gzip wrapper) Uint8Array via the native
   * "deflate-raw" DecompressionStream and return UTF-8 text.
   * @param {Uint8Array} bytes
   * @returns {Promise<string>}
   */
  function inflateRawToText(bytes) {
    return new Promise(function (resolve, reject) {
      var ds;
      try {
        ds = new DecompressionStream('deflate-raw');
      } catch (e) {
        reject(new Error('deflate-raw decompression is not supported.'));
        return;
      }
      var blob;
      try {
        // A length-0 view is valid; Blob handles it as empty input.
        blob = new Blob([bytes]);
      } catch (e2) {
        reject(new Error('Could not wrap ZIP entry data for inflation.'));
        return;
      }
      var piped;
      try {
        piped = blob.stream().pipeThrough(ds);
      } catch (e3) {
        reject(new Error('Could not start raw-deflate decompression.'));
        return;
      }
      streamToText(piped).then(resolve, function (err) {
        reject(new Error('Failed to inflate ZIP entry: ' +
          (err && err.message ? err.message : String(err))));
      });
    });
  }

  /**
   * Decode a slice of a Uint8Array as UTF-8 text (used for stored ZIP entries
   * and entry names).
   * @param {Uint8Array} bytes
   * @returns {string}
   */
  function utf8Decode(bytes) {
    try {
      return new TextDecoder('utf-8').decode(bytes);
    } catch (e) {
      // Extremely old runtimes without TextDecoder — best-effort latin1.
      var s = '';
      for (var i = 0; i < bytes.length; i++) {
        s += String.fromCharCode(bytes[i]);
      }
      return s;
    }
  }

  // -------------------------------------------------------------------------
  //  GZIP
  // -------------------------------------------------------------------------

  /**
   * Decompress a gzip file into UTF-8 text by piping its stream through the
   * native "gzip" DecompressionStream.
   * @param {File|Blob} file
   * @returns {Promise<string>}
   */
  function gunzipToText(file) {
    return new Promise(function (resolve, reject) {
      var ds;
      try {
        ds = new DecompressionStream('gzip');
      } catch (e) {
        reject(new Error('gzip decompression is not supported in this browser.'));
        return;
      }
      var source;
      try {
        source = file.stream();
      } catch (e2) {
        // Fallback: build a stream from the bytes when File.stream() is missing.
        reject(new Error('Could not read the compressed file stream.'));
        return;
      }
      var piped;
      try {
        piped = source.pipeThrough(ds);
      } catch (e3) {
        reject(new Error('Could not start gzip decompression (corrupt file?).'));
        return;
      }
      streamToText(piped).then(resolve, function (err) {
        reject(new Error('Failed to decompress gzip file: ' +
          (err && err.message ? err.message : String(err))));
      });
    });
  }

  // -------------------------------------------------------------------------
  //  ZIP
  //
  //  Minimal but correct ZIP reader. We parse the End Of Central Directory
  //  record to find the central directory, walk its entries to learn each
  //  file's compression method + sizes + local-header offset, then read the
  //  local header to skip its variable name/extra fields and inflate the data.
  //  Supports method 0 (stored) and method 8 (deflate). ZIP64 and encrypted
  //  archives are rejected with a clear message.
  // -------------------------------------------------------------------------

  var SIG_EOCD = 0x06054b50;   // End Of Central Directory
  var SIG_CEN  = 0x02014b50;   // Central directory file header
  var SIG_LOC  = 0x04034b50;   // Local file header

  /**
   * Read a little-endian unsigned 16-bit integer.
   * @param {DataView} dv
   * @param {number} off
   * @returns {number}
   */
  function u16(dv, off) { return dv.getUint16(off, true); }

  /**
   * Read a little-endian unsigned 32-bit integer.
   * @param {DataView} dv
   * @param {number} off
   * @returns {number}
   */
  function u32(dv, off) { return dv.getUint32(off, true); }

  /**
   * Locate the End Of Central Directory record by scanning backwards from the
   * end of the buffer (the EOCD lives near the end, after an optional comment
   * of up to 65535 bytes).
   * @param {DataView} dv
   * @returns {number} byte offset of the EOCD signature, or -1
   */
  function findEOCD(dv) {
    var len = dv.byteLength;
    if (len < 22) return -1;
    // The comment can be at most 0xFFFF bytes; cap the scan accordingly.
    var minOff = Math.max(0, len - 22 - 0xFFFF);
    // The 4 EOCD signature bytes can legitimately appear inside the archive
    // comment (or trailing junk) that sits AFTER the real EOCD record. Validate
    // each candidate against its declared comment length: the true EOCD has
    // off + 22 + commentLen === byteLength. Remember the first exact match (the
    // real one); fall back to the highest-offset candidate only if none is
    // consistent (e.g. a few bytes of appended data after the comment).
    var fallback = -1;
    for (var off = len - 22; off >= minOff; off--) {
      if (u32(dv, off) !== SIG_EOCD) continue;
      if (fallback === -1) fallback = off;
      var commentLen = u16(dv, off + 20);
      if (off + 22 + commentLen === len) return off;
    }
    return fallback;
  }

  /**
   * Heuristic: treat an entry as text/log-like when its name has a known text
   * extension or no extension at all. Used to decide what to concatenate.
   * @param {string} name
   * @returns {boolean}
   */
  function looksLikeText(name) {
    var lower = name.toLowerCase();
    // Directory placeholder entries end with "/" and have no content.
    if (lower.charAt(lower.length - 1) === '/') return false;
    if (/\.(log|lo_|txt|csv|xml|json|etl|inf|ini|cfg|trace|out|err|md)$/.test(lower)) {
      return true;
    }
    // No extension at all — many ConfigMgr logs ship without one in archives.
    var base = lower.split('/').pop();
    if (base.indexOf('.') === -1) return true;
    return false;
  }

  /**
   * Parse the central directory into a list of entry descriptors.
   * @param {DataView} dv
   * @param {number} eocdOff
   * @returns {Array<{name:string, method:number, compSize:number,
   *                  uncompSize:number, localOffset:number}>}
   */
  function parseCentralDirectory(dv, eocdOff) {
    var cdSize = u32(dv, eocdOff + 12);
    var cdOffset = u32(dv, eocdOff + 16);

    // ZIP64 sentinel values — we do not support ZIP64 archives. The 32-bit
    // cdOffset/cdSize fields are the meaningful indicators; the 16-bit entry
    // count is NOT a reliable sentinel (a legitimate non-ZIP64 archive can hold
    // exactly 65535 entries), and the entry-walking loop below bounds itself by
    // cdSize rather than the count, so it is not consulted here.
    if (cdOffset === 0xFFFFFFFF || cdSize === 0xFFFFFFFF) {
      throw new Error('ZIP64 archives are not supported.');
    }
    if (cdOffset + cdSize > dv.byteLength) {
      throw new Error('Malformed ZIP: central directory out of bounds.');
    }

    var entries = [];
    var off = cdOffset;
    var end = cdOffset + cdSize;
    var guard = 0;
    var MAX_ENTRIES = 100000; // sanity guard against pathological input

    while (off + 46 <= end && guard < MAX_ENTRIES) {
      guard++;
      if (u32(dv, off) !== SIG_CEN) {
        throw new Error('Malformed ZIP: bad central-directory signature.');
      }
      var flags = u16(dv, off + 8);
      var method = u16(dv, off + 10);
      var compSize = u32(dv, off + 20);
      var uncompSize = u32(dv, off + 24);
      var nameLen = u16(dv, off + 28);
      var extraLen = u16(dv, off + 30);
      var commentLen = u16(dv, off + 32);
      var localOffset = u32(dv, off + 42);

      var nameStart = off + 46;
      if (nameStart + nameLen > dv.byteLength) {
        throw new Error('Malformed ZIP: entry name out of bounds.');
      }
      var nameBytes = new Uint8Array(dv.buffer, dv.byteOffset + nameStart, nameLen);
      var name = utf8Decode(nameBytes);

      entries.push({
        name: name,
        flags: flags,
        method: method,
        compSize: compSize,
        uncompSize: uncompSize,
        localOffset: localOffset
      });

      off = nameStart + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  /**
   * Given a central-directory entry, read its local header to find the true
   * start of the file data (the local header has its own name/extra lengths,
   * which can differ from the central record), and return the compressed bytes.
   * @param {DataView} dv
   * @param {Uint8Array} all whole-file bytes
   * @param {object} entry
   * @returns {Uint8Array} the compressed (or stored) data bytes
   */
  function readEntryData(dv, all, entry) {
    var lo = entry.localOffset;
    if (lo + 30 > dv.byteLength) {
      throw new Error('Malformed ZIP: local header out of bounds.');
    }
    if (u32(dv, lo) !== SIG_LOC) {
      throw new Error('Malformed ZIP: bad local-header signature.');
    }
    var nameLen = u16(dv, lo + 26);
    var extraLen = u16(dv, lo + 28);
    var dataStart = lo + 30 + nameLen + extraLen;

    var size = entry.compSize;
    if (dataStart + size > all.length) {
      throw new Error('Malformed ZIP: entry data out of bounds.');
    }
    return all.subarray(dataStart, dataStart + size);
  }

  /**
   * Decompress a single ZIP entry to UTF-8 text.
   * @param {DataView} dv
   * @param {Uint8Array} all
   * @param {object} entry
   * @returns {Promise<string>}
   */
  function decodeEntry(dv, all, entry) {
    // Bit 0 of the general-purpose flag means the entry is encrypted.
    if (entry.flags & 0x0001) {
      return Promise.reject(new Error('Encrypted ZIP entries are not supported.'));
    }
    var data = readEntryData(dv, all, entry);
    if (entry.method === 0) {
      // Stored — already raw bytes.
      return Promise.resolve(utf8Decode(data));
    }
    if (entry.method === 8) {
      // Deflate — inflate via native deflate-raw.
      // Copy into a standalone buffer so the DecompressionStream input is not a
      // view onto the large shared file buffer (keeps things predictable).
      var copy = new Uint8Array(data.length);
      copy.set(data);
      return inflateRawToText(copy);
    }
    return Promise.reject(
      new Error('Unsupported ZIP compression method ' + entry.method + '.')
    );
  }

  /**
   * Read a ZIP file and return the concatenated text of all text/log entries,
   * each prefixed by a header line identifying the entry.
   * @param {File|Blob} file
   * @returns {Promise<string>}
   */
  function unzipToText(file) {
    return file.arrayBuffer().then(function (buf) {
      var all = new Uint8Array(buf);
      var dv = new DataView(buf);

      var eocdOff = findEOCD(dv);
      if (eocdOff < 0) {
        throw new Error('Not a valid ZIP file (no End Of Central Directory).');
      }

      var entries = parseCentralDirectory(dv, eocdOff);
      if (!entries.length) {
        throw new Error('ZIP archive contains no entries.');
      }

      // Only keep text/log-like entries with actual content.
      var wanted = [];
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (looksLikeText(e.name)) wanted.push(e);
      }
      if (!wanted.length) {
        throw new Error('ZIP archive contains no text/log files.');
      }

      // Decode each wanted entry in order, concatenating with header lines.
      var parts = [];
      var idx = 0;
      function next() {
        if (idx >= wanted.length) {
          return parts.join('\n');
        }
        var entry = wanted[idx++];
        return decodeEntry(dv, all, entry).then(function (text) {
          parts.push('===== ' + entry.name + ' =====');
          parts.push(text);
          return next();
        }, function (err) {
          // A single bad/unsupported entry should not abort the whole archive;
          // record the failure inline and continue with the others.
          parts.push('===== ' + entry.name + ' =====');
          parts.push('[CMTrace: could not decode this entry — ' +
            (err && err.message ? err.message : String(err)) + ']');
          return next();
        });
      }
      return next();
    });
  }

  // -------------------------------------------------------------------------
  //  Public entry point
  // -------------------------------------------------------------------------

  /**
   * Decompress a supported file (.gz/.gzip/.zip) into its UTF-8 text content.
   * Rejects with a clear Error when the format is unsupported, the runtime
   * lacks DecompressionStream, or the input is malformed.
   * @param {File|Blob} file
   * @returns {Promise<string>}
   */
  function toText(file) {
    if (!file) {
      return Promise.reject(new Error('No file provided to decompress.'));
    }
    if (!hasDecompressionStream()) {
      return Promise.reject(new Error(
        'This browser does not support DecompressionStream; cannot open ' +
        'compressed logs. Please decompress the file and open it directly.'
      ));
    }
    var n = nameOf(file);
    if (/\.(gz|gzip)$/.test(n)) {
      return gunzipToText(file);
    }
    if (/\.zip$/.test(n)) {
      return unzipToText(file);
    }
    return Promise.reject(
      new Error('Unsupported compressed format: "' + (file.name || '') + '".')
    );
  }

  // -------------------------------------------------------------------------
  //  Export
  // -------------------------------------------------------------------------
  CMT.decompress = {
    isCompressed: isCompressed,
    toText: toText,
    hasDecompressionStream: hasDecompressionStream
  };
})();
