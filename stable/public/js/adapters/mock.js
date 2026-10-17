/*
 * margin adapters/mock — いいね収集モック（架空データだけを返す取得元）
 *
 *  - 「あなたのいいね一覧」を模した架空のデータ。並びはいいねした順（新しい順）
 *  - モック時計が 12 時間進むと、1 件のいいねが一覧から消える（いいね解除・投稿削除の再現）
 *  - 通信は一切しない。ここで作った架空の投稿を、ページに分けて返すだけ
 *  - 時刻は「モック時計」（実時刻＋手動で進めた分）。6 時間の間隔を実際に待たずに試すため
 *  - 状況（通常・ページ上限・429・401・403・確認要求・取得エラー）を選んで、規則どおり動くかを確かめる
 *  - ハンドルは mock_ で始まり、記事ドメインは .example（実在しない）
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.Margin = root.Margin || {}; root.Margin.mockSource = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var H = 3600e3;
  var STEP = 6 * H;

  var AUTHORS = [
    { name: '架空・森野ことは', handle: 'mock_kotoha' },
    { name: '架空・Riku Aoyama', handle: 'mock_riku' },
    { name: '架空・夏目工房', handle: 'mock_natsume' },
    { name: '架空・Tidal Notes', handle: 'mock_tidal' },
    { name: '架空・小野寺 灯', handle: 'mock_akari' }
  ];
  var TEXTS = [
    ['作業ログは 1 行でいい。続けられる粒度がいちばん強い。', null],
    ['見出しだけ縦書きにすると、和文の LP に落ち着きが出る。', ['zine.example', '/tategaki', '見出しだけ縦書きにするレイアウト']],
    ['ローカルで完結する道具は、壊れたときに自分で直せるのがいい。', null],
    ['検索ボックスは、結果がどこにあるかまで見せると迷わない。', ['design.example', '/search-labels', '検索結果に場所を添える']],
    ['評価セットに「やってほしくない答え」も混ぜておくと差分が読みやすい。', ['research.example', '/negative', '否定例を含む評価セット']],
    ['朝いちばんに「残す」を 5 件だけ見返す。', null],
    ['バックアップは書き出すだけでなく、戻せるかまで試して初めて意味がある。', ['dev.example', '/restore-drill', '復元訓練のすすめ']],
    ['タグは名詞 1 語にそろえると、半年後の自分が探しやすい。', null]
  ];

  function pad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }

  // epoch（モック開始時刻）と現在のモック時刻から、その時点のいいね一覧を「いいねした順（新しい順）」で返す
  function timeline(epoch, now) {
    var likes = [];
    var base = 14;
    for (var i = base; i >= 1; i--) likes.push(make(i, epoch - i * H, epoch, now));
    var steps = Math.min(100, Math.max(0, Math.floor((now - epoch) / STEP)));
    for (var s = 1; s <= steps; s++) {
      for (var j = 0; j < 3; j++) {
        var n = base + (s - 1) * 3 + j + 1;
        likes.push(make(n, epoch + s * STEP - (3 - j) * 10 * 60e3, epoch, now));
      }
    }
    // 12 時間後には 3 番の投稿のいいねが外れている
    if (now >= epoch + 2 * STEP) likes = likes.filter(function (p) { return p._n !== 3; });
    likes.sort(function (a, b) { return b._likedMs - a._likedMs; });
    return likes;
  }

  function make(n, likedMs, epoch, now) {
    // 投稿された時刻は、いいねした時刻より前（古い投稿をあとからいいねすることもある）
    var at = likedMs - ((n * 7) % 5) * 864e5 - ((n * 13) % 9) * H - 15 * 60e3;
    var a = AUTHORS[n % AUTHORS.length];
    var t = TEXTS[n % TEXTS.length];
    var id = '7' + pad(n, 17);           // 架空の投稿 ID（18 桁）
    var text = t[0];
    // 最初の一覧でいちばん新しいいいね（1 番）は、モック時計が 6 時間進むと本文が更新される
    // （次の取得で重複として統合され、取得元の値だけが更新されることの確認用）
    if (n === 1 && now >= epoch + STEP) text += '（投稿者が後から追記：架空）';
    var post = { postId: id, url: 'https://x.com/' + a.handle + '/status/' + id, author: a, text: text, postedAt: new Date(at).toISOString(), likedAt: new Date(likedMs).toISOString(), links: [], _n: n, _likedMs: likedMs };
    if (t[1]) post.links.push({ url: 'https://' + t[1][0] + t[1][1], title: t[1][2] });
    return post;
  }

  var SCENARIOS = {
    ok: { label: '通常', size: 4 },
    full: { label: '全件確認', size: 4, fullCheck: true },
    many: { label: 'ページ上限', size: 2 },
    // 混雑・エラーは 2 ページ目で起こす。差分で 1 ページ目に既知のいいねへ届いて終わらないよう、1 ページ 1 件にする
    r429: { label: '429', size: 1, failAt: 2, status: 429, retryAfter: '32400' },
    r429n: { label: '429（Retry-After なし）', size: 1, failAt: 2, status: 429 },
    a401: { label: '401', size: 4, failAt: 1, status: 401 },
    f403: { label: '403', size: 4, failAt: 1, status: 403 },
    chal: { label: '確認要求', size: 4, failAt: 1, status: 'challenge' },
    err: { label: '取得エラー', size: 1, failAt: 2, status: 'error' }
  };

  /*
   * opts: { epoch, now(): number, scenario }
   */
  function create(opts) {
    var sc = SCENARIOS[opts.scenario] || SCENARIOS.ok;
    return {
      id: 'mock',
      fictional: true,
      connected: true,
      fetchPage: async function (req) {
        if (sc.failAt && req.page >= sc.failAt) {
          if (sc.status === 'error') throw new Error('mock network error');
          var r = { status: sc.status };
          if (sc.retryAfter) r.retryAfter = sc.retryAfter;
          return r;
        }
        var all = timeline(opts.epoch, opts.now());
        var start = 0;
        if (req.cursor) {
          var m = /^before:(\d{1,16})$/.exec(req.cursor);
          if (!m) return { status: 400 };
          var before = Number(m[1]);
          start = all.findIndex(function (p) { return p._likedMs < before; });
          if (start === -1) return { status: 200, posts: [], nextCursor: null };
        }
        var slice = all.slice(start, start + sc.size);
        var more = start + sc.size < all.length;
        var out = slice.map(function (p) { var c = JSON.parse(JSON.stringify(p)); delete c._n; delete c._likedMs; return c; });
        return { status: 200, posts: out, nextCursor: more && slice.length ? 'before:' + slice[slice.length - 1]._likedMs : null };
      }
    };
  }

  return Object.freeze({ create: create, SCENARIOS: SCENARIOS, timeline: timeline, STEP: STEP });
});
