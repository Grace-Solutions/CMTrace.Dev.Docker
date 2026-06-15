window.CMT = window.CMT || {};

/*
 * landing.js — drag-and-drop + upload on the marketing landing page.
 *
 * Dropping or picking a log file stashes it (via CMT.handoff) and navigates to
 * the app (app.html), which opens it immediately. Dropping anywhere on the page
 * works, plus a dedicated drop zone and an "Upload log file" button.
 */
(function () {
  'use strict';

  var APP_URL = 'app.html';

  function byId(id) { return document.getElementById(id); }

  /** Hand off the files to the app and navigate; falls back to the empty app. */
  function go(files) {
    if (!files || !files.length) { window.location.href = APP_URL; return; }
    if (window.CMT && CMT.handoff && typeof CMT.handoff.put === 'function') {
      CMT.handoff.put(files).then(function () {
        window.location.href = APP_URL;
      }, function () {
        // IndexedDB unavailable (e.g. private mode) — just open the app.
        window.location.href = APP_URL;
      });
    } else {
      window.location.href = APP_URL;
    }
  }

  function init() {
    var input = byId('landing-file');
    var uploadBtn = byId('landing-upload');
    var dropZone = byId('landing-drop');
    var sampleLink = byId('landing-sample');

    if (uploadBtn && input) {
      uploadBtn.addEventListener('click', function () { input.click(); });
    }
    if (input) {
      input.addEventListener('change', function () { go(input.files); });
    }

    if (dropZone) {
      // Clicking the zone (but not the upload button) opens the picker.
      dropZone.addEventListener('click', function (ev) {
        if (uploadBtn && (ev.target === uploadBtn || uploadBtn.contains(ev.target))) return;
        if (input) input.click();
      });
      ['dragenter', 'dragover'].forEach(function (type) {
        dropZone.addEventListener(type, function (ev) {
          ev.preventDefault();
          dropZone.classList.add('is-dragover');
        });
      });
      ['dragleave', 'dragend'].forEach(function (type) {
        dropZone.addEventListener(type, function () {
          dropZone.classList.remove('is-dragover');
        });
      });
      dropZone.addEventListener('drop', function (ev) {
        ev.preventDefault();
        dropZone.classList.remove('is-dragover');
        go(ev.dataTransfer && ev.dataTransfer.files);
      });
    }

    // Allow dropping ANYWHERE on the page (prevent the browser from just
    // opening the file in the tab).
    window.addEventListener('dragover', function (ev) { ev.preventDefault(); });
    window.addEventListener('drop', function (ev) {
      ev.preventDefault();
      if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files.length) {
        go(ev.dataTransfer.files);
      }
    });

    if (sampleLink) {
      sampleLink.addEventListener('click', function (ev) {
        ev.preventDefault();
        window.location.href = APP_URL + '?sample=1';
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
