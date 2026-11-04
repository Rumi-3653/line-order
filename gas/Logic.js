// 純邏輯：菜單整理、算價、統計。GAS、瀏覽器、node 測試三邊共用——頂層只能有 function/var 宣告。

function appError(code, message) {
  var e = new Error(message || code);
  e.code = code;
  return e;
}

function str_(v) {
  return v == null ? '' : String(v).trim();
}

// 140 / "$170" / "1,000" / " 50 " / "+10" → 整數；"時價"、空字串 → null
function toAmount(v) {
  if (typeof v === 'number') return isFinite(v) && v >= 0 ? Math.round(v) : null;
  var s = str_(v).replace(/^\+/, '').replace(/NT|[\s,$＄元]/g, '');
  return /^\d+$/.test(s) ? Number(s) : null;
}

function clampInt_(v, lo, hi, dflt) {
  var n = parseInt(v, 10);
  if (isNaN(n)) n = dflt;
  return Math.min(Math.max(n, lo), hi);
}

function isObj_(x) {
  return !!x && typeof x === 'object';
}

// AI 有時把陣列寫成單一物件：陣列照用、物件包成陣列、其他當空陣列
function list_(x) {
  return Array.isArray(x) ? x : isObj_(x) ? [x] : [];
}

// flag（選填）：讀不懂加價時把 flag.unsure 設成 true
function normalizeGroup_(g, flag) {
  if (!isObj_(g)) return null;
  var raw = typeof g.choices === 'string' ? g.choices.split(/[、,，]/) : list_(g.choices);
  var seen = {}, choices = [];
  raw.forEach(function (c) {
    var label = str_(isObj_(c) ? c.label : c);
    if (!label || seen[label]) return; // 重複的選項直接合併
    seen[label] = true;
    var delta = isObj_(c) && str_(c.delta) !== '' ? toAmount(c.delta) : 0;
    if (delta === null) { delta = 0; if (flag) flag.unsure = true; }
    choices.push({ label: label, delta: delta });
  });
  if (!choices.length) return null;
  var min = clampInt_(g.min, 0, choices.length, 0);
  var max = clampInt_(g.max, min, choices.length, Math.max(min, 1));
  return { name: str_(g.name) || '選項', min: min, max: max, choices: choices };
}

// 價格寫「-」、空白或 0 代表店家沒賣這個份量（「時價」不算：有賣只是沒標價）
function notSold_(price) {
  return price == null || toAmount(price) === 0 || /^\s*([-－—–‐~～xX×]|無|沒有)?\s*$/.test(String(price));
}

// 品項自己的選項優先，再補上分類共用、整張菜單共用的（同名的不重複加）
function mergeGroups_(own, shared) {
  var names = {}, out = [];
  own.concat(shared).forEach(function (g) {
    if (names[g.name]) return;
    names[g.name] = true;
    out.push(JSON.parse(JSON.stringify(g)));
  });
  return out;
}

// 把 AI 讀出來或行政編輯過的菜單整理成固定形狀；不改動傳入的物件。
// 品名重複、同品項份量名稱重複會讓統計混在一起：讀取時標 unsure，clearUnsure（存檔）時直接擋下。
// 最外層與分類上的 groups（糖量、冰量、配料）是共用選項，會複製進每個品項，之後就跟品項自己的選項一樣處理。
function normalizeMenu(raw, opts) {
  var clear = !!(opts && opts.clearUnsure);
  var fromAi = !!(opts && opts.fromAi); // AI 剛讀出來的：價格「-」或 0 的份量當作沒賣
  var used = {}, needId = [], out = [], byName = {}, problems = [];
  var menuFlag = { unsure: false };
  var menuGroups = list_(raw && raw.groups).map(function (g) { return normalizeGroup_(g, menuFlag); }).filter(Boolean);
  list_(raw && raw.categories).forEach(function (c) {
    var items = [];
    var catFlag = { unsure: false };
    var catGroups = list_(c && c.groups).map(function (g) { return normalizeGroup_(g, catFlag); }).filter(Boolean);
    list_(c && c.items).forEach(function (it) {
      var name = str_(isObj_(it) ? it.name : '');
      if (!name) return;
      var flag = { unsure: !!it.unsure || catFlag.unsure || menuFlag.unsure };
      var rawVariants = list_(it.variants).map(function (v) { return isObj_(v) ? v : { label: '', price: v }; });
      if (!rawVariants.length) rawVariants = [{ label: '', price: it.price }]; // 只寫了單一價格，或根本沒價格
      // 只在剛讀進 AI 結果時判斷（存過的菜單裡的 0 是行政確認過的，不能動）
      if (fromAi && rawVariants.some(function (v) { return toAmount(v.price) > 0; })) {
        rawVariants = rawVariants.filter(function (v) { return !notSold_(v.price); });
      }
      var labels = {};
      var variants = rawVariants.map(function (v) {
        var price = toAmount(v.price);
        if (price === null) { price = 0; flag.unsure = true; }
        var label = str_(v.label);
        if (labels[label]) problems.push({ names: [name], msg: '「' + name + '」有兩個份量都叫「' + (label || '空白') + '」，請改成不同名稱' });
        labels[label] = true;
        return { label: label, price: price };
      });
      var item = {
        id: str_(it.id), name: name, variants: variants,
        groups: mergeGroups_(list_(it.groups).map(function (g) { return normalizeGroup_(g, flag); }).filter(Boolean),
          catGroups.concat(menuGroups)),
        unsure: flag.unsure
      };
      if (byName[name]) problems.push({ names: [name], msg: '「' + name + '」出現兩次，請改成不同名稱（例如加上分類）' });
      byName[name] = true;
      if (item.id && !used[item.id]) used[item.id] = true; else needId.push(item);
      items.push(item);
    });
    if (items.length) out.push({ name: str_(c.name) || '其他', items: items });
  });
  if (!out.length) throw appError('INVALID', '菜單裡沒有任何品項');
  if (clear && problems.length) {
    throw appError('INVALID', problems.map(function (p) { return p.msg; }).filter(function (m, i, all) {
      return all.indexOf(m) === i;
    }).join('；'));
  }
  var flagged = {};
  problems.forEach(function (p) { flagged[p.names[0]] = true; });
  out.forEach(function (c) {
    c.items.forEach(function (it) { it.unsure = clear ? false : it.unsure || !!flagged[it.name]; });
  });
  var n = 0;
  needId.forEach(function (item) {
    do { n++; } while (used['i' + n]);
    item.id = 'i' + n;
    used[item.id] = true;
  });
  return { categories: out };
}

// 行政貼上 Claude 在對話裡整理好的菜單：可能包在 ```json 裡、前後有說明文字，取第一個 { 到最後一個 } 解析
function parseMenuPaste(text) {
  var s = str_(text), a = s.indexOf('{'), b = s.lastIndexOf('}'), raw = null;
  try { raw = JSON.parse(s.slice(a, b + 1)); } catch (e) { /* 下面統一報錯 */ }
  if (a < 0 || !isObj_(raw)) throw appError('INVALID', '貼上的內容不是完整的菜單，請把整段重新複製再貼一次');
  return { name: str_(raw.name), menu: normalizeMenu(raw, { fromAi: true }) };
}

// 存進試算表前去掉預設值（空份量名、加價 0、沒選項、unsure false），normalizeMenu 讀回時會補回來
function compactMenu(menu) {
  return {
    categories: menu.categories.map(function (c) {
      return {
        name: c.name,
        items: c.items.map(function (it) {
          var o = {
            id: it.id, name: it.name,
            variants: it.variants.map(function (v) { return v.label ? { label: v.label, price: v.price } : { price: v.price }; })
          };
          if (it.groups.length) {
            o.groups = it.groups.map(function (g) {
              return {
                name: g.name, min: g.min, max: g.max,
                choices: g.choices.map(function (ch) { return ch.delta ? { label: ch.label, delta: ch.delta } : { label: ch.label }; })
              };
            });
          }
          if (it.unsure) o.unsure = true;
          return o;
        })
      };
    })
  };
}

function findItem_(menu, itemId) {
  var found = null;
  ((menu && menu.categories) || []).forEach(function (c) {
    c.items.forEach(function (it) { if (!found && it.id === itemId) found = it; });
  });
  return found;
}

function rangeText_(g) {
  return (g.min === g.max ? g.min : g.min + '～' + g.max) + ' 項';
}

// 驗證一行點餐並算出單價與統一的品項名稱（選項依菜單順序排，所以先選哪個都算同一項）。
function resolveLine(menu, input) {
  input = input || {};
  var item = findItem_(menu, input.itemId);
  if (!item) throw appError('INVALID', '找不到這個品項，菜單可能改過了');
  var variant = null;
  item.variants.forEach(function (v) { if (!variant && v.label === str_(input.variant)) variant = v; });
  if (!variant) throw appError('INVALID', item.name + '：份量不對');
  var qty = input.qty;
  if (typeof qty !== 'number' || qty % 1 !== 0 || qty < 1 || qty > 50) {
    throw appError('INVALID', item.name + '：數量要是 1～50');
  }
  var picked = Array.isArray(input.choices) ? input.choices : [];
  var price = variant.price, parts = [], choices = [];
  item.groups.forEach(function (g, gi) {
    var sel = Array.isArray(picked[gi]) ? picked[gi].map(str_) : [];
    var seen = {};
    sel.forEach(function (label) {
      if (seen[label]) throw appError('INVALID', g.name + '：選項重複了');
      seen[label] = true;
    });
    var ordered = g.choices.filter(function (c) { return seen[c.label]; });
    if (ordered.length !== sel.length) throw appError('INVALID', g.name + '：有菜單上沒有的選項');
    if (sel.length < g.min || sel.length > g.max) throw appError('INVALID', g.name + '：要選 ' + rangeText_(g));
    var labels = ordered.map(function (c) { price += c.delta; return c.label; });
    choices.push(labels);
    if (labels.length) parts.push(labels.join('＋'));
  });
  return {
    itemId: item.id, variant: variant.label, choices: choices, qty: qty,
    note: str_(input.note).slice(0, 100), forWhom: str_(input.forWhom).slice(0, 20),
    unitPrice: price,
    label: item.name + (variant.label ? ' ' + variant.label : '') + (parts.length ? '（' + parts.join('；') + '）' : '')
  };
}

// ---- 暫停供應（只對單張訂單，不動菜單庫）----
// soldOut = { items: [itemId], choices: ['選項群組名/選項'] }；選項依名稱比對，所以「加料/波霸」會停掉每杯飲料的波霸
function normalizeSoldOut(x) {
  function uniq(list) {
    var seen = {};
    return (Array.isArray(list) ? list : []).map(str_).filter(function (s) {
      if (!s || seen[s]) return false;
      seen[s] = true;
      return true;
    });
  }
  return { items: uniq(x && x.items), choices: uniq(x && x.choices) };
}

// 這一行點餐碰到暫停的品項或選項就回傳原因，沒有就回 ''
function soldOutReason(menu, soldOut, line) {
  var so = normalizeSoldOut(soldOut);
  var item = findItem_(menu, line.itemId);
  if (!item) return '';
  if (so.items.indexOf(item.id) >= 0) return '「' + item.name + '」今日暫停供應';
  var hit = '';
  item.groups.forEach(function (g, gi) {
    ((line.choices || [])[gi] || []).forEach(function (label) {
      if (!hit && so.choices.indexOf(g.name + '/' + label) >= 0) hit = '「' + label + '」今日暫停供應';
    });
  });
  return hit;
}

// ---- 截止與統計 ----
function isOpen(order, nowMs) {
  return nowMs < Date.parse(order.deadline);
}

// 依 key 分組並保留第一次出現的順序
function groupBy_(list, keyFn) {
  var map = {}, keys = [];
  list.forEach(function (x) {
    var k = keyFn(x);
    if (!map[k]) { map[k] = []; keys.push(k); }
    map[k].push(x);
  });
  return keys.map(function (k) { return { key: k, items: map[k] }; });
}

function sum_(list, fn) {
  return list.reduce(function (s, x) { return s + fn(x); }, 0);
}

function lineAmount_(l) {
  return l.unitPrice * l.qty;
}

// 給店家：每個品項幾份、備註彙總
function tallyForStore(lines) {
  var rows = groupBy_(lines, function (l) { return l.label; }).map(function (g) {
    return { label: g.key, qty: sum_(g.items, function (l) { return l.qty; }) };
  });
  rows.sort(function (a, b) { return b.qty - a.qty; }); // 穩定排序：同份數維持出現順序
  var noted = lines.filter(function (l) { return l.note; });
  return {
    rows: rows,
    notes: groupBy_(noted, function (l) { return l.note; }).map(function (g) {
      return { text: g.key, count: sum_(g.items, function (l) { return l.qty; }) };
    }),
    totalQty: sum_(lines, function (l) { return l.qty; }),
    totalAmount: sum_(lines, lineAmount_)
  };
}

// 給收錢：每人點了什麼、應付多少（代點算在下單的人身上）
function tallyByPerson(lines) {
  return groupBy_(lines, function (l) { return l.userId; }).map(function (g) {
    return {
      userId: g.key,
      userName: g.items[g.items.length - 1].userName,
      amount: sum_(g.items, lineAmount_),
      lines: g.items.map(function (l) {
        return { label: l.label, qty: l.qty, unitPrice: l.unitPrice, note: l.note, forWhom: l.forWhom };
      })
    };
  });
}

// 月報：month = 'YYYY-MM'，以截止時間所在月份計
function monthlyReport(orders, lines, members, month) {
  var inMonth = orders.filter(function (o) { return String(o.deadline).slice(0, 7) === month; });
  var ids = {};
  inMonth.forEach(function (o) { ids[o.orderId] = true; });
  var names = {};
  members.forEach(function (m) { names[m.userId] = m.name; });
  var people = tallyByPerson(lines.filter(function (l) { return ids[l.orderId]; })).map(function (p) {
    return { userId: p.userId, name: names[p.userId] || p.userName, amount: p.amount };
  });
  people.sort(function (a, b) { return b.amount - a.amount; });
  var stores = groupBy_(inMonth, function (o) { return o.storeName; }).map(function (g) {
    return { storeName: g.key, count: g.items.length };
  });
  stores.sort(function (a, b) { return b.count - a.count; });
  return { people: people, stores: stores };
}

// ---- 行政編輯器用的文字格式 ----
// 價格：「140」或「份 50 / 條 130」。斜線兩側有空白、或「數字/非數字」才算分隔，所以「1/4 280」不會被拆開。
function formatVariants(variants) {
  return variants.map(function (v) { return (v.label ? v.label + ' ' : '') + v.price; }).join(' / ');
}

function parseVariants(text) {
  // 先把「數字/非數字」補成有空白的分隔，再依「有空白的斜線」切（不用 lookbehind：iOS 16.4 以前的 LINE 內建瀏覽器不支援）
  var segs = str_(text).replace(/(\d)\/(?=\D)/g, '$1 / ').split(/\s+\/\s*|\s*\/\s+/).map(str_).filter(Boolean);
  if (!segs.length) throw appError('INVALID', '請填價格');
  return segs.map(function (s) {
    var m = s.match(/^(.*?)\s*(?:NT)?[$＄]?\s*(\d[\d,]*)\s*元?$/);
    if (!m) throw appError('INVALID', '看不懂價格「' + s + '」');
    return { label: str_(m[1]), price: toAmount(m[2]) };
  });
}

// 選項：一行一組，「名稱 最少[-最多]: 選項、選項+加價」
function formatGroups(groups) {
  return groups.map(function (g) {
    return g.name + ' ' + (g.min === g.max ? g.min : g.min + '-' + g.max) + ': ' +
      g.choices.map(function (c) { return c.label + (c.delta ? '+' + c.delta : ''); }).join('、');
  }).join('\n');
}

function parseGroups(text) {
  return str_(text).split(/\n/).map(str_).filter(Boolean).map(function (line) {
    var m = line.match(/^(.*?)\s*(\d+)(?:\s*-\s*(\d+))?\s*[:：]\s*(.+)$/);
    if (!m) throw appError('INVALID', '看不懂選項「' + line + '」，格式是「名稱 數量: 選項、選項」');
    var choices = m[4].split(/[、,，]/).map(str_).filter(Boolean).map(function (c) {
      var d = c.match(/^(.*?)\s*\+\s*(\d+)$/);
      return d ? { label: d[1], delta: Number(d[2]) } : { label: c, delta: 0 };
    });
    var g = normalizeGroup_({ name: m[1], min: m[2], max: m[3] || m[2], choices: choices });
    if (!g) throw appError('INVALID', '「' + line + '」沒有選項');
    return g;
  });
}
