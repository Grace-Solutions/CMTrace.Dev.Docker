window.CMT = window.CMT || {};

/*
 * CMT.handoff — pass dropped/selected files from the landing page (index.html)
 * to the app (app.html) across the navigation.
 *
 * Files are stashed as real File objects in IndexedDB (structured clone keeps
 * the File backing intact, with no size limit like sessionStorage's ~5 MB), so
 * even large ConfigMgr logs survive the hop. The app reads + clears them on
 * load. Everything stays 100% client-side — nothing is uploaded.
 */
(function () {
  'use strict';

  var DB_NAME = 'cmtrace';
  var STORE = 'handoff';
  var KEY = 'pending';

  function openDb() {
    return new Promise(function (resolve, reject) {
      if (typeof indexedDB === 'undefined') { reject(new Error('no indexedDB')); return; }
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  /** Store a FileList/array of File for the app to pick up. Resolves when written. */
  function put(files) {
    var arr = Array.prototype.slice.call(files || []);
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({ files: arr, ts: Date.now() }, KEY);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    });
  }

  /** Read AND delete the pending handoff. Resolves with {files,ts} or null. */
  function take() {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        var store = tx.objectStore(STORE);
        var getReq = store.get(KEY);
        getReq.onsuccess = function () {
          var val = getReq.result || null;
          store.delete(KEY);
          resolve(val);
        };
        getReq.onerror = function () { reject(getReq.error); };
      });
    });
  }

  CMT.handoff = { put: put, take: take };
})();
