/*
 * margin ui/app — あなたのいいねを読むための画面
 *
 * 画面の柱
 *   未読／ライブラリ（全いいね・自動分類・検索）。既読にしてもストックに残る。
 *   投稿詳細：本文の次にメモを置き、記事・つながりへ進める
 *
 * 保存はすべて repo.js 経由（IndexedDB）。失敗・競合は隠さず表示する。
 */
(function (root) {
  'use strict';
  var G = root.Margin;
  var S = G.safe, M = G.model, I = G.insight, C = G.collector, D = G.dom, P = G.posts;
  var h = D.h, icon = D.icon;

  var VIEWS = {
    likes: { label: '未読のいいね', short: '未読', icon: 'article' },
    library: { label: 'ライブラリ', short: 'ライブラリ', icon: 'grid' }
  };

  var state = {
    ready: false,
    view: 'likes',
    tabs: { library: 'all' },
    pageLimits: {},
    genre: null,
    topic: null,
    group: null,
    query: '',
    searching: false,
    detail: null,          // 開いている投稿の id
    detailFocus: null,
    items: new Map(),
    articles: {},
    storage: { ok: false, reason: null },
    server: null,          // /api/health の結果（null ならローカルサーバーなし）
    writeError: null,
    sticky: null,          // 未読タブで、読んだ直後の 1 件だけ残す
    kbd: null,             // キーボードで選んでいる投稿
    articleLoading: {},
    articleAbort: {},
    mediaUrl: {},
    mediaState: {},
    memo: {},              // 保存前のメモ { id: { text, state } }
    genrePickOpen: false,
    orgOpen: null,
    showAllRel: false,
    scroll: {},            // 一覧ごとのスクロール位置
    intake: null           // intake.js が使う
  };
  var repo = null;
  var undoStack = [];
  var anaCache = null;

  var $main, $nav, $side, $tabbar, $layer, $toasts;

  /* ================================================================ 起動 */

  async function boot() {
    $main = document.getElementById('main');
    $nav = document.getElementById('nav');
    $side = document.getElementById('side');
    $tabbar = document.getElementById('tabbar');
    $layer = document.getElementById('layer');
    $toasts = document.getElementById('toasts');
    render();

    if (location.protocol === 'file:') {
      state.storage = { ok: false, reason: 'file' };
    } else {
      try {
        var backend = await G.backends.openIdb({ onVersionChange: function () { state.storage = { ok: false, reason: 'version' }; render(); } });
        var ch = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('margin-v1') : null;
        repo = G.repo.createRepo(backend, { channel: ch });
        repo.onChange(onRemote);
        state.storage = { ok: true };
        await reloadAll();
      } catch (e) {
        state.storage = { ok: false, reason: (e && e.code) || 'unavailable' };
      }
    }
    state.server = await G.net.health();
    state.ready = true;
    readHash();
    render();
    window.addEventListener('popstate', onPop);
    document.addEventListener('keydown', onKey);
    document.addEventListener('focusin', function (e) { if (isField(e.target)) document.body.classList.add('typing'); });
    document.addEventListener('focusout', function (e) { if (isField(e.target)) setTimeout(function () { if (!isField(document.activeElement)) document.body.classList.remove('typing'); }, 50); });
    if (G.intake) G.intake.init(api);
    if (G.xSource) G.xSource.init(api);
  }
  function isField(el) { return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'); }

  async function reloadAll() {
    var r = await repo.loadAll();
    state.items = new Map(r.items.map(function (x) { return [x.id, x]; }));
    state.articles = r.articles;
    if (r.broken) toast('読めない記録が ' + r.broken + ' 件ありました（消さずに残しています）', 'bad');
    dirty();
  }



  async function refreshIds(ids, removed) {
    var got = await repo.getItems(ids);
    got.forEach(function (r) {
      if (r.missing) state.items.delete(r.id);
      else {
        var cur = state.items.get(r.id);
        // 編集中のメモは他タブの更新で上書きしない（下書きとして残し、知らせる）
        if (cur && state.memo[r.id] && state.memo[r.id].text !== r.user.memo && document.activeElement && document.activeElement.dataset && document.activeElement.dataset.memo === r.id) {
          state.memo[r.id].remote = true;
        }
        state.items.set(r.id, r);
      }
    });
    dirty();
  }

  async function onRemote(msg) {
    try {
      if (msg.kind === 'items') { await refreshIds(msg.ids || [], msg.removed); render(); }
      else if (msg.kind === 'articles') {
        var arts = await repo.getArticles(msg.keys || []);
        arts.forEach(function (a) { state.articles[a.key] = a; });
        dirty(); render();
      } else if (msg.kind === 'kv' && G.intake) G.intake.refresh();
    } catch (e) { /* 次の操作で読み直す */ }
  }

  function dirty() { anaCache = null; }
  function ana() {
    if (!anaCache) anaCache = I.analyze(all(), state.articles);
    return anaCache;
  }

  /* ================================================================ 一覧の中身 */

  function all() { return Array.from(state.items.values()).filter(function(it) { return !(state.x && state.x.account && P.isFictional(it)); }); }
  function currentList() {
    var a = ana(), g = state.group && a.groups.find(function(x) { return x.id === state.group; }), topic = selectedTopic();
    return {groups:[{items:G.library.select(all(),{view:state.view,filter:state.tabs.library,query:state.query,genre:state.genre,genreOf:a.genreOf,ids:topic ? topic.ids:g ? g.ids:null,sticky:state.sticky})}]};
  }
  function selectedTopic() {
    var topic = state.topic ? ana().topics.get(state.topic) : null;
    if (state.topic && !topic) state.topic = null;
    return topic;
  }
  function topicsOf(it) { return ana().topics.forItem(it.id); }
  function flat(list) { return list.groups.reduce(function(acc,g) { return acc.concat(g.items); },[]); }
  function counts() {
    var items = all();
    return {total:items.length,unread:items.filter(function(it) { return !it.user.read; }).length,
      read:items.filter(function(it) { return it.user.read; }).length,
      fictional:items.filter(P.isFictional).length,missing:items.filter(function(it) { return it.meta.missing; }).length};
  }
  function pageLimit() { return state.pageLimits[listKey()] || 40; }
  function moreItems() {
    var y = window.scrollY; state.pageLimits[listKey()] = pageLimit()+40;
    renderMain(); window.scrollTo(0,y);
  }

  function errText(e) {
    var code = e && e.code;
    if (code === 'quota') return '保存先の空き容量が足りません';
    if (code === 'write_failed') return '書き込みが失敗しました';
    if (code === 'tx_failed' || code === 'blocked' || code === 'version') return '保存先が使えない状態です（他のタブを閉じてから再読み込みしてください）';
    return '保存できませんでした' + (e && e.message ? '（' + String(e.message).slice(0, 80) + '）' : '');
  }
  function showWriteError(e, retry) {
    state.writeError = { text: errText(e), retry: retry || null };
    render();
  }

  // あなたの編集を保存。成功・競合・失敗を必ず画面に返す
  async function save(id, patch) {
    var it = state.items.get(id);
    if (!it) return { status: 'missing' };
    if (!repo) { showWriteError({ code: 'unavailable', message: '保存先が開けていません' }); return { status: 'error' }; }
    var base = {};
    Object.keys(patch).forEach(function (k) { base[k] = it.user[k]; });
    var r;
    try { r = await repo.patchUser(id, base, patch, Date.now()); }
    catch (e) { showWriteError(e, function () { return save(id, patch); }); return { status: 'error', error: e }; }
    if (r.status === 'ok') { state.items.set(id, r.item); state.writeError = null; dirty(); return r; }
    if (r.status === 'conflict') {
      state.items.set(id, r.item); dirty();
      toast('別のタブで先に変更されていました。最新の内容を表示しています（今の操作は反映していません）', 'bad');
      render();
      return r;
    }
    state.items.delete(id); dirty();
    toast('この投稿は別のタブで取り除かれていました', 'neutral');
    render();
    return r;
  }



  async function toggleRead(id) {
    var it = state.items.get(id);
    if (!it) return;
    var before = { read: it.user.read };
    var r = await save(id, { read: !it.user.read });
    if (r.status === 'ok') { undoStack.push({ id: id, before: before, after: { read: !before.read } }); render(); toast(r.item.user.read ? '既読にしました' : '未読に戻しました', 'neutral', true); }
  }

  async function undo() {
    var u = undoStack.pop();
    if (!u) { toast('取り消せる操作はありません', 'neutral'); return; }
    var it = state.items.get(u.id);
    if (!it) return;
    // 取り消しも「今の値が自分の変更後のままか」を確かめてから
    var base = {};
    Object.keys(u.before).forEach(function (k) { base[k] = it.user[k]; });
    var r;
    try { r = await repo.patchUser(u.id, base, u.before, Date.now()); }
    catch (e) { showWriteError(e); return; }
    if (r.status === 'ok') { state.items.set(u.id, r.item); dirty(); render(); toast('取り消しました', 'neutral'); flash(u.id); }
    else if (r.status === 'conflict') { state.items.set(u.id, r.item); dirty(); render(); toast('別のタブで変更済みのため取り消せませんでした', 'bad'); }
  }

  /* ================================================================ 画面の切り替え */

  function setView(v) {
    rememberScroll();
    closeDetailSilently();
    state.view = VIEWS[v] ? v : 'library';
    state.query = '';
    state.searching = false;
    state.genre = null;
    state.topic = null;
    state.group = null;
    state.sticky = null;
    state.kbd = null;
    render();
    restoreScroll();
  }
  function listKey() { return state.query ? 'q:' + state.query : state.view + ':' + (state.tabs[state.view] || '') + ':' + (state.genre || '') + ':' + (state.topic || '') + ':' + (state.group || ''); }
  function rememberScroll() { if (!state.detail) state.scroll[listKey()] = window.scrollY; }
  function restoreScroll() { var y = state.scroll[listKey()] || 0; requestAnimationFrame(function () { window.scrollTo(0, y); }); }

  // 詳細の表示。push=true のときだけ履歴に積む（戻る・進むで呼ばれたときは積まない）
  var detailScroll = {};
  function showDetail(id, opt, push) {
    if (!state.items.get(id)) return false;
    if (!state.detail) rememberScroll();
    else detailScroll[state.detail] = window.scrollY;   // 詳細 A → 詳細 B のとき、A の位置を覚える
    state.detail = id;
    state.detailFocus = opt && opt.focus || null;
    state.genrePickOpen = false;
    state.showAllRel = false;
    closeLayer();
    if (push) { try { history.pushState({ margin: 'detail', id: id }, '', '#post/' + encodeURIComponent(id)); } catch (e) { /* file: など */ } }
    var it = state.items.get(id);
    if (it.meta.sources && it.meta.sources.xapi && G.xSource) G.xSource.action('post',{postId:it.src.postId});
    if (!it.user.read) { state.sticky = id; save(id, { read: true }).then(function () { render(); }); }
    render();
    var y = !push && detailScroll[id] != null ? detailScroll[id] : 0;
    window.scrollTo(0, y);
    if (push && state.detailFocus) requestAnimationFrame(function () { var t = document.getElementById('sec-' + state.detailFocus); if (t) t.scrollIntoView({ block: 'start' }); });
    return true;
  }
  function openDetail(id, opt) {
    if (state.detail === id) { window.scrollTo(0, 0); return; }
    showDetail(id, opt, true);
  }
  // 戻る：ヘッダーの戻ると端末の戻るを同じにする（履歴があれば history.back）
  function closeDetail() {
    if (!state.detail) return;
    if (history.state && history.state.margin === 'detail') { history.back(); return; }
    closeDetailSilently();
    render();
    restoreScroll();
  }
  function closeDetailSilently() {
    if (!state.detail) return;
    var id = state.detail;
    detailScroll[id] = window.scrollY;
    state.detail = null;
    state.kbd = id;
    if (location.hash.indexOf('#post/') === 0) { try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* noop */ } }
  }
  // 戻る・進む：URL（history.state）を正として、表示を必ずそれに合わせる
  function onPop() {
    var hs = history.state;
    if (hs && hs.margin === 'detail' && state.items.get(hs.id)) {
      if (state.detail !== hs.id) showDetail(hs.id, null, false);
      return;
    }
    if (state.detail) {
      var id = state.detail;
      detailScroll[id] = window.scrollY;
      state.detail = null;
      state.kbd = id;
      closeLayer();
      render();
      restoreScroll();
    }
  }
  function readHash() {
    var m = /^#post\/(.+)$/.exec(location.hash);
    if (m) {
      var id = decodeURIComponent(m[1]);
      if (state.items.get(id)) { state.detail = id; history.replaceState({ margin: 'detail', id: id }, '', location.hash); }
    }
  }

  function search(q) {
    rememberScroll();
    closeDetailSilently();
    state.query = String(q || '').slice(0, S.LIMITS.queryChars);
    state.kbd = null;
    render();
    window.scrollTo(0, 0);
    var inp = document.querySelector('.search input');
    if (inp && document.activeElement !== inp) inp.value = state.query;
  }
  function showGenre(name) {
    rememberScroll();
    closeDetailSilently();
    state.view = 'library';
    state.genre = name;
    state.topic = null;
    state.group = null;
    state.query = '';
    state.searching = false;
    render();
    window.scrollTo(0, 0);
  }
  function showGroup(id) {
    rememberScroll();
    closeDetailSilently();
    state.view = 'library';
    state.group = id;
    state.genre = null;
    state.topic = null;
    state.query = '';
    state.searching = false;
    render();
    window.scrollTo(0, 0);
  }

  function showTopic(id) {
    var topic = ana().topics.get(id);
    if (!topic) return;
    rememberScroll();
    closeDetailSilently();
    closeLayer();
    state.view = 'library';
    state.genre = topic.genre;
    state.topic = topic.id;
    state.group = null;
    state.query = '';
    state.searching = false;
    state.sticky = null;
    state.kbd = null;
    render();
    window.scrollTo(0, 0);
  }

  function topicFilters() {
    var topics = ana().topics.forGenre(state.genre);
    var section = h('section', {class:'topic-filter','aria-label':state.genre + 'のトピック'});
    var label=h('div', {class:'topic-filter-label'},h('span',{text:state.genre + 'のトピック'}));
    if (topics.length>6) label.appendChild(h('button',{class:'topic-more',onclick:openTopicPicker},'すべて見る',h('span',{text:' '+topics.length})));
    section.appendChild(label);
    if (!topics.length) {
      section.appendChild(h('p', {class:'topic-empty',text:'具体的なトピックの手がかりが、まだありません。'}));
      return section;
    }
    var row = h('div', {class:'chips topic-chips',role:'group','aria-label':'トピックで絞り込む'});
    row.appendChild(h('button', {class:'chip','aria-pressed':String(!state.topic),onclick:function () { state.topic=null;render();window.scrollTo(0,0); }},'すべて'));
    var selected = selectedTopic();
    var visible = selected ? [selected].concat(topics.filter(function (t) { return t.id!==selected.id; }).slice(0,5)) : topics.slice(0,6);
    visible.forEach(function (topic) {
      row.appendChild(h('button', {class:'chip','aria-pressed':String(state.topic===topic.id),title:'本文・見出し・メモ・タグから自動で抽出',onclick:function () { showTopic(topic.id); }},topic.label,h('span',{class:'n',text:topic.count})));
    });
    section.appendChild(row);
    return section;
  }

  function openTopicPicker() {
    var genre = state.genre, topics = ana().topics.forGenre(genre);
    var dialog = h('section', {class:'topic-picker',role:'dialog','aria-modal':'true','aria-label':genre + 'のトピックを選ぶ'});
    dialog.appendChild(h('div', {class:'topic-picker-head'},h('h2',{text:genre + 'のトピック'}),h('button',{class:'icon-btn','aria-label':'閉じる',onclick:closeLayer},icon('close'))));
    var input = h('input', {type:'search',placeholder:'トピックを探す','aria-label':'トピックを探す',autocomplete:'off',maxlength:'80'});
    dialog.appendChild(h('label', {class:'search topic-picker-search'},input,icon('search')));
    var list = h('div', {class:'topic-picker-list'});
    dialog.appendChild(list);
    function draw() {
      var query = G.topics.keyOf(input.value);
      list.textContent = '';
      var matches = topics.filter(function (t) { return !query || t.key.indexOf(query)!==-1; });
      matches.forEach(function (t) {
        list.appendChild(h('button', {class:'topic-choice','aria-pressed':String(state.topic===t.id),onclick:function () { showTopic(t.id); }},h('span',{text:t.label}),h('span',{class:'count',text:t.count+'件'})));
      });
      if (!matches.length) list.appendChild(h('p',{class:'topic-empty',text:'一致するトピックはありません。'}));
    }
    input.addEventListener('input',draw);
    dialog.addEventListener('keydown',function (e) {
      if (e.key==='Escape') { e.stopPropagation();closeLayer(); }
      if (e.key==='Tab') {
        var controls=Array.from(dialog.querySelectorAll('button,input')),first=controls[0],last=controls[controls.length-1];
        if (e.shiftKey && document.activeElement===first) { e.preventDefault();last.focus(); }
        else if (!e.shiftKey && document.activeElement===last) { e.preventDefault();first.focus(); }
      }
    });
    draw();showLayer(dialog);input.focus({preventScroll:true});
  }

  /* ================================================================ 外部へのリンク */

  function openExternal(url, it) {
    if (it && P.isFictional(it)) { toast('架空のデータなので、リンク先はありません', 'neutral'); return; }
    var u = S.sanitizeUrl(url);
    if (!u) { toast('安全でない URL なので開きません', 'bad'); return; }
    window.open(u, '_blank', 'noopener,noreferrer');
  }
  function openOriginal(it) {
    if (P.isFictional(it)) { toast('架空のデータなので、X に元の投稿はありません', 'neutral'); return; }
    openExternal(it.src.url, null);
  }

  /* ================================================================ 記事 */

  function articleKey(link) { return I.canonicalUrl(link.url); }
  function articleFor(link) { var k = articleKey(link); return k ? state.articles[k] || null : null; }
  function articleLoading(link) { return !!state.articleLoading[articleKey(link)]; }

  async function loadArticle(link, it) {
    var key = articleKey(link);
    if (!key) { toast('この URL は読み込めません', 'bad'); return; }
    if (P.isFictional(it) || /\.example$/i.test(link.domain)) { toast('架空サンプルのリンクは読み込みません', 'neutral'); return; }
    if (!state.server) { toast('記事の読み込みにはローカルサーバー（node server.mjs）が必要です', 'bad'); return; }
    if (state.articleLoading[key]) return;
    var ac = new AbortController();
    state.articleLoading[key] = true;
    state.articleAbort[key] = ac;
    render();
    var r = await G.net.fetchArticle(link.url, ac.signal);
    delete state.articleLoading[key];
    delete state.articleAbort[key];
    if (r.status === 'aborted') { render(); toast('読み込みを中止しました', 'neutral'); return; }
    var rec = articleRecord(key, link.url, r);
    try { await repo.saveArticle(rec); } catch (e) { showWriteError(e); }
    state.articles[key] = rec;
    if (rec.finalUrl) { var fk = I.canonicalUrl(rec.finalUrl); if (fk && fk !== key) { /* 転送後の URL でも同じ記事と分かるように同じ内容を引けるようにする */ } }
    dirty();
    render();
    toast(rec.status === 'ok' ? '記事を読み込みました' : '記事を読み込めませんでした：' + rec.reason, rec.status === 'ok' ? '' : 'bad');
  }
  function abortArticle(link) { var k = articleKey(link); if (state.articleAbort[k]) state.articleAbort[k].abort(); }

  // サーバーの応答を、そのまま信用せずに保存用の形へ（文字だけ・長さを制限）
  function articleRecord(key, url, r) {
    var ok = r && r.status === 'ok';
    var base = { key: key, url: url, fetchedAt: new Date().toISOString(), status: ok ? 'ok' : (['blocked', 'refused'].indexOf(r && r.status) !== -1 ? r.status : 'failed') };
    if (!ok) { base.reason = S.cleanText(r && r.reason || '不明な理由', 200); base.code = S.cleanText(r && r.code || '', 40); return base; }
    base.finalUrl = S.sanitizeUrl(r.finalUrl) || url;
    base.title = S.cleanText(r.title, 300);
    base.siteName = S.cleanText(r.siteName, 100);
    base.byline = S.cleanText(r.byline, 100);
    base.publishedAt = r.publishedAt && isFinite(Date.parse(r.publishedAt)) ? new Date(Date.parse(r.publishedAt)).toISOString() : null;
    base.excerpt = S.cleanText(r.excerpt, 400);
    base.text = S.cleanText(r.text, 60000);
    base.lang = S.cleanText(r.lang, 20);
    base.contentType = S.cleanText(r.contentType, 80);
    base.bytes = Number.isFinite(r.bytes) ? r.bytes : null;
    base.redirects = Array.isArray(r.redirects) ? r.redirects.slice(0, 5).map(function (u) { return S.sanitizeUrl(u) || ''; }).filter(Boolean) : [];
    base.notes = Array.isArray(r.notes) ? r.notes.slice(0, 5).map(function (n) { return S.cleanText(n, 120); }) : [];
    return base;
  }

  /* ================================================================ 画像 */

  function mediaKey(m) { return m.url; }
  function mediaSrc(m, it) {
    if (m.local) return m.local;               // 同じオリジンの架空サンプル画像だけ
    var k = mediaKey(m);
    if (!k) return null;
    if (state.mediaUrl[k]) return state.mediaUrl[k];
    if (state.mediaState[k] === undefined && repo) {
      state.mediaState[k] = 'checking';
      repo.getMedia(k).then(function (rec) {
        if (rec && rec.status === 'ok' && rec.blob) { state.mediaUrl[k] = URL.createObjectURL(rec.blob); state.mediaState[k] = 'ok'; render(); }
        else state.mediaState[k] = rec && rec.status === 'failed' ? 'failed' : 'none';
      }).catch(function () { state.mediaState[k] = 'none'; });
    }
    return null;
  }
  function mediaState(m) { return state.mediaState[mediaKey(m)] || 'none'; }
  async function loadImage(m, it) {
    if (P.isFictional(it)) return;
    if (!state.server) { toast('画像の読み込みにはローカルサーバーが必要です', 'bad'); return; }
    var k = mediaKey(m);
    state.mediaState[k] = 'loading'; render();
    var r = await G.net.fetchImage(m.url);
    if (r.status === 'ok' && typeof r.data === 'string' && /^image\/(png|jpeg|gif|webp)$/.test(r.contentType)) {
      var bin = atob(r.data);
      var arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      var blob = new Blob([arr], { type: r.contentType });
      try { await repo.saveMedia({ key: k, status: 'ok', blob: blob, contentType: r.contentType, bytes: arr.length, fetchedAt: new Date().toISOString() }); } catch (e) { showWriteError(e); }
      state.mediaUrl[k] = URL.createObjectURL(blob);
      state.mediaState[k] = 'ok';
    } else {
      state.mediaState[k] = 'failed';
      toast('画像を読み込めませんでした：' + S.cleanText(r.reason || '不明', 120), 'bad');
    }
    render();
  }

  /* ================================================================ 描画 */

  function render() {
    renderNav();
    renderTabbar();
    renderSide();
    renderMain();
  }

  function navItems() { return [['likes',counts().unread],['library',0]]; }
  function renderNav() {
    if (!$nav) return;
    $nav.textContent = '';
    $nav.appendChild(h('a',{class:'brand',href:'#','aria-label':'margin',onclick:function(e) { e.preventDefault();setView('likes'); }},D.brand(),h('span',{class:'lbl',text:'margin'})));
    $nav.appendChild(h('p',{class:'nav-caption',text:'いいねを、知識に。'}));
    navItems().forEach(function(n) {
      var v=VIEWS[n[0]],cur=state.view===n[0] && !state.query;
      $nav.appendChild(h('button',{class:'nav-item','aria-label':v.short,'aria-current':String(cur),onclick:function() { setView(n[0]); }},icon(v.icon),h('span',{class:'lbl',text:v.short}),n[1] ? h('span',{class:'badge',text:n[1].toLocaleString()}):null));
    });
    if (state.ready && all().length) {
      var gs=Object.keys(ana().genreCounts).sort(function(a,b) { return ana().genreCounts[b]-ana().genreCounts[a]; });
      var section=h('div',{class:'nav-genres'},h('p',{class:'nav-label',text:'自動分類'}));
      gs.forEach(function(g) { section.appendChild(h('button',{class:'nav-genre','aria-pressed':String(state.genre===g),onclick:function() { showGenre(g); }},h('span',{class:'genre-dot'}),h('span',{text:g}),h('span',{class:'count',text:ana().genreCounts[g]}))); });
      $nav.appendChild(section);
    }
    $nav.appendChild(h('button',{class:'nav-settings',onclick:function() { G.intake && G.intake.open(); }},icon('more'),h('span',{class:'lbl',text:'接続と設定'})));
    var xs=state.x || {};
    $nav.appendChild(h('div',{class:'nav-foot'},h('button',{class:'status-pill',onclick:function() { G.intake && G.intake.open(); }},h('span',{class:'dot'+(xs.connected && !xs.paused ? ' connected':'')}),h('span',{class:'txt'},h('b',{text:xs.connected && xs.account ? '@'+xs.account.handle:'X を接続'}),h('span',{text:xs.connected ? xs.paused ? '自動更新は停止中':xs.automatic === 'cloud_webhook' ? 'いいね通知で自動更新':'自動更新 · 1日1回':'公式APIで取り込み'})))));
  }

  function renderTabbar() {
    if (!$tabbar) return;
    $tabbar.textContent = '';
    navItems().forEach(function (n) {
      var v = VIEWS[n[0]];
      var cur = state.view === n[0] && !state.query;
      var b = h('button', { 'aria-label': v.short + (n[1] ? '（未読' + n[1] + '件）' : ''), 'aria-current': String(cur), onclick: function () { if (cur && !state.detail) { window.scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' }); } else setView(n[0]); } },
        icon(v.icon, cur && n[0] === 'likes' ? 'fill' : ''), h('span', { class: 'tl', text: v.short }));
      if (n[1]) b.appendChild(h('span', { class: 'badge', text: n[1] > 99 ? '99+' : String(n[1]) }));
      $tabbar.appendChild(b);
    });
  }

  function searchBox(autofocus) {
    var inp = h('input', { type: 'search', placeholder: 'ストックから検索', 'aria-label': 'いいねを検索', maxlength: String(S.LIMITS.queryChars), enterkeyhint: 'search', autocomplete: 'off' });
    inp.value = state.query;
    var t = null;
    inp.addEventListener('input', function (e) {
      if (e.isComposing) return;
      clearTimeout(t);t=setTimeout(function() {
        var y=window.scrollY,focused=document.activeElement===inp && !!inp.closest('.main'),caret=inp.selectionStart;
        state.query=inp.value.slice(0,S.LIMITS.queryChars);state.detail=null;
        renderMain();renderNav();renderTabbar();
        if (focused) { var next=$main.querySelector('.search input');if (next) { next.focus({preventScroll:true});try { next.setSelectionRange(caret,caret); } catch (_) {} } }
        if (!state.query) window.scrollTo(0,y);
      },120);
    });
    inp.addEventListener('keydown', function (e) { if (e.key === 'Escape') { inp.value = ''; search(''); inp.blur(); } if (e.key === 'Enter') inp.blur(); });
    var wrap = h('label', { class: 'search' }, inp, icon('search'));
    if (state.query) wrap.appendChild(h('button', { class: 'clear', 'aria-label': '検索を消す', onclick: function (e) { e.preventDefault(); search(''); } }, icon('close')));
    if (autofocus) requestAnimationFrame(function () { inp.focus(); });
    return wrap;
  }

  function renderSide() {
    if (!$side) return;
    var inner=h('div',{class:'side-inner'}), c=counts();
    inner.appendChild(searchBox(false));
    if (state.ready && c.total) {
      var box=h('section',{class:'box stock-box','aria-label':'ライブラリの概要'},h('h3',{text:'あなたのライブラリ'}),h('div',{class:'stock-number'},c.total.toLocaleString(),h('span',{text:'いいね'})),h('p',{class:'stock-caption',text:'読んだ投稿も、ここに残ります。'}));
      box.appendChild(h('div',{class:'reading-stats'},h('button',{onclick:function() { setView('likes'); }},h('span',{text:'未読'}),h('b',{text:c.unread.toLocaleString()})),h('button',{onclick:function() { setView('library');state.tabs.library='read';render(); }},h('span',{text:'既読'}),h('b',{text:c.read.toLocaleString()}))));
      var progress=h('div',{class:'reading-progress',role:'img','aria-label':'既読 '+c.read+'件 / '+c.total+'件'});
      var progressFill=h('span');progressFill.style.width=(c.read/c.total*100)+'%';progress.appendChild(progressFill);box.appendChild(progress);inner.appendChild(box);
      var groups=ana().groups.filter(function(g) { return g.ids.length<=40; }).slice(0,3);
      if (groups.length) {
        var related=h('section',{class:'box','aria-label':'つながるいいね'},h('h3',{text:'つながるいいね'}));
        groups.forEach(function(g) { related.appendChild(h('button',{class:'row',onclick:function() { showGroup(g.id); }},h('div',{class:'k',text:g.kind==='article' ? '同じ記事':'共通の話題'}),h('div',{class:'v',text:g.label}),h('div',{class:'n',text:g.ids.length+'件'}))); });
        inner.appendChild(related);
      }
    }
    var xs=state.x || {};
    inner.appendChild(h('div',{class:'sync-note'},h('span',{class:'dot'+(xs.connected && !xs.paused ? ' connected':'')}),h('div',{},h('b',{text:xs.connected ? xs.paused ? '自動更新は停止中':'X と接続しています':'X は未接続です'}),h('p',{text:xs.lastSuccessAt ? '最終更新 '+D.short(xs.lastSuccessAt):'接続と設定から取り込めます'}))));
    inner.appendChild(h('p',{class:'legal',text:xs.automatic === 'cloud_webhook' ? '自分だけの、いいねライブラリ。本文は本人専用サーバー、メモはこの端末に保存。X の公式サービスではありません。':'自分だけの、いいねライブラリ。投稿・メモはこのMacに保存。X の公式サービスではありません。'}));
    $side.textContent='';$side.appendChild(inner);
  }

  function renderMain() {
    if (!$main) return;
    document.body.classList.toggle('detail', !!(state.detail && state.items.get(state.detail)));
    $main.textContent = '';
    if (!state.ready) { $main.appendChild(h('div', { class: 'head' }, h('div', { class: 'head-top' }, h('h1', { text: 'あなたのいいね' })))); $main.appendChild(h('div', { class: 'loading', role: 'status' }, h('div', { class: 'spin' }), '読み込み中…')); return; }
    if (state.detail && state.items.get(state.detail)) { renderDetail(); return; }
    state.detail = null;
    renderTimeline();
  }

  function banners() {
    var out = [];
    if (!state.storage.ok) {
      var why = { file: 'ファイルを直接開いているため、保存できません。ターミナルで node server.mjs を実行し、表示された http://127.0.0.1:47321 を開いてください。', unavailable: 'このブラウザでは保存先（IndexedDB）が使えません。プライベートブラウズを解除してください。', blocked: '別のタブが古い版で開いています。ほかの margin のタブを閉じてから再読み込みしてください。', version: '別のタブで新しい版が開かれました。再読み込みしてください。' }[state.storage.reason] || '保存先を開けませんでした（' + state.storage.reason + '）。';
      out.push(h('div', { class: 'banner', role: 'alert' }, icon('alert'), h('div', { class: 'grow' }, h('b', { text: '保存できない状態です' }), why)));
    }
    if (state.writeError) {
      var we = state.writeError;
      out.push(h('div', { class: 'banner', role: 'alert' }, icon('alert'), h('div', { class: 'grow' }, h('b', { text: '保存できませんでした' }), we.text + '。この変更は反映していません。'),
        we.retry ? h('button', { class: 'btn sm', onclick: function () { var f = we.retry; state.writeError = null; f().then(render); } }, 'もう一度') : null,
        h('button', { class: 'icon-btn', 'aria-label': '閉じる', onclick: function () { state.writeError = null; render(); } }, icon('close'))));
    }
    return out;
  }

  function header(title, sub, opts) {
    opts = opts || {};
    var top = h('div', { class: 'head-top' });
    if (opts.back) top.appendChild(h('button', { class: 'icon-btn', 'aria-label': '戻る', onclick: opts.back }, icon('back')));
    else top.appendChild(h('button', { class: 'icon-btn m-only brand-btn', 'aria-label': '取り込みと設定', onclick: function () { G.intake && G.intake.open(); } }, D.brand()));
    top.appendChild(h('div', { class: 'grow' }, h('h1', { text: title }), sub ? h('div', { class: 'sub', text: sub }) : null));
    if (!opts.back || opts.searchBtn) top.appendChild(h('button', { class: 'icon-btn', 'aria-label': '検索', onclick: function () { openMobileSearch(); } }, icon('search')));
    var head = h('div', { class: 'head' }, top);
    if (opts.tabs) head.appendChild(opts.tabs);
    if (opts.extra) head.appendChild(opts.extra);
    return head;
  }

  function tabs(list, cur, onPick) {
    var el = h('div', { class: 'tabs', role: 'tablist' });
    list.forEach(function (t) {
      el.appendChild(h('button', { role: 'tab', 'aria-selected': String(cur === t[0]), onclick: function () { onPick(t[0]); } }, t[1], t[2] != null ? h('span', { class: 'n', text: String(t[2]) }) : null));
    });
    return el;
  }

  function renderTimeline() {
    var c=counts(), list=currentList(),items=flat(list),a=ana(),head, group=state.group && a.groups.find(function(g) { return g.id===state.group; }),topic=selectedTopic();
    if (state.query || state.searching) {
      head=header('ライブラリを検索',items.length.toLocaleString()+'件',{back:function() { state.searching=false;search(''); },extra:h('div',{class:'reader-search'},searchBox(false))});
    } else if (state.view==='likes') {
      head=header('未読のいいね',c.unread.toLocaleString()+'件 · 気になったものから、ひとつずつ');
    } else {
      var scoped=G.library.select(all(),{view:'library',genre:state.genre,genreOf:a.genreOf,ids:topic ? topic.ids:group ? group.ids:null});
      var scopeRead=scoped.filter(function(it) { return it.user.read; }).length;
      var chips=h('div',{class:'chips reader-chips',role:'group','aria-label':'自動分類で絞り込む'});
      chips.appendChild(h('button',{class:'chip','aria-pressed':String(!state.genre && !state.group),onclick:function() { showGenre(null); }},'すべて'));
      Object.keys(a.genreCounts).sort(function(x,y) { return a.genreCounts[y]-a.genreCounts[x]; }).forEach(function(g) { chips.appendChild(h('button',{class:'chip','aria-pressed':String(state.genre===g),onclick:function() { showGenre(state.genre===g ? null:g); }},g,h('span',{class:'n',text:a.genreCounts[g]}))); });
      var filters=h('div',{class:'classification-filters'},chips,state.genre ? topicFilters():null);
      head=header(topic ? topic.label:group ? group.label:'ライブラリ',state.genre ? state.genre+' · '+items.length+'件':'あなたのいいね '+c.total.toLocaleString()+'件',{
        tabs:tabs([['all','すべて',scoped.length],['unread','未読',scoped.length-scopeRead],['read','既読',scopeRead]],state.tabs.library,function(k) { state.tabs.library=k;state.sticky=null;render();window.scrollTo(0,0); }),extra:filters});
    }
    $main.appendChild(head);banners().forEach(function(b) { $main.appendChild(b); });
    if (!state.storage.ok && !state.items.size) return;
    if (group) $main.appendChild(h('div',{class:'note-line'},group.evidence.join(' · '),h('button',{class:'inline-link',onclick:function() { state.group=null;render(); }},'解除')));
    if (!items.length) { $main.appendChild(emptyState());return; }
    var shown=items.slice(0,pageLimit());
    shown.forEach(function(it) { var el=P.postEl(api,it);if (state.kbd===it.id) el.classList.add('kbd');$main.appendChild(el); });
    if (shown.length<items.length) $main.appendChild(h('button',{class:'load-more',onclick:moreItems},'さらに40件を表示',h('span',{text:shown.length+' / '+items.length.toLocaleString()+'件'})));
    else $main.appendChild(h('div',{class:'end',text:items.length.toLocaleString()+'件のいいね'}));
  }
  function emptyState() {
    if (!all().length) return h('div',{class:'empty'},icon('heart'),h('h2',{text:'いいねを、あなたの知識に。'}),h('p',{text:'Xのいいねが、自動で分類されたライブラリになります。気になった投稿を開いて、ひとことメモを添えるだけ。'}),h('div',{class:'btns'},h('button',{class:'btn blue',onclick:function() { G.intake && G.intake.open(); }},'X を接続する'),h('button',{class:'btn out',onclick:function() { G.intake && G.intake.insertSample(); }},'サンプルで試す')));
    if (state.query) return h('div',{class:'empty'},h('h2',{text:'一致するいいねがありません'}),h('p',{text:'本文・メモ・タグ・著者から探しています。別の言葉を試してみてください。'}));
    if (state.view==='likes') return h('div',{class:'empty'},icon('check'),h('h2',{text:'未読はありません'}),h('p',{text:'読んだいいねはライブラリに残っています。新しいいいねは自動でここに届きます。'}),h('div',{class:'btns'},h('button',{class:'btn out',onclick:function() { setView('library'); }},'ライブラリを見る')));
    return h('div',{class:'empty'},h('h2',{text:'この条件のいいねはありません'}),h('button',{class:'btn out',onclick:function() { state.genre=null;state.topic=null;state.group=null;state.tabs.library='all';render(); }},'すべてのいいねを見る'));
  }

  function renderDetail() {
    var it = state.items.get(state.detail);
    var u = it.user, s = it.src;
    $main.appendChild(header('投稿', null, { back: closeDetail }));
    banners().forEach(function (b) { $main.appendChild(b); });

    // スレッド（あなたのいいねの中にある、さかのぼれる返信先）
    var chain = [];
    var p = s.replyTo && byPostId(s.replyTo.postId);
    var guard = 0;
    while (p && guard++ < 10) { chain.unshift(p); p = p.src.replyTo && byPostId(p.src.replyTo.postId); }
    var thr = h('div', { id: 'sec-thread' });
    chain.forEach(function (x) { thr.appendChild(P.postEl(api, x, { compact: true, noContext: true, threadLine: true })); });
    if (chain.length) $main.appendChild(thr);
    else if (s.replyTo) $main.appendChild(h('div', { class: 'note-line', id: 'sec-thread', text: '返信先の投稿（@' + (s.replyTo.handle || '不明') + '）は、あなたのいいねに入っていないため表示できません。' }));

    var d = h('article', { class: 'detail', 'aria-label': s.author.name + 'の投稿' });
    d.appendChild(h('div', { class: 'd-head' }, D.avatar(s.author), h('div', { class: 'who' }, h('span', { class: 'nm', text: s.author.name }), h('span', { class: 'hd', text: s.author.handle ? '@' + s.author.handle : '' })),
      P.isFictional(it) ? h('span', { class: 'flag', text: it.meta.origin === 'mock' ? 'モック取得（架空）' : '架空サンプル' }) : null));
    if (s.replyTo) d.appendChild(h('div', { class: 'reply-to' }, '返信先: ', h('span', { text: '@' + (s.replyTo.handle || '不明') })));
    d.appendChild(h('div', { class: 'text' }, D.richText(s.text || (it.meta.sourceStatus === 'expired' ? '本文を再確認しています。取得できない場合はXで開いてください。' : it.meta.sourceStatus === 'removed' ? '取得元の投稿を確認できません。あなたのメモは保持しています。' : '（本文は未取得です。X で開くと読めます）'), P.handlers(api, it))));
    D.addIf(d, P.mediaEl(api, it, s.media));
    D.addIf(d, P.quoteEl(api, it, s.quote));
    var when = h('div', { class: 'when' });
    if (s.postedAt) when.appendChild(h('time', { datetime: s.postedAt, text: D.full(s.postedAt) }));
    if (it.meta.likedAt) when.appendChild(h('span', { class: 'liked-at' }, D.icon('heart', 'fill'), 'あなたのいいね ' + D.short(it.meta.likedAt)));
    d.appendChild(when);
    var flags = h('div', { class: 'flags' });
    if (it.meta.missing) flags.appendChild(h('span', { class: 'flag warn', text: '取得元で見つかりません（いいね解除か削除の可能性）' }));
    if (flags.childNodes.length) d.appendChild(flags);
    d.appendChild(P.actsEl(api, it, { detail: true }));
    $main.appendChild(d);

    $main.appendChild(organizePanel(it));
    // 記事（投稿のリンク先と、あなたが貼ったリンク）
    var links = linksOf(it).filter(I.isArticleLink);
    if (links.length || it.meta.origin === 'manual') {
      var sec = h('section', { class: 'panel', id: 'sec-article', 'aria-label': 'リンク先の記事' }, h('h2', {}, 'リンク先の記事'));
      links.forEach(function (l) { sec.appendChild(articlePanel(it, l)); });
      if (it.meta.origin === 'manual') sec.appendChild(addLinkRow(it));
      $main.appendChild(sec);
    }

    // つながり
    $main.appendChild(relationsPanel(it));

    // 取得の記録
    $main.appendChild(h('details', { class: 'panel source-info' }, h('summary', {text:'投稿の情報'}),
      h('dl', { class: 'kv' },
        h('dt', { text: '入手' }), h('dd', { text: { sample: '架空サンプル', mock: 'モック取得（架空）', manual: '手で追加', import: '取り込み' }[it.meta.origin] }),
        h('dt', { text: '最初に取り込み' }), h('dd', { text: D.short(it.meta.firstSeenAt) }),
        h('dt', { text: '最後に取得元で確認' }), h('dd', { text: it.meta.lastSeenAt ? D.short(it.meta.lastSeenAt) : '—' }),
        h('dt', { text: '重複の統合' }), h('dd', { text: it.meta.merged ? it.meta.merged + '回（同じ投稿 ID）' : 'なし' }),
        h('dt', { text: 'あなたの編集' }), h('dd', { text: u.editedAt ? D.short(u.editedAt) + '（取得し直しても上書きしません）' : 'まだありません' }))));

    // スマホの親指の位置に置く操作
    $main.appendChild(h('div', {class:'dock m-only',role:'toolbar','aria-label':'読むための操作'},
      dockBtn('check',u.read ? '未読に戻す':'既読にする','read',u.read,function() { toggleRead(it.id); }),
      dockBtn('ext','X で開く','ext',false,function() { openOriginal(it); })));
  }
  function dockBtn(ic, label, cls, on, fn) {
    return h('button', { class: 'dk ' + cls + (on ? ' on' : ''), 'aria-pressed': String(on), onclick: fn }, icon(ic), h('span', { text: label }));
  }

  function linksOf(it) {
    var seen = {};
    return I.linksOf(it).filter(function (l) { var k = I.canonicalUrl(l.url); if (!k || seen[k]) return false; seen[k] = 1; return true; });
  }

  // 投稿のリンク先を手で補う（本文を取得していない、手で追加したいいね向け）
  function addLinkRow(it) {
    var u = it.user;
    var f = h('input', { class: 'field', type: 'url', inputmode: 'url', placeholder: 'この投稿のリンク先の URL を貼る', 'aria-label': 'リンク先の URL', maxlength: String(S.LIMITS.urlChars), enterkeyhint: 'done', autocomplete: 'off' });
    async function add() {
      var url = S.sanitizeUrl(f.value);
      if (!url) { toast('http(s) の公開 URL を貼ってください', 'bad'); return; }
      if (u.links.length >= S.LIMITS.linksPerItem) { toast('リンクは ' + S.LIMITS.linksPerItem + ' 件までです', 'bad'); return; }
      if (linksOf(it).some(function (l) { return I.canonicalUrl(l.url) === I.canonicalUrl(url); })) { toast('このリンクはもうあります', 'neutral'); return; }
      var r = await save(it.id, { links: u.links.concat([{ url: url }]) });
      if (r.status === 'ok') { render(); toast('リンクを追加しました。「記事を読み込む」で本文を取りに行けます', 'neutral'); }
    }
    f.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.isComposing) add(); });
    var row = h('div', { class: 'add-link' }, f, h('button', { class: 'btn out sm', onclick: add }, '追加'));
    var mine = u.links.length ? h('div', { class: 'why', text: 'あなたが貼ったリンク：' + u.links.length + '件（取得し直しても消えません）' }) : null;
    return h('div', { class: 'add-link-wrap' }, row, mine);
  }

  function articlePanel(it, link) {
    if(state.server && state.server.cloud) {
      return h('section',{class:'article'},P.cardEl(api,it,link));
    }
    var art = articleFor(link);
    var loading = articleLoading(link);
    var fictional = P.isFictional(it) || /\.example$/i.test(link.domain);
    var thumb = h('div', { class: 'thumb', text: (link.domain.charAt(0) || '·').toUpperCase() });
    D.paint(thumb, link.domain);
    var showTitle = art && (art.status === 'ok' || art.status === 'sample') ? art.title || link.title : link.title;
    var box = h('div', { class: 'article' }, h('div', { class: 'a-top' }, thumb, h('div', { class: 'a-meta' },
      h('div', { class: 'a-dom', text: (art && art.siteName) || link.domain }),
      h('div', { class: 'a-title', text: showTitle }),
      art && art.publishedAt ? h('div', { class: 'a-dom', text: '公開 ' + D.short(art.publishedAt) + (art.byline ? '・' + art.byline : '') } ) : null)));
    var st;
    if (loading) {
      st = h('div', { class: 'a-status' }, h('div', { class: 'spin' }), h('span', { class: 'grow', text: 'ローカルサーバーが安全に読み込み中…' }), h('button', { class: 'btn out sm', onclick: function () { abortArticle(link); } }, '中止'));
    } else if (art && art.status === 'ok') {
      st = h('div', { class: 'a-status ok' }, icon('check'), h('span', { class: 'grow', text: '読み込み済み ' + D.short(art.fetchedAt) + '・' + (art.text ? Array.from(art.text).length.toLocaleString() + '字' : '本文なし') }),
        h('button', { class: 'btn out sm', onclick: function () { loadArticle(link, it); } }, '読み直す'));
    } else if (art && art.status === 'sample') {
      st = h('div', { class: 'a-status sample' }, icon('alert'), h('span', { class: 'grow', text: '架空の記事サンプルです（取得していません）' }));
    } else if (art) {
      st = h('div', { class: 'a-status bad' }, icon('alert'), h('span', { class: 'grow', text: (art.status === 'refused' ? '読み込みを断りました：' : art.status === 'blocked' ? '読み込めませんでした（ログイン・確認・有料の壁）：' : '読み込めませんでした：') + (art.reason || '') }),
        art.status === 'refused' ? null : h('button', { class: 'btn out sm', onclick: function () { loadArticle(link, it); } }, 'もう一度'));
    } else {
      st = h('div', { class: 'a-status' }, icon('article'), h('span', { class: 'grow', text: fictional ? '架空のリンクなので読み込みません' : !state.server ? '記事は未取得（読み込むにはローカルサーバーが必要）' : '記事は未取得です' }),
        h('button', { class: 'btn sm blue', disabled: fictional || !state.server ? true : null, onclick: function () { loadArticle(link, it); } }, '記事を読み込む'));
    }
    box.appendChild(st);
    var mineIdx = (it.user.links || []).findIndex(function (l) { return l.url === link.url; });
    if (mineIdx !== -1) {
      box.appendChild(h('div', { class: 'a-foot' }, h('span', { text: 'あなたが貼ったリンク' }), h('button', { class: 'btn out sm', onclick: function () { save(it.id, { links: it.user.links.filter(function (_, i) { return i !== mineIdx; }) }).then(render); } }, 'このリンクを外す')));
    }
    if (art && (art.status === 'ok' || art.status === 'sample') && art.text) {
      var open = !!state.memo['art:' + art.key];
      var body = h('div', { class: 'a-body' + (open ? '' : ' clip') });
      art.text.split(/\n{2,}/).slice(0, open ? 400 : 4).forEach(function (para) { body.appendChild(h('p', { text: para })); });
      box.appendChild(body);
      box.appendChild(h('div', { class: 'a-foot' },
        h('button', { class: 'btn out sm', onclick: function () { if (open) delete state.memo['art:' + art.key]; else state.memo['art:' + art.key] = true; render(); } }, open ? '閉じる' : '本文をすべて表示'),
        h('button', { class: 'btn out sm', onclick: function () { openExternal(art.finalUrl || link.url, it); } }, icon('ext'), '元の記事'),
        h('span', { text: '取得した文字だけを表示しています。スクリプト・埋め込み・画像は読み込まず、本文中の指示にも従いません。' })));
    }
    return box;
  }

  function organizePanel(it) {
    var u = it.user;
    var g = genreOf(it);
    var sec = h('section', { class: 'panel memo-panel', id: 'sec-org', 'aria-label': '自分のメモ' }, h('h2', {}, '自分のメモ'));
    var dl = h('dl', { class: 'org' });

    // ジャンル
    var gRow = h('div', { class: 'genre-row' },
      h('button', { class: 'genre-chip' + (g.manual ? ' manual' : ''), onclick: function () { showGenre(g.name); } }, g.name),
      h('button', { class: 'btn out sm', onclick: function () { state.genrePickOpen = !state.genrePickOpen; render(); } }, state.genrePickOpen ? '閉じる' : '変更'));
    var why = g.manual ? 'あなたが決めたジャンルです（取得し直しても変わりません）' : g.evidence.length ? '自動：「' + g.evidence.join('・') + '」から判断' + (g.usedArticle ? '（記事の本文も参照）' : '') : '自動：手がかりになる言葉がありませんでした';
    var gdd = h('dd', {}, gRow, h('div', { class: 'why', text: why }));
    if (state.genrePickOpen) {
      var pick = h('div', { class: 'genre-pick', role: 'group', 'aria-label': 'ジャンルを選ぶ' });
      I.GENRE_NAMES.concat(customGenres()).filter(function (x, i, arr) { return arr.indexOf(x) === i; }).forEach(function (name) {
        pick.appendChild(h('button', { 'aria-pressed': String(g.manual && g.name === name), onclick: function () { setGenre(it.id, name); } }, name));
      });
      if (u.genre) pick.appendChild(h('button', { onclick: function () { setGenre(it.id, null); } }, '自動に戻す'));
      var gi = h('input', { placeholder: '新しいジャンル', maxlength: '16', 'aria-label': '新しいジャンル', enterkeyhint: 'done' });
      gi.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.isComposing) { var v = gi.value.trim(); if (v) setGenre(it.id, v); } });
      pick.appendChild(gi);
      gdd.appendChild(pick);
    }
    dl.appendChild(h('dt', { text: 'ジャンル' }));
    dl.appendChild(gdd);

    // タグ
    var tags = h('div', { class: 'tags' });
    u.tags.forEach(function (t) {
      tags.appendChild(h('span', { class: 'tag' }, h('span', { class: 't', role: 'link', tabindex: '0', text: '#' + t, onclick: function () { search('#' + t); } }),
        h('button', { class: 'x', 'aria-label': t + ' を外す', onclick: function () { save(it.id, { tags: u.tags.filter(function (x) { return x !== t; }) }).then(render); } }, icon('close'))));
    });
    var ti = h('input', { class: 'tag-input', placeholder: '＋ タグ', maxlength: String(S.LIMITS.tagChars), 'aria-label': 'タグを追加', list: 'tag-list', enterkeyhint: 'done' });
    ti.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        var t = S.cleanTag(ti.value);
        if (!t) return;
        if (u.tags.indexOf(t) !== -1) { ti.value = ''; return; }
        if (u.tags.length >= S.LIMITS.tagsPerItem) { toast('タグは ' + S.LIMITS.tagsPerItem + ' 個までです', 'bad'); return; }
        save(it.id, { tags: u.tags.concat([t]) }).then(function (r) { render(); if (r.status === 'ok') { var again = document.querySelector('.tag-input'); if (again) again.focus(); } });
      }
    });
    var dlTags = h('datalist', { id: 'tag-list' });
    allTags().forEach(function (t) { if (u.tags.indexOf(t) === -1) dlTags.appendChild(h('option', { value: t })); });
    tags.appendChild(ti);
    tags.appendChild(dlTags);
    dl.appendChild(h('dt', { text: 'タグ' }));
    dl.appendChild(h('dd', {}, tags));

    // メモ
    var draft = state.memo[it.id];
    var ta = h('textarea', { class: 'memo', placeholder: '気づいたこと、使いどころ…', maxlength: String(S.LIMITS.memoChars), 'aria-label': 'メモ', rows: '3', dataset: { memo: it.id } });
    ta.value = draft && draft.text != null ? draft.text : u.memo;
    var ms = h('div', { class: 'memo-state' + (draft && (draft.state === 'error' || draft.remote) ? ' bad' : '') });
    if (draft && draft.state === 'error') ms.appendChild(document.createTextNode('保存できませんでした。入力は残っています。'));
    else if (draft && draft.remote) ms.appendChild(document.createTextNode('別のタブでメモが変わりました。'));
    else if (draft && draft.state === 'saved') ms.appendChild(document.createTextNode('保存しました'));
    if (draft && (draft.state === 'error' || draft.remote)) {
      ms.appendChild(h('button', { class: 'btn out sm', onclick: function () { saveMemo(it.id, ta.value, true); } }, 'この内容で保存'));
      if (draft.remote) ms.appendChild(h('button', { class: 'btn out sm', onclick: function () { delete state.memo[it.id]; render(); } }, '向こうの内容を使う'));
    }
    var mt = null;
    ta.addEventListener('input', function () {
      var prev = state.memo[it.id];
      state.memo[it.id] = { text: ta.value, state: 'typing', remote: prev && prev.remote, base: prev && prev.base != null ? prev.base : u.memo };
      clearTimeout(mt);
      mt = setTimeout(function () { saveMemo(it.id, ta.value, false); }, 700);
    });
    ta.addEventListener('blur', function () { clearTimeout(mt); if (state.memo[it.id] && state.memo[it.id].state === 'typing') saveMemo(it.id, ta.value, false); });
    sec.appendChild(ta); sec.appendChild(ms);
    var options=h('details',{class:'organize-options',open:state.orgOpen===it.id ? true:null},h('summary',{text:'分類・タグを調整'}),dl);
    options.addEventListener('toggle',function() { state.orgOpen=options.open ? it.id:null; });
    sec.appendChild(options);
    return sec;
  }

  async function saveMemo(id, text, force) {
    var it = state.items.get(id);
    if (!it) return;
    var d = state.memo[id] || {};
    if (d.remote && !force) { render(); return; }
    var base = force ? { memo: it.user.memo } : { memo: d.base != null ? d.base : it.user.memo };
    var r;
    try { r = await repo.patchUser(id, base, { memo: text }, Date.now()); }
    catch (e) { state.memo[id] = { text: text, state: 'error' }; showWriteError(e, function () { return saveMemo(id, text, true); }); return; }
    if (r.status === 'ok') {
      state.items.set(id, r.item); dirty();
      state.memo[id] = { text: null, state: 'saved', base: null };
      updateMemoState(id, '保存しました');
      renderSideQuiet();
    } else if (r.status === 'conflict') {
      state.items.set(id, r.item); dirty();
      state.memo[id] = { text: text, state: 'conflict', remote: true };
      render();
    }
  }
  function updateMemoState(id, text) {
    var el = document.querySelector('textarea[data-memo="' + cssEsc(id) + '"]');
    var st = el && el.parentNode.querySelector('.memo-state');
    if (st) { st.className = 'memo-state'; st.textContent = text; }
  }
  function renderSideQuiet() { /* メモ保存のたびに画面全体を作り直さない（入力中のカーソルを保つ） */ }

  async function setGenre(id, name) {
    var r = await save(id, { genre: name });
    if (r.status === 'ok') { state.genrePickOpen = false; render(); toast(name ? 'ジャンルを「' + name + '」にしました' : 'ジャンルを自動に戻しました', 'neutral', true); undoStack.push({ id: id, before: { genre: null }, after: { genre: name } }); }
  }
  function customGenres() {
    var out = [];
    state.items.forEach(function (it) { if (it.user.genre && I.GENRE_NAMES.indexOf(it.user.genre) === -1 && out.indexOf(it.user.genre) === -1) out.push(it.user.genre); });
    return out;
  }
  function allTags() {
    var m = {};
    state.items.forEach(function (it) { it.user.tags.forEach(function (t) { m[t] = (m[t] || 0) + 1; }); });
    return Object.keys(m).sort(function (a, b) { return m[b] - m[a]; });
  }

  function relationsPanel(it) {
    var rel = relationsOf(it.id).filter(function (r) { return r.kind !== 'thread' || true; });
    var sec = h('section', { class: 'panel rel-panel', id: 'sec-rel', 'aria-label': 'つながり' }, h('h2', {}, 'つながり', h('span', { class: 'muted', text: 'あなたのいいねの中だけ' })));
    if (it.meta.merged) sec.appendChild(h('div', { class: 'dupe-note' }, icon('merge'), '同じ投稿を ' + it.meta.merged + ' 回取り込み、1 件にまとめています（重複）'));
    if (!rel.length) {
      sec.appendChild(h('p', { class: 'lead', text: 'つながるいいねは見つかりませんでした。同じ記事へのリンク、共通する言葉・タグ、返信のつながりで探しています（言葉が違うと、意味が近くてもつながりません）。' }));
      return sec;
    }
    var shown = state.showAllRel ? rel : rel.slice(0, 4);
    var wrap = h('div', { class: 'rels' });
    shown.forEach(function (r) {
      var other = state.items.get(r.id);
      if (!other) return;
      var kindLabel = { thread: 'スレッド', same_article: '同じ記事', related: '関連' }[r.kind];
      var box = h('div', { class: 'rel' }, h('div', { class: 'rel-why' }, h('span', { class: 'rel-kind ' + r.kind, text: kindLabel }), h('span', { text: r.reasons.join('／') })));
      box.appendChild(P.postEl(api, other, { compact: true, noContext: true }));
      wrap.appendChild(box);
    });
    sec.appendChild(wrap);
    if (rel.length > shown.length) sec.appendChild(h('button', { class: 'showmore', onclick: function () { state.showAllRel = true; render(); } }, 'さらに ' + (rel.length - shown.length) + '件 表示'));
    return sec;
  }

  function relationsOf(id) { return ana().byId[id] || []; }
  function genreOf(it) {
    var a = null;
    var ls = I.linksOf(it);
    for (var i = 0; i < ls.length && !a; i++) a = articleFor(ls[i]);
    return I.genreOf(it, a);
  }
  function byPostId(pid) { return state.items.get(M.keyOf(pid)) || null; }

  /* ================================================================ 重ね表示 */

  var lastFocus = null;
  function showLayer(node, opts) {
    opts = opts || {};
    lastFocus = document.activeElement;
    $layer.textContent = '';
    $layer.appendChild(h('div', { class: 'scrim' + (opts.clear ? ' clear' : ''), onclick: closeLayer }));
    $layer.appendChild(node);
    $layer.classList.add('on');
    document.body.classList.add('locked');
  }
  function closeLayer() {
    if (!$layer.classList.contains('on')) return;
    $layer.classList.remove('on');
    $layer.textContent = '';
    document.body.classList.remove('locked');
    if (lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
    if (!isField(document.activeElement)) document.body.classList.remove('typing');
  }
  function isMobile() { return window.matchMedia('(max-width: 700px)').matches; }



  function openViewer(it, media, index) {
    var i = index;
    var v = h('div', { class: 'viewer', role: 'dialog', 'aria-label': '画像' });
    function draw() {
      v.textContent = '';
      var m = media[i];
      var src = mediaSrc(m, it);
      v.appendChild(h('div', { class: 'vt' }, h('button', { class: 'icon-btn', 'aria-label': '閉じる', onclick: closeLayer }, icon('close')),
        h('span', { text: media.length > 1 ? (i + 1) + ' / ' + media.length : '' }),
        h('button', { class: 'icon-btn', 'aria-label': 'X で開く', onclick: function () { openOriginal(it); } }, icon('ext'))));
      var vm = h('div', { class: 'vm' });
      if (src) vm.appendChild(h('img', { src: src, alt: m.alt || '' }));
      else vm.appendChild(h('div', { class: 'va', text: '画像は未取得です' }));
      if (media.length > 1) {
        vm.appendChild(h('button', { class: 'icon-btn nav-l', 'aria-label': '前の画像', onclick: function () { i = (i - 1 + media.length) % media.length; draw(); } }, icon('left')));
        vm.appendChild(h('button', { class: 'icon-btn nav-r', 'aria-label': '次の画像', onclick: function () { i = (i + 1) % media.length; draw(); } }, icon('right')));
      }
      v.appendChild(vm);
      v.appendChild(h('div', { class: 'va', text: m.alt ? '説明：' + m.alt : '説明はありません' }));
    }
    draw();
    v.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft' && media.length > 1) { i = (i - 1 + media.length) % media.length; draw(); }
      if (e.key === 'ArrowRight' && media.length > 1) { i = (i + 1) % media.length; draw(); }
    });
    v.tabIndex = -1;
    showLayer(v);
    v.focus();
  }

  function openMobileSearch() {
    state.searching=true;
    rememberScroll();
    closeDetailSilently();
    state.query = state.query || '';
    // 検索の画面（結果は入力に合わせてすぐ出る）
    $main.textContent = '';
    var box = searchBox(true);
    var head = h('div', { class: 'head' }, h('div', { class: 'head-top' }, h('button', { class: 'icon-btn', 'aria-label': '戻る', onclick: function () { search(''); restoreScroll(); } }, icon('back')), h('div', { class: 'grow' }, box)));
    $main.appendChild(head);
    var tags = allTags().slice(0, 12);
    var p = h('div', { class: 'panel' }, h('h2', {}, 'タグ'));
    var t = h('div', { class: 'chips wrap' });
    tags.forEach(function (x) { t.appendChild(h('button', { class: 'chip', onclick: function () { search('#' + x); } }, '#' + x)); });
    if (!tags.length) t.appendChild(h('span', { class: 'muted', text: 'まだタグはありません' }));
    p.appendChild(t);
    var g = h('div', { class: 'chips wrap' });
    Object.keys(ana().genreCounts).forEach(function (x) { g.appendChild(h('button', { class: 'chip', onclick: function () { showGenre(x); } }, x)); });
    $main.appendChild(p);
    $main.appendChild(h('div', { class: 'panel' }, h('h2', {}, 'ジャンル'), g));
    window.scrollTo(0, 0);
  }

  /* ================================================================ 通知 */

  var toastTimer = null;
  function toast(msg, kind, withUndo) {
    $toasts.textContent = '';
    var t = h('div', { class: 'toast' + (kind ? ' ' + kind : ''), role: 'status' }, h('span', { text: msg }));
    if (withUndo) t.appendChild(h('button', { onclick: function () { $toasts.textContent = ''; undo(); } }, '取り消す'));
    $toasts.appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $toasts.textContent = ''; }, withUndo ? 6000 : 3500);
  }
  function flash(id) {
    requestAnimationFrame(function () { var el = document.querySelector('.post[data-id="' + cssEsc(id) + '"]'); if (el) { el.classList.add('flash'); setTimeout(function () { el.classList.remove('flash'); }, 900); } });
  }

  /* ================================================================ キーボード（PC） */

  function onKey(e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase()==='k') { e.preventDefault();openMobileSearch();return; }
    if (isField(e.target) || e.metaKey || e.ctrlKey || e.altKey) { if (e.key==='Escape' && isField(e.target)) e.target.blur();return; }
    if ($layer.classList.contains('on')) { if (e.key==='Escape') closeLayer();return; }
    var items=state.detail ? []:flat(currentList()),cur=state.detail || state.kbd;
    function moveK(d) {
      if (!items.length) return;
      var i=items.findIndex(function(x) { return x.id===state.kbd; }), index=Math.max(0,Math.min(items.length-1,i+d)),n=items[index];
      state.kbd=n.id;
      if (index>=pageLimit()) { state.pageLimits[listKey()]=Math.ceil((index+1)/40)*40;renderMain(); }
      document.querySelectorAll('.post.kbd').forEach(function(x) { x.classList.remove('kbd'); });
      var el=document.querySelector('.post[data-id="'+cssEsc(n.id)+'"]');
      if (el) { el.classList.add('kbd');el.focus({preventScroll:true});el.scrollIntoView({block:'nearest'}); }
    }
    switch (e.key) {
      case 'j': if (!state.detail) { e.preventDefault();moveK(1); } break;
      case 'k': if (!state.detail) { e.preventDefault();moveK(-1); } break;
      case 'Enter': case 'o': if (!state.detail && state.kbd) openDetail(state.kbd);else if (state.detail && e.key==='o') openOriginal(state.items.get(state.detail));break;
      case 'Escape': if (state.detail) closeDetail();else if (state.query || state.searching) { state.searching=false;search(''); } break;
      case '/': e.preventDefault();var input=document.querySelector('.side .search input');if (input && input.offsetParent) input.focus();else openMobileSearch();break;
      case 'u': if (cur) toggleRead(cur);break;
      case 'z': undo();break;
      case '1': setView('likes');break;
      case '2': setView('library');break;
    }
  }

  function cssEsc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'); }
  function reduced() { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }

  // posts.js・intake.js に渡す窓口
  var api = {
    state: state,
    get repo() { return repo; },
    render: render,
    reloadAll: reloadAll,
    toast: toast,
    showLayer: showLayer, closeLayer: closeLayer, isMobile: isMobile,
    openDetail: openDetail, closeDetail: closeDetail,
    toggleRead: toggleRead, undo: undo,
    openViewer: openViewer,
    openExternal: openExternal, openOriginal: openOriginal,
    search: search, showGenre: showGenre, showGroup: showGroup, showTopic:showTopic, topicsOf:topicsOf, setView: setView,
    articleFor: articleFor, articleLoading: articleLoading, loadArticle: loadArticle,
    mediaSrc: mediaSrc, mediaState: mediaState, loadImage: loadImage,
    relationsOf: relationsOf, genreOf: genreOf, byPostId: byPostId,
    showWriteError: showWriteError, dirty: dirty
  };
  G.app = api;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);
