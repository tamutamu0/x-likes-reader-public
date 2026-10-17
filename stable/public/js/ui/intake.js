/*
 * margin ui/intake — 取り込みの画面
 *
 *  - X のいいね（自動取得）：ローカルサーバーの公式API接続を操作する
 *  - いいね収集モック：架空のいいね一覧で、収集の規則（間隔・同時 1 件・ページ上限・429・停止）を確かめる
 *  - 手で追加：あなたがいいねした投稿の URL を 1 件ずつ
 *  - JSON・バックアップ：Mac での承認待ち。ボタンは押せず、ほかの入口もない
 *  - 架空サンプル：押したときだけ入れる。取り除くのも明示操作だけ
 */
(function (root) {
  'use strict';
  var G = root.Margin;
  var S = G.safe, C = G.collector, D = G.dom;
  var h = D.h, icon = D.icon;
  var A = null;
  var running = false;
  var openSection = null;

  function init(app) {
    A = app;
    A.state.intake = { control: null, mock: null, settings: null, log: [] };
    refresh();
  }

  async function refresh() {
    if (!A || !A.repo) return;
    try {
      var r = A.repo;
      A.state.intake = { control: await r.getControl(), mock: await r.getSource('mock'), settings: await r.getMockSettings(), log: await r.getLog('mock') };
    } catch (e) { /* 保存先が使えないときは表示だけ */ }
    if (document.querySelector('.dialog.intake')) draw();
    A.render();
  }

  function mockNow(settings) { return Date.now() + (settings && settings.offsetMs || 0); }

  function open(section) {
    openSection = section || null;
    var dlg = h('div', { class: 'dialog intake', role: 'dialog', 'aria-label': '取り込み' });
    A.showLayer(dlg);
    draw();
    if (section === 'manual') { var f = dlg.querySelector('#manual-url'); if (f) f.focus(); }
  }

  function close() { A.closeLayer(); }

  function draw() {
    var dlg = document.querySelector('.dialog.intake');
    if (!dlg) return;
    var keepScroll = dlg.querySelector('.db') ? dlg.querySelector('.db').scrollTop : 0;
    var ix = A.state.intake || {};
    var control = ix.control || {};
    var st = ix.mock || C.emptyState();
    var set = ix.settings || { scenario: 'ok', offsetMs: 0 };
    var now = mockNow(set);
    dlg.textContent = '';
    if (A.isMobile()) dlg.appendChild(h('div', { class: 'grab' }));
    dlg.appendChild(h('div', { class: 'dh' }, h('button', { class: 'icon-btn', 'aria-label': '閉じる', onclick: close }, icon('close')), h('h2', { text: '取り込み' })));
    var b = h('div', { class: 'db' });

    var xs = A.state.x || {}, xr = G.xSource;
    var cloud = xs.automatic === 'cloud_webhook';
    if (cloud) b.appendChild(h('section', {class:'ix-sec'},h('h3',{text:'本人認証'}),h('p',{text:'本人用リンクで接続したブラウザーだけで使えます。ログインは30日間有効です。'}),h('a',{class:'btn out',href:'/auth/security',text:'ログイン端末の管理'})));
    var reasons = {manual:'手動で停止中',auth:'再接続が必要です',credits:'クレジット不足で停止中',budget:'設定した予算の上限で停止中',rate_limit:'Xの回数制限により待機中',network:'通信できませんでした',request:'Xが取得を受け付けませんでした',disconnected:'接続解除済み'};
    var canSync = xs.connected && !xs.paused && !xs.running && (xs.automatic === 'cloud_webhook' || !xs.nextAllowedAt || Date.parse(xs.nextAllowedAt) <= Date.now());
    async function xa(kind, body) { var r = await xr.action(kind, body); await refresh(); if (r.status === 'ok' && kind === 'sync') A.toast(xs.automatic === 'cloud_webhook' ? '保存済みのいいねを更新しました':'新しいいいね ' + (r.added || 0) + '件を取り込みました'); }
    b.appendChild(h('section', {class:'ix-sec'},
      h('h3', {}, 'X のいいね', h('span',{class:'pill ' + (xs.connected ? 'ok':'off')},h('i'),xs.connected ? '@' + xs.account.handle : '未接続')),
      h('p',{text:xs.connected ? xs.automatic === 'cloud_webhook' ? 'Xでいいねすると、通知を受け取って自動で反映します。Macを閉じていても動きます。画面の更新は保存済みデータだけを読みます。':'1日1回、新しいいいねを自動で取り込みます。既読・メモはそのまま。画面を開き直してもXへの取得は増えません。' : '公式X APIで、あなたのいいねだけを取り込みます。Xへの投稿・いいね解除・DMは行いません。'}),
      xs.reason ? h('p',{class:'warn',role:'status',text:reasons[xs.reason] || '取得を待機しています'}) : null,
      xs.connected && xs.bootstrapImported < xs.bootstrapTarget ? h('p',{role:'status',text:'初回取り込み ' + xs.bootstrapImported + ' / ' + xs.bootstrapTarget + '件'}) : null,
      h('div',{class:'ix-row'},
        !xs.connected ? h('button',{class:'btn blue',disabled:!xs.configured || !xr ? true:null,onclick:function(){xr.connect();}},'X を接続する') : null,
        xs.connected ? h('button',{class:'btn blue',disabled:canSync ? null:true,onclick:function(){xa('sync');}},xs.running ? '取り込み中…':'新着を確認') : null,
        xs.connected ? h('button',{class:'btn out',onclick:function(){xa('pause',{paused:!xs.paused});}},xs.paused ? '自動更新を再開':'自動更新を止める') : null),
      xs.lastSuccessAt ? h('p',{class:'muted',text:(xs.automatic === 'cloud_webhook' ? '購読確認 ':'最終更新 ') + D.short(xs.lastSuccessAt) + '・取り込み済み ' + xs.count + '件' + (xs.nextAllowedAt ? (xs.automatic === 'cloud_webhook' ? '・購読期限 ':'・次回 ') + D.short(xs.nextAllowedAt):'')}) : null,
      !xs.configured ? h('p',{class:'muted',text:'接続設定を準備中です。'}) : null,
      h('details',{class:'rules'},h('summary',{text:'取得範囲・費用・データの扱い'}),
        h('p',{text:xs.automatic === 'cloud_webhook' ? '保存済みの初回1,000件を引き継ぎ、新着は本人のいいね通知で追加します。本文がある通知は取り直さず、著者プロフィールも取得しません。':'初回は過去を最大1,000件まで100件ずつ取り込みます。以後は5件ずつ新着を確認し、取り込み済みの投稿に届いたら終了します。新着は1日最大20件。さらに古い分は100件ずつ追加できます。'}),
        h('p',{text:'Xのクレジットを使います。追加の著者プロフィール取得は行いません。アプリの安全側の予算計算は初回$5・その後は月$1・累計$8で停止し、2027年1月9日以降は取得しません。実際の請求額はXの管理画面で確認してください。'}),
        xs.budget ? h('p',{text:'予算予約額（実際の請求額とは異なります）：今月 $' + xs.budget.monthReservedUsd.toFixed(3) + ' / $1・初回 $' + xs.budget.bootstrapReservedUsd.toFixed(3) + ' / $5'}) : null,
        h('p',{text:xs.automatic === 'cloud_webhook' ? '認証トークンはCloudflare側で暗号化して保存します。投稿本文は本人専用DB、メモ・既読・タグはこの端末に保存します。分類は端末内で行い、外部AIには送りません。通知の料金は未確定のため1件$0.01を暫定予約し、無料残高と予算で購読を停止します。これはXの実単価や厳密な請求上限ではありません。':'認証トークンはこのMacのサーバーだけに暗号化保存します。取得した投稿はこのMacとこのブラウザ内に保存し、他人や外部AIには送りません。分類は端末内で行います。停止・接続解除はここで操作できます。現在の自動更新にはMacとサーバーの起動が必要です。'}),
        h('p',{text:cloud ? '本文は7日で表示用キャッシュから取り除き、必要な投稿を開いた時だけ1件確認します。同じ投稿の再確認は24時間に1回まで。メモと既読は保持します。' : '読んでいる投稿だけを定期的に再確認します。古い本文は7日で表示用キャッシュから取り除き、再び開いた時に1件だけ確認します。削除・閲覧不可の本文は取り除き、あなたのメモと既読は保持します。'}),
        h('div',{class:'ix-row'},
          xs.connected && xs.backfillAvailable ? h('button',{class:'btn out',disabled:xs.paused ? true:null,onclick:function(){xa('backfill');}},'過去のいいねを100件追加') : null,
          xs.connected && xs.automatic !== 'cloud_webhook' ? h('button',{class:'btn out',onclick:function(){ if (confirm('Xの接続を解除し、取得元の本文を端末から取り除きます。あなたのメモと既読の記録は保持します。')) xa('disconnect');}},'接続を解除') : null))));

    // 手で追加
    var f = h('input', { class: 'field', id: 'manual-url', type: 'url', inputmode: 'url', placeholder: 'https://x.com/…/status/…', 'aria-label': 'いいねした投稿の URL', maxlength: String(S.LIMITS.urlChars), enterkeyhint: 'done', autocomplete: 'off' });
    async function add() {
      if (!A.repo) { A.toast('保存先が使えません', 'bad'); return; }
      var r;
      try { r = await A.repo.addManual(f.value, Date.now()); } catch (e) { A.showWriteError(e); return; }
      if (r.status === 'invalid') { A.toast('x.com の投稿 URL を貼ってください', 'bad'); return; }
      if (r.status === 'exists') { A.toast('この投稿はもうあります', 'neutral'); A.closeLayer(); A.openDetail(r.item.id); return; }
      if (r.status === 'full') { A.toast('保存できる件数の上限に達しています', 'bad'); return; }
      // 手で追加したものは「あなたがいいねした投稿」として扱う（あなたの申告）
      await A.reloadAll();
      A.closeLayer();
      A.toast('いいねに追加しました', '');
      A.setView('likes');
    }
    f.addEventListener('keydown', function (e) { if (e.key === 'Enter') add(); });
    b.appendChild(h('section', { class: 'ix-sec' },
      h('h3', {}, 'いいねした投稿を追加'),
      h('p', { text: 'X でいいねした投稿の URL を貼ると、未読に入ります。本文は取得しないので、X で開いて読めます。同じ投稿は 2 回入りません。' }),
      h('div', { class: 'ix-row' }, f, h('button', { class: 'btn blue', onclick: add }, '追加'))));

    // いいね収集モック
    var lr = st.lastRun;
    var lastText = lr ? C.OUTCOME_TEXT[lr.outcome] + '・' + lr.pages + 'ページ・新規' + lr.added + '・重複' + lr.merged + (lr.missing ? '・見つからない' + lr.missing : '') : 'まだありません';
    var rangeText = lr && lr.range ? D.short(lr.range.from) + '〜' + D.short(lr.range.to) + '（いいねした時刻）' + (lr.partial ? '・途中まで' : '') : '—';
    var sel = h('select', { class: 'select', 'aria-label': '状況' });
    Object.keys(G.mockSource.SCENARIOS).forEach(function (k) { var o = h('option', { value: k, text: G.mockSource.SCENARIOS[k].label }); if (k === set.scenario) o.selected = true; sel.appendChild(o); });
    sel.addEventListener('change', async function () { await A.repo.setMockSettings({ scenario: sel.value }); refresh(); });
    var nextOk = !st.nextAllowedAt || Date.parse(st.nextAllowedAt) <= now;
    var leaseOn = st.lease && Date.parse(st.lease.expiresAt) > now;
    var runBtn = h('button', { class: 'btn', disabled: running || control.stopped ? true : null, onclick: run }, running ? '実行中…' : 'モックを実行');
    var logEl = h('ol', { class: 'log', 'aria-live': 'polite' });
    (ix.log || []).slice(-30).reverse().forEach(function (l) { logEl.appendChild(h('li', { class: l.kind }, h('time', { text: D.short(l.at) }), h('span', { text: l.text }))); });
    b.appendChild(h('section', { class: 'ix-sec' },
      h('h3', {}, 'いいね収集モック', h('span', { class: 'pill mock' }, h('i'), '架空データ')),
      h('p', { text: 'X にはつながず、ここで作った架空の「いいね一覧」で、収集の規則どおりに動くかを確かめます。取り込んだものには「モック」と表示されます。' }),
      h('dl', { class: 'kv' },
        h('dt', { text: '状態' }), h('dd', { class: control.stopped ? 'bad' : '', text: control.stopped ? '停止中' : leaseOn ? '実行中' : nextOk ? '実行できます' : '間隔待ち' }),
        h('dt', { text: '最後の成功' }), h('dd', { text: st.lastSuccessAt ? D.short(st.lastSuccessAt) : 'まだありません' }),
        h('dt', { text: '最後の試行' }), h('dd', { text: st.lastAttemptAt ? D.short(st.lastAttemptAt) : '—' }),
        h('dt', { text: '次に実行できる' }), h('dd', { class: nextOk ? '' : 'warn', text: st.nextAllowedAt ? D.short(st.nextAllowedAt) + (nextOk ? '（いま可）' : '') : 'いつでも' }),
        h('dt', { text: '前回の結果' }), h('dd', { class: lr && lr.partial ? 'warn' : '', text: lastText }),
        h('dt', { text: '今回の取得範囲' }), h('dd', { text: rangeText }),
        h('dt', { text: '続きの位置' }), h('dd', { text: st.cursor ? 'あり（次回そこから）' : 'なし' }),
        h('dt', { text: '連続 429' }), h('dd', { text: String(st.consecutive429 || 0) + '回' }),
        h('dt', { text: 'モック時計' }), h('dd', { text: '実時刻 +' + Math.round((set.offsetMs || 0) / 3600e3) + '時間' })),
      h('div', { class: 'ix-row' }, h('label', { class: 'muted', text: '状況' }), sel, runBtn,
        h('button', { class: 'btn out', onclick: async function () { await A.repo.setMockSettings({ offsetMs: (set.offsetMs || 0) + 6 * 3600e3 }); await A.repo.collector.log('mock', '', 'モック時計を 6 時間進めました（実時刻は変わりません）', Date.now()); refresh(); } }, 'モック時計を 6 時間進める'),
        h('button', { class: 'btn out', onclick: async function () { if (!confirm('モックの収集状態（時計・続きの位置・記録）を初めに戻します。取り込んだいいねは消しません。')) return; await A.repo.resetMockSource(); refresh(); } }, 'モックを初めに戻す')),
      h('details', { class: 'rules' }, h('summary', { text: '決めてある規則' }), h('dl', {},
        h('dt', { text: '間隔' }), h('dd', { text: '前回の試行開始から 6 時間以上あける（成功・失敗とも）' }),
        h('dt', { text: '同時実行' }), h('dd', { text: '1 つだけ（タブ間ロックと、10 分で切れる実行中の印）' }),
        h('dt', { text: '1 回の上限' }), h('dd', { text: S.LIMITS.pagesPerRun + ' ページ。続きは位置を覚えて次回' }),
        h('dt', { text: '差分' }), h('dd', { text: '取り込み済みのいいねに届いたら止める（全件確認を除く）' }),
        h('dt', { text: '429' }), h('dd', { text: 'Retry-After と「6 時間×2^(連続回数−1)、上限 48 時間」の長い方まで待つ' }),
        h('dt', { text: '401・403・確認要求' }), h('dd', { text: 'その場で止まり、停止スイッチをオンにする' }),
        h('dt', { text: '見つからないいいね' }), h('dd', { text: '全件確認で見かけなかったものに印を付けるだけ。消さず、あなたの記録はそのまま' }))),
      h('h4', { class: 'log-title', text: '実行の記録（新しい順）' }),
      logEl));

    // JSON・バックアップ（承認ゲートが true のときだけ使える。すべて端末の中で処理し、どこへも送らない）
    b.appendChild(jsonSection());

    // 架空サンプル
    var fictional = 0;
    A.state.items.forEach(function (it) { if (it.meta.origin === 'sample' || it.meta.origin === 'mock') fictional++; });
    b.appendChild(h('section', { class: 'ix-sec' },
      h('h3', {}, '架空サンプル'),
      h('p', { text: '人物・投稿・画像・記事はすべて作り話です。いいね数などの反応数は持っていません。' + (fictional ? 'いま架空データが ' + fictional + '件 あります。' : '') }),
      h('div', { class: 'ix-row' },
        h('button', { class: 'btn out', onclick: insertSample }, '架空サンプルを入れる'),
        h('button', { class: 'btn out', disabled: fictional ? null : true, onclick: removeFictional }, '架空データを取り除く'))));

    dlg.appendChild(b);
    b.scrollTop = keepScroll;
  }

  /* ------------------------------------------------------------ JSON 取り込み・バックアップ */

  var jx = { phase: 'idle' };   // idle | reading | preview | applying | done | error
  var REASON = { not_object: '形が不正', unsafe_id: 'ID が不正', bad_id: 'ID が不正', not_x_post: 'X の投稿ではない', id_mismatch: 'ID と URL が食い違う', no_id: 'ID がない', duplicate_in_file: 'ファイル内で重複' };

  function jsonSection() {
    var ok = G.approvals && G.approvals.jsonFileIO === true;
    var sec = h('section', { class: 'ix-sec', id: 'ix-json' },
      h('h3', {}, 'JSON ファイル・バックアップ', ok ? h('span', { class: 'pill ok' }, h('i'), '使えます') : h('span', { class: 'pill off' }, h('i'), '承認待ち')));
    if (!ok) {
      sec.appendChild(h('div', { class: 'gate' }, icon('alert'), h('div', { text: G.approvals.jsonFileIONote + '。承認が済むまで、ファイルの選択・読み込み・解析・保存（バックアップの書き出しを含む）はできません。貼り付けなどの別の入口もありません。' })));
      sec.appendChild(h('div', { class: 'ix-row' },
        h('button', { class: 'btn out', disabled: true, 'aria-disabled': 'true' }, 'JSON を読み込む'),
        h('button', { class: 'btn out', disabled: true, 'aria-disabled': 'true' }, 'バックアップを書き出す')));
      return sec;
    }
    sec.appendChild(h('p', { text: '対応するのは margin のバックアップ（margin-backup v1）と margin の投稿一覧（margin-items v1）だけです。旧版の形式や X 公式のエクスポート形式には対応していません。ファイルはこの端末の中だけで読み、どこへも送りません。' }));
    var busy = jx.phase === 'reading' || jx.phase === 'applying';
    sec.appendChild(h('div', { class: 'ix-row' },
      h('button', { class: 'btn out', disabled: busy || jx.phase === 'preview' ? true : null, onclick: pickJson }, 'JSON を読み込む'),
      h('button', { class: 'btn out', disabled: busy ? true : null, onclick: exportBackup }, 'バックアップを書き出す')));

    if (jx.phase === 'reading') {
      sec.appendChild(h('div', { class: 'jx-box' }, h('div', { class: 'jx-line' }, h('div', { class: 'spin' }), h('span', { text: '「' + jx.fileName + '」を読んでいます' + (jx.progress ? '（' + jx.progress + '）' : '') + '…' })),
        h('button', { class: 'btn out sm', onclick: function () { if (jx.ac) jx.ac.abort(); } }, '中止')));
    } else if (jx.phase === 'preview') {
      var st = jx.parsed.stats, pl = jx.plan;
      var reasons = {};
      jx.parsed.rejected.forEach(function (r) { var k = REASON[r.reason] || r.reason; reasons[k] = (reasons[k] || 0) + 1; });
      var box = h('div', { class: 'jx-box', role: 'region', 'aria-label': '取り込みの確認' },
        h('div', { class: 'jx-title', text: '「' + jx.fileName + '」の中身（まだ保存していません）' }),
        h('dl', { class: 'kv' },
          h('dt', { text: '形式' }), h('dd', { text: jx.parsed.format + ' v1' }),
          h('dt', { text: '件数' }), h('dd', { text: st.total + '件（受け入れ ' + st.accepted + '・弾いた ' + st.rejected + '）' }),
          h('dt', { text: '新しく追加' }), h('dd', { text: pl.add.length + '件' }),
          h('dt', { text: '本文などを更新' }), h('dd', { text: pl.updateSrc.length + '件（あなたの編集はそのまま）' }),
          h('dt', { text: '変化なし' }), h('dd', { text: pl.unchanged.length + '件' }),
          pl.userRestored ? h('dt', { text: '既読・メモを復元' }) : null, pl.userRestored ? h('dd', { text: pl.userRestored + '件（この端末でまだ編集していない投稿だけ）' }) : null,
          pl.userKept ? h('dt', { text: '手元の編集を優先' }) : null, pl.userKept ? h('dd', { class: 'warn', text: pl.userKept + '件（ファイル側の既読・タグ・メモは使いません）' }) : null,
          st.secretKeys ? h('dt', { text: '秘密に見える項目' }) : null, st.secretKeys ? h('dd', { class: 'warn', text: st.secretKeys + '個（値は読み込みません）' }) : null,
          st.linksDropped ? h('dt', { text: '捨てたリンク' }) : null, st.linksDropped ? h('dd', { class: 'warn', text: st.linksDropped + '個（安全でない URL など）' }) : null,
          Object.keys(reasons).length ? h('dt', { text: '弾いた理由' }) : null, Object.keys(reasons).length ? h('dd', { text: Object.keys(reasons).map(function (k) { return k + ' ' + reasons[k]; }).join('・') }) : null),
        h('div', { class: 'ix-row' },
          h('button', { class: 'btn blue', disabled: pl.add.length + pl.updateSrc.length ? null : true, onclick: applyJson }, pl.add.length + pl.updateSrc.length ? '反映する（' + (pl.add.length + pl.updateSrc.length) + '件）' : '反映するものはありません'),
          h('button', { class: 'btn out', onclick: function () { jx = { phase: 'idle' }; draw(); } }, 'やめる')));
      sec.appendChild(box);
    } else if (jx.phase === 'applying') {
      sec.appendChild(h('div', { class: 'jx-box' }, h('div', { class: 'jx-line' }, h('div', { class: 'spin' }), h('span', { text: '保存しています…' }))));
    } else if (jx.phase === 'done' || jx.phase === 'error') {
      var cls = jx.phase === 'error' ? 'jx-box bad' : 'jx-box ok';
      sec.appendChild(h('div', { class: cls, role: jx.phase === 'error' ? 'alert' : 'status' }, h('div', { class: 'jx-line' }, icon(jx.phase === 'error' ? 'alert' : 'check'), h('span', { text: jx.message })),
        jx.undo ? h('div', { class: 'ix-row' }, h('button', { class: 'btn out sm', onclick: undoJson }, 'この取り込みを取り消す'), h('button', { class: 'btn out sm', onclick: function () { jx = { phase: 'idle' }; draw(); } }, '閉じる'))
          : h('div', { class: 'ix-row' }, h('button', { class: 'btn out sm', onclick: function () { jx = { phase: 'idle' }; draw(); } }, '閉じる'))));
    }
    if (jx.lastBackup) sec.appendChild(h('p', { class: 'jx-note', text: jx.lastBackup }));
    return sec;
  }

  function pickJson() {
    if (!(G.approvals && G.approvals.jsonFileIO === true)) return;   // ゲートが閉じていれば何もしない
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'application/json,.json';
    inp.hidden = true;
    document.body.appendChild(inp);
    inp.addEventListener('change', function () { var f = inp.files && inp.files[0]; inp.remove(); if (f) readJson(f); });
    inp.addEventListener('cancel', function () { inp.remove(); });
    inp.click();
  }

  async function readJson(file) {
    var max = S.LIMITS.jsonBytes;
    if (file.size > max) { jx = { phase: 'error', message: '「' + file.name + '」は大きすぎます（' + Math.ceil(file.size / 1048576) + 'MB。上限 20MB）。何も保存していません。' }; draw(); return; }
    var ac = new AbortController();
    jx = { phase: 'reading', fileName: S.cleanText(file.name, 80), ac: ac };
    draw();
    try {
      var text = await file.text();                                   // 端末の中で読むだけ
      var parsed = await G.jsonio.parseImport(text, { signal: ac.signal, onProgress: function (d, t) { jx.progress = d + ' / ' + t; draw(); } });
      var batchId = 'imp-' + Date.now().toString(36);
      var plan = await A.repo.planImport(parsed, Date.now(), batchId);
      if (ac.signal.aborted) throw Object.assign(new Error('aborted'), { code: 'aborted' });
      jx = { phase: 'preview', fileName: jx.fileName, parsed: parsed, plan: plan };
    } catch (e) {
      var msg = (e && e.code && G.jsonio.MESSAGES[e.code]) || '読み込めませんでした';
      jx = { phase: 'error', message: '「' + jx.fileName + '」：' + msg + (e && e.code === 'aborted' ? '' : '。何も保存していません。') };
    }
    draw();
  }

  async function applyJson() {
    var plan = jx.plan, name = jx.fileName;
    jx = { phase: 'applying', fileName: name };
    draw();
    try {
      var batch = await A.repo.applyImport(plan, Date.now());
      await A.reloadAll();
      A.render();
      jx = { phase: 'done', undo: batch.id, message: '「' + name + '」を反映しました：追加 ' + batch.added.length + '件・更新 ' + batch.updated.length + '件。' };
    } catch (e) {
      jx = { phase: 'error', message: '保存できませんでした（' + (e && e.code === 'full' ? '保存できる件数の上限です' : e && e.code === 'quota' ? '空き容量が足りません' : '書き込みに失敗しました') + '）。何も反映していません。' };
    }
    draw();
  }

  async function undoJson() {
    var id = jx.undo;
    try {
      var r = await A.repo.undoImport(id, Date.now());
      await A.reloadAll();
      A.render();
      jx = r.status === 'ok'
        ? { phase: 'done', message: '取り消しました：取り除いた ' + r.removed.length + '件・元に戻した ' + r.restored.length + '件' + (r.keptEdited.length ? '・あなたが触った ' + r.keptEdited.length + '件は残しました' : '') + '。' }
        : { phase: 'error', message: 'この取り込みはもう取り消されています。' };
    } catch (e) {
      jx = { phase: 'error', message: '取り消しを保存できませんでした。何も変えていません。' };
    }
    draw();
  }

  async function exportBackup() {
    if (!(G.approvals && G.approvals.jsonFileIO === true)) return;
    try {
      var now = Date.now();
      var data = await A.repo.buildBackup(now);
      var blob = new Blob([G.jsonio.serialize(data)], { type: 'application/json' });
      var d = new Date(now);
      var name = 'margin-backup-' + d.getFullYear() + D.pad(d.getMonth() + 1) + D.pad(d.getDate()) + '-' + D.pad(d.getHours()) + D.pad(d.getMinutes()) + '.json';
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = name; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      jx.lastBackup = '「' + name + '」を書き出しました（' + data.count + '件）。保存先はブラウザのダウンロード設定に従います。';
    } catch (e) {
      jx.lastBackup = 'バックアップを作れませんでした（保存先を読めませんでした）。';
    }
    draw();
  }

  async function run() {
    if (running) return;
    var set = await A.repo.getMockSettings();
    if (!set.epoch) set = await A.repo.setMockSettings({ epoch: Date.now() });
    running = true;
    draw();
    var transport = G.mockSource.create({ epoch: set.epoch, now: function () { return mockNow(set); }, scenario: set.scenario });
    var withLock = (navigator.locks && navigator.locks.request)
      ? function (fn) { return navigator.locks.request('margin-collect-mock', { ifAvailable: true }, function (lock) { return lock ? fn() : null; }); }
      : null;
    var res;
    try {
      res = await C.run({ repo: A.repo.collector, transport: transport, now: function () { return mockNow(set); }, owner: A.repo.tabId, withLock: withLock, fullCheck: !!G.mockSource.SCENARIOS[set.scenario].fullCheck });
    } catch (e) {
      A.showWriteError(e);
    }
    running = false;
    await A.reloadAll();
    await refresh();
    if (res) A.toast(res.refused ? res.text : 'モック：' + res.text, res.refused || res.outcome !== 'complete' ? 'bad' : '');
  }

  async function insertSample() {
    if (!A.repo) { A.toast('保存先が使えません', 'bad'); return; }
    var now = Date.now();
    try {
      var r = await A.repo.insertSample(G.sample.build(now));
      var arts = G.sample.articles(now);
      for (var i = 0; i < arts.length; i++) {
        var cur = await A.repo.getArticles([arts[i].key]);
        if (!cur.length) await A.repo.saveArticle(arts[i]);
      }
      await A.reloadAll();
      A.closeLayer();
      A.setView('likes');
      A.toast(r.added ? '架空サンプルを ' + r.added + '件 入れました' : '架空サンプルはもう入っています', 'neutral');
    } catch (e) { A.showWriteError(e); }
  }

  async function removeFictional() {
    if (!confirm('架空サンプルとモックで取り込んだいいねを取り除きます。あなたが追加・取り込んだものには触れません。よろしいですか？')) return;
    try {
      var r = await A.repo.removeFictional();
      await A.reloadAll();
      A.closeLayer();
      A.setView('likes');
      A.toast('架空データを ' + r.removed + '件 取り除きました', 'neutral');
    } catch (e) { A.showWriteError(e); }
  }

  G.intake = { init: init, open: open, refresh: refresh, insertSample: insertSample };
})(typeof globalThis !== 'undefined' ? globalThis : this);
