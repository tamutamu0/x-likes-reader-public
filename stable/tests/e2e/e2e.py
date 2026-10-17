"""
margin ブラウザ検証（Playwright / Chromium）。サンドボックスでの実操作検証に使ったスクリプト。

  1. node tests/e2e/harness.mjs 47322   … 試験用の宛先規則で起動（架空の記事ページを 127.0.0.1 に置く）
  2. node server.mjs                     … 本番の規則で起動（47321）
  3. python3 tests/e2e/e2e.py <harness の fixturePort> <出力フォルダ>

Mac での確認には不要（docs/VERIFICATION.md の手順で手で確認できる）。
"""
import json, sys, time, re, pathlib
from playwright.sync_api import sync_playwright, expect

FP = int(sys.argv[1])
OUT = pathlib.Path(sys.argv[2]); OUT.mkdir(parents=True, exist_ok=True)
SHOT = OUT / 'screenshots'; SHOT.mkdir(exist_ok=True)
APP = 'http://127.0.0.1:47322/'
REAL = 'http://127.0.0.1:47321/'
results = []
external = []
console_errors = []

def check(name, cond, detail=''):
    results.append({'name': name, 'ok': bool(cond), 'detail': str(detail)[:300]})
    print(('OK   ' if cond else 'FAIL ') + name + ((' — ' + str(detail)[:160]) if detail else ''))

def watch(page, tag):
    def on_req(r):
        u = r.url
        if not (u.startswith('http://127.0.0.1:47322/') or u.startswith('http://127.0.0.1:47321/') or u.startswith('blob:') or u.startswith('data:')):
            external.append(tag + ' ' + u)
    page.on('request', on_req)
    page.on('console', lambda m: console_errors.append(tag + ' ' + m.text) if m.type == 'error' and 'favicon' not in m.text else None)
    page.on('pageerror', lambda e: console_errors.append(tag + ' PAGEERROR ' + str(e)))

def clear_toast(p):
    p.evaluate("document.getElementById('toasts').textContent=''")
    p.wait_for_timeout(120)

def shot(p, name, full=False):
    clear_toast(p)
    p.screenshot(path=str(SHOT / (name + '.png')), full_page=full)

def no_overflow(p, label):
    w = p.evaluate("[document.documentElement.scrollWidth, window.innerWidth]")
    check(label + '：横にはみ出さない', w[0] <= w[1], w)

def posts(p):
    return p.locator('#main article.post').count()

with sync_playwright() as pw:
    b = pw.chromium.launch()

    # ------------------------------------------------------------ スマホ 390
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=3, is_mobile=True, has_touch=True, locale='ja-JP', timezone_id='Asia/Tokyo')
    p = ctx.new_page(); watch(p, 'sp390')
    p.goto(APP); p.wait_for_selector('.empty h2')
    check('起動時は空（架空サンプルは自動で入らない）', posts(p) == 0 and 'あなたのいいねを' in p.inner_text('.empty h2'))
    shot(p, 'sp390-01-empty')
    no_overflow(p, '390 空の状態')
    p.get_by_role('button', name='架空サンプルで試す').click()
    p.wait_for_selector('#main article.post')
    n0 = posts(p)
    check('明示操作で架空サンプルが入る', n0 > 5, n0)
    check('架空の印が付く', p.locator('.p-head .fict').count() >= n0)
    shot(p, 'sp390-02-timeline')
    no_overflow(p, '390 タイムライン')

    # スクロール位置の復元（ヘッダーの戻る・端末の戻る）
    p.evaluate("window.scrollTo(0, 1600)"); p.wait_for_timeout(250)
    y0 = p.evaluate("window.scrollY")
    pid = p.evaluate("(() => { const els=[...document.querySelectorAll('#main article.post')]; const e=els.find(x=>{const r=x.getBoundingClientRect(); return r.top>80 && r.top<500}); return e && e.dataset.id })()")
    p.locator(f'article.post[data-id="{pid}"] .text').first.click()
    p.wait_for_selector('.detail')
    check('投稿を開くと詳細になる（URL に履歴が積まれる）', '#post/' in p.url, p.url)
    check('詳細ではタブの代わりに下の操作（あとで・済み・残す）', p.locator('.dock').is_visible() and not p.locator('#tabbar').is_visible())
    p.get_by_role('button', name='戻る').first.click(); p.wait_for_timeout(400)
    y1 = p.evaluate("window.scrollY")
    check('戻るでスクロール位置が戻る（ヘッダーの戻る）', abs(y1 - y0) <= 4, (y0, y1))
    p.locator(f'article.post[data-id="{pid}"] .text').first.click(); p.wait_for_selector('.detail')
    p.go_back(); p.wait_for_timeout(400)
    y2 = p.evaluate("window.scrollY")
    check('戻るでスクロール位置が戻る（端末の戻る）', abs(y2 - y0) <= 4 and p.locator('article.detail').count() == 0, (y0, y2))

    # 済みにする → 取り消す
    p.evaluate("window.scrollTo(0,0)"); p.wait_for_timeout(150)
    first = p.locator('#main article.post').first
    fid = first.get_attribute('data-id')
    first.locator('.act.done').click(); p.wait_for_timeout(500)
    gone = p.locator(f'#main article.post[data-id="{fid}"]').count() == 0
    check('済みにすると未読一覧から外れる', gone)
    check('取り消しの案内が出る', p.locator('.toast button', has_text='取り消す').is_visible())
    shot(p, 'sp390-03-done-undo-toast') if False else None
    p.locator('.toast button', has_text='取り消す').click(); p.wait_for_timeout(400)
    check('取り消すと戻る', p.locator(f'#main article.post[data-id="{fid}"]').count() == 1)

    # あとで（ボトムシート）
    first = p.locator('#main article.post').first
    lid = first.get_attribute('data-id')
    first.locator('.act.later').click(); p.wait_for_selector('.menu.as-sheet')
    shot(p, 'sp390-04-later-sheet')
    p.locator('.menu .mi', has_text='明日の朝').click(); p.wait_for_timeout(500)
    p.locator('#tabbar button', has_text='あとで').click(); p.wait_for_timeout(300)
    check('あとでに入り、日時が出る', p.locator(f'#main article.post[data-id="{lid}"]').count() == 1 and '明日' in p.inner_text('#main'))
    shot(p, 'sp390-05-later')
    p.locator('#tabbar button', has_text='いいね').click(); p.wait_for_timeout(300)

    # 詳細で整理：タグ・メモ・ジャンル → 再読み込みで残る
    target = 'x:91000000000000107'
    p.evaluate(f"Margin.app.openDetail('{target}')"); p.wait_for_selector('.detail')
    p.locator('.tag-input').fill('e2e'); p.locator('.tag-input').press('Enter'); p.wait_for_timeout(300)
    p.locator('textarea.memo').fill('E2E のメモ：読んだら試す'); p.wait_for_timeout(1000)
    p.locator('.genre-row .btn', has_text='変更').click(); p.locator('.genre-pick button', has_text='デザイン').click(); p.wait_for_timeout(400)
    shot(p, 'sp390-06-detail-organize')
    p.reload(); p.wait_for_selector('.detail')
    check('再読み込み後も詳細が開いたまま（URL から復元）', p.locator('article.detail').count() == 1)
    txt = p.inner_text('#main')
    check('再読み込み後もタグが残る', '#e2e' in txt)
    check('再読み込み後もメモが残る', p.locator('textarea.memo').input_value() == 'E2E のメモ：読んだら試す')
    check('再読み込み後もジャンル（あなたの指定）が残る', p.locator('.genre-chip.manual').inner_text() == 'デザイン')
    check('詳細を開くと既読になる', p.evaluate(f"Margin.app.state.items.get('{target}').user.read") is True)

    # タグで検索
    p.locator('.tag .t', has_text='#e2e').click(); p.wait_for_timeout(300)
    check('タグを押すと、いいねの中から検索', p.locator('#main h1').inner_text() == '検索' and posts(p) == 1)
    shot(p, 'sp390-07-tag-search')
    p.get_by_role('button', name='戻る').first.click(); p.wait_for_timeout(300)

    # 手で追加 → リンクを貼る → 記事を読み込む（試験用の架空ページ）
    p.locator('.brand-btn').click(); p.wait_for_selector('.dialog.intake')
    check('JSON の読み込み・書き出しは押せない（承認待ち）', p.locator('.dialog button', has_text='JSON を読み込む').is_disabled() and p.locator('.dialog button', has_text='バックアップを書き出す').is_disabled())
    check('X のいいねは未接続と表示', '未接続' in p.inner_text('.dialog'))
    shot(p, 'sp390-08-intake')
    p.locator('#manual-url').fill('https://twitter.com/fic_e2e/status/424242?s=20')
    p.locator('.dialog button', has_text='追加').first.click(); p.wait_for_timeout(500)
    p.evaluate("Margin.app.openDetail('x:424242')"); p.wait_for_selector('.detail')
    p.locator('.add-link .field').fill(f'http://article.fic:{FP}/redirect?utm_source=x&auth_token=SECRET')
    p.locator('.add-link .btn').click(); p.wait_for_timeout(300)
    stored = p.evaluate("Margin.app.state.items.get('x:424242').user.links[0].url")
    check('貼ったリンクから秘密・追跡クエリを除く', 'SECRET' not in stored and 'utm_source' not in stored, stored)
    title_before = p.title()
    p.locator('.article .btn', has_text='記事を読み込む').click()
    p.wait_for_selector('.a-status.ok', timeout=15000)
    body = p.inner_text('.article')
    check('記事を読み込み、タイトル・出典・本文を表示', '架空の記事：ローカルで読むためのリーダー設計' in body and '架空テックノート' in body, body[:120])
    check('取得状態（読み込み済み・日時・字数）を表示', '読み込み済み' in body)
    p.locator('.article .btn', has_text='本文をすべて表示').click(); p.wait_for_timeout(200)
    body = p.inner_text('.article')
    check('記事の中の注入文はただの文字として表示', '注入文' in body)
    check('記事のスクリプトは動かない（タイトルが変わらない・alert なし）', p.title() == title_before and 'alert' not in body and 'スクリプトが動いた' not in body)
    shot(p, 'sp390-09-article-loaded')
    p.locator('.add-link .field').fill(f'http://article.fic:{FP}/wall'); p.locator('.add-link .btn').click(); p.wait_for_timeout(2300)
    p.locator('.article >> nth=1').locator('.btn', has_text='記事を読み込む').click(); p.wait_for_selector('.article >> nth=1 >> .a-status.bad', timeout=15000)
    check('確認画面のページは「読めなかった」と表示（迂回しない）', '確認' in p.inner_text('.article >> nth=1'))
    p.locator('.add-link .field').fill(f'http://article.fic:{FP}/to-private'); p.locator('.add-link .btn').click(); p.wait_for_timeout(2300)
    p.locator('.article >> nth=2').locator('.btn', has_text='記事を読み込む').click(); p.wait_for_selector('.article >> nth=2 >> .a-status.bad', timeout=15000)
    check('非公開アドレスへの転送は拒否', '読み込みを断りました' in p.inner_text('.article >> nth=2'), p.inner_text('.article >> nth=2')[:120])
    p.reload(); p.wait_for_selector('.detail')
    check('記事の取得結果も保存される（再読み込み後も）', p.locator('.a-status.ok').count() == 1 and p.locator('.a-status.bad').count() == 2)

    # 複数タブ
    p2 = ctx.new_page(); watch(p2, 'sp390-tab2')
    p2.goto(APP + '#post/' + 'x%3A91000000000000108'); p2.wait_for_selector('.detail')
    p.evaluate("Margin.app.closeDetail()"); p.wait_for_timeout(200)
    p.evaluate("Margin.app.repo.patchUser('x:91000000000000108', {memo: ''}, {memo: '別のタブで書いたメモ'}, Date.now())")
    p2.wait_for_timeout(600)
    check('別のタブの変更が届く（BroadcastChannel）', p2.evaluate("Margin.app.state.items.get('x:91000000000000108').user.memo") == '別のタブで書いたメモ')
    # 競合：タブ2で書き始めた後に、タブ1が同じメモを保存
    p2.reload(); p2.wait_for_selector('textarea.memo')
    p2.locator('textarea.memo').click(); p2.keyboard.type('タブ2の追記')
    p.evaluate("Margin.app.repo.patchUser('x:91000000000000108', {memo: '別のタブで書いたメモ'}, {memo: 'タブ1が先に保存'}, Date.now())")
    p2.wait_for_timeout(1400)
    check('同じメモの競合を検出し、入力を残して知らせる', '別のタブでメモが変わりました' in p2.inner_text('#sec-org') and 'タブ2の追記' in p2.locator('textarea.memo').input_value(), p2.inner_text('#sec-org')[-120:])
    shot(p2, 'sp390-10-conflict')
    p2.close()

    # 保存の失敗
    p.evaluate("window.scrollTo(0,0)")
    first = p.locator('#main article.post').first
    sid = first.get_attribute('data-id')
    p.evaluate("(() => { window.__put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function () { throw new DOMException('simulated', 'QuotaExceededError'); }; return true; })()")
    first.locator('.act.keep').click(); p.wait_for_timeout(600)
    check('保存に失敗したら正直に表示', '保存できませんでした' in p.inner_text('#main'))
    shot(p, 'sp390-11-save-error')
    p.evaluate("(() => { IDBObjectStore.prototype.put = window.__put; return true; })()")
    p.reload(); p.wait_for_selector('#main article.post')
    check('失敗した変更は反映されていない', p.evaluate(f"Margin.app.state.items.get('{sid}').user.state") == 'inbox')

    # まとまり・残す
    p.locator('#tabbar button', has_text='まとまり').click(); p.wait_for_timeout(300)
    shot(p, 'sp390-12-topics')
    p.locator('.tabs button', has_text='同じ記事・関連').click(); p.wait_for_timeout(200)
    shot(p, 'sp390-13-groups')
    check('同じ記事のまとまりに根拠が付く', '同じ記事' in p.inner_text('#main'))
    p.locator('#tabbar button', has_text='残す').click(); p.wait_for_timeout(300)
    shot(p, 'sp390-14-keep')
    no_overflow(p, '390 残す')
    p.locator('#tabbar button', has_text='いいね').click(); p.wait_for_timeout(300)
    p.evaluate("Margin.app.openDetail('x:91000000000000103')"); p.wait_for_selector('.detail'); p.wait_for_timeout(200)
    shot(p, 'sp390-15-detail')
    p.evaluate("document.getElementById('sec-rel').scrollIntoView()"); p.wait_for_timeout(200)
    shot(p, 'sp390-16-relations')
    p.evaluate("Margin.app.openDetail('x:91000000000000108')"); p.wait_for_selector('.detail')
    p.locator('.detail .m').first.click(); p.wait_for_selector('.viewer')
    shot(p, 'sp390-17-media')
    p.keyboard.press('Escape')
    p.evaluate("Margin.app.openDetail('x:91000000000000106')"); p.wait_for_selector('.detail'); p.wait_for_timeout(200)
    shot(p, 'sp390-18-quote')
    no_overflow(p, '390 詳細')
    ctx.close()

    # ------------------------------------------------------------ スマホ 320
    ctx = b.new_context(viewport={'width': 320, 'height': 640}, device_scale_factor=3, is_mobile=True, has_touch=True, locale='ja-JP', timezone_id='Asia/Tokyo')
    p = ctx.new_page(); watch(p, 'sp320')
    p.goto(APP); p.wait_for_selector('.empty')
    no_overflow(p, '320 空の状態')
    p.get_by_role('button', name='架空サンプルで試す').click(); p.wait_for_selector('#main article.post')
    no_overflow(p, '320 タイムライン')
    shot(p, 'sp320-01-timeline')
    p.evaluate("window.scrollTo(0, 1200)"); p.wait_for_timeout(200)
    y0 = p.evaluate("window.scrollY")
    pid = p.evaluate("(() => { const e=[...document.querySelectorAll('#main article.post')].find(x=>{const r=x.getBoundingClientRect(); return r.top>60 && r.top<400}); return e && e.dataset.id })()")
    p.locator(f'article.post[data-id="{pid}"] .text').first.click(); p.wait_for_selector('.detail')
    no_overflow(p, '320 詳細')
    shot(p, 'sp320-02-detail')
    p.go_back(); p.wait_for_timeout(400)
    check('320：戻るでスクロール位置が戻る', abs(p.evaluate("window.scrollY") - y0) <= 4)
    p.evaluate("window.scrollTo(0,0)")
    first = p.locator('#main article.post').first; fid = first.get_attribute('data-id')
    first.locator('.act.done').click(); p.wait_for_timeout(500)
    p.locator('.toast button', has_text='取り消す').click(); p.wait_for_timeout(400)
    check('320：済み → 取り消す', p.locator(f'#main article.post[data-id="{fid}"]').count() == 1)
    btn = p.locator('#main article.post').first.locator('.act.later .ic').bounding_box()
    check('320：操作ボタンは 40×44 以上', btn['width'] >= 39.5 and btn['height'] >= 43.5, btn)
    p.locator('#main article.post').nth(1).locator('.hint-row button', has_text='#').first.click() if p.locator('#main article.post').nth(1).locator('.hint-row button', has_text='#').count() else None
    p.evaluate("Margin.app.search('#マーケ')"); p.wait_for_timeout(200)
    check('320：タグ検索', p.locator('#main h1').inner_text() == '検索')
    no_overflow(p, '320 検索')
    p.evaluate("Margin.app.search('')")
    p.locator('.brand-btn').click(); p.wait_for_selector('.dialog.intake')
    no_overflow(p, '320 取り込み')
    shot(p, 'sp320-03-intake')
    p.keyboard.press('Escape')
    p.evaluate("Margin.app.openDetail('x:91000000000000103')"); p.wait_for_selector('.detail')
    p.locator('.tag-input').focus(); p.wait_for_timeout(150)
    check('320：入力中は下の固定ボタンを隠す（キーボードと重ならない）', not p.locator('.dock').is_visible())
    p.locator('.tag-input').blur()
    ctx.close()

    # ------------------------------------------------------------ PC 1440
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}, device_scale_factor=2, locale='ja-JP', timezone_id='Asia/Tokyo')
    p = ctx.new_page(); watch(p, 'pc')
    p.goto(APP); p.wait_for_selector('.empty')
    shot(p, 'pc-01-empty')
    p.get_by_role('button', name='架空サンプルで試す').click(); p.wait_for_selector('#main article.post')
    shot(p, 'pc-02-timeline')
    # キーボード
    p.keyboard.press('j'); p.keyboard.press('j'); p.keyboard.press('Enter'); p.wait_for_selector('.detail')
    check('PC：j / Enter で開ける', p.locator('article.detail').count() == 1)
    p.keyboard.press('Escape'); p.wait_for_timeout(200)
    p.evaluate("Margin.app.openDetail('x:91000000000000103')"); p.wait_for_selector('.detail')
    shot(p, 'pc-03-detail')
    p.evaluate("document.getElementById('sec-rel').scrollIntoView()"); p.wait_for_timeout(200)
    shot(p, 'pc-04-relations')
    p.evaluate("Margin.app.closeDetail()"); p.wait_for_timeout(200)
    p.locator('.nav-item', has_text='まとまり').click(); p.wait_for_timeout(200)
    shot(p, 'pc-05-topics')
    p.locator('.nav-item', has_text='あとで').click(); p.wait_for_timeout(200)
    shot(p, 'pc-06-later')
    p.locator('.nav-item', has_text='残す').click(); p.wait_for_timeout(200)
    shot(p, 'pc-07-keep')
    # 収集モック
    p.locator('.cta').click(); p.wait_for_selector('.dialog.intake')
    p.locator('.dialog select').select_option('ok'); p.wait_for_timeout(200)
    p.locator('.dialog button', has_text='モックを実行').click(); p.wait_for_timeout(1500)
    check('モック：通常は最後まで取得', '最後まで取得' in p.inner_text('.dialog'))
    p.locator('.dialog button', has_text='モックを実行').click(); p.wait_for_timeout(1000)
    check('モック：6 時間たたないと実行しない', '6 時間たっていない' in p.inner_text('.dialog .log'))
    p.locator('.dialog button', has_text='モック時計を 6 時間進める').click(); p.wait_for_timeout(300)
    p.locator('.dialog select').select_option('r429'); p.wait_for_timeout(200)
    p.locator('.dialog button', has_text='モックを実行').click(); p.wait_for_timeout(1500)
    check('モック：429 で中断し、Retry-After を守る', 'Retry-After 32400秒' in p.inner_text('.dialog .log') and '途中まで' in p.inner_text('.dialog'))
    shot(p, 'pc-08-intake-mock')
    for _ in range(2):
        p.locator('.dialog button', has_text='モック時計を 6 時間進める').click(); p.wait_for_timeout(250)
    p.locator('.dialog select').select_option('a401'); p.wait_for_timeout(200)
    p.locator('.dialog button', has_text='モックを実行').click(); p.wait_for_timeout(1500)
    check('モック：401 で自動停止し、停止スイッチがオン', p.locator('.dialog .switch').get_attribute('aria-checked') == 'true')
    check('停止中は実行ボタンが押せない', p.locator('.dialog button', has_text='モックを実行').is_disabled())
    p.locator('.dialog .switch').click(); p.wait_for_timeout(300)
    check('停止スイッチは手動で戻せる', p.locator('.dialog .switch').get_attribute('aria-checked') == 'false')
    p.keyboard.press('Escape')
    p.locator('.nav-item', has_text='いいね').click(); p.wait_for_timeout(300)
    check('モックで取り込んだものに印', p.locator('.p-head .fict', has_text='モック').count() >= 1)
    # ダーク
    ctxd = b.new_context(viewport={'width': 1440, 'height': 900}, device_scale_factor=2, color_scheme='dark', locale='ja-JP', timezone_id='Asia/Tokyo')
    pd = ctxd.new_page(); watch(pd, 'pc-dark')
    pd.goto(APP); pd.wait_for_selector('.empty'); pd.get_by_role('button', name='架空サンプルで試す').click(); pd.wait_for_selector('#main article.post')
    shot(pd, 'pc-09-dark')
    ctxd.close()
    ctx.close()

    # ------------------------------------------------------------ あとでの期限（時計を進める）
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, locale='ja-JP', timezone_id='Asia/Tokyo')
    p = ctx.new_page(); watch(p, 'clock')
    p.clock.install()
    p.goto(APP); p.wait_for_selector('.empty')
    p.get_by_role('button', name='架空サンプルで試す').click(); p.wait_for_selector('#main article.post')
    p.evaluate("Margin.app.act('x:91000000000000107', 'later', new Date(Date.now() + 3600e3).toISOString())"); p.wait_for_timeout(500)
    check('あとでに置くと一覧から外れる', p.locator('#main article.post[data-id="x:91000000000000107"]').count() == 0)
    p.clock.fast_forward('01:05:00'); p.wait_for_timeout(500)
    p.evaluate("window.dispatchEvent(new Event('focus'))"); p.wait_for_timeout(800)
    check('時間が来ると未読に戻り「あとでから戻りました」', p.locator('#main article.post[data-id="x:91000000000000107"] .ctx.later').count() == 1)
    ctx.close()

    # ------------------------------------------------------------ 本番の規則での実ネットワーク取得（このサンドボックス）
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, locale='ja-JP', timezone_id='Asia/Tokyo')
    p = ctx.new_page(); watch(p, 'real')
    p.goto(REAL); p.wait_for_selector('.empty')
    p.locator('.brand-btn').click(); p.wait_for_selector('#manual-url')
    p.locator('#manual-url').fill('https://x.com/fic_real/status/515151')
    p.locator('.dialog button', has_text='追加').first.click(); p.wait_for_timeout(500)
    p.evaluate("Margin.app.openDetail('x:515151')"); p.wait_for_selector('.detail')
    p.locator('.add-link .field').fill('https://example.com/'); p.locator('.add-link .btn').click(); p.wait_for_timeout(300)
    p.locator('.article .btn', has_text='記事を読み込む').click(); p.wait_for_selector('.a-status.bad, .a-status.ok', timeout=30000)
    real_text = p.inner_text('.article')
    check('実ネットワーク：https://example.com/ を明示操作で取得を試行（結果をそのまま記録）', True, real_text.replace('\n', ' ')[:200])
    shot(p, 'sp390-19-real-fetch-attempt')
    ctx.close()
    b.close()

summary = {'checks': results, 'passed': sum(1 for r in results if r['ok']), 'failed': sum(1 for r in results if not r['ok']), 'externalRequests': external, 'consoleErrors': console_errors}
(OUT / 'e2e-result.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
print('PASSED', summary['passed'], 'FAILED', summary['failed'])
print('EXTERNAL', external)
print('CONSOLE', console_errors[:10])
