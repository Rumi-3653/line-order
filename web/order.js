// 點餐頁（草圖 A）＋購物車編輯元件。行政在統計頁修改別人的單時也共用 renderCartEditor。

function toInput_(l) {
  return { itemId: l.itemId, variant: l.variant, choices: l.choices, qty: l.qty, note: l.note || '', forWhom: l.forWhom || '' };
}

function pendingKey_(orderId) {
  return 'pendingCart:' + orderId;
}

// 重新登入前暫存的購物車，取出後就刪掉
function takePendingCart_(orderId) {
  var raw = sessionStorage.getItem(pendingKey_(orderId));
  sessionStorage.removeItem(pendingKey_(orderId));
  try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}

function notifyGroup_() {
  if (state.demo) return;
  try {
    var ctx = liff.getContext();
    if (ctx && ['group', 'room', 'utou'].indexOf(ctx.type) >= 0) {
      liff.sendMessages([{ type: 'text', text: '✅ 已點餐' }]).catch(function () { /* 發不出去不影響點餐 */ });
    }
  } catch (e) { /* 同上 */ }
}

function showOrder(orderId) {
  return api('bootstrap', { orderId: orderId }).then(function (b) {
    state.me = b.me;
    var o = b.order;
    var hadSaved = b.myLines.length > 0;
    var saved = JSON.stringify(b.myLines.map(toInput_)); // 伺服器上真正存著的內容，用來判斷畫面上的有沒有送出
    var cart = takePendingCart_(orderId) || b.myLines.map(toInput_);
    render_('<header class="bar"><div><div class="title">🍱 ' + esc_(o.storeName) + '</div>' +
      '<div class="sub" id="deadline"></div></div>' +
      (b.me.isAdmin ? '<a class="link" href="' + linkWith_({ admin: '1', o: orderId }) + '">看統計</a>' : '') +
      '</header><main id="editor"></main>');
    state.onRelogin = function () { sessionStorage.setItem(pendingKey_(orderId), JSON.stringify(cart)); };

    function draw(open) {
      // 截止可能是行政剛提早的，頁面上的時間不一定準，所以截止後只寫「已截止」
      document.getElementById('deadline').textContent = open ? '截止 ' + fmtTime_(o.deadline) : '已截止';
      renderCartEditor(document.getElementById('editor'), o.menu, cart, {
        soldOut: o.soldOut,
        readOnly: !open,
        notice: function (lines) {
          var dirty = JSON.stringify(lines) !== saved;
          if (!open) return dirty ? '已截止。下面有修改沒有送出成功，要改請找行政' : '已截止，要修改請找行政';
          return dirty ? '下面的內容還沒送出，記得按下方按鈕' : '';
        },
        saveLabel: function (lines) {
          if (!lines.length) return hadSaved ? '取消我的點餐' : '';
          return hadSaved ? '更新我的點餐' : '送出';
        },
        onChange: function (lines) { cart = lines; },
        onSave: function (lines) {
          return api('saveMyLines', { orderId: orderId, lines: lines }).then(function () {
            if (!hadSaved && lines.length) notifyGroup_();
            toast_(lines.length ? '✅ 已送出' : '已取消點餐');
            hadSaved = lines.length > 0;
            saved = JSON.stringify(lines);
            draw(true);
          }, function (e) {
            if (e.code !== 'CLOSED') throw e;
            draw(false); // 截止了：轉唯讀，購物車內容照樣顯示
          });
        }
      });
    }
    draw(o.open);
  });
}

function priceText_(item) {
  var prices = item.variants.map(function (v) { return v.price; });
  return item.variants.length > 1 ? money_(Math.min.apply(null, prices)) + ' 起' : money_(prices[0]);
}

// opts: { onSave(lines) → Promise, saveLabel(lines) → 按鈕文字（'' = 不能送）, onChange(lines), readOnly,
//         notice（字串，或 function(lines) → 字串）, title, soldOut（這張單暫停供應的品項／選項） }
function renderCartEditor(container, menu, lines, opts) {
  var cart = lines.map(toInput_);
  var cat = 0;
  var so = normalizeSoldOut(opts.soldOut);

  function draw() {
    var total = 0;
    var items = cart.map(function (l, i) {
      var r;
      try { r = resolveLine(menu, l); } catch (e) {
        return '<li class="bad"><span>菜單改過了，這項請刪掉重點</span>' +
          (opts.readOnly ? '' : '<button class="x" data-del="' + i + '" aria-label="刪除">×</button>') + '</li>';
      }
      var paused = soldOutReason(menu, so, l);
      if (paused && !opts.readOnly) {
        return '<li class="bad"><span>' + esc_(r.label) + ' ×' + r.qty + '<br>' + esc_(paused) + '，請刪掉重點</span>' +
          '<button class="x" data-del="' + i + '" aria-label="刪除">×</button></li>';
      }
      total += r.unitPrice * r.qty;
      return '<li><div><b>' + esc_(r.label) + '</b> ×' + r.qty +
        (r.forWhom ? ' <span class="tag">幫 ' + esc_(r.forWhom) + '</span>' : '') +
        (r.note ? '<div class="sub">' + esc_(r.note) + '</div>' : '') + '</div>' +
        '<div class="right">' + money_(r.unitPrice * r.qty) +
        (opts.readOnly ? '' : '<button class="x" data-del="' + i + '" aria-label="刪除">×</button>') + '</div></li>';
    }).join('');
    var label = opts.readOnly ? '' : opts.saveLabel(cart);
    var notice = typeof opts.notice === 'function' ? opts.notice(cart) : opts.notice;
    var hasPaused = !opts.readOnly && cart.some(function (l) { return soldOutReason(menu, so, l); });
    container.innerHTML =
      (hasPaused ? '<div class="notice bad-notice">有東西今日暫停供應，請把標紅的刪掉再送出</div>' : '') +
      (notice ? '<div class="notice">' + esc_(notice) + '</div>' : '') +
      (opts.readOnly ? '' :
        '<nav class="tabs">' + menu.categories.map(function (c, i) {
          return '<button data-cat="' + i + '" class="' + (i === cat ? 'on' : '') + '">' + esc_(c.name) + '</button>';
        }).join('') + '</nav>' +
        '<ul class="menu">' + menu.categories[cat].items.map(function (it) {
          if (so.items.indexOf(it.id) >= 0) {
            return '<li class="paused"><span>' + esc_(it.name) + '</span><span class="right">今日暫停</span></li>';
          }
          return '<li data-item="' + esc_(it.id) + '"><span>' + esc_(it.name) +
            (it.groups.length ? ' <span class="sub">可選</span>' : '') + '</span>' +
            '<span class="right">' + priceText_(it) + '<span class="plus">＋</span></span></li>';
        }).join('') + '</ul>') +
      '<section class="cart"><h3>' + esc_(opts.title || (opts.readOnly ? '點餐內容' : '我的點餐')) + '</h3>' +
      (cart.length ? '<ul>' + items + '</ul><div class="total">合計 ' + money_(total) + '</div>' :
        '<div class="sub">還沒有點東西</div>') + '</section>' +
      (opts.readOnly ? '' : '<div class="actions"><button class="primary" id="save"' + (label ? '' : ' disabled') + '>' +
        esc_(label || '送出') + '</button></div>');
  }

  function changed() {
    if (opts.onChange) opts.onChange(cart.slice());
    draw();
  }

  container.onclick = function (ev) {
    var t = ev.target.closest('[data-cat],[data-item],[data-del],#save');
    if (!t) return;
    if (t.dataset.cat) { cat = Number(t.dataset.cat); draw(); return; }
    if (t.dataset.item) {
      var item = findItem_(menu, t.dataset.item);
      openPicker_(menu, item, function (input) { cart.push(input); changed(); }, so);
      return;
    }
    if (t.dataset.del) { cart.splice(Number(t.dataset.del), 1); changed(); return; }
    t.disabled = true;
    t.textContent = '送出中…';
    opts.onSave(cart.slice()).catch(function (e) {
      toast_(e.message);
      draw();
    });
  };
  draw();
}

// 選品項的面板：份量、選項、數量、備註、幫誰點；so 裡暫停的選項變灰不能選
function openPicker_(menu, item, onAdd, so) {
  so = normalizeSoldOut(so);
  var sel = { itemId: item.id, variant: item.variants[0].label, choices: item.groups.map(function () { return []; }),
    qty: 1, note: '', forWhom: '' };
  var bg = document.createElement('div');
  bg.className = 'sheet-bg';
  document.body.appendChild(bg);

  function close() { bg.remove(); }
  function draw() {
    var r = null, err = '';
    try { r = resolveLine(menu, sel); } catch (e) { err = e.message; }
    bg.innerHTML = '<div class="sheet"><div class="sheet-head"><b>' + esc_(item.name) + '</b>' +
      '<button class="x" data-close aria-label="關閉">×</button></div>' +
      (item.variants.length > 1 ? '<div class="sub">份量</div><div class="chips">' + item.variants.map(function (v) {
        return '<button class="chip' + (v.label === sel.variant ? ' on' : '') + '" data-variant="' + esc_(v.label) + '">' +
          esc_(v.label) + ' ' + money_(v.price) + '</button>';
      }).join('') + '</div>' : '') +
      item.groups.map(function (g, gi) {
        return '<div class="sub">' + esc_(g.name) + '（選 ' + (g.min === g.max ? g.max : g.min + '～' + g.max) +
          '，已選 ' + sel.choices[gi].length + '）</div><div class="chips">' + g.choices.map(function (c) {
            if (so.choices.indexOf(g.name + '/' + c.label) >= 0) {
              return '<button class="chip off" data-paused>' + esc_(c.label) + '（暫停）</button>';
            }
            var on = sel.choices[gi].indexOf(c.label) >= 0;
            return '<button class="chip' + (on ? ' on' : '') + '" data-group="' + gi + '" data-choice="' + esc_(c.label) + '">' +
              esc_(c.label) + (c.delta ? ' +' + c.delta : '') + (on ? ' ✓' : '') + '</button>';
          }).join('') + '</div>';
      }).join('') +
      '<div class="row"><span class="sub">數量</span><span class="stepper">' +
      '<button data-qty="-1" aria-label="少一份">−</button><b>' + sel.qty + '</b><button data-qty="1" aria-label="多一份">＋</button></span></div>' +
      '<input id="p-note" placeholder="備註（例：飯少）" maxlength="100" value="' + esc_(sel.note) + '">' +
      '<input id="p-for" placeholder="幫誰點（自己吃免填）" maxlength="20" value="' + esc_(sel.forWhom) + '">' +
      '<button class="primary" id="p-add"' + (r ? '' : ' disabled') + '>' +
      (r ? '加入　' + money_(r.unitPrice * r.qty) : esc_(err)) + '</button></div>';
  }

  bg.onclick = function (ev) {
    if (ev.target === bg || ev.target.closest('[data-close]')) { close(); return; }
    var t = ev.target.closest('[data-variant],[data-group],[data-qty],#p-add');
    if (!t) return;
    sel.note = bg.querySelector('#p-note').value;
    sel.forWhom = bg.querySelector('#p-for').value;
    if (t.id === 'p-add') { onAdd(JSON.parse(JSON.stringify(sel))); close(); return; }
    if (t.dataset.variant != null) sel.variant = t.dataset.variant;
    if (t.dataset.qty) sel.qty = Math.min(50, Math.max(1, sel.qty + Number(t.dataset.qty)));
    if (t.dataset.group) {
      var g = item.groups[Number(t.dataset.group)], picked = sel.choices[Number(t.dataset.group)];
      var at = picked.indexOf(t.dataset.choice);
      if (at >= 0) picked.splice(at, 1);
      else if (picked.length < g.max) picked.push(t.dataset.choice);
      else if (g.max === 1) picked.splice(0, 1, t.dataset.choice);
      else toast_(g.name + '最多選 ' + g.max + ' 項');
    }
    draw();
  };
  draw();
}
