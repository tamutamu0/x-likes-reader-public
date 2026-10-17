import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicAddress, checkHostname, expandIPv6 } from '../server/netguard.mjs';

test('公開でないアドレスはすべて拒否', () => {
  const bad = ['0.0.0.0', '127.0.0.1', '127.255.255.254', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254', '100.64.0.1', '192.0.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '240.0.0.1',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:8.8.8.8', '::127.0.0.1', '64:ff9b::7f00:1', '64:ff9b::808:808', '2002:7f00:0001::', '2001:0:4136::', '2001:db8::1', 'fc00::1', 'fd00:ec2::254', 'fe80::1', 'fec0::1', 'ff02::1', '100::1', 'not-an-ip', ''];
  for (const ip of bad) assert.equal(isPublicAddress(ip), false, ip);
});

test('公開アドレスは許す', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.215.14', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicAddress(ip), true, ip);
});

test('IPv6 の展開（IPv4 埋め込みを含む）', () => {
  assert.deepEqual(expandIPv6('::ffff:1.2.3.4'), [0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
  assert.equal(expandIPv6('1::2::3'), null);
  assert.equal(expandIPv6('fe80::1%eth0'), null);
});

test('ホスト名：内部向け・予約済み・数字だけは拒否', () => {
  for (const h of ['localhost', 'a.localhost', 'printer', 'nas.local', 'svc.internal', 'x.corp', 'dev.example', 'a.test', 'b.invalid', '2130706433', '0x7f.1', 'metadata.google.internal', 'x.onion', '127.0.0.1', '[::1]']) assert.equal(checkHostname(h).ok, false, h);
  for (const h of ['example.com', 'news.example.org', 'xn--wgv71a119e.jp', 'x.com']) assert.equal(checkHostname(h).ok, true, h);
});

test('IANA IPv6 特殊用途レジストリ：Globally Reachable = False はすべて拒否', () => {
  // https://www.iana.org/assignments/iana-ipv6-special-registry/
  const notReachable = ['2001:2::1', '2001:2:0:ffff::1', '3fff::1', '3fff:fff::1', '5f00::1', '100::1', '100:0:0:1::1', '64:ff9b:1::1', '2001::1', '2001:10::1', '2001:1::4', '2001:1ff:ffff::1', '2001:db8:ffff::1', 'fc00::1', 'fe80::1'];
  for (const ip of notReachable) assert.equal(isPublicAddress(ip), false, ip);
});

test('IANA IPv6 特殊用途レジストリ：より細かい割り当てで True のものは通す', () => {
  for (const ip of ['2001:1::1', '2001:1::2', '2001:1::3', '2001:3::1', '2001:4:112::1', '2001:20::1', '2001:2f:ffff::1', '2001:30::1', '2620:4f:8000::1', '3fff:1000::1', '2001:200::1']) assert.equal(isPublicAddress(ip), true, ip);
});

test('方針として拒否：IPv4 を埋め込む形式（NAT64 64:ff9b::/96 は registry 上 True でも拒否）', () => {
  for (const ip of ['64:ff9b::808:808', '2002:808:808::1', '2001:0:4136:e378::1', '::ffff:8.8.8.8', '::8.8.8.8']) assert.equal(isPublicAddress(ip), false, ip);
});
