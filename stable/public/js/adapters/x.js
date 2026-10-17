/* The browser only reads this server's cache. X secrets never enter the browser. */
(function (root) {
  'use strict';
  var A, busy = false, cloudCursor = 0, statusAt = 0;
  async function request(endpoint, body, query) {
    return root.Margin.net.xRequest(endpoint,body,query);
  }
  async function refresh() {
    if (!A || !A.repo || busy) return;
    busy = true;
    try {
      if (await A.repo.expireXSources(Date.now())) { await A.reloadAll(); A.render(); }
      var previousAccount = A.state.x && A.state.x.account && A.state.x.account.id;
      // The source diff stays near-real-time; the aggregate status/count
      // scan needs only one refresh a minute to stay within D1 Free usage.
      if (!A.state.x || A.state.x.automatic !== 'cloud_webhook' || Date.now()-statusAt >= 60000) {
        A.state.x = await request('status'); statusAt = Date.now();
      }
      var changed = false, cloud = A.state.x.automatic === 'cloud_webhook', pages = 0, r;
      do {
        r = await request('items',null,cloud ? '?after=' + cloudCursor : '');
        var imported = await A.repo.applyXSnapshot(r,Date.now());
        changed = changed || imported.ids.length > 0;
        if (cloud && Number.isSafeInteger(r.cursor)) cloudCursor = r.cursor;
        pages++;
      } while (cloud && r.hasMore && pages < 20);
      if (changed || previousAccount !== (A.state.x.account && A.state.x.account.id)) await A.reloadAll();
      A.render();
      if (document.querySelector(".dialog.intake") && root.Margin.intake) await root.Margin.intake.refresh();
    } catch (_) { A.state.x = Object.assign({},A.state.x,{unavailable:true}); }
    finally { busy = false; }
  }
  async function action(kind, body) {
    try { var r = await request(kind,body || {}); statusAt = 0; await refresh(); return r; }
    catch(e) { A.toast(e.message,'bad'); return {status:'failed'}; }
  }
  async function connect() {
    var r = await action('connect');
    if (r.url && new URL(r.url).origin === 'https://x.com') location.assign(r.url);
  }
  function init(app) {
    A = app; refresh();
    setInterval(function () { if (!document.hidden) refresh(); },15000);
    window.addEventListener('focus',refresh);
    var q = new URLSearchParams(location.search);
    if (q.get('x') === 'auth_failed') A.toast('Xの接続が完了しませんでした。もう一度接続してください','bad');
    if (q.has('x')) history.replaceState(history.state,'',location.pathname+location.hash);
  }
  root.Margin = root.Margin || {};
  root.Margin.xSource = {id:'x',fictional:false,connected:false,fetchPage:function(){return Promise.reject(new Error('ブラウザの収集器は接続していません。X取得はサーバーが担当します'));},init:init,refresh:refresh,connect:connect,action:action};
  if (typeof module === 'object' && module.exports) module.exports = root.Margin.xSource;
})(typeof globalThis !== 'undefined' ? globalThis : this);
