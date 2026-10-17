/*
 * margin core/insight — ジャンル分けと、投稿どうしのつながり（すべて手元で計算）
 *
 * 外部の AI やサービスは使わない。辞書と文字列の一致だけで決めるので、
 *  - ジャンルは「辞書の言葉が何回出たか」で決まる。辞書にない話題は「その他」になる
 *  - 2段目のトピックは投稿・見出し・メモ・タグから抽出し、ストック内の共通する具体語でまとめる
 *  - 関連は「共通する言葉・タグ」で決まる。意味が近くても言葉が違えばつながらない
 * という限界がある。画面ではいつも根拠（どの言葉で決めたか）を見せる。
 *
 * つながりの種類（混ぜない）
 *  - duplicate    同じ投稿：投稿 ID が同じ。保存時に 1 件へ統合済み（meta.merged に回数）
 *  - thread       スレッド：返信先（replyTo）でつながる
 *  - same_article 同じ記事：リンク先 URL を正規化して一致（記事を読み込んだ後は転送後の URL でも一致）
 *  - related      関連：共通する言葉が 2 つ以上、または同じタグ＋同じジャンル
 *
 * 取得した記事の本文は「データ」としてだけ扱う。中に書かれた指示には従わない（実行しない・評価しない）。
 */
(function (root, factory) {
  var safe = (typeof require === 'function') ? require('./safe.js') : root.Margin.safe;
  var topics = (typeof require === 'function') ? require('./topics.js') : root.Margin.topics;
  var api = factory(safe, topics);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.Margin = root.Margin || {}; root.Margin.insight = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (S, T) {
  'use strict';

  var GENRES = [
    { name: '開発', words: ['sqlite', 'rust', 'cli', 'api', 'git', 'node', 'javascript', 'typescript', 'python', 'upsert', 'wal', 'コード', '実装', 'バックアップ', 'データベース', 'サーバー', 'テスト', 'エラー', 'デプロイ', 'ブラウザ', '開発', '設計書', 'バグ'] },
    { name: 'デザイン', words: ['ui', 'ux', 'figma', 'デザイン', '角丸', '行間', '組版', 'フォント', '書体', 'トークン', '余白', 'レイアウト', '配色', 'タイポグラフィ', '混植', '縦書き', 'ボタン', '見出し'] },
    { name: 'AI', words: ['llm', 'ai', 'gpt', 'プロンプト', '評価セット', '評価', 'モデル', '機械学習', '生成', 'ラベル'] },
    { name: 'マーケ', words: ['lp', 'cvr', 'd2c', '離脱', 'レビュー', '広告', 'コピー', '集客', 'ファーストビュー', 'スクロール', '実績'] },
    { name: '習慣・学び', words: ['習慣', '朝', '読書', '学び', '見返す', '振り返り', '作業ログ', 'メモ', '続けられる', '読む時間'] }
  ];
  var OTHER = 'その他';
  var GENRE_NAMES = GENRES.map(function (g) { return g.name; }).concat([OTHER]);

  var STOP = { the: 1, and: 1, for: 1, with: 1, this: 1, that: 1, from: 1, http: 1, https: 1, com: 1, www: 1, example: 1, status: 1, are: 1, you: 1, was: 1, but: 1, not: 1, have: 1 };
  var STOP_JA = { 自分: 1, 今日: 1, 一番: 1, 場合: 1, 結局: 1, 最初: 1, 時間: 1, 確率: 1, 以上: 1, 前後: 1, 架空: 1, 投稿者: 1, 追記: 1 };

  function countIn(text, word) {
    if (!text) return 0;
    var hay = text.toLowerCase();
    var n = 0, i = 0;
    var isAscii = /^[a-z0-9]+$/.test(word);
    while ((i = hay.indexOf(word, i)) !== -1) {
      // 英字の語は前後が英数字でないときだけ数える（"ui" が "build" に含まれる誤判定を防ぐ）
      if (!isAscii || (!/[a-z0-9]/.test(hay.charAt(i - 1) || ' ') && !/[a-z0-9]/.test(hay.charAt(i + word.length) || ' '))) n++;
      i += word.length;
    }
    return n;
  }

  // ジャンルの自動判定。article は読み込み済みの記事（なければ null）
  function classify(item, article) {
    var parts = [
      { t: item.src.text, w: 2 },
      { t: item.src.quote ? item.src.quote.text : '', w: 1 },
      { t: linksOf(item).map(function (l) { return l.title; }).join(' '), w: 2 },
      { t: article && article.status === 'ok' ? article.title : '', w: 2 },
      { t: article && article.status === 'ok' ? String(article.text || '').slice(0, 3000) : '', w: 1 }
    ];
    var best = null;
    GENRES.forEach(function (g) {
      var score = 0, hits = {};
      g.words.forEach(function (w) {
        parts.forEach(function (p) { var c = countIn(p.t, w); if (c) { score += c * p.w; hits[w] = (hits[w] || 0) + c; } });
      });
      if (!best || score > best.score) best = { name: g.name, score: score, evidence: Object.keys(hits).sort(function (a, b) { return hits[b] - hits[a]; }).slice(0, 4) };
    });
    if (!best || best.score < 2) return { name: OTHER, score: best ? best.score : 0, evidence: [], usedArticle: !!(article && article.status === 'ok') };
    best.usedArticle = !!(article && article.status === 'ok');
    return best;
  }

  // 実際に使うジャンル：あなたが選んだものがあれば常にそれ
  function genreOf(item, article) {
    if (item.user.genre) return { name: item.user.genre, manual: true, evidence: [] };
    var c = classify(item, article);
    return { name: c.name, manual: false, evidence: c.evidence, score: c.score, usedArticle: c.usedArticle };
  }

  // 記事 URL の正規化（同じ記事の判定用）
  function canonicalUrl(raw) {
    var safe = S.sanitizeUrl(raw);
    if (!safe) return null;
    var u = new URL(safe);
    var host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
    var path = u.pathname.replace(/\/+$/, '') || '/';
    var params = [];
    u.searchParams.forEach(function (v, k) { params.push([k, v]); });
    params.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
    var q = params.map(function (p) { return encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1]); }).join('&');
    return host + path + (q ? '?' + q : '');
  }

  function keywords(item) {
    var text = [item.src.text, item.src.quote ? item.src.quote.text : '', linksOf(item).map(function (l) { return l.title; }).join(' ')].join('\n');
    var set = {};
    (text.match(/[A-Za-z][A-Za-z0-9+#.-]{1,30}/g) || []).forEach(function (w) {
      w = w.toLowerCase().replace(/[.-]+$/, '');
      if (w.length >= 2 && !STOP[w] && !/^\d/.test(w)) set[w] = 1;
    });
    (text.match(/[ァ-ヶー]{3,}/g) || []).forEach(function (w) { set[w] = 1; });
    (text.match(/[一-龠々]{2,}/g) || []).forEach(function (w) { if (!STOP_JA[w]) set[w] = 1; });
    return Object.keys(set);
  }

  /*
   * items: 記録の配列、articles: { canonicalUrl: article }
   * 戻り値: { byId: { id: [ { id, kind, reasons[], score } ] }, groups: [...] }
   */
  function analyze(items, articles) {
    articles = articles || {};
    var byPost = {};
    items.forEach(function (it) { byPost[it.src.postId] = it; });

    var info = {};
    var kwIndex = {};
    var articleIndex = {};
    items.forEach(function (it) {
      var art = articleFor(it, articles);
      var kws = keywords(it);
      var g = genreOf(it, art.article);
      info[it.id] = { kws: kws, genre: g.name, tags: it.user.tags.map(function (t) { return t.toLowerCase(); }), articleKeys: art.keys };
      kws.forEach(function (k) { (kwIndex[k] = kwIndex[k] || []).push(it.id); });
      art.keys.forEach(function (k) { (articleIndex[k] = articleIndex[k] || []).push(it.id); });
    });

    var rel = {};
    function add(a, b, kind, reasons, score) {
      if (a === b) return;
      (rel[a] = rel[a] || {});
      var cur = rel[a][b];
      if (!cur || rank(kind) > rank(cur.kind)) rel[a][b] = { id: b, kind: kind, reasons: reasons, score: score };
    }
    function rank(k) { return { thread: 4, same_article: 3, related: 1 }[k] || 0; }

    // スレッド
    items.forEach(function (it) {
      var p = it.src.replyTo && byPost[it.src.replyTo.postId];
      if (p) {
        add(it.id, p.id, 'thread', ['返信先の投稿'], 10);
        add(p.id, it.id, 'thread', ['この投稿への返信'], 10);
      }
    });
    // 同じ記事
    Object.keys(articleIndex).forEach(function (k) {
      var ids = articleIndex[k];
      if (ids.length < 2) return;
      var title = titleFor(k, articles);
      ids.forEach(function (a) { ids.forEach(function (b) { add(a, b, 'same_article', ['同じ記事：' + title], 8); }); });
    });
    // 関連（共通の言葉・タグ）
    var counts = {};
    Object.keys(kwIndex).forEach(function (k) {
      var ids = kwIndex[k];
      if (ids.length < 2 || ids.length > 60) return; // ありふれた言葉は根拠にしない
      for (var i = 0; i < ids.length; i++) for (var j = 0; j < ids.length; j++) {
        if (i === j) continue;
        var key = ids[i] + '\u0000' + ids[j];
        (counts[key] = counts[key] || []).push(k);
      }
    });
    var tagIndex = {};
    items.forEach(function (it) { info[it.id].tags.forEach(function (t) { (tagIndex[t] = tagIndex[t] || []).push(it.id); }); });
    var tagPairs = {};
    Object.keys(tagIndex).forEach(function (t) {
      var ids = tagIndex[t];
      for (var i = 0; i < ids.length; i++) for (var j = 0; j < ids.length; j++) {
        if (i !== j) (tagPairs[ids[i] + '\u0000' + ids[j]] = tagPairs[ids[i] + '\u0000' + ids[j]] || []).push(t);
      }
    });
    var pairKeys = {};
    Object.keys(counts).forEach(function (k) { pairKeys[k] = 1; });
    Object.keys(tagPairs).forEach(function (k) { pairKeys[k] = 1; });
    Object.keys(pairKeys).forEach(function (key) {
      var ab = key.split('\u0000');
      var shared = counts[key] || [];
      var tags = tagPairs[key] || [];
      var sameGenre = info[ab[0]].genre === info[ab[1]].genre && info[ab[0]].genre !== OTHER;
      if (shared.length >= 2 || (tags.length >= 1 && sameGenre)) {
        var reasons = [];
        if (shared.length) reasons.push('共通の言葉：' + shared.slice(0, 4).join('、'));
        if (tags.length) reasons.push('同じタグ：' + tags.map(function (t) { return '#' + t; }).join(' '));
        if (sameGenre) reasons.push('同じジャンル：' + info[ab[0]].genre);
        add(ab[0], ab[1], 'related', reasons, shared.length + tags.length * 2 + (sameGenre ? 0.5 : 0));
      }
    });

    var byId = {};
    Object.keys(rel).forEach(function (a) {
      byId[a] = Object.keys(rel[a]).map(function (b) { return rel[a][b]; })
        .sort(function (x, y) { return rank(y.kind) - rank(x.kind) || y.score - x.score; });
    });

    // まとまり：同じ記事・関連でつながった投稿の集まり（スレッドは投稿詳細で見せる）
    var parent = {};
    function find(x) { while (parent[x] && parent[x] !== x) x = parent[x] = parent[parent[x]] || parent[x]; return x; }
    function union(a, b) { var ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
    items.forEach(function (it) { parent[it.id] = it.id; });
    Object.keys(byId).forEach(function (a) { byId[a].forEach(function (r) { if (r.kind === 'related') union(a, r.id); }); });
    var comp = {};
    items.forEach(function (it) { var r = find(it.id); (comp[r] = comp[r] || []).push(it.id); });
    var groups = Object.keys(comp).map(function (k) { return comp[k]; }).filter(function (ids) { return ids.length >= 2; }).map(function (ids) {
      var words = {};
      ids.forEach(function (a) {
        (byId[a] || []).forEach(function (r) {
          if (ids.indexOf(r.id) === -1 || r.kind !== 'related') return;
          (counts[a + '\u0000' + r.id] || []).forEach(function (w) { words[w] = (words[w] || 0) + 1; });
        });
      });
      var top = Object.keys(words).sort(function (x, y) { return words[y] - words[x]; }).slice(0, 3);
      var genres = {};
      ids.forEach(function (id) { genres[info[id].genre] = (genres[info[id].genre] || 0) + 1; });
      var genre = Object.keys(genres).sort(function (x, y) { return genres[y] - genres[x]; })[0];
      return {
        id: 'g:' + ids.slice().sort()[0],
        ids: ids,
        kind: 'topic',
        label: top.join('・') || genre,
        evidence: top.length ? ['共通の言葉：' + top.join('、')] : ['同じタグとジャンル'],
        genre: genre
      };
    }).sort(function (a, b) { return b.ids.length - a.ids.length; });
    // A shared article group contains only posts with that exact article; related paths cannot widen it.
    var articleGroups = {};
    Object.keys(articleIndex).forEach(function(k) {
      var ids=articleIndex[k].slice().sort();
      if (ids.length<2) return;
      var identity=ids.join('|');if (articleGroups[identity]) return;
      articleGroups[identity]={id:'a:'+k,ids:ids,kind:'article',label:titleFor(k,articles),evidence:['同じ記事へのリンク'],genre:info[ids[0]].genre};
    });
    groups=Object.keys(articleGroups).map(function(k) { return articleGroups[k]; }).concat(groups).sort(function(a,b) { return b.ids.length-a.ids.length; });

    var genreCounts = {};
    items.forEach(function (it) { genreCounts[info[it.id].genre] = (genreCounts[info[it.id].genre] || 0) + 1; });

    var genreForId = function (id) { return info[id] ? info[id].genre : OTHER; };
    var concrete = T.build(items, {genreOf:genreForId,exclude:GENRE_NAMES,articleFor:function (it) { return articleFor(it, articles).article; }});
    return { byId: byId, groups: groups, genreOf: genreForId, genreCounts: genreCounts, topics:concrete };
  }

  function linksOf(it) { return it.src.links.concat(it.user && it.user.links ? it.user.links : []); }

  function isArticleLink(link) {
    var url=S.sanitizeUrl(link && link.url);
    if (!url) return false;
    return !/(^|\.)(x\.com|twitter\.com|t\.co)$/.test(new URL(url).hostname.toLowerCase());
  }

  function articleFor(it, articles) {
    var keys = [], article = null;
    linksOf(it).forEach(function (l) {
      if (!isArticleLink(l)) return;
      var k = canonicalUrl(l.url);
      if (!k) return;
      if (keys.indexOf(k)===-1) keys.push(k);
      var a = articles[k];
      if (a) {
        if (!article) article = a;
        if (a.status === 'ok' && a.finalUrl) { var f = canonicalUrl(a.finalUrl); if (f && keys.indexOf(f) === -1) keys.push(f); }
      }
    });
    return { keys: keys, article: article };
  }

  function titleFor(key, articles) {
    var a = articles[key];
    if (a && (a.status === 'ok' || a.status === 'sample') && a.title) return a.title;
    return key.length > 48 ? key.slice(0, 47) + '…' : key;
  }

  return Object.freeze({
    GENRES: GENRES, GENRE_NAMES: GENRE_NAMES, OTHER: OTHER,
    classify: classify, genreOf: genreOf, linksOf: linksOf, isArticleLink:isArticleLink, canonicalUrl: canonicalUrl, keywords: keywords, analyze: analyze, articleFor: articleFor
  });
});
