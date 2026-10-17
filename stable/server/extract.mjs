// margin server/extract — 受け取った HTML から「文字だけ」を取り出す
//
//  - HTML は信頼しない入力。実行も描画もせず、タグを外した文字列だけを返す
//  - script / style / iframe / svg / template / noscript などは中身ごと捨てる
//  - 本文中の「指示らしい文」はただの文字として扱う（ここには解釈する仕組みがない）
//  - ログイン・確認画面（CAPTCHA）・有料の壁と思われるページは、その旨を返す（迂回はしない）
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const S = require('../public/js/core/safe.js');

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·', copy: '©', reg: '®', trade: '™', yen: '¥', times: '×', bull: '•'
};

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '';
      return String.fromCodePoint(cp);
    }
    const v = NAMED[e.toLowerCase()];
    return v == null ? m : v;
  });
}

// バイト列を文字に（Content-Type か <meta charset> の指定。分からなければ UTF-8）
export function decodeBody(buf, headerCharset) {
  let cs = headerCharset;
  if (!cs) {
    const head = buf.slice(0, 4096).toString('latin1');
    const m = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head);
    if (m) cs = m[1].toLowerCase();
  }
  const label = (cs || 'utf-8').replace(/^x-sjis$/, 'shift_jis');
  try { return new TextDecoder(label, { fatal: false }).decode(buf); }
  catch (e) { return new TextDecoder('utf-8', { fatal: false }).decode(buf); }
}

function attr(tag, name) {
  const re = new RegExp('\\b' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i');
  const m = re.exec(tag);
  return m ? decodeEntities(m[2] != null ? m[2] : m[3] != null ? m[3] : m[4]) : null;
}

function metas(html) {
  const out = {};
  const re = /<meta\b[^>]*>/gi;
  let m;
  let n = 0;
  while ((m = re.exec(html)) && n++ < 500) {
    const tag = m[0];
    const key = (attr(tag, 'property') || attr(tag, 'name') || attr(tag, 'itemprop') || '').toLowerCase();
    const val = attr(tag, 'content');
    if (key && val != null && out[key] == null) out[key] = val;
  }
  return out;
}

const DROP_BLOCKS = ['script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'svg', 'math', 'canvas', 'video', 'audio', 'picture', 'select', 'button', 'textarea', 'form'];
const CHROME_BLOCKS = ['nav', 'header', 'footer', 'aside'];

function stripBlocks(html, tags) {
  let s = html;
  for (const t of tags) {
    const re = new RegExp('<' + t + '\\b[\\s\\S]*?<\\/' + t + '\\s*>', 'gi');
    for (let i = 0; i < 4; i++) { const before = s; s = s.replace(re, ' '); if (s === before) break; }
    s = s.replace(new RegExp('<' + t + '\\b[^>]*\\/?>', 'gi'), ' ');
  }
  return s;
}

function largest(html, tag) {
  const re = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/' + tag + '\\s*>', 'gi');
  let m, best = null;
  let n = 0;
  while ((m = re.exec(html)) && n++ < 50) if (!best || m[1].length > best.length) best = m[1];
  return best;
}

function toText(fragment) {
  let s = fragment
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|h[1-6]|blockquote|pre|tr|dd|dt|figcaption|table|ul|ol)\s*>/gi, '\n\n')
    .replace(/<(li)\b[^>]*>/gi, '\n・')
    .replace(/<[^>]{0,2000}>/g, ' ')
    .replace(/<|>/g, ' ');
  s = decodeEntities(s);
  const paras = s.split(/\n\s*\n+/).map((p) => p.replace(/[ \t\u00a0\u3000]+/g, ' ').replace(/ *\n */g, '\n').trim()).filter((p) => p.length >= 2);
  // 連続する同じ行（メニューの繰り返しなど）を省く
  const out = [];
  for (const p of paras) if (out[out.length - 1] !== p) out.push(p);
  return out.join('\n\n');
}

const WALL = [
  /captcha|recaptcha|hcaptcha|turnstile|cf-challenge|challenge-platform|are you a robot|verify you are human|unusual traffic/i,
  /paywall|subscribe to (continue|read)|subscribers only|members only|会員限定|有料会員|購読(して|者限定)|続きを読むには(ログイン|会員)/i,
  /(sign|log) ?in to (continue|view|read)|ログインして(ください|続き)|ログインが必要/i
];

/*
 * html: 文字列（デコード済み）
 * 戻り値: { title, siteName, byline, publishedAt, lang, excerpt, text, wall: null | 'captcha' | 'paywall' | 'login', notes[] }
 */
export function extractArticle(html, finalUrl) {
  const src = String(html).slice(0, 3 * 1024 * 1024);
  const meta = metas(src);
  const titleTag = /<title\b[^>]*>([\s\S]{0,1000}?)<\/title>/i.exec(src);
  const title = S.cleanText(decodeEntities(meta['og:title'] || meta['twitter:title'] || (titleTag ? titleTag[1] : '') || ''), 300);
  const lang = (/<html\b[^>]*\blang\s*=\s*["']?([a-zA-Z-]{2,20})/i.exec(src) || [])[1] || '';
  const desc = S.cleanText(meta['og:description'] || meta['description'] || meta['twitter:description'] || '', 400);
  const siteName = S.cleanText(meta['og:site_name'] || meta['application-name'] || '', 100);
  const byline = S.cleanText(meta['author'] || meta['article:author'] || '', 100);
  const pubRaw = meta['article:published_time'] || meta['date'] || meta['pubdate'] || meta['datepublished'] || '';
  const publishedAt = pubRaw && isFinite(Date.parse(pubRaw)) ? new Date(Date.parse(pubRaw)).toISOString() : null;

  let body = stripBlocks(src.replace(/<!--[\s\S]*?-->/g, ' '), DROP_BLOCKS);
  const region = largest(body, 'article') || largest(body, 'main') || largest(body, 'body') || body;
  const text = S.cleanText(toText(stripBlocks(region, CHROME_BLOCKS)), 60000);

  const notes = [];
  let wall = null;
  const probe = src.slice(0, 400000);
  if (WALL[0].test(probe)) wall = 'captcha';
  else if (WALL[1].test(probe)) wall = 'paywall';
  else if (WALL[2].test(probe) || /<input[^>]+type\s*=\s*["']?password/i.test(probe)) wall = 'login';
  if (wall && text.length >= 600) { notes.push(wall === 'captcha' ? '確認画面の表示が含まれています（本文は読めた範囲だけ）' : wall === 'paywall' ? '有料部分がある可能性があります（読めた範囲だけ）' : 'ログインを求める表示があります（読めた範囲だけ）'); wall = null; }

  const paras = text.split(/\n\n/);
  const excerpt = desc || S.cleanText(paras.slice(0, 2).join(' '), 300);
  return { title: title || S.hostOf(finalUrl || ''), siteName, byline, publishedAt, lang, excerpt, text, wall, notes };
}

export function extractPlain(textBody) {
  const text = S.cleanText(String(textBody).slice(0, 2 * 1024 * 1024), 60000);
  const first = text.split(/\n/).find((l) => l.trim()) || '';
  return { title: S.cleanText(first, 200), siteName: '', byline: '', publishedAt: null, lang: '', excerpt: S.cleanText(text.slice(0, 300), 300), text, wall: null, notes: [] };
}
