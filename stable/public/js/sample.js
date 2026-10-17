/*
 * margin sample — 架空サンプル（「架空サンプルを入れる」を押したときだけ保存される）
 *
 *  - 人物・投稿・記事・画像はすべて作り話。ハンドルは sample_、記事ドメインは予約語 .example
 *  - 画像はこのフォルダにある SVG（コードで描いた絵）。外から取ってきたものではない
 *  - いいね数・リポスト数などの反応数は持たない（取得していない値は作らない）
 *  - 記事の中身もサンプル。画面では「架空の記事サンプル（取得していません）」と表示する
 */
(function (root) {
  'use strict';
  var M = root.Margin.model;
  var H = 3600e3, D = 24 * H;

  var P = {
    kotoha: { name: '森野ことは', handle: 'sample_kotoha' },
    riku: { name: 'Riku Aoyama', handle: 'sample_riku' },
    natsume: { name: '夏目工房', handle: 'sample_natsume' },
    tidal: { name: 'Tidal Notes', handle: 'sample_tidal' },
    akari: { name: '小野寺 灯', handle: 'sample_akari' },
    dfm: { name: 'Design Field Memo', handle: 'sample_dfm' },
    kuon: { name: '久遠ラボ', handle: 'sample_kuon' },
    mio: { name: '白石みお', handle: 'sample_mio' }
  };

  function img(name, w, h, alt) { return { kind: 'image', local: '/samples/media/' + name + '.svg', w: w, h: h, alt: alt }; }

  // [id末尾, 人, 本文, 投稿(何時間前), いいね(何時間前), オプション]
  var DEF = [
    ['101', P.tidal, 'LLM の評価は、まず手作業で 10 件ラベルを付けるところから始めるのが結局いちばん早い。\n\n指標を先に決めると「測りやすいもの」を測り始めてしまう。10 件眺めると、何が失敗なのかの言葉ができる。', 74, 1, { links: [['research.example', '/small-evals', '小さく始める評価セット設計 — 10件から育てる']], media: [img('chart', 1200, 800, '評価スコアの推移を表す棒グラフ（架空）')] }],
    ['102', P.kotoha, '読みやすい日本語 UI の行間は、本文 1.8 前後・見出し 1.4 前後に落ち着くことが多い。\n\n数字で決めるより「段落の終わりで目が休めるか」で決めている。', 3, 2, { media: [img('type', 1200, 800, '行間を比べた見本（架空）')] }],
    ['103', P.riku, '個人ツールのデータは SQLite の WAL モードで十分すぎる。バックアップは .backup コマンド 1 行。\n同期はあとから考えればいい。まず手元で壊れないこと。', 30, 3, { links: [['dev.example', '/sqlite-for-one', '個人アプリのための SQLite 運用ガイド']] }],
    ['104', P.riku, 'つづき）WAL にすると読み込みが書き込みを待たなくなる。個人ツールでもこの差は体感できる。', 29.5, 3.2, { replyTo: '103' }],
    ['105', P.riku, 'つづき）ただしバックアップ中も書き込みは止まらないので、.backup か VACUUM INTO を使う。ファイルを直接コピーしない。', 29, 3.3, { replyTo: '104', media: [img('terminal', 1200, 750, 'CLI の出力画面（架空）')] }],
    ['106', P.mio, 'これ、うちも同じ構成にした。SQLite で十分。', 6, 4, { quote: '103', links: [['dev.example', '/sqlite-for-one/', '個人アプリのための SQLite 運用ガイド']] }],
    ['107', P.akari, '朝の 30 分だけ「読むだけの時間」を作ったら、いいねした投稿が溜まらなくなった。\n\nコツは、判断（残す？済み？）を読む時間に混ぜないこと。読み終えてから一気に決める。', 9, 5, { media: [img('morning', 1200, 800, '朝の机（架空）')] }],
    ['108', P.dfm, 'ボタンの角丸は全部同じにしない。押せるものは小さく、包むものは大きく。\n入れ子になったら内側は「外側の半径 − 余白」。', 12, 6, { links: [['design.example', '/radius', '角丸の入れ子を整える計算式']], media: [img('radius', 1200, 800, '角丸の入れ子の図（架空）'), img('desk', 1200, 800, '机の上のノート（架空）')] }],
    ['109', P.natsume, '道具を作るときは、最初に「やらないこと」を 3 つ書く。\n機能を足すより、毎日開いても疲れないことの方が大事だった。', 40, 20, { read: true }],
    ['110', P.kuon, 'D2C の LP で離脱が多いのは、ファーストビューより 2 スクロール目。\n約束（コピー）と証拠（実績・レビュー）の順番が逆になっているケースが多い。', 50, 26, { links: [['lp.example', '/second-scroll', '2スクロール目で離脱させない構成チェックリスト']], media: [img('lp', 800, 1000, 'LP の構成図（架空）')], state: 'later', laterHours: 22, tags: ['マーケ'] }],
    ['111', P.tidal, '評価セットは「失敗の種類」ごとに 3 件ずつ集めると、モデルを変えたときの差分が読みやすい。', 100, 48, { state: 'kept', tags: ['評価'], memo: '次の PoC の評価設計で使う。' }],
    ['112', P.kotoha, '和文と欧文の混植では、欧文側をわずかに大きくすると揃って見える。比率は 1.05 前後から試す。', 150, 60, { state: 'kept', tags: ['組版'], memo: '次の LP 案件で本文の欧文サイズを試す。', genre: 'デザイン' }],
    ['113', P.dfm, 'デザイントークンは「名前が意味を表すか」でレビューする。gray-500 ではなく text-muted。', 120, 70, { links: [['design.example', '/tokens', '意味で名付けるデザイントークン']], state: 'later', laterHours: 9 * 24 }],
    ['114', P.akari, '週に一度、残したいいねを 5 分だけ見返す。タグを付け直すより、要らないものを済みにする方が効く。', 200, 90, { state: 'kept', tags: ['習慣'], memo: '日曜の朝にやる。', merged: 2 }],
    ['115', P.mio, '新しいメモアプリを試した。たぶん来月には別のを試している。', 260, 100, { state: 'done' }],
    ['116', P.natsume, '動画で撮ると、作業の手順は文章の 3 倍伝わる。', 36, 28, { media: [{ kind: 'video', local: '/samples/media/video.svg', w: 1280, h: 720, alt: '作業手順の動画のサムネイル（架空）' }], missing: true }]
  ];

  function idOf(tail) { return '91000000000000' + tail; }

  function build(now) {
    var srcs = {};
    var out = [];
    DEF.forEach(function (d) {
      var o = d[5] || {};
      var raw = {
        postId: idOf(d[0]),
        url: 'https://x.com/' + d[1].handle + '/status/' + idOf(d[0]),
        author: d[1],
        text: d[2],
        postedAt: new Date(now - d[3] * H).toISOString(),
        links: (o.links || []).map(function (l) { return { url: 'https://' + l[0] + l[1], title: l[2] }; }),
        media: o.media || [],
        replyTo: o.replyTo ? { postId: idOf(o.replyTo), handle: d[1].handle } : null,
        quote: o.quote && srcs[o.quote] ? srcs[o.quote] : null
      };
      var n = M.normalizeSrc(raw, now, { allowLocalMedia: true });
      if (!n.ok) throw new Error('sample invalid: ' + d[0] + ' ' + n.reason);
      srcs[d[0]] = raw;
      var rec = M.makeItem(n.src, 'sample', now);
      rec.meta.sources = { like: true };
      rec.meta.likedAt = new Date(now - d[4] * H).toISOString();
      rec.meta.merged = o.merged || 0;
      if (o.missing) { rec.meta.missing = true; rec.meta.missingSince = new Date(now - 2 * H).toISOString(); }
      var u = rec.user;
      if (o.read) u.read = true;
      if (o.state) {
        u.state = o.state;
        u.read = true;
        if (o.state === 'later') u.laterUntil = new Date(now + o.laterHours * H).toISOString();
        if (o.state === 'kept' || o.state === 'done') u.decidedAt = new Date(now - (d[4] - 1) * H).toISOString();
      }
      if (o.tags) u.tags = o.tags.slice();
      if (o.memo) u.memo = o.memo;
      if (o.genre) u.genre = o.genre;
      if (o.state || o.tags || o.memo || o.genre || o.read) u.editedAt = new Date(now - D).toISOString();
      out.push(rec);
    });
    return out;
  }

  // 架空の記事サンプル。取得したものではないので status は 'sample'
  function articles(now) {
    var I = root.Margin.insight;
    return [{
      key: I.canonicalUrl('https://dev.example/sqlite-for-one'),
      url: 'https://dev.example/sqlite-for-one',
      status: 'sample',
      fetchedAt: null,
      title: '個人アプリのための SQLite 運用ガイド',
      siteName: 'dev.example（架空）',
      byline: '架空の著者',
      publishedAt: new Date(now - 40 * D).toISOString(),
      excerpt: '個人で使うアプリなら、データベースは SQLite ひとつで足りることが多い。WAL モード、バックアップ、壊れたときの戻し方までを短くまとめる。',
      text: '個人で使うアプリなら、データベースは SQLite ひとつで足りることが多い。サーバーを立てる必要がなく、ファイルひとつを持ち歩ける。\n\nWAL モードにすると、読み込みが書き込みを待たなくなる。設定は PRAGMA journal_mode=WAL; の 1 行で、以後はファイルの横に -wal と -shm が作られる。\n\nバックアップは、動いているデータベースのファイルを直接コピーしない。.backup コマンドか VACUUM INTO で、整合のとれた複製を作る。\n\n最後に、戻せることを確かめる。バックアップから実際に開き直してみるまでが手順である。\n\n（この記事は margin の架空サンプルです。実在の記事を取得したものではありません）',
      words: 0
    }];
  }

  root.Margin.sample = { build: build, articles: articles };
})(typeof globalThis !== 'undefined' ? globalThis : this);
