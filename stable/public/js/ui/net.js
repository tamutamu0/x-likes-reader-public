/*
 * margin ui/net — このアプリのローカルサーバー（同じオリジン）にだけ話しかける
 *
 * 公開記事や画像の取得は、ブラウザから直接ではなく、ローカルサーバーの安全な取得層が行う。
 * ブラウザの CSP は connect-src 'self' なので、ここ以外の宛先には通信できない。
 */
(function (root) {
  'use strict';
  function requireSession(res) {
    if (res.status === 401 && root.location && root.location.protocol === 'https:') {
      root.location.replace('/auth/login');
      throw new Error('本人認証が必要です');
    }
  }

  async function post(path, body, signal) {
    var res;
    try {
      res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-margin-request': '1' },
        body: JSON.stringify(body),
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: signal
      });
    } catch (e) {
      if (e && e.name === 'AbortError') return { status: 'aborted', reason: '中止しました' };
      return { status: 'failed', reason: 'ローカルサーバーに届きません（起動しているか確認してください）', code: 'no_server' };
    }
    requireSession(res);
    var data = null;
    try { data = await res.json(); } catch (e) { /* 下で扱う */ }
    if (!data || typeof data !== 'object') return { status: 'failed', reason: 'ローカルサーバーの応答を読めません', code: 'bad_reply' };
    return data;
  }

  async function health() {
    try {
      var res = await fetch('/api/health', { cache: 'no-store', credentials: 'same-origin', headers: { 'x-margin-request': '1' } });
      requireSession(res);
      if (!res.ok) return null;
      return await res.json();
    } catch (e) { return null; }
  }

  async function xRequest(endpoint, body, query) {
    if (!['status','items','connect','sync','backfill','pause','disconnect','post'].includes(endpoint)) throw new Error('bad endpoint');
    var path = '/api/x/' + endpoint + (endpoint === 'items' && /^\?after=\d+$/.test(query || '') ? query : '');
    var res = await fetch(path, {method:body ? 'POST':'GET',headers:Object.assign({'x-margin-request':'1'},body ? {'content-type':'application/json'} : {}),body:body ? JSON.stringify(body) : undefined,credentials:'same-origin',cache:'no-store',redirect:'error'});
    requireSession(res);
    var r = await res.json();
    if (!res.ok) throw new Error('X連携の処理を完了できませんでした');
    return r;
  }

  function fetchArticle(url, signal) { return post('/api/article', { url: url }, signal); }
  function fetchImage(url, signal) { return post('/api/image', { url: url }, signal); }
  function fetchPreview(postId,url) { return post('/api/link-preview',{postId:postId,url:url}); }
  async function previewImage(path) {
    if(!/^\/api\/link-preview\/[a-f0-9]{64}\/image$/.test(path))return null;
    var res=await fetch(path,{credentials:'same-origin',cache:'no-store',redirect:'error',headers:{'x-margin-request':'1'}});
    requireSession(res);
    if(!res.ok || !/^image\/(png|jpeg|webp)$/.test(res.headers.get('content-type') || ''))return null;
    var blob=await res.blob();return blob.size<=256*1024?blob:null;
  }

  root.Margin = root.Margin || {};
  root.Margin.net = { health: health, xRequest:xRequest, fetchArticle: fetchArticle, fetchImage: fetchImage, fetchPreview:fetchPreview, previewImage:previewImage };
})(typeof globalThis !== 'undefined' ? globalThis : this);
