/*
 * margin ui/posts — 投稿の表示部品（タイムライン・詳細・引用・メディア・リンクカード）
 *  A は app.js が渡す操作の窓口（開く・保存・検索など）
 */
(function (root) {
  'use strict';
  var G = root.Margin;
  var D = G.dom, h = D.h, icon = D.icon;

  function isFictional(it) { return it.meta.origin === 'sample' || it.meta.origin === 'mock'; }

  function handlers(A, it) {
    return {
      url: function (u) { A.openExternal(u, it); },
      mention: function (hd) { A.search('@' + hd); },
      hashtag: function (t) { A.search(t); }
    };
  }

  /* ---------------- メディア ---------------- */
  function mediaEl(A, it, media, opt) {
    if (!media || !media.length) return null;
    var box = h('div', { class: 'media n' + media.length });
    if (media.length === 1 && media[0].w && media[0].h) {
      var r = media[0].h / media[0].w;
      box.style.setProperty('aspect-ratio', media[0].w + ' / ' + Math.min(media[0].h, media[0].w * 1.25));
      if (r > 1.25) box.classList.add('tall');
    }
    media.forEach(function (m, i) {
      var cell;
      var src = A.mediaSrc(m, it);
      if (m.kind === 'video' || m.kind === 'gif') {
        cell = h('div', { class: 'm', role: 'button', tabindex: '0', 'aria-label': (m.kind === 'gif' ? 'GIF' : '動画') + '：' + (m.alt || '説明なし') });
        if (src) cell.appendChild(h('img', { src: src, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' }));
        cell.appendChild(h('div', { class: 'play' }, h('i', {}, icon('play', 'fill'))));
        cell.appendChild(h('div', { class: 'note', text: isFictional(it) ? '架空サンプルの動画（再生できません）' : 'ここでは再生しません。X で開いて見てください' }));
        cell.addEventListener('click', function (e) { e.stopPropagation(); if (isFictional(it)) A.toast('架空サンプルの動画なので再生できません', 'neutral'); else A.openOriginal(it); });
      } else if (src) {
        cell = h('div', { class: 'm', role: 'button', tabindex: '0', 'aria-label': '画像を大きく表示：' + (m.alt || '説明なし') },
          h('img', { src: src, alt: m.alt || '', loading: 'lazy', decoding: 'async', draggable: 'false' }),
          m.alt ? h('span', { class: 'badge-alt', text: 'ALT' }) : null);
        cell.addEventListener('click', function (e) { e.stopPropagation(); A.openViewer(it, media, i); });
        cell.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.stopPropagation(); A.openViewer(it, media, i); } });
      } else {
        // 取得していない画像は、取得していないとそのまま書く
        var st = A.mediaState(m);
        cell = h('div', { class: 'm missing' }, h('div', {},
          icon('image'),
          h('div', { text: st === 'loading' ? '画像を読み込み中…' : st === 'failed' ? '画像を読み込めませんでした' : '画像は未取得です' }),
          m.alt ? h('div', { class: 'muted', text: '説明：' + m.alt }) : null,
          st === 'loading' ? null : isFictional(it)
            ? h('div', { class: 'muted', text: '架空のデータなので読み込みません' })
            : h('button', { onclick: function (e) { e.stopPropagation(); A.loadImage(m, it); } }, st === 'failed' ? 'もう一度' : '画像を読み込む')));
        cell.addEventListener('click', function (e) { e.stopPropagation(); });
      }
      box.appendChild(cell);
    });
    if (opt && opt.small) box.classList.add('small');
    return box;
  }

  /* ---------------- 引用 ---------------- */
  function quoteEl(A, it, q) {
    if (!q) return null;
    var el = h('div', { class: 'quote', role: 'link', tabindex: '0' },
      h('div', { class: 'q-head' }, D.avatar(q.author, 'sm'), h('span', { class: 'nm', text: q.author.name }), h('span', { class: 'hd', text: q.author.handle ? '@' + q.author.handle : '' }),
        q.postedAt ? h('span', { class: 'tm', text: '· ' + D.rel(q.postedAt) }) : null),
      h('div', { class: 'text' }, D.richText(q.text || '（本文は未取得）', handlers(A, it))),
      mediaEl(A, it, q.media, { small: true }));
    el.addEventListener('click', function (e) {
      e.stopPropagation();
      var target = A.byPostId(q.postId);
      if (target) A.openDetail(target.id); else A.toast('引用元の投稿は、あなたのいいねに入っていません', 'neutral');
    });
    return el;
  }

  /* ---------------- リンクカード ---------------- */
  function cardEl(A, it, link) {
    var art = A.articleFor(link);
    var thumb = h('div', { class: 'thumb', text: (link.domain.charAt(0) || '·').toUpperCase() });
    var stText, stCls = '';
    if (art && art.status === 'ok') { stText = '記事を読み込み済み'; stCls = 'ok'; }
    else if (art && art.status === 'sample') { stText = '架空の記事サンプル'; }
    else if (art && (art.status === 'failed' || art.status === 'blocked' || art.status === 'refused')) { stText = '記事を読み込めませんでした'; stCls = 'bad'; }
    else if (A.articleLoading(link)) stText = '記事を読み込み中…';
    else stText = '記事は未取得';
    var el = h('button', { class: 'card', 'aria-label': 'リンク：' + link.title },
      thumb,
      h('div', { class: 'c-body' },
        h('div', { class: 'c-dom', text: link.domain }),
        h('div', { class: 'c-title', text: (art && (art.status === 'ok' || art.status === 'sample') && art.title) || link.title }),
        h('div', { class: 'c-desc', text: art && (art.status === 'ok' || art.status === 'sample') ? art.excerpt || link.description || '' : link.description || '' }),
        h('div', { class: 'c-state ' + stCls }, icon('article'), stText)));
    el.addEventListener('click', function (e) { e.stopPropagation(); A.openExternal(link.url,it); });
    if(G.previews)G.previews.attach(el,A,it,link);
    return el;
  }

  /* ---------------- 操作の列 ---------------- */
  function actsEl(A, it, opt) {
    var u = it.user;
    function b(cls, ic, label, on, fn, title) {
      var el = h('button', { class: 'act ' + cls + (on ? ' on' : ''), 'aria-pressed': on ? 'true' : 'false', title: title || label, 'aria-label': title || label },
        h('span', { class: 'ic' }, icon(ic)), h('span', { class: 'lb', text: label }));
      el.addEventListener('click', function (e) { e.stopPropagation(); fn(e.currentTarget); });
      return el;
    }
    var row = h('div', { class: opt && opt.detail ? 'd-acts' : 'acts', role: 'group', 'aria-label': 'この投稿をどうするか' });
    // 一覧では短い操作名（片手・狭い幅で省略されない長さ）、詳細では言い切りの操作名
    row.appendChild(b('read', u.read ? 'check' : 'eye', u.read ? '既読' : '既読にする', u.read, function () { A.toggleRead(it.id); }, u.read ? '未読に戻す' : '既読にする'));
    row.appendChild(b('note', 'article', u.memo ? 'メモあり' : 'メモ', !!u.memo, function () { A.openDetail(it.id,{focus:'org'}); }, '自分のメモを書く'));
    row.appendChild(b('ext', 'ext', 'Xで開く', false, function () { A.openOriginal(it); }, 'X で元の投稿を開く'));
    return row;
  }

  /* ---------------- タイムラインの 1 件 ---------------- */
  function importContext(it) {
    return it.meta.origin === 'import' ? h('div', { class: 'ctx' }, h('span', {}, icon('intake')), h('span', { class: 'rest' }, h('span', { text: 'JSON から取り込み' }))) : null;
  }

  function postEl(A, it, opt) {
    opt = opt || {};
    var u = it.user, s = it.src;
    var el = h('article', { class: 'post', tabindex: '0', dataset: { id: it.id }, 'aria-label': s.author.name + 'の投稿' });

    // 文脈の行（X の「〜さんがいいねしました」の位置）
    if (!opt.noContext) {
      var ctx = null;
      if (it.meta.missing) ctx = h('div', { class: 'ctx warn' }, h('span', {}, icon('alert')), h('span', { class: 'rest' }, h('span', { text: '取得元で見つかりません（いいね解除か削除の可能性）。あなたの記録は残しています' })));
      else if (!(it.meta.sources && it.meta.sources.like) && it.meta.origin === 'import') ctx = importContext(it);
      if (ctx) el.appendChild(ctx);
    }

    var avCol = h('div', { class: 'avatar-col' }, D.avatar(s.author));
    if (opt.threadLine) avCol.appendChild(h('div', { class: 'thread-line' }));
    el.appendChild(avCol);

    var body = h('div', { class: 'p-body' });
    body.appendChild(h('div', { class: 'p-head' },
      h('span', { class: 'nm', text: s.author.name || '@' + s.author.handle }),
      h('span', { class: 'hd', text: s.author.handle ? '@' + s.author.handle : '' }),
      s.postedAt ? h('span', { class: 'sep', text: '·' }) : null,
      s.postedAt ? h('time', { class: 'tm', datetime: s.postedAt, title: D.full(s.postedAt), text: D.rel(s.postedAt) }) : null,
      h('span', { class: 'grow' }),
      isFictional(it) ? h('span', { class: 'fict', text: it.meta.origin === 'mock' ? 'モック' : '架空' }) : null,
      !u.read ? h('span', { class: 'unread', title: '未読', 'aria-label': '未読' }) : null));
    if (s.replyTo) body.appendChild(h('div', { class: 'reply-to' }, '返信先: ', h('span', { text: '@' + (s.replyTo.handle || '不明') })));
    var tx = s.text || (it.meta.sourceStatus === 'expired' ? '本文は再確認が必要です。開くと1件だけ取得します。' : it.meta.sourceStatus === 'removed' ? '取得元の投稿を確認できません。あなたのメモは残しています。' : it.meta.origin === 'manual' ? '（本文は未取得です。X で開くと読めます）' : '');
    body.appendChild(h('div', { class: 'text' }, D.richText(tx, handlers(A, it))));
    if (tx.length > 240 || tx.split('\n').length > 5) body.appendChild(h('button',{class:'more-text',onclick:stop(function() { A.openDetail(it.id); })},'続きを読む'));
    D.addIf(body, mediaEl(A, it, s.media));
    D.addIf(body, quoteEl(A, it, s.quote));
    var firstLink = G.insight.linksOf(it).filter(G.insight.isArticleLink)[0];
    if (firstLink) body.appendChild(cardEl(A, it, firstLink));

    // 補助の手がかり（スレッド・つながり・ジャンル・タグ）
    if (!opt.compact) {
      var hints = h('div', { class: 'hint-row' });
      var rel = A.relationsOf(it.id);
      var thread = rel.filter(function (r) { return r.kind === 'thread'; }).length;
      var same = rel.filter(function (r) { return r.kind === 'same_article'; }).length;
      var related = rel.filter(function (r) { return r.kind === 'related'; }).length;
      var g = A.genreOf(it);
      hints.appendChild(h('button', { class: 'tagtxt', title: g.manual ? 'あなたが決めたジャンル' : '自動分類', onclick: stop(function () { A.showGenre(g.name); }) }, g.name));
      var topics=A.topicsOf(it), topic=topics.find(function(t) { return t.id===A.state.topic; }) || topics[0];
      if (topic) hints.appendChild(h('button',{class:'topic-hint',title:topic.evidence(it.id),onclick:stop(function() { A.showTopic(topic.id); })},icon('right'),topic.label));
      if (thread+same+related) hints.appendChild(h('button', { class:'related-link',onclick: stop(function () { A.openDetail(it.id, { focus: 'rel' }); }) }, 'つながり ' + (thread+same+related)));
      u.tags.forEach(function (t) { hints.appendChild(h('button', { onclick: stop(function () { A.search('#' + t); }) }, '#' + t)); });
      if (u.memo) hints.appendChild(h('span', { class: 'tagtxt', text: 'メモあり' }));
      body.appendChild(hints);
      body.appendChild(actsEl(A, it));
    }
    el.appendChild(body);

    el.addEventListener('click', function () { A.openDetail(it.id); });
    el.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target === el) A.openDetail(it.id); });
    return el;
  }

  function stop(fn) { return function (e) { e.stopPropagation(); fn(); }; }

  G.posts = { postEl: postEl, mediaEl: mediaEl, quoteEl: quoteEl, cardEl: cardEl, actsEl: actsEl, isFictional: isFictional, handlers: handlers };
})(typeof globalThis !== 'undefined' ? globalThis : this);
