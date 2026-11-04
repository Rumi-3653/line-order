// API 處理器：權限、截止、驗證都在這裡。db 由外部注入（GAS 用 SheetDb，demo 與測試用 MemDb）。
// 頂層只能有 function/var 宣告（GAS、瀏覽器、node 共用）。

var DEADLINE_RE_ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/;
var MEMBER_ACTIONS_ = { bootstrap: true, saveMyLines: true };
var MAX_LINES_ = 30;

// ms → 'YYYY-MM-DDTHH:mm:ss+08:00'
function taipeiIso(ms) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 19) + '+08:00';
}

function handle(action, payload, identity, deps, nowMs) {
  var me = deps.db.upsertMember({ userId: identity.userId, name: identity.name });
  var fn = HANDLERS_[action];
  if (!fn) throw appError('INVALID', '不認得的動作：' + action);
  if (!MEMBER_ACTIONS_[action] && !me.isAdmin) throw appError('FORBIDDEN', '只有行政可以做這件事');
  return fn(payload || {}, me, deps, nowMs);
}

function mustOrder_(db, orderId) {
  var o = orderId ? db.getOrder(orderId) : null;
  if (!o) throw appError('NOT_FOUND', '找不到這張訂單');
  return o;
}

function checkDeadline_(deadline) {
  if (!DEADLINE_RE_.test(String(deadline)) || isNaN(Date.parse(deadline))) {
    throw appError('INVALID', '截止時間格式不對');
  }
}

function orderView_(o, nowMs, withMenu) {
  var v = { orderId: o.orderId, storeName: o.storeName, deadline: o.deadline, open: isOpen(o, nowMs),
    soldOut: normalizeSoldOut(o.soldOut) };
  if (withMenu) v.menu = o.menu;
  return v;
}

// 全部驗過才回傳；任何一行不對就整批丟錯，不會存一半
function resolveAll_(order, userId, userName, inputs, nowMs) {
  if (!Array.isArray(inputs)) throw appError('INVALID', '點餐內容格式不對');
  if (inputs.length > MAX_LINES_) throw appError('INVALID', '一次最多點 ' + MAX_LINES_ + ' 項');
  return inputs.map(function (input) {
    var l = resolveLine(order.menu, input);
    l.orderId = order.orderId;
    l.userId = userId;
    l.userName = userName;
    l.updatedAt = taipeiIso(nowMs);
    return l;
  });
}

// 校對頁上方的一行摘要：哪個模型、讀到幾個分類幾項、有沒有被截斷，行政對照照片就知道漏了沒
function readNote_(ai, menu) {
  var items = menu.categories.reduce(function (n, c) { return n + c.items.length; }, 0);
  var note = '讀到 ' + menu.categories.length + ' 個分類、' + items + ' 項';
  if (!ai) return note;
  note = 'AI（' + ai.model + '）' + note;
  if (ai.finishReason && ai.finishReason !== 'STOP') note += '；回應被截斷（' + ai.finishReason + '），後面可能漏了';
  return note;
}

var HANDLERS_ = {
  bootstrap: function (p, me, deps, now) {
    var out = { me: me };
    if (p.orderId) {
      var o = mustOrder_(deps.db, p.orderId);
      out.order = orderView_(o, now, true);
      out.myLines = deps.db.getLines(o.orderId).filter(function (l) { return l.userId === me.userId; });
    }
    return out;
  },

  saveMyLines: function (p, me, deps, now) {
    var db = deps.db;
    return db.withLock(function () {
      var o = mustOrder_(db, p.orderId);
      if (!isOpen(o, now)) throw appError('CLOSED', '已截止，要修改請找行政');
      var lines = resolveAll_(o, me.userId, me.name, p.lines, now);
      lines.forEach(function (l) { // 暫停供應只擋同仁；行政幫人改單不受限（店家可能已經備好）
        var why = soldOutReason(o.menu, o.soldOut, l);
        if (why) throw appError('INVALID', why + '，請刪掉或換一個再送出');
      });
      db.replaceLines(o.orderId, me.userId, lines);
      return { lines: lines };
    });
  },

  listStores: function (p, me, deps) {
    return deps.db.listStores();
  },

  readMenu: function (p, me, deps) {
    var images = p.images;
    if (!Array.isArray(images) || images.length < 1 || images.length > 4) {
      throw appError('INVALID', '請上傳 1～4 張菜單照片');
    }
    images.forEach(function (img) {
      if (!img || typeof img.data !== 'string' || !/^image\//.test(String(img.mimeType))) {
        throw appError('INVALID', '照片格式不對');
      }
    });
    var raw = deps.readMenu(images);
    var menu = normalizeMenu(raw, { fromAi: true });
    return { menu: menu, note: readNote_(raw && raw._ai, menu) };
  },

  saveStore: function (p, me, deps, now) {
    var db = deps.db;
    var name = str_(p.name);
    if (!name) throw appError('INVALID', '請填店名');
    var menu = normalizeMenu(p.menu, { clearUnsure: true });
    return db.withLock(function () {
      if (p.storeId && !db.getStore(p.storeId)) throw appError('NOT_FOUND', '找不到這家店');
      return db.saveStore({ storeId: p.storeId || '', name: name, menu: menu, updatedAt: taipeiIso(now) });
    });
  },

  createOrder: function (p, me, deps, now) {
    var db = deps.db;
    checkDeadline_(p.deadline);
    if (Date.parse(p.deadline) <= now) throw appError('INVALID', '截止時間要晚於現在');
    var store = p.storeId ? db.getStore(p.storeId) : null;
    if (!store) throw appError('NOT_FOUND', '找不到這家店');
    return db.withLock(function () {
      return db.createOrder({
        storeId: store.storeId, storeName: store.name, menu: store.menu,
        deadline: p.deadline, createdBy: me.userId, createdAt: taipeiIso(now), soldOut: normalizeSoldOut(p.soldOut)
      });
    });
  },

  listOrders: function (p, me, deps, now) {
    var people = {};
    deps.db.listAllLines().forEach(function (l) {
      people[l.orderId] = people[l.orderId] || {};
      people[l.orderId][l.userId] = true;
    });
    return deps.db.listOrders()
      .sort(function (a, b) { return a.deadline < b.deadline ? 1 : a.deadline > b.deadline ? -1 : 0; })
      .map(function (o) {
        var v = orderView_(o, now, false);
        v.peopleCount = Object.keys(people[o.orderId] || {}).length;
        return v;
      });
  },

  setDeadline: function (p, me, deps) {
    var db = deps.db;
    checkDeadline_(p.deadline);
    return db.withLock(function () {
      mustOrder_(db, p.orderId);
      return db.updateOrder(p.orderId, { deadline: p.deadline });
    });
  },

  summary: function (p, me, deps, now) {
    var o = mustOrder_(deps.db, p.orderId);
    var lines = deps.db.getLines(o.orderId);
    // 已經點了現在暫停的東西的人，統計頁用紅字列出來讓行政處理
    var affected = tallyByPerson(lines.filter(function (l) { return soldOutReason(o.menu, o.soldOut, l); }))
      .map(function (p) {
        return { userId: p.userId, userName: p.userName, labels: p.lines.map(function (l) { return l.label; }) };
      });
    return {
      order: orderView_(o, now, true), store: tallyForStore(lines), people: tallyByPerson(lines), lines: lines,
      affected: affected,
      members: deps.db.listMembers().map(function (m) { return { userId: m.userId, name: m.name }; }) // 讓行政幫還沒點的人新增
    };
  },

  setSoldOut: function (p, me, deps, now) {
    var db = deps.db;
    return db.withLock(function () {
      mustOrder_(db, p.orderId);
      return orderView_(db.updateOrder(p.orderId, { soldOut: normalizeSoldOut(p.soldOut) }), now, false);
    });
  },

  setLinesFor: function (p, me, deps, now) {
    var db = deps.db;
    var target = db.listMembers().filter(function (m) { return m.userId === p.userId; })[0];
    if (!target) throw appError('NOT_FOUND', '找不到這位同仁');
    return db.withLock(function () {
      var o = mustOrder_(db, p.orderId);
      var lines = resolveAll_(o, target.userId, target.name, p.lines, now);
      db.replaceLines(o.orderId, target.userId, lines);
      return { lines: lines };
    });
  },

  monthly: function (p, me, deps) {
    if (!/^\d{4}-\d{2}$/.test(String(p.month))) throw appError('INVALID', '月份格式不對');
    return monthlyReport(deps.db.listOrders(), deps.db.listAllLines(), deps.db.listMembers(), p.month);
  }
};
