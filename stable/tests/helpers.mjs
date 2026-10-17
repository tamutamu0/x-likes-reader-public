// テスト用の読み込み（public/js の CommonJS モジュールを Node から使う）
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export const S = require('../public/js/core/safe.js');
export const M = require('../public/js/core/model.js');
export const J = require('../public/js/core/jsonio.js');
export const C = require('../public/js/core/collector.js');
export const I = require('../public/js/core/insight.js');
export const B = require('../public/js/store/backends.js');
export const R = require('../public/js/store/repo.js');
export const Mock = require('../public/js/adapters/mock.js');
export const X = require('../public/js/adapters/x.js');
export const Approvals = require('../public/js/approvals.js');

export function src(id, extra) {
  return Object.assign({ postId: String(id), url: 'https://x.com/fic_user/status/' + id, author: { name: '架空 ' + id, handle: 'fic_user' }, text: '架空の投稿 ' + id, postedAt: '2026-10-01T00:00:00.000Z', links: [] }, extra || {});
}
export function norm(raw) { const n = M.normalizeSrc(raw, Date.parse('2026-10-11T00:00:00Z')); if (!n.ok) throw new Error(n.reason); return n.src; }
export function newRepo() { const be = B.memoryBackend(); return { be, repo: R.createRepo(be, {}) }; }
