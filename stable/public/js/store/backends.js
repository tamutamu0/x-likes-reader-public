/*
 * margin store/backends — 保存先
 *
 *  idb:    ブラウザの IndexedDB（データベース名 "margin-v1"。この製品専用の新しい領域）
 *  memory: テスト用。IndexedDB と同じく「全部書けるか、何も書かないか」で動く
 *
 * どちらも tx(stores, mode, fn) を持つ。fn には get / getAll / put / del が渡され、
 * fn が例外を投げればその取引で書いたものはすべて取り消される。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.Margin = root.Margin || {}; root.Margin.backends = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DB_NAME = 'margin-v1';
  var DB_VERSION = 1;
  var STORES = { items: 'id', kv: 'k', batches: 'id', articles: 'key', media: 'key' };

  function StorageError(code, cause) {
    var e = new Error(code + (cause && cause.message ? ': ' + cause.message : ''));
    e.code = code;
    e.cause = cause;
    return e;
  }

  /* ---------------------------------------------------------------- IndexedDB */

  function openIdb(opts) {
    opts = opts || {};
    var idb = opts.indexedDB || (typeof indexedDB !== 'undefined' ? indexedDB : null);
    if (!idb) return Promise.reject(StorageError('unavailable'));
    return new Promise(function (resolve, reject) {
      var req;
      try { req = idb.open(opts.name || DB_NAME, DB_VERSION); }
      catch (e) { reject(StorageError('unavailable', e)); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        Object.keys(STORES).forEach(function (s) {
          if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: STORES[s] });
        });
      };
      req.onblocked = function () { reject(StorageError('blocked')); };
      req.onerror = function () { reject(StorageError('open_failed', req.error)); };
      req.onsuccess = function () {
        var db = req.result;
        db.onversionchange = function () { db.close(); if (opts.onVersionChange) opts.onVersionChange(); };
        resolve(idbBackend(db));
      };
    });
  }

  function reqP(r) {
    return new Promise(function (res, rej) {
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }

  function idbBackend(db) {
    return {
      name: 'indexeddb',
      tx: function (stores, mode, fn) {
        return new Promise(function (resolve, reject) {
          var t;
          try { t = db.transaction(stores, mode); }
          catch (e) { reject(StorageError('tx_failed', e)); return; }
          var result, failed = null;
          var api = {
            get: function (s, k) { return reqP(t.objectStore(s).get(k)); },
            getAll: function (s) { return reqP(t.objectStore(s).getAll()); },
            put: function (s, v) { return reqP(t.objectStore(s).put(v)); },
            del: function (s, k) { return reqP(t.objectStore(s).delete(k)); }
          };
          t.oncomplete = function () { if (failed) reject(failed); else resolve(result); };
          t.onabort = function () {
            var err = failed || t.error;
            var code = err && err.name === 'QuotaExceededError' ? 'quota' : 'write_failed';
            reject(failed && failed.code ? failed : StorageError(code, err));
          };
          t.onerror = function (ev) { if (ev && ev.preventDefault) ev.preventDefault(); };
          Promise.resolve().then(function () { return fn(api); }).then(function (r) { result = r; }, function (e) {
            failed = e;
            try { t.abort(); } catch (x) { reject(e); }
          });
        });
      },
      close: function () { db.close(); }
    };
  }

  /* ---------------------------------------------------------------- メモリ（テスト用） */

  function memoryBackend(opts) {
    opts = opts || {};
    var data = {};
    Object.keys(STORES).forEach(function (s) { data[s] = new Map(); });
    var queue = Promise.resolve();
    function clone(v) { return v === undefined ? undefined : (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v))); }
    return {
      name: 'memory',
      data: data,
      failNext: 0,               // テストで保存失敗を起こすため
      tx: function (stores, mode, fn) {
        var self = this;
        var run = queue.then(async function () {
          var draft = {};
          stores.forEach(function (s) { draft[s] = new Map(Array.from(data[s].entries()).map(function (e) { return [e[0], clone(e[1])]; })); });
          var api = {
            get: async function (s, k) { return clone(draft[s].get(k)); },
            getAll: async function (s) { return Array.from(draft[s].values()).map(clone); },
            put: async function (s, v) {
              if (mode !== 'readwrite') throw new Error('readonly');
              var key = v[STORES[s]];
              if (key == null) throw new Error('no key');
              draft[s].set(key, clone(v));
            },
            del: async function (s, k) { if (mode !== 'readwrite') throw new Error('readonly'); draft[s].delete(k); }
          };
          var r = await fn(api);
          if (mode === 'readwrite') {
            if (self.failNext > 0) { self.failNext--; throw StorageError('write_failed', new Error('simulated')); }
            stores.forEach(function (s) { data[s] = draft[s]; });
          }
          return r;
        });
        queue = run.catch(function () {});
        return run;
      },
      close: function () {}
    };
  }

  return Object.freeze({ openIdb: openIdb, memoryBackend: memoryBackend, DB_NAME: DB_NAME, StorageError: StorageError });
});
