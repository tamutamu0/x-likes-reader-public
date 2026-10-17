/*
 * margin approvals — 承認ゲート
 *
 * JSON ファイルの選択・読み込み・解析・保存（バックアップの書き出しを含む）は、
 * MacでのローカルJSON操作は2026-10-11に人間ユーザーが明示承認した。
 * 画面からは変更できず、テキスト貼り付けなどの別の入口も用意していない。
 * 承認後に有効にする手順は docs/MIGRATION.md に書いてある。
 */
(function (root) {
  'use strict';
  var approvals = Object.freeze({
    jsonFileIO: true,
    jsonFileIONote: 'ローカルJSONの選択・読み込み・解析・保存は承認済み。端末内だけで処理します'
  });
  if (typeof module === 'object' && module.exports) module.exports = approvals;
  else { root.Margin = root.Margin || {}; root.Margin.approvals = approvals; }
})(typeof globalThis !== 'undefined' ? globalThis : this);
