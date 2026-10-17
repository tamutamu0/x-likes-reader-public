/* Read state is the only reading workflow; legacy storage states are preserved. */
(function (root, factory) {
  var model = typeof require === 'function' ? require('./model.js') : root.Margin.model;
  var api = factory(model);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Margin.library = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (M) {
  'use strict';
  function compare(a, b) {
    if (Number.isSafeInteger(a.meta.xFeedOrder) && Number.isSafeInteger(b.meta.xFeedOrder)) return a.meta.xFeedOrder - b.meta.xFeedOrder;
    var x = a.meta.likedAt || a.meta.firstSeenAt, y = b.meta.likedAt || b.meta.firstSeenAt;
    return x < y ? 1 : x > y ? -1 : 0;
  }
  function select(items, options) {
    var o = options || {}, query = String(o.query || '').trim(), parsed = M.parseQuery(query.replace(/^@/, ''));
    return items.filter(function(it) {
      // Search covers the entire stock, including all records in the old workflow.
      if (query) return M.matches(it, parsed) || (query.charAt(0) === '@' && it.src.author.handle.toLowerCase() === query.slice(1).toLowerCase());
      if (o.view === 'likes' && it.user.read && it.id !== o.sticky) return false;
      if (o.view !== 'likes' && o.filter === 'unread' && it.user.read) return false;
      if (o.view !== 'likes' && o.filter === 'read' && !it.user.read) return false;
      if (o.genre && o.genreOf(it.id) !== o.genre) return false;
      if (o.ids && o.ids.indexOf(it.id) === -1) return false;
      return true;
    }).sort(compare);
  }
  return Object.freeze({select:select,compare:compare});
});
