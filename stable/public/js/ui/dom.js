/*
 * margin ui/dom — 画面部品の道具
 *  - 文字はすべて textContent（createTextNode）で入れる。innerHTML に入れるのは下の固定アイコンだけ
 */
(function (root) {
  'use strict';

  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v == null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.keys(v).forEach(function (d) { el.dataset[d] = v[d]; });
        else el.setAttribute(k, v === true ? '' : String(v));
      });
    }
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
    el.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
  }

  // 固定アイコン（データを含まない定数）
  var ICONS = {
    heart: '<path d="M12 20.3C6.4 15.9 3 12.8 3 9a4.6 4.6 0 0 1 9-1.5A4.6 4.6 0 0 1 21 9c0 3.8-3.4 6.9-9 11.3z"/>',
    clock: '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.4V12l3.2 2"/>',
    keep: '<path d="M4.5 7.5h15v12a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z"/><path d="M3.5 4.5h17v3h-17z"/><path d="M9.5 11.5h5"/>',
    check: '<circle cx="12" cy="12" r="8.6"/><path d="M8 12.3l2.7 2.7L16.2 9.5"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeoff: '<path d="M3 3l18 18"/><path d="M10.6 5.6A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.9 3.7M6.3 6.8C3.9 8.5 2.5 12 2.5 12S6 18.5 12 18.5c1.5 0 2.9-.4 4.1-1"/>',
    ext: '<path d="M14 4.5h5.5V10"/><path d="M19.5 4.5 11 13"/><path d="M17.5 14v4a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V8A1.5 1.5 0 0 1 6 6.5h4"/>',
    back: '<path d="M20 12H5"/><path d="M11 5l-7 7 7 7"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    search: '<circle cx="11" cy="11" r="6.8"/><path d="m16.2 16.2 4.3 4.3"/>',
    grid: '<path d="M4.5 4.5h6v6h-6zM13.5 4.5h6v6h-6zM4.5 13.5h6v6h-6zM13.5 13.5h6v6h-6z"/>',
    hash: '<path d="M9 3.5 7 20.5M17 3.5l-2 17M4 8.5h16.5M3.5 15.5H20"/>',
    intake: '<path d="M12 3.5v11"/><path d="M7.5 10 12 14.5 16.5 10"/><path d="M4.5 15v3.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V15"/>',
    more: '<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    alert: '<path d="M12 4 21 19.5H3z"/><path d="M12 10v4.2M12 17.2v.1"/>',
    image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m20.5 16-5-5-8.5 8.5"/>',
    play: '<path d="M8 5.5v13l10-6.5z"/>',
    article: '<path d="M5.5 3.5h9l4 4v13h-13z"/><path d="M14.5 3.5v4h4M8.5 12h7M8.5 15.5h7"/>',
    thread: '<path d="M6 4.5v15M6 9.5h7a4 4 0 0 1 4 4v6"/>',
    merge: '<path d="M7 4.5v5a4 4 0 0 0 4 4h6"/><path d="M14 10.5l3 3-3 3"/><path d="M7 19.5v-4"/>',
    undo: '<path d="M9 7 4.5 11.5 9 16"/><path d="M4.5 11.5H14a5.5 5.5 0 0 1 0 11h-2"/>',
    left: '<path d="M15 5l-7 7 7 7"/>',
    right: '<path d="M9 5l7 7-7 7"/>',
    pin: '<path d="M7.5 3.5h9l-1.5 6 3 3H6l3-3z"/><path d="M12 12.5v8"/>',
    tag: '<path d="M3.5 12V4.5H11l9.5 9.5-7.5 7.5z"/><circle cx="7.8" cy="8.8" r="1.4"/>'
  };
  function icon(name, cls) {
    var tpl = document.createElement('template');
    tpl.innerHTML = '<svg class="i' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">' + ICONS[name] + '</svg>';
    return tpl.content.firstChild;
  }
  function brand() {
    var tpl = document.createElement('template');
    // margin のしるし：紙と、右の余白線
    tpl.innerHTML = '<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="5" y="4.5" width="22" height="23" rx="5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M10 11h8M10 15.5h8M10 20h5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M22.5 4.5v23" stroke="#1d9bf0" stroke-width="2.2"/></svg>';
    return tpl.content.firstChild;
  }

  function hash(str) {
    var x = 2166136261;
    for (var i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 16777619); }
    return x >>> 0;
  }
  function paint(el, seed) {
    var hh = hash(seed) % 360;
    el.style.setProperty('background', 'linear-gradient(135deg, hsl(' + hh + ' 45% 52%), hsl(' + ((hh + 50) % 360) + ' 50% 36%))');
  }
  function avatar(author, size) {
    var name = author.name || author.handle || '?';
    var ch = Array.from(name.replace(/^架空・/, '').replace(/^@/, ''))[0] || '?';
    var el = h('div', { class: 'avatar' + (size ? ' ' + size : ''), 'aria-hidden': 'true', text: ch.toUpperCase() });
    return el;
  }

  /* ---------------- 日時（X の表示に合わせる） ---------------- */
  function rel(iso, now) {
    if (!iso) return '';
    var t = Date.parse(iso);
    var s = Math.round(((now || Date.now()) - t) / 1000);
    if (s < 0) s = 0;
    if (s < 60) return s + '秒';
    if (s < 3600) return Math.floor(s / 60) + '分';
    if (s < 86400) return Math.floor(s / 3600) + '時間';
    var d = new Date(t), n = new Date(now || Date.now());
    if (d.getFullYear() === n.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日';
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function clock(d) {
    var hh = d.getHours();
    return (hh < 12 ? '午前' : '午後') + ((hh % 12) || 12) + ':' + pad(d.getMinutes());
  }
  function full(iso) {
    var d = new Date(iso);
    return clock(d) + ' · ' + d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }
  function short(iso) {
    var d = new Date(iso);
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + d.getHours() + ':' + pad(d.getMinutes());
  }
  var WD = ['日', '月', '火', '水', '木', '金', '土'];
  function dayDiff(iso, now) {
    var a = new Date(iso); a.setHours(0, 0, 0, 0);
    var b = new Date(now || Date.now()); b.setHours(0, 0, 0, 0);
    return Math.round((a - b) / 864e5);
  }
  function due(iso, now) {
    var d = new Date(iso), diff = dayDiff(iso, now);
    var t = d.getHours() + ':' + pad(d.getMinutes());
    if (diff < 0) return '期限を過ぎた';
    if (diff === 0) return '今日 ' + t;
    if (diff === 1) return '明日 ' + t;
    if (diff < 7) return WD[d.getDay()] + '曜 ' + t;
    return (d.getMonth() + 1) + '月' + d.getDate() + '日（' + WD[d.getDay()] + '）' + t;
  }

  /*
   * 本文の中の URL・@・# を見分けて、押せる文字にする（HTML は解釈しない）
   * handlers: { url(u), mention(h), hashtag(t) }
   */
  var TOKEN = /(https?:\/\/[^\s<>"'「」（）]+)|(@[A-Za-z0-9_]{1,15})|(#[^\s#@.,、。!?！？「」（）()]{1,40})/g;
  function richText(text, handlers) {
    var frag = document.createDocumentFragment();
    var last = 0, m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      var s = m[0];
      var span = h('span', { class: 'lk', role: 'link', tabindex: '0' });
      if (m[1]) {
        var shown = s.replace(/^https?:\/\//, '');
        span.textContent = shown.length > 32 ? shown.slice(0, 31) + '…' : shown;
        span.title = s;
        bind(span, function () { handlers.url(s); });
      } else if (m[2]) { span.textContent = s; bind(span, function () { handlers.mention(s.slice(1)); }); }
      else { span.textContent = s; bind(span, function () { handlers.hashtag(s.slice(1)); }); }
      frag.appendChild(span);
      last = m.index + s.length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }
  function bind(el, fn) {
    el.addEventListener('click', function (e) { e.stopPropagation(); fn(); });
    el.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.stopPropagation(); fn(); } });
  }

  root.Margin = root.Margin || {};
  function addIf(el, c) { if (c) el.appendChild(c); return el; }
  root.Margin.dom = { addIf: addIf, h: h, icon: icon, brand: brand, paint: paint, avatar: avatar, rel: rel, full: full, short: short, due: due, dayDiff: dayDiff, richText: richText, pad: pad };
})(typeof globalThis !== 'undefined' ? globalThis : this);
