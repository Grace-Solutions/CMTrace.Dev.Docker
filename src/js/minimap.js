window.CMT = window.CMT || {};

/*
 * CMT.minimap — a severity heat-strip rendered over the right edge of the
 * grid (code-minimap style).
 *
 * It paints one thin horizontal line per view row, downsampled so that even a
 * 1M-row log maps onto the (few-hundred-pixel-tall) canvas in a single pass:
 * each canvas pixel-row shows the MOST SEVERE entry type that falls within its
 * range, so a single error in a block of info still shows up red. A translucent
 * viewport indicator reflects the current #grid scroll position/height, and
 * pointer drag on the strip scrolls the grid to the corresponding view row.
 *
 * Fully self-contained: it resolves its DOM (#minimap) and the grid scroll
 * container (#grid) itself and degrades to a no-op when either is absent.
 *
 * Severity → colour:
 *   3 (error)   -> var(--err)   / fallback red
 *   2 (warning) -> var(--warn)  / fallback amber
 *   1 (info)    -> neutral dim
 *
 * Colours are re-read from CSS custom properties on every full render so a
 * theme switch (data-theme flip, "themechange" event, or any store event that
 * triggers a re-render) is reflected automatically.
 */
(function () {
  'use strict';

  // Fallback colours used only when the theme CSS vars cannot be read.
  var FALLBACK_ERR = '#ff5c5c';
  var FALLBACK_WARN = '#e2b13c';
  var FALLBACK_INFO = '#7a8190';
  var FALLBACK_BG = 'rgba(0,0,0,0.18)';

  var minimap = {
    el: null,         // #minimap host div
    canvas: null,     // the <canvas> we draw into
    ctx: null,        // 2d context
    grid: null,       // #grid scroll container (for viewport + scroll sync)

    // Cached device-pixel canvas dimensions (set in resize()).
    cssW: 0,
    cssH: 0,
    pxW: 0,
    pxH: 0,
    dpr: 1,

    // Downsampled severity per canvas pixel-row (0 = empty/none).
    // Length === pxH; value is the most-severe type (3>2>1) in that band.
    _bands: null,
    _viewLen: 0,

    _renderScheduled: false,
    _store: null,
    _util: null,
    _wired: false
  };

  function store() { return minimap._store || (minimap._store = CMT.store); }
  function util() { return minimap._util || (minimap._util = CMT.util); }

  function clamp(n, lo, hi) {
    return n < lo ? lo : n > hi ? hi : n;
  }

  function viewLen() {
    var s = store();
    return s && s.view ? s.view.length : 0;
  }

  // -------------------------------------------------------------------------
  // Theme colours — read fresh on each full render so a theme flip is honoured.
  // -------------------------------------------------------------------------

  function readVar(name, fallback) {
    try {
      var host = minimap.el || document.documentElement;
      var v = getComputedStyle(host).getPropertyValue(name);
      if (v) {
        v = v.trim();
        if (v) return v;
      }
    } catch (e) { /* ignore — fall back */ }
    return fallback;
  }

  function themeColors() {
    return {
      err: readVar('--err', FALLBACK_ERR),
      warn: readVar('--warn', FALLBACK_WARN),
      info: readVar('--fg-dim', FALLBACK_INFO),
      bg: readVar('--bg-elev', FALLBACK_BG)
    };
  }

  // -------------------------------------------------------------------------
  // Canvas sizing (devicePixelRatio-aware)
  // -------------------------------------------------------------------------

  // Sync the backing-store size to the host element's CSS box. Returns true when
  // the pixel dimensions changed (so the band cache must be recomputed).
  function resize() {
    if (!minimap.el || !minimap.canvas) return false;
    var rect = minimap.el.getBoundingClientRect();
    var cssW = Math.max(1, Math.round(rect.width));
    var cssH = Math.max(1, Math.round(rect.height));
    var dpr = window.devicePixelRatio || 1;
    if (!isFinite(dpr) || dpr <= 0) dpr = 1;

    var pxW = Math.max(1, Math.round(cssW * dpr));
    var pxH = Math.max(1, Math.round(cssH * dpr));

    var changed = (pxW !== minimap.pxW) || (pxH !== minimap.pxH);

    minimap.cssW = cssW;
    minimap.cssH = cssH;
    minimap.dpr = dpr;
    minimap.pxW = pxW;
    minimap.pxH = pxH;

    if (changed) {
      minimap.canvas.width = pxW;
      minimap.canvas.height = pxH;
      // The canvas is stretched to fill the host via CSS (width/height:100%),
      // but pin the intrinsic CSS size too so layout never reflows the strip.
      minimap.canvas.style.width = cssW + 'px';
      minimap.canvas.style.height = cssH + 'px';
    }
    return changed;
  }

  // -------------------------------------------------------------------------
  // Severity downsampling — single pass over the view, O(view.length).
  // -------------------------------------------------------------------------

  // Build minimap._bands: for each canvas pixel-row, the most severe entry type
  // (3 error > 2 warn > 1 info > 0 none) among the view rows mapped to it.
  function computeBands() {
    var pxH = minimap.pxH;
    var len = viewLen();
    minimap._viewLen = len;

    var bands = new Uint8Array(pxH); // zero-filled => "none"
    minimap._bands = bands;

    if (len === 0 || pxH === 0) return;

    var s = store();
    var entries = s.entries;
    var view = s.view;

    // Single forward pass: map each view row to the RUN of pixel-rows it covers
    // and keep the most-severe type per band. When downsampling (len >= pxH) the
    // run is ~0/1 px so this stays a cheap O(view.length) pass; when upsampling
    // (len < pxH, the common small-log case) filling the whole run avoids the
    // empty inter-row gaps a single-index mapping would leave.
    for (var vp = 0; vp < len; vp++) {
      var idx = view[vp];
      var e = entries[idx];
      if (!e) continue;
      var type = e.type === 3 ? 3 : e.type === 2 ? 2 : 1;
      var bStart = (vp * pxH / len) | 0;
      var bEnd = ((vp + 1) * pxH / len) | 0;
      if (bEnd <= bStart) bEnd = bStart + 1;
      if (bEnd > pxH) bEnd = pxH;
      for (var y = bStart; y < bEnd; y++) {
        if (type > bands[y]) bands[y] = type;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  function draw() {
    var ctx = minimap.ctx;
    if (!ctx) return;
    var pxW = minimap.pxW;
    var pxH = minimap.pxH;
    if (pxW === 0 || pxH === 0) return;

    var colors = themeColors();

    // Clear + subtle backing fill so the strip reads as a distinct gutter.
    ctx.clearRect(0, 0, pxW, pxH);
    ctx.fillStyle = colors.bg;
    ctx.globalAlpha = 0.5;
    ctx.fillRect(0, 0, pxW, pxH);
    ctx.globalAlpha = 1;

    var bands = minimap._bands;
    if (bands && bands.length === pxH) {
      // Info lines stay faint; warnings/errors are drawn opaque and full-width
      // so a lone severe entry inside a downsampled block is unmissable.
      for (var y = 0; y < pxH; y++) {
        var t = bands[y];
        if (t === 0) continue;
        if (t === 3) {
          ctx.fillStyle = colors.err;
          ctx.globalAlpha = 1;
        } else if (t === 2) {
          ctx.fillStyle = colors.warn;
          ctx.globalAlpha = 0.95;
        } else {
          ctx.fillStyle = colors.info;
          ctx.globalAlpha = 0.35;
        }
        ctx.fillRect(0, y, pxW, 1);
      }
      ctx.globalAlpha = 1;
    }

    drawViewport(ctx, pxW, pxH);
  }

  // Translucent rectangle marking the slice of the view currently on screen.
  function drawViewport(ctx, pxW, pxH) {
    var len = minimap._viewLen || viewLen();
    var g = minimap.grid;
    if (!g || len === 0) return;

    var rowH = rowHeight();
    var headerH = headerHeight();
    var clientH = g.clientHeight;
    if (clientH <= 0 || rowH <= 0) return;

    // The sticky header eats the top headerH px of the scroll viewport, so the
    // content (rows) actually visible spans [scrollTop, scrollTop+clientH) minus
    // that header band. Convert both edges into fractional view positions.
    var scrollTop = g.scrollTop;
    var topRow = (scrollTop) / rowH;            // first row near the header edge
    var visibleRows = (clientH - headerH) / rowH;
    if (visibleRows < 0) visibleRows = clientH / rowH;
    var botRow = topRow + visibleRows;

    var topFrac = clamp(topRow / len, 0, 1);
    var botFrac = clamp(botRow / len, 0, 1);

    var y0 = Math.floor(topFrac * pxH);
    var y1 = Math.ceil(botFrac * pxH);
    var h = Math.max(2, y1 - y0); // always show at least a 2px sliver

    var colors = themeColors();
    // Fill: faint accent wash. Border: brighter accent edge.
    ctx.fillStyle = readVar('--accent', '#5b9dff');
    ctx.globalAlpha = 0.16;
    ctx.fillRect(0, y0, pxW, h);
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = readVar('--accent', '#5b9dff');
    ctx.lineWidth = Math.max(1, minimap.dpr);
    ctx.strokeRect(0.5, y0 + 0.5, pxW - 1, h - 1);
    ctx.globalAlpha = 1;
    // Silence the unused-var lint while keeping the variable for readability.
    void colors;
  }

  function rowHeight() {
    var s = store();
    var h = (s && s.settings) ? Number(s.settings.rowHeight) : 24;
    if (!isFinite(h) || h <= 0) h = 24;
    return h;
  }

  function headerHeight() {
    var header = document.getElementById('grid-header');
    return header ? header.offsetHeight : 0;
  }

  // -------------------------------------------------------------------------
  // Render scheduling
  // -------------------------------------------------------------------------

  // Full render: resize, recompute bands, redraw. Debounced via rAF.
  function render() {
    if (!minimap.canvas || !minimap.ctx) return;
    resize();
    computeBands();
    draw();
  }

  function scheduleRender() {
    if (minimap._renderScheduled) return;
    minimap._renderScheduled = true;
    var run = function () {
      minimap._renderScheduled = false;
      render();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  // Cheap path used on grid scroll: only the viewport indicator moved, so we
  // just repaint without recomputing the (expensive) severity bands.
  function redrawViewportOnly() {
    if (!minimap.ctx || minimap.pxH === 0) return;
    draw();
  }

  // -------------------------------------------------------------------------
  // Pointer interaction — click/drag to scroll the grid.
  // -------------------------------------------------------------------------

  // Map a clientY on the canvas to a view position and scroll the grid there.
  function scrollToY(clientY) {
    if (!minimap.el) return;
    var len = viewLen();
    if (len === 0) return;
    var rect = minimap.el.getBoundingClientRect();
    if (rect.height <= 0) return;
    var frac = clamp((clientY - rect.top) / rect.height, 0, 1);
    var pos = Math.floor(frac * len);
    pos = clamp(pos, 0, len - 1);
    if (CMT.grid && typeof CMT.grid.scrollToViewPos === 'function') {
      CMT.grid.scrollToViewPos(pos, true);
    }
  }

  function wirePointer() {
    var canvas = minimap.canvas;
    if (!canvas) return;
    var dragging = false;
    var pointerId = null;

    var onMove = function (e) {
      if (!dragging) return;
      scrollToY(e.clientY);
    };
    var onUp = function (e) {
      if (!dragging) return;
      dragging = false;
      try {
        if (pointerId != null && canvas.releasePointerCapture) {
          canvas.releasePointerCapture(pointerId);
        }
      } catch (err) { /* ignore */ }
      pointerId = null;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
    };

    canvas.addEventListener('pointerdown', function (e) {
      // Left button / touch / pen only.
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      pointerId = e.pointerId;
      try {
        if (canvas.setPointerCapture) canvas.setPointerCapture(pointerId);
      } catch (err) { /* ignore */ }
      scrollToY(e.clientY);
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
    });
  }

  // -------------------------------------------------------------------------
  // Wiring: store events + grid scroll + resize + theme change.
  // -------------------------------------------------------------------------

  function wire() {
    if (minimap._wired) return;
    minimap._wired = true;

    var s = store();
    var u = util();

    // Re-render (bands + draw) on data/view/selection — debounced so a burst of
    // store mutations collapses into one repaint.
    var debouncedRender = (u && typeof u.debounce === 'function')
      ? u.debounce(scheduleRender, 60)
      : function () { scheduleRender(); };

    if (s && typeof s.on === 'function') {
      s.on('data', debouncedRender);
      s.on('view', debouncedRender);
      s.on('selection', debouncedRender);
      s.on('highlight', debouncedRender);
    }

    // Grid scroll: throttle a viewport-only repaint (no band recompute).
    if (minimap.grid) {
      var onScroll = (u && typeof u.throttle === 'function')
        ? u.throttle(redrawViewportOnly, 33)
        : redrawViewportOnly;
      minimap.grid.addEventListener('scroll', onScroll, { passive: true });
    }

    // Keep in sync with container resizing (the grid shrinks when the insights
    // panel / detail pane open) and device-pixel-ratio / zoom changes.
    if (typeof ResizeObserver !== 'undefined') {
      var ro = new ResizeObserver(function () { scheduleRender(); });
      ro.observe(minimap.el);
      if (minimap.grid) ro.observe(minimap.grid);
    } else {
      window.addEventListener('resize', scheduleRender);
    }

    // Theme change: an explicit "themechange" event OR an attribute flip on the
    // root (data-theme) both trigger a fresh read of the CSS colour vars.
    document.addEventListener('themechange', scheduleRender);
    if (typeof MutationObserver !== 'undefined') {
      try {
        var mo = new MutationObserver(function () { scheduleRender(); });
        mo.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['data-theme', 'class']
        });
      } catch (e) { /* ignore */ }
    }

    wirePointer();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  minimap.init = function () {
    minimap.el = document.getElementById('minimap');
    if (!minimap.el) return; // strip not present in DOM — no-op.

    minimap.grid = document.getElementById('grid');

    // Create the canvas the contract requires us to own.
    var canvas = minimap.el.querySelector('canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.className = 'minimap-canvas';
      minimap.el.appendChild(canvas);
    }
    minimap.canvas = canvas;
    try {
      minimap.ctx = canvas.getContext('2d');
    } catch (e) {
      minimap.ctx = null;
    }
    if (!minimap.ctx) return; // no 2d support — bail gracefully.

    minimap.el.setAttribute('aria-hidden', 'true');

    wire();

    // Initial paint (after layout settles so getBoundingClientRect is sane).
    scheduleRender();
  };

  // Force a full recompute + repaint (exposed for callers / tests).
  minimap.refresh = function () { scheduleRender(); };

  CMT.minimap = minimap;
})();
