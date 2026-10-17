"""
UX 修正の回帰確認（架空データだけ）。
  node tests/e2e/harness.mjs 47322 を起動してから：python3 tests/e2e/ux_regress.py <出力フォルダ>
JSON の承認ゲートは、このテストのブラウザの中だけ approvals.js の応答を差し替えて true にする（ファイル自体は変えない）。
"""
import json, sys, pathlib, tempfile
from playwright.sync_api import sync_playwright

OUT = pathlib.Path(sys.argv[1]); SHOT = OUT / 'screenshots'; SHOT.mkdir(parents=True, exist_ok=True)
APP = 'http://127.0.0.1:47322/'
FIX = pathlib.Path(__file__).resolve().parent.parent / 'fixtures'
res = []; external = []; errors = []
def check(n, c, d=''):
    res.append({'name': n, 'ok': bool(c), 'detail': str(d)[:200]}); print(('OK   ' if c else 'FAIL ') + n + ((' — ' + str(d)[:140]) if d and not c else ''))
def watch(p, tag):
    p.on('request', lambda r: external.append(r.url) if not (r.url.startswith('http://127.0.0.1:47322/') or r.url.startswith('blob:') or r.url.startswith('data:')) else None)
    p.on('console', lambda m: errors.append(tag + ' ' + m.text) if m.type == 'error' else None)
    p.on('pageerror', lambda e: errors.append(tag + ' ' + str(e)))
def gate_true(page):
    page.route('**/js/approvals.js', lambda route: route.fulfill(status=200, content_type='text/javascript; charset=utf-8',
        body="(function(r){r.Margin=r.Margin||{};r.Margin.approvals=Object.freeze({jsonFileIO:true,jsonFileIONote:'検証用に承認済み'});})(globalThis);"))
def clear(p): p.evaluate("document.getElementById('toasts').textContent=''"); p.wait_for_timeout(100)
def overflow(p): return p.evaluate("document.documentElement.scrollWidth > window.innerWidth")

A = 'x:91000000000000103'
with sync_playwright() as pw:
    b = pw.chromium.launch()
    for W, H in [(390, 844), (320, 640)]:
        ctx = b.new_context(viewport={'width': W, 'height': H}, device_scale_factor=3, is_mobile=True, has_touch=True, locale='ja-JP', timezone_id='Asia/Tokyo', accept_downloads=True)
        p = ctx.new_page(); watch(p, str(W)); gate_true(p)
        p.goto(APP); p.wait_for_selector('.empty')
        p.get_by_role('button', name='架空サンプルで試す').click(); p.wait_for_selector('#main article.post')
        p.locator('#tabbar button', has_text='いいね').click(); p.wait_for_timeout(200)
        p.locator('.tabs button', has_text='すべて').click(); p.wait_for_timeout(200)
        # 1) 履歴：一覧 → 詳細 A → 関連 B → 戻る（ヘッダー）→ 戻る（端末）→ 進む → 進む
        p.evaluate("window.scrollTo(0, 900)"); p.wait_for_timeout(200); y0 = p.evaluate("window.scrollY")
        p.locator(f'article.post[data-id="{A}"] .text').first.click() if p.locator(f'article.post[data-id="{A}"]').count() else p.evaluate(f"Margin.app.openDetail('{A}')")
        p.wait_for_selector('article.detail')
        p.locator('#sec-rel article.post').first.click(); p.wait_for_timeout(300)
        bid = p.evaluate("Margin.app.state.detail")
        check(f'{W}：詳細 A から関連 B を開ける', bid != A and '#post/' in p.url)
        p.get_by_role('button', name='戻る').first.click(); p.wait_for_timeout(400)
        cur = p.evaluate("Margin.app.state.detail"); url = p.url
        check(f'{W}：ヘッダーの戻るで URL も本文も A に戻る', cur == A and url.endswith('#post/' + A.replace(':', '%3A')) and p.locator('article.detail .nm').inner_text() == 'Riku Aoyama', (cur, url))
        p.go_back(); p.wait_for_timeout(400)
        check(f'{W}：端末の戻るで一覧へ、絞り込み（すべて）とスクロール位置を復元', p.evaluate("Margin.app.state.detail") is None and p.locator('.tabs button[aria-selected=true]').inner_text().startswith('すべて') and abs(p.evaluate("window.scrollY") - y0) <= 4, (p.evaluate("window.scrollY"), y0))
        p.go_forward(); p.wait_for_timeout(400)
        check(f'{W}：進むで A', p.evaluate("Margin.app.state.detail") == A)
        p.go_forward(); p.wait_for_timeout(400)
        check(f'{W}：もう一度進むで B', p.evaluate("Margin.app.state.detail") == bid)
        p.go_back(); p.wait_for_timeout(300); p.go_back(); p.wait_for_timeout(400)
        # 2) 操作名：省略されない・はみ出さない
        p.evaluate("window.scrollTo(0,0)"); p.wait_for_timeout(150)
        labels = p.evaluate("[...document.querySelectorAll('#main .acts')].slice(0,3).flatMap(r=>[...r.querySelectorAll('.act')].map(a=>{const l=a.querySelector('.lb');const vis=l&&getComputedStyle(l).display!=='none';return {name:a.getAttribute('aria-label'),label:vis?l.textContent:'',cut:vis&&l.scrollWidth>l.clientWidth+1, right:a.getBoundingClientRect().right}}))")
        check(f'{W}：操作名が省略されない', not any(x['cut'] for x in labels), [x for x in labels if x['cut']])
        check(f'{W}：操作の列が画面内に収まる', all(x['right'] <= W for x in labels))
        shown = sorted(set(x['label'] for x in labels if x['label']))
        check(f'{W}：あとで・済み・残すは名前つき', {'済み', '残す'} <= set(shown) and any(s.startswith('あとで') or '明日' in s for s in shown), shown)
        check(f'{W}：既読・X は名前（表示か読み上げ）つき', all(x['name'] for x in labels))
        check(f'{W}：横にはみ出さない（一覧）', not overflow(p))
        clear(p); p.screenshot(path=str(SHOT / f'sp{W}-timeline.png'))
        p.evaluate(f"Margin.app.openDetail('{A}')"); p.wait_for_selector('article.detail')
        check(f'{W}：横にはみ出さない（詳細）', not overflow(p))
        clear(p); p.screenshot(path=str(SHOT / f'sp{W}-detail.png'))
        p.get_by_role('button', name='戻る').first.click(); p.wait_for_timeout(300)
        # 3) JSON 取り込み（架空 fixture）→ 確認 → 反映 → 取り消し、バックアップ書き出し
        p.locator('.brand-btn').click(); p.wait_for_selector('#ix-json')
        p.locator('#ix-json').scroll_into_view_if_needed()
        with p.expect_file_chooser() as fc:
            p.locator('#ix-json button', has_text='JSON を読み込む').click()
        fc.value.set_files(str(FIX / 'margin-items.fictional.json'))
        p.wait_for_selector('#ix-json .jx-box .jx-title')
        txt = p.inner_text('#ix-json')
        check(f'{W}：読み込んだ後、保存前に件数と内訳を確認できる', 'まだ保存していません' in txt and '受け入れ 3' in txt and '新しく追加' in txt and '弾いた理由' in txt, txt[:160])
        check(f'{W}：確認の段階では何も保存していない', p.evaluate("Margin.app.state.items.has('x:8000000000000000001')") is False)
        check(f'{W}：取り込み画面も横にはみ出さない', not overflow(p))
        p.locator('#ix-json .jx-box').scroll_into_view_if_needed(); clear(p)
        p.screenshot(path=str(SHOT / f'sp{W}-json-preview.png'))
        p.locator('#ix-json button', has_text='反映する').click(); p.wait_for_selector('#ix-json .jx-box.ok')
        check(f'{W}：反映すると結果と取り消しが出る', '追加 3件' in p.inner_text('#ix-json') and p.locator('#ix-json button', has_text='この取り込みを取り消す').count() == 1)
        check(f'{W}：反映したものが一覧に入る', p.evaluate("Margin.app.state.items.has('x:8000000000000000001')") is True)
        p.locator('#ix-json button', has_text='この取り込みを取り消す').click(); p.locator('#ix-json .jx-box.ok', has_text='取り消しました').wait_for(timeout=5000)
        check(f'{W}：取り消すと取り除かれる', '取り除いた 3件' in p.inner_text('#ix-json') and p.evaluate("Margin.app.state.items.has('x:8000000000000000001')") is False)
        bad = pathlib.Path(tempfile.mkdtemp()) / 'broken.json'; bad.write_text('{', encoding='utf-8')
        p.locator('#ix-json button', has_text='閉じる').click(); p.wait_for_timeout(150)
        with p.expect_file_chooser() as fc:
            p.locator('#ix-json button', has_text='JSON を読み込む').click()
        fc.value.set_files(str(bad))
        p.wait_for_selector('#ix-json .jx-box.bad')
        check(f'{W}：壊れた JSON は理由を出して何も保存しない', 'JSON として読めません' in p.inner_text('#ix-json'))
        old = pathlib.Path(tempfile.mkdtemp()) / 'other-format.json'; old.write_text(json.dumps({'data': [{'tweet': {'id': '1'}}]}), encoding='utf-8')
        p.locator('#ix-json button', has_text='閉じる').click(); p.wait_for_timeout(150)
        with p.expect_file_chooser() as fc:
            p.locator('#ix-json button', has_text='JSON を読み込む').click()
        fc.value.set_files(str(old)); p.wait_for_selector('#ix-json .jx-box.bad')
        check(f'{W}：margin 以外の形式は推測せず「未対応」', 'margin の形式ではありません' in p.inner_text('#ix-json'))
        with p.expect_download() as dl:
            p.locator('#ix-json button', has_text='バックアップを書き出す').click()
        d = dl.value; path = OUT / f'backup-{W}.json'; d.save_as(str(path))
        data = json.loads(path.read_text(encoding='utf-8'))
        check(f'{W}：バックアップを書き出せる（架空データ）', d.suggested_filename.startswith('margin-backup-') and data['format'] == 'margin-backup' and data['count'] == len(data['items']) > 0, d.suggested_filename)
        check(f'{W}：架空の印はバックアップでも保たれる', all(x['meta']['origin'] in ('sample', 'mock') for x in data['items']))
        check(f'{W}：書き出しの結果を画面で知らせる', '書き出しました' in p.inner_text('#ix-json'))
        path.unlink()
        ctx.close()
    # PC
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}, device_scale_factor=2, locale='ja-JP', timezone_id='Asia/Tokyo')
    p = ctx.new_page(); watch(p, 'pc')
    p.goto(APP); p.wait_for_selector('.empty'); p.get_by_role('button', name='架空サンプルで試す').click(); p.wait_for_selector('#main article.post')
    clear(p); p.screenshot(path=str(SHOT / 'pc-timeline.png'))
    p.evaluate(f"Margin.app.openDetail('{A}')"); p.wait_for_selector('article.detail')
    p.locator('#sec-rel article.post').first.click(); p.wait_for_timeout(300)
    p.get_by_role('button', name='戻る').first.click(); p.wait_for_timeout(300)
    check('PC：関連 B から戻ると A', p.evaluate("Margin.app.state.detail") == A)
    p.locator('.cta').click(); p.wait_for_selector('#ix-json')
    check('ゲートが閉じているとき（本物の approvals.js）はボタンが押せない', p.locator('#ix-json button', has_text='JSON を読み込む').is_disabled())
    clear(p); p.screenshot(path=str(SHOT / 'pc-detail-intake-gate-closed.png'))
    ctx.close(); b.close()
s = {'checks': res, 'passed': sum(r['ok'] for r in res), 'failed': sum(not r['ok'] for r in res), 'externalRequests': external, 'consoleErrors': errors}
(OUT / 'ux-regress-result.json').write_text(json.dumps(s, ensure_ascii=False, indent=2))
print('PASSED', s['passed'], 'FAILED', s['failed'], 'EXTERNAL', external, 'ERRORS', errors[:5])
