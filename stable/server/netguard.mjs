// margin server/netguard — 公開記事を取りに行ってよい宛先かを決める
//
// 公開されたインターネット上のアドレスだけを許す。次はすべて拒否する：
//   ループバック・プライベート・リンクローカル・CGNAT・マルチキャスト・予約・文書用・ベンチマーク用、
//   クラウドのメタデータ（169.254.169.254, fd00:ec2::254 など）、IPv4 射影 IPv6（::ffff:a.b.c.d）、
//   NAT64（64:ff9b::/96）・6to4（2002::/16）・Teredo（2001::/32）に埋め込まれた非公開 IPv4、
//   localhost や .local などの名前、予約済みのトップレベルドメイン（.example .test .invalid .localhost）
import net from 'node:net';

function v4parts(ip) {
  const p = ip.split('.').map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : null;
}

export function isPublicIPv4(ip) {
  const p = v4parts(ip);
  if (!p) return false;
  const [a, b, c] = p;
  if (a === 0) return false;                         // 0.0.0.0/8
  if (a === 10) return false;                        // private
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 127) return false;                       // loopback
  if (a === 169 && b === 254) return false;          // link-local（メタデータ 169.254.169.254 を含む）
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 0 && c === 0) return false; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return false; // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay anycast
  if (a === 192 && b === 168) return false;          // private
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false;  // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false;   // TEST-NET-3
  if (a >= 224) return false;                        // multicast・予約・broadcast
  return true;
}

// IPv6 を 8 個の 16 ビット値へ展開する（IPv4 埋め込み表記にも対応）
export function expandIPv6(ip) {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '');
  const zone = s.indexOf('%');
  if (zone !== -1) return null; // ゾーン ID 付きは扱わない
  if (s.includes('.')) {
    const idx = s.lastIndexOf(':');
    const v4 = v4parts(s.slice(idx + 1));
    if (!v4) return null;
    s = s.slice(0, idx + 1) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const all = head.concat(new Array(fill).fill('0'), tail);
  if (all.length !== 8) return null;
  const out = all.map((x) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN));
  return out.some(Number.isNaN) ? null : out;
}

function embeddedV4(w, i) { return [w[i] >> 8, w[i] & 255, w[i + 1] >> 8, w[i + 1] & 255].join('.'); }

// IANA IPv6 Special-Purpose Address Registry の「Globally Reachable = False」をすべて拒否する。
// さらに、IPv4 を埋め込む形式（射影・互換・NAT64・6to4・Teredo）は、中の IPv4 で迂回されないよう
// レジストリ上の扱いにかかわらず拒否する（64:ff9b::/96 は registry では True だが、ここでは拒否する）。
// 参照：https://www.iana.org/assignments/iana-ipv6-special-registry/
export function isPublicIPv6(ip) {
  const w = expandIPv6(ip);
  if (!w) return false;
  const z = (from, to) => w.slice(from, to).every((x) => x === 0);
  if (z(0, 8)) return false;                                               // ::/128 未指定
  if (z(0, 7) && w[7] === 1) return false;                                 // ::1/128 ループバック
  if (z(0, 5) && w[5] === 0xffff) return false;                            // ::ffff:0:0/96 IPv4 射影
  if (z(0, 6)) return false;                                               // ::/96 IPv4 互換（廃止）ほか先頭がすべて 0
  if (w[0] === 0x0064 && w[1] === 0xff9b) return false;                    // 64:ff9b::/96（NAT64・方針で拒否）と 64:ff9b:1::/48（False）
  if (w[0] === 0x0100 && w[1] === 0 && w[2] === 0 && (w[3] === 0 || w[3] === 1)) return false; // 100::/64 破棄用・100:0:0:1::/64 ダミー
  if (w[0] === 0x2001 && w[1] < 0x0200) {                                  // 2001::/23 IETF プロトコル割り当て（原則 False）
    // より細かい割り当てで Globally Reachable = True のものだけ通す
    const anycast = w[1] === 0x0001 && z(2, 7) && (w[7] === 1 || w[7] === 2 || w[7] === 3); // 2001:1::1〜3/128
    const amt = w[1] === 0x0003;                                           // 2001:3::/32
    const as112 = w[1] === 0x0004 && w[2] === 0x0112;                      // 2001:4:112::/48
    const orchid2 = (w[1] & 0xfff0) === 0x0020;                            // 2001:20::/28
    const det = (w[1] & 0xfff0) === 0x0030;                                // 2001:30::/28
    // Teredo 2001::/32（N/A・IPv4 埋め込み）、ベンチマーク 2001:2::/48、旧 ORCHID 2001:10::/28 などはここで拒否
    return anycast || amt || as112 || orchid2 || det;
  }
  if (w[0] === 0x2001 && w[1] === 0x0db8) return false;                    // 2001:db8::/32 文書用
  if (w[0] === 0x2002) return false;                                       // 2002::/16 6to4（N/A・IPv4 埋め込み）
  if (w[0] === 0x3fff && (w[1] & 0xf000) === 0) return false;              // 3fff::/20 文書用
  if (w[0] === 0x5f00) return false;                                       // 5f00::/16 SRv6 SID
  if ((w[0] & 0xfe00) === 0xfc00) return false;                            // fc00::/7 ユニークローカル（fd00:ec2::254 を含む）
  if ((w[0] & 0xffc0) === 0xfe80) return false;                            // fe80::/10 リンクローカル
  if ((w[0] & 0xffc0) === 0xfec0) return false;                            // fec0::/10 サイトローカル（廃止）
  if ((w[0] & 0xff00) === 0xff00) return false;                            // ff00::/8 マルチキャスト
  if ((w[0] & 0xe000) !== 0x2000) return false;                            // グローバルユニキャスト 2000::/3 以外（未割り当て）
  return true;
}

export function isPublicAddress(ip) {
  const v = net.isIP(ip);
  if (v === 4) return isPublicIPv4(ip);
  if (v === 6) return isPublicIPv6(ip);
  return false;
}

const BAD_SUFFIX = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|private|arpa|example|test|invalid|onion|alt)$/i;

// ホスト名そのものを見て拒否できるもの
export function checkHostname(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) return { ok: false, code: 'bad_host', reason: 'ホスト名がありません' };
  if (h.length > 253) return { ok: false, code: 'bad_host', reason: 'ホスト名が長すぎます' };
  if (net.isIP(h)) {
    return isPublicAddress(h) ? { ok: true, ip: h } : { ok: false, code: 'private_address', reason: '公開されていないアドレスです' };
  }
  // WHATWG URL は 0x7f.1 や 2130706433 を IPv4 に直すが、念のため数字だけの名前も拒否
  if (/^[0-9.]+$/.test(h) || /^0x[0-9a-f.]+$/i.test(h)) return { ok: false, code: 'numeric_host', reason: '数字だけのホスト名は使えません' };
  if (!h.includes('.')) return { ok: false, code: 'single_label', reason: '内部向けのホスト名は使えません' };
  if (BAD_SUFFIX.test(h)) return { ok: false, code: 'reserved_domain', reason: '予約済み・内部向けのドメインです' };
  if (!/^[a-z0-9.-]+$/.test(h)) return { ok: false, code: 'bad_host', reason: 'ホスト名に使えない文字があります' };
  return { ok: true };
}
