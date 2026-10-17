/* Concrete topics are discovered from the stock, never from a list of product names. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Margin.topics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Grammar, promotional language and generic category words are not useful topic names.
  var STOP = new Set(('a an the and or but for to of in on at by from with into as is are was were be been being it its this that these those i we you they he she my our your their me us them not no yes do does did can could will would should may might has have had get gets got just now new today tomorrow yesterday more most very really much many some any all each every one two first last next also about how what when where why who which here there out up down over under after before than then so if while because via use used using make made making want need lets let thanks thank please like likes post posts read reading thread rt http https www com org net co example status video videos image images code model models tool tools app apps data update release available introducing'.split(' ')).concat(
    'これ それ あれ ここ そこ こちら そちら ため よう もの こと 自分 今日 明日 昨日 今回 本当 最近 最初 最後 一番 以上 以下 場合 時間 方法 投稿 記事 情報 紹介 公開 無料 有料 利用 使用 機能 対応 作成 実装 開発 デザイン 生成 モデル ツール サービス リンク コメント おすすめ オススメ お勧め 可能 必要 実際 確認 完了 便利 簡単 新規 最新 新しい 良い すごい スゴイ 架空 投稿者 追記 詳細 内容 全部 皆さん'.split(' ')));

  function keyOf(label) {
    return String(label || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  }
  ['api','ai','ui','ux'].forEach(function (word) { STOP.add(word); });
  'pro max mini fast slow high low medium only same keep full half best better free beta preview prompt prompts agent agents product products style camera color background people person frame scene output work quality ultra simple beautiful great'.split(' ').forEach(function (word) { STOP.add(word); });
  function cleanLabel(label) {
    return String(label || '').normalize('NFKC').trim().replace(/\s+/g, ' ').replace(/^[#＃]+|[.,:;!?、。]+$/g, '');
  }
  function candidates(raw) {
    var text = String(raw || '').normalize('NFKC').slice(0, 12000)
      .replace(/(?:https?:\/\/|www\.)[^\s<>]+/gi, ' ')
      .replace(/\b(?:[\w-]+\.)+[a-z]{2,}\/[^\s<>]*/gi, ' ')
      .replace(/@[A-Za-z0-9_]+/g, ' ');
    var found = new Map();
    function add(label, strength, explicit) {
      label = cleanLabel(label);
      var key = keyOf(label);
      if (key.length < 2 || key.length > 40 || STOP.has(key) || !/[\p{L}]/u.test(key)) return;
      if (/^[\p{Script=Han}]+的$/u.test(key)) return;
      if (/\.(?:com|org|net|co|io|dev|ai)$/.test(key)) return;
      var previous = found.get(key);
      if (!previous || strength > previous.strength) found.set(key, {key:key,label:label,strength:strength,explicit:!!explicit});
    }
    // Explicit hashtags retain Japanese phrases and non-Latin names as written.
    (text.match(/[#＃][\p{L}\p{N}_-]{2,40}/gu) || []).forEach(function (s) { add(s, 5, true); });
    // Capitalized phrases keep names such as a product followed by its edition or component.
    (text.match(/\b[A-Z][A-Za-z0-9.+#-]*(?:[ \t]+[A-Z][A-Za-z0-9.+#-]*){1,2}\b/g) || []).forEach(function (s) {
      var words=s.split(/\s+/);
      while (words.length && STOP.has(keyOf(words[0]))) words.shift();
      while (words.length && words[words.length-1]===words[words.length-1].toUpperCase() && STOP.has(keyOf(words[words.length-1]))) words.pop();
      if (words.length>1) add(words.join(' '), 4, false);
    });
    (text.match(/[A-Za-z][A-Za-z0-9]*(?:[.+#-][A-Za-z0-9]+)*(?:\+\+|#)?/g) || []).forEach(function (s) {
      var named = /[A-Z]/.test(s) || /[0-9.+#-]/.test(s);
      add(s, named ? 3 : 1, false);
    });
    // Script boundaries preserve meaningful Japanese compounds instead of individual characters.
    (text.match(/[\p{Script=Han}\p{Script=Katakana}ー]{2,24}/gu) || []).forEach(function (s) { add(s, s.length>2 ? 2:1, false); });
    (text.match(/[A-Za-z][A-Za-z0-9.+#-]*[ァ-ヶー]{2,16}/g) || []).forEach(function (s) { add(s, 4, false); });
    return Array.from(found.values()).slice(0, 160);
  }

  function build(items, options) {
    var o = options || {}, excluded = new Set((o.exclude || []).map(keyOf));
    var genres = new Map(), genreTotals = new Map(), lookup = new Map(), perItem = new Map();
    items.forEach(function (it) {
      var genre = o.genreOf(it.id), terms = new Map();
      genreTotals.set(genre, (genreTotals.get(genre) || 0) + 1);
      function collect(text, source, boost) {
        candidates(text).forEach(function (term) {
          if (excluded.has(term.key)) return;
          var previous = terms.get(term.key), strength = term.strength + (boost || 0);
          if (!previous || strength > previous.strength) terms.set(term.key, {key:term.key,label:term.label,strength:strength,
            explicit:term.explicit && source==='タグ',evidence:source + 'に「' + term.label + '」'});
        });
      }
      collect(it.src.text, '本文');
      collect(it.src.quote && it.src.quote.text, '引用');
      (it.src.links || []).concat(it.user.links || []).forEach(function (l) { collect(l.title, 'リンクの見出し'); });
      collect(it.user.memo, 'メモ');
      (it.user.tags || []).forEach(function (tag) { collect('#' + tag, 'タグ', 1); });
      var article = o.articleFor && o.articleFor(it);
      if (article && article.status === 'ok') collect(article.title, '保存済み記事の見出し');
      var bucket = genres.get(genre);
      if (!bucket) { bucket = new Map(); genres.set(genre, bucket); }
      terms.forEach(function (term) {
        var topic = bucket.get(term.key);
        if (!topic) {
          topic = {id:'t:' + encodeURIComponent(genre) + ':' + encodeURIComponent(term.key),key:term.key,label:term.label,
            genre:genre,members:new Map(),variants:new Map(),strength:0,explicit:false};
          bucket.set(term.key, topic);
        }
        topic.members.set(it.id, term.evidence);
        topic.variants.set(term.label, (topic.variants.get(term.label) || 0) + 1);
        topic.strength = Math.max(topic.strength, term.strength);
        topic.explicit = topic.explicit || term.explicit;
      });
    });
    var byGenre = new Map();
    genres.forEach(function (bucket, genre) {
      var topics = Array.from(bucket.values()).filter(function (t) {
        // In a large stock, ordinary words need more support than distinctive names/phrases.
        var distinctive=/[a-z][A-Z]/.test(t.label) || /[A-Za-z].*\d/.test(t.label) && t.key.length>=4 || t.key.indexOf(' ')!==-1;
        var support=distinctive ? 2:Math.max(2,Math.min(5,Math.ceil(Math.log2(1+genreTotals.get(genre))/2)));
        return t.members.size>=support || t.explicit;
      }).map(function (t) {
        var variants = Array.from(t.variants.keys()).sort(function (a, b) {
          var displayA = a !== a.toLowerCase() ? 1 : 0, displayB = b !== b.toLowerCase() ? 1 : 0;
          return displayB - displayA || t.variants.get(b) - t.variants.get(a) || a.localeCompare(b);
        });
        return {id:t.id,key:t.key,label:variants[0],genre:genre,ids:Array.from(t.members.keys()).sort(),count:t.members.size,
          score:Math.log2(1 + t.members.size) * t.strength + (t.key.indexOf(' ') !== -1 ? 2 : 0),
          evidence:function (id) { return t.members.get(id) || ''; }};
      }).sort(function (a, b) { return b.score - a.score || b.count - a.count || a.key.localeCompare(b.key); });
      // Prefer a full name when its shortened form represents exactly the same posts.
      topics = topics.filter(function (t) {
        return !topics.some(function (other) {
          if (other === t || other.count !== t.count || other.key.indexOf(' ') === -1) return false;
          if (other.key.indexOf(t.key + ' ') !== 0 && !other.key.endsWith(' ' + t.key)) return false;
          return other.ids.every(function (id, i) { return id === t.ids[i]; });
        });
      });
      byGenre.set(genre, topics);
      topics.forEach(function (t) {
        lookup.set(t.id, t);
        t.ids.forEach(function (id) { var list = perItem.get(id) || []; list.push(t); perItem.set(id, list); });
      });
    });
    return {forGenre:function (genre) { return byGenre.get(genre) || []; },
      forItem:function (id) { return perItem.get(id) || []; },get:function (id) { return lookup.get(id) || null; }};
  }
  return Object.freeze({build:build,keyOf:keyOf,candidates:candidates});
});
