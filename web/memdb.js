// 記憶體版資料庫：node 測試與瀏覽器 demo 模式用，方法與 gas/SheetDb.js 相同。
// 頂層只能有 function/var 宣告。

function MemDb(seed) {
  function copy(x) { return x == null ? null : JSON.parse(JSON.stringify(x)); }
  var d = copy(seed || {});
  ['members', 'stores', 'orders', 'lines'].forEach(function (k) { d[k] = d[k] || []; });
  var seq = { s: d.stores.length, o: d.orders.length };

  function find(list, key, id) {
    return list.filter(function (x) { return x[key] === id; })[0] || null;
  }
  function nextId(prefix, list, key) {
    var id;
    do { id = prefix + (++seq[prefix]); } while (find(list, key, id));
    return id;
  }

  return {
    upsertMember: function (m) {
      var cur = find(d.members, 'userId', m.userId);
      if (!cur) {
        cur = { userId: m.userId, name: m.name, isAdmin: false };
        d.members.push(cur);
      } else {
        cur.name = m.name;
      }
      return copy(cur);
    },
    listMembers: function () { return copy(d.members); },

    listStores: function () { return copy(d.stores); },
    getStore: function (storeId) { return copy(find(d.stores, 'storeId', storeId)); },
    saveStore: function (s) {
      s = copy(s);
      var cur = s.storeId ? find(d.stores, 'storeId', s.storeId) : null;
      if (cur) d.stores[d.stores.indexOf(cur)] = s;
      else { s.storeId = nextId('s', d.stores, 'storeId'); d.stores.push(s); }
      return copy(s);
    },

    createOrder: function (o) {
      o = copy(o);
      o.orderId = nextId('o', d.orders, 'orderId');
      d.orders.push(o);
      return copy(o);
    },
    getOrder: function (orderId) { return copy(find(d.orders, 'orderId', orderId)); },
    listOrders: function () { return copy(d.orders); },
    updateOrder: function (orderId, patch) {
      var o = find(d.orders, 'orderId', orderId);
      if (!o) return null;
      Object.keys(patch).forEach(function (k) { o[k] = patch[k]; });
      return copy(o);
    },

    getLines: function (orderId) {
      return copy(d.lines.filter(function (l) { return l.orderId === orderId; }));
    },
    listAllLines: function () { return copy(d.lines); },
    replaceLines: function (orderId, userId, lines) {
      d.lines = d.lines.filter(function (l) { return !(l.orderId === orderId && l.userId === userId); })
        .concat(copy(lines));
    },

    withLock: function (fn) { return fn(); },
    dump: function () { return copy(d); }
  };
}
