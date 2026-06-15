window.CMT = window.CMT || {};

/*
 * CMT.compare — git-style comparison of two open log files.
 *
 * Aligns the two files line-by-line using a Myers shortest-edit-script diff
 * (with a fast greedy fallback for pathologically different / huge inputs),
 * then renders the result in a VIRTUALIZED two-column ("side-by-side") or
 * single-column ("unified") view. Diff rows are colored like git:
 *   equal = neutral, removed (left-only) = red, added (right-only) = green,
 *   changed (a removed/added pair) = amber.
 *
 * The diff key is the entry MESSAGE, optionally normalized to ignore volatile
 * noise (timestamps / numbers / hex / GUIDs / PIDs / paths) so only real
 * content differences show — exactly what you want when comparing a working
 * vs. a failing client log.
 *
 * 100% client-side; reads CMT.store, draws into the #compare overlay.
 */
(function () {
  'use strict';

  function util() { return CMT.util; }
  function store() { return CMT.store; }
  function $(id) { return document.getElementById(id); }

  var ROW_H = 22;          // fixed compare row height (must match CSS --cmp-row-h)
  var OVERSCAN = 10;       // extra rows above/below the viewport
  var MAX_D = 4000;        // Myers edit-distance cap before falling back
  var MAX_PRODUCT = 120000; // skip Myers entirely above this line total

  var state = {
    open: false,
    leftId: null,
    rightId: null,
    ignore: true,
    mode: 'side',          // 'side' | 'unified'
    rows: [],              // side-by-side aligned rows
    unified: [],           // expanded rows for unified mode
    pool: [],              // recycled row elements
    firstRendered: -1,
    wired: false
  };

  // ----------------------------------------------------------------------
  //  Data helpers
  // ----------------------------------------------------------------------

  /** All entries belonging to a file id, in store (chronological) order. */
  function entriesForFile(id) {
    var s = store();
    var ents = (s && s.entries) || [];
    var out = [];
    for (var i = 0; i < ents.length; i++) {
      if (ents[i].fileId === id) out.push(ents[i]);
    }
    return out;
  }

  /**
   * Diff key for an entry. With `ignore`, collapse volatile tokens so two
   * lines that differ only in timestamps/ids/numbers compare as equal.
   */
  function keyOf(entry, ignore) {
    var m = entry && entry.message != null ? String(entry.message) : '';
    if (!ignore) return m;
    m = m.toLowerCase();
    // GUIDs first (before generic hex/number collapsing).
    m = m.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '#guid');
    m = m.replace(/0x[0-9a-f]+/g, '0x#');           // hex codes/addresses
    m = m.replace(/[a-z]:\\[^\s"'<>|]*/g, '#path');  // windows paths
    m = m.replace(/\\\\[^\s"'<>|]*/g, '#unc');        // UNC paths
    m = m.replace(/\b\d+(?:[.:]\d+)+\b/g, '#seq');    // ip / time-ish sequences
    m = m.replace(/\b\d+\b/g, '#');                   // bare numbers (PIDs, counts)
    m = m.replace(/\s+/g, ' ').trim();
    return m;
  }

  // ----------------------------------------------------------------------
  //  Diff engine
  // ----------------------------------------------------------------------

  /**
   * Myers O(ND) shortest-edit-script over two string arrays.
   * Returns ops [{t,li,ri}] where t: 0=equal, 1=delete(left), 2=insert(right),
   * or null when the edit distance exceeds MAX_D (caller falls back).
   */
  function myers(a, b) {
    var N = a.length, M = b.length;
    if (N === 0 && M === 0) return [];
    // Trim common prefix/suffix to shrink the problem (very effective on logs).
    var pre = 0;
    while (pre < N && pre < M && a[pre] === b[pre]) pre++;
    var endA = N, endB = M;
    while (endA > pre && endB > pre && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

    var midOps = myersCore(a, b, pre, endA, pre, endB);
    if (midOps === null) return null;

    var ops = [];
    var i;
    for (i = 0; i < pre; i++) ops.push({ t: 0, li: i, ri: i });
    for (i = 0; i < midOps.length; i++) ops.push(midOps[i]);
    var sufLen = N - endA;
    for (i = 0; i < sufLen; i++) ops.push({ t: 0, li: endA + i, ri: endB + i });
    return ops;
  }

  /** Core Myers on the sub-ranges a[as,ae) vs b[bs,be). */
  function myersCore(a, b, as, ae, bs, be) {
    var N = ae - as, M = be - bs;
    var i;
    if (N === 0) {
      var r = [];
      for (i = 0; i < M; i++) r.push({ t: 2, li: -1, ri: bs + i });
      return r;
    }
    if (M === 0) {
      var r2 = [];
      for (i = 0; i < N; i++) r2.push({ t: 1, li: as + i, ri: -1 });
      return r2;
    }
    var maxd = N + M;
    if (maxd > MAX_D) return null;
    var offset = maxd;
    var v = new Int32Array(2 * maxd + 1);
    var trace = [];
    var foundD = -1, k, x, y;
    for (var d = 0; d <= maxd; d++) {
      trace.push(v.slice(0));
      for (k = -d; k <= d; k += 2) {
        if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
          x = v[offset + k + 1];        // move down  => insertion
        } else {
          x = v[offset + k - 1] + 1;    // move right => deletion
        }
        y = x - k;
        while (x < N && y < M && a[as + x] === b[bs + y]) { x++; y++; }
        v[offset + k] = x;
        if (x >= N && y >= M) { foundD = d; break; }
      }
      if (foundD >= 0) break;
    }
    if (foundD < 0) return null;

    // Backtrack through the recorded traces to recover the edit script.
    var ops = [];
    x = N; y = M;
    for (var dd = foundD; dd > 0; dd--) {
      var vv = trace[dd];
      k = x - y;
      var prevK;
      if (k === -dd || (k !== dd && vv[offset + k - 1] < vv[offset + k + 1])) {
        prevK = k + 1;
      } else {
        prevK = k - 1;
      }
      var prevX = vv[offset + prevK];
      var prevY = prevX - prevK;
      while (x > prevX && y > prevY) { x--; y--; ops.push({ t: 0, li: as + x, ri: bs + y }); }
      if (x === prevX) {            // came from down => insertion
        y--; ops.push({ t: 2, li: -1, ri: bs + y });
      } else {                       // came from right => deletion
        x--; ops.push({ t: 1, li: as + x, ri: -1 });
      }
    }
    while (x > 0 && y > 0) { x--; y--; ops.push({ t: 0, li: as + x, ri: bs + y }); }
    while (x > 0) { x--; ops.push({ t: 1, li: as + x, ri: -1 }); }
    while (y > 0) { y--; ops.push({ t: 2, li: -1, ri: bs + y }); }
    ops.reverse();
    return ops;
  }

  /**
   * Greedy windowed fallback alignment for huge / wholly-different inputs.
   * Never expensive, never hangs; not minimal but visually sensible.
   */
  function coarse(a, b) {
    var ops = [], i = 0, j = 0, N = a.length, M = b.length, W = 50, w, s;
    while (i < N && j < M) {
      if (a[i] === b[j]) { ops.push({ t: 0, li: i, ri: j }); i++; j++; continue; }
      var found = -1, side = 0;
      for (w = 1; w <= W; w++) {
        if (j + w < M && a[i] === b[j + w]) { found = w; side = 2; break; }
        if (i + w < N && a[i + w] === b[j]) { found = w; side = 1; break; }
      }
      if (found < 0) { ops.push({ t: 1, li: i, ri: -1 }); ops.push({ t: 2, li: -1, ri: j }); i++; j++; }
      else if (side === 2) { for (s = 0; s < found; s++) { ops.push({ t: 2, li: -1, ri: j }); j++; } }
      else { for (s = 0; s < found; s++) { ops.push({ t: 1, li: i, ri: -1 }); i++; } }
    }
    while (i < N) { ops.push({ t: 1, li: i, ri: -1 }); i++; }
    while (j < M) { ops.push({ t: 2, li: -1, ri: j }); j++; }
    return ops;
  }

  /** Turn the op list into side-by-side display rows + stats. */
  function buildRows(ops, L, R) {
    var rows = [], stats = { add: 0, del: 0, chg: 0, eq: 0 };
    var i = 0;
    while (i < ops.length) {
      if (ops[i].t === 0) {
        var o = ops[i];
        rows.push({ type: 'equal', l: L[o.li], r: R[o.ri], ln: o.li + 1, rn: o.ri + 1 });
        stats.eq++; i++; continue;
      }
      // Collect the whole non-equal block (dels + inss, any interleaving).
      var dels = [], inss = [];
      while (i < ops.length && ops[i].t !== 0) {
        if (ops[i].t === 1) dels.push(ops[i]); else inss.push(ops[i]);
        i++;
      }
      var max = Math.max(dels.length, inss.length);
      for (var p = 0; p < max; p++) {
        var dl = dels[p], in_ = inss[p];
        if (dl && in_) {
          rows.push({ type: 'changed', l: L[dl.li], r: R[in_.ri], ln: dl.li + 1, rn: in_.ri + 1 });
          stats.chg++;
        } else if (dl) {
          rows.push({ type: 'del', l: L[dl.li], r: null, ln: dl.li + 1, rn: null });
          stats.del++;
        } else {
          rows.push({ type: 'ins', l: null, r: R[in_.ri], ln: null, rn: in_.ri + 1 });
          stats.add++;
        }
      }
    }
    return { rows: rows, stats: stats };
  }

  /** Expand side-by-side rows into a flat unified list (changed => del + ins). */
  function toUnified(rows) {
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.type === 'equal') {
        out.push({ kind: 'eq', text: msg(r.l), ln: r.ln, rn: r.rn, sev: sev(r.l) });
      } else if (r.type === 'del') {
        out.push({ kind: 'del', text: msg(r.l), ln: r.ln, sev: sev(r.l) });
      } else if (r.type === 'ins') {
        out.push({ kind: 'ins', text: msg(r.r), rn: r.rn, sev: sev(r.r) });
      } else {
        out.push({ kind: 'del', text: msg(r.l), ln: r.ln, sev: sev(r.l) });
        out.push({ kind: 'ins', text: msg(r.r), rn: r.rn, sev: sev(r.r) });
      }
    }
    return out;
  }

  function msg(e) { return e && e.message != null ? String(e.message) : ''; }
  function sev(e) { return e ? e.type : 0; }

  // ----------------------------------------------------------------------
  //  Rendering (virtualized)
  // ----------------------------------------------------------------------

  function currentRows() { return state.mode === 'side' ? state.rows : state.unified; }

  function makeSideRow() {
    var u = util();
    return u.el('div', { className: 'cmp-row' }, [
      u.el('span', { className: 'cmp-ln cmp-ln-l' }),
      u.el('span', { className: 'cmp-txt cmp-txt-l' }),
      u.el('span', { className: 'cmp-sign' }),
      u.el('span', { className: 'cmp-ln cmp-ln-r' }),
      u.el('span', { className: 'cmp-txt cmp-txt-r' })
    ]);
  }

  function makeUnifiedRow() {
    var u = util();
    return u.el('div', { className: 'cmp-row cmp-row-uni' }, [
      u.el('span', { className: 'cmp-ln cmp-ln-l' }),
      u.el('span', { className: 'cmp-ln cmp-ln-r' }),
      u.el('span', { className: 'cmp-sign' }),
      u.el('span', { className: 'cmp-txt cmp-txt-u' })
    ]);
  }

  function ensurePool(count, builder) {
    var rowsEl = $('cmp-rows');
    if (!rowsEl) return;
    // Rebuild the pool when the row template (mode) changes.
    if (state.poolMode !== state.mode) {
      while (rowsEl.firstChild) rowsEl.removeChild(rowsEl.firstChild);
      state.pool = [];
      state.poolMode = state.mode;
      state.firstRendered = -1;
    }
    while (state.pool.length < count) {
      var el = builder();
      el.style.position = 'absolute';
      el.style.left = '0';
      el.style.right = '0';
      el.style.height = ROW_H + 'px';
      rowsEl.appendChild(el);
      state.pool.push(el);
    }
    for (var i = count; i < state.pool.length; i++) state.pool[i].style.display = 'none';
  }

  function fillSideRow(el, row) {
    el.className = 'cmp-row type-' + row.type;
    var c = el.childNodes;
    c[0].textContent = row.ln != null ? row.ln : '';
    c[1].textContent = msg(row.l);
    c[1].className = 'cmp-txt cmp-txt-l' + (row.l ? ' sev-' + row.l.type : '');
    c[1].title = msg(row.l);
    c[2].textContent = row.type === 'del' ? '−' : row.type === 'ins' ? '+' : row.type === 'changed' ? '~' : '';
    c[3].textContent = row.rn != null ? row.rn : '';
    c[4].textContent = msg(row.r);
    c[4].className = 'cmp-txt cmp-txt-r' + (row.r ? ' sev-' + row.r.type : '');
    c[4].title = msg(row.r);
  }

  function fillUnifiedRow(el, row) {
    el.className = 'cmp-row cmp-row-uni type-' + row.kind;
    var c = el.childNodes;
    c[0].textContent = row.ln != null ? row.ln : '';
    c[1].textContent = row.rn != null ? row.rn : '';
    c[2].textContent = row.kind === 'del' ? '−' : row.kind === 'ins' ? '+' : '';
    c[3].textContent = row.text;
    c[3].className = 'cmp-txt cmp-txt-u' + (row.sev ? ' sev-' + row.sev : '');
    c[3].title = row.text;
  }

  function render() {
    var body = $('cmp-body');
    var sizer = $('cmp-sizer');
    if (!body || !sizer) return;
    var rows = currentRows();
    sizer.style.height = (rows.length * ROW_H) + 'px';

    var viewH = body.clientHeight || 400;
    var scrollTop = body.scrollTop;
    var visible = Math.ceil(viewH / ROW_H);
    var count = Math.min(rows.length, visible + OVERSCAN * 2);
    var first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
    if (first + count > rows.length) first = Math.max(0, rows.length - count);

    var builder = state.mode === 'side' ? makeSideRow : makeUnifiedRow;
    var filler = state.mode === 'side' ? fillSideRow : fillUnifiedRow;
    ensurePool(count, builder);

    for (var i = 0; i < count; i++) {
      var idx = first + i;
      var el = state.pool[i];
      if (idx >= rows.length) { el.style.display = 'none'; continue; }
      el.style.display = '';
      el.style.transform = 'translateY(' + (idx * ROW_H) + 'px)';
      filler(el, rows[idx]);
    }
    state.firstRendered = first;
  }

  // ----------------------------------------------------------------------
  //  Diff orchestration + UI state
  // ----------------------------------------------------------------------

  function populateSelects() {
    var s = store();
    var files = (s && s.files) || new Map();
    var left = $('cmp-left'), right = $('cmp-right');
    if (!left || !right) return;
    function fill(sel, selectedId) {
      while (sel.firstChild) sel.removeChild(sel.firstChild);
      files.forEach(function (meta) {
        var opt = document.createElement('option');
        opt.value = meta.id;
        opt.textContent = (meta.name || meta.id) + ' (' + (meta.entryCount || 0) + ')';
        if (meta.id === selectedId) opt.selected = true;
        sel.appendChild(opt);
      });
    }
    fill(left, state.leftId);
    fill(right, state.rightId);
  }

  function setStats(stats, note) {
    var el = $('cmp-stats');
    if (!el) return;
    el.innerHTML = '';
    if (note) { el.appendChild(util().el('span', { className: 'cmp-stat cmp-note', text: note })); return; }
    if (!stats) return;
    el.appendChild(util().el('span', { className: 'cmp-stat cmp-stat-add', text: '+' + stats.add }));
    el.appendChild(util().el('span', { className: 'cmp-stat cmp-stat-del', text: '−' + stats.del }));
    el.appendChild(util().el('span', { className: 'cmp-stat cmp-stat-chg', text: '~' + stats.chg }));
    el.appendChild(util().el('span', { className: 'cmp-stat cmp-stat-eq', text: '=' + stats.eq }));
  }

  function runDiff() {
    var s = store();
    var files = (s && s.files) || new Map();
    var body = $('cmp-body');
    if (files.size < 2) {
      state.rows = []; state.unified = [];
      if ($('cmp-sizer')) $('cmp-sizer').style.height = '0px';
      if ($('cmp-rows')) while ($('cmp-rows').firstChild) $('cmp-rows').removeChild($('cmp-rows').firstChild);
      state.pool = []; state.poolMode = null;
      setStats(null, 'Open at least two log files to compare.');
      return;
    }
    if (state.leftId === state.rightId) {
      state.rows = []; state.unified = [];
      render();
      setStats(null, 'Pick two different files.');
      return;
    }
    var L = entriesForFile(state.leftId);
    var R = entriesForFile(state.rightId);
    var ka = new Array(L.length), kb = new Array(R.length), i;
    for (i = 0; i < L.length; i++) ka[i] = keyOf(L[i], state.ignore);
    for (i = 0; i < R.length; i++) kb[i] = keyOf(R[i], state.ignore);

    var ops;
    if (L.length + R.length > MAX_PRODUCT) {
      ops = coarse(ka, kb);
    } else {
      ops = myers(ka, kb);
      if (ops === null) ops = coarse(ka, kb);
    }
    var built = buildRows(ops, L, R);
    state.rows = built.rows;
    state.unified = toUnified(built.rows);
    setStats(built.stats, null);
    if (body) body.scrollTop = 0;
    state.firstRendered = -1;
    render();
  }

  // ----------------------------------------------------------------------
  //  Public API
  // ----------------------------------------------------------------------

  function open(leftId, rightId) {
    var s = store();
    if (!s) return;
    var files = s.files || new Map();
    var ids = [];
    files.forEach(function (m) { ids.push(m.id); });

    state.leftId = leftId || state.leftId || ids[0] || null;
    state.rightId = rightId || state.rightId || ids[1] || ids[0] || null;
    // Guard against both defaulting to the same id when 2+ files exist.
    if (state.leftId === state.rightId && ids.length >= 2) {
      state.rightId = ids[0] === state.leftId ? ids[1] : ids[0];
    }

    // Side-by-side is unreadable on a phone — default to the unified view.
    if (typeof window !== 'undefined' && window.innerWidth && window.innerWidth <= 680) {
      state.mode = 'unified';
    }

    populateSelects();
    var panel = $('compare');
    if (panel) panel.hidden = false;
    state.open = true;
    reflectControls();
    runDiff();
  }

  function close() {
    var panel = $('compare');
    if (panel) panel.hidden = true;
    state.open = false;
  }

  function isOpen() { return state.open; }

  function reflectControls() {
    var ig = $('cmp-ignore');
    if (ig) ig.checked = state.ignore;
    var mode = $('cmp-mode');
    if (mode) {
      mode.textContent = state.mode === 'side' ? 'Side-by-side' : 'Unified';
      mode.setAttribute('aria-pressed', state.mode === 'unified' ? 'true' : 'false');
    }
    var panel = $('compare');
    if (panel) panel.setAttribute('data-mode', state.mode);
  }

  function init() {
    if (state.wired) return;
    state.wired = true;

    var left = $('cmp-left'), right = $('cmp-right');
    if (left) left.addEventListener('change', function () { state.leftId = left.value; runDiff(); });
    if (right) right.addEventListener('change', function () { state.rightId = right.value; runDiff(); });

    var ignore = $('cmp-ignore');
    if (ignore) ignore.addEventListener('change', function () { state.ignore = !!ignore.checked; runDiff(); });

    var mode = $('cmp-mode');
    if (mode) mode.addEventListener('click', function () {
      state.mode = state.mode === 'side' ? 'unified' : 'side';
      reflectControls();
      state.firstRendered = -1;
      render();
    });

    var swap = $('cmp-swap');
    if (swap) swap.addEventListener('click', function () {
      var t = state.leftId; state.leftId = state.rightId; state.rightId = t;
      populateSelects();
      runDiff();
    });

    var closeBtn = $('cmp-close');
    if (closeBtn) closeBtn.addEventListener('click', close);

    var body = $('cmp-body');
    if (body) {
      var onScroll = function () {
        if (Math.abs(body.scrollTop / ROW_H - (state.firstRendered + OVERSCAN)) < 1) return;
        render();
      };
      body.addEventListener('scroll', onScroll, { passive: true });
    }

    // Re-render on resize so the virtual window matches the viewport.
    if (typeof ResizeObserver !== 'undefined' && body) {
      var ro = new ResizeObserver(function () { if (state.open) render(); });
      ro.observe(body);
    }

    // If files change (closed/added) while compare is open, refresh selects.
    var s = store();
    if (s && typeof s.on === 'function') {
      s.on('data', function () {
        if (!state.open) return;
        var files = s.files || new Map();
        var ids = []; files.forEach(function (m) { ids.push(m.id); });
        if (ids.indexOf(state.leftId) < 0) state.leftId = ids[0] || null;
        if (ids.indexOf(state.rightId) < 0) state.rightId = ids[1] || ids[0] || null;
        populateSelects();
        runDiff();
      });
    }
  }

  CMT.compare = {
    init: init,
    open: open,
    close: close,
    isOpen: isOpen
  };
})();
