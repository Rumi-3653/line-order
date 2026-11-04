// 行政頁：首頁、開單流程（上傳菜單 → AI 讀 → 校對 → 截止時間 → 發卡片）、統計與月報。

function app_() {
  return document.getElementById('app');
}

function adminHeader_(title, withBack) {
  return '<header class="bar"><div class="title">' + esc_(title) + '</div>' +
    (withBack ? '<button class="link plain" data-back>‹ 回首頁</button>' : '') + '</header>';
}

// 每個畫面註冊自己的點擊處理；data-back 一律回首頁
function onClick_(fn) {
  app_().onclick = function (ev) {
    if (ev.target.closest('[data-back]')) { showAdmin(); return; }
    fn(ev);
  };
}

function busy_(btn, text) {
  btn.disabled = true;
  btn.dataset.label = btn.textContent;
  btn.textContent = text;
}

function unbusy_(btn) {
  btn.disabled = false;
  btn.textContent = btn.dataset.label;
}

// ---- 首頁 ----
function showAdmin() {
  render_('<div class="loading">載入中…</div>');
  return api('listOrders', {}).then(function (orders) {
    orders.sort(function (a, b) { return b.open - a.open; }); // 進行中的排前面（穩定排序，其餘維持新到舊）
    render_(adminHeader_('訂餐管理', false) +
      '<div class="card stack"><button class="primary" id="new">開新單</button>' +
      '<button class="ghost" id="monthly">月報</button></div>' +
      '<div class="card"><h3>訂單</h3>' + (orders.length ? '<ul class="list">' + orders.map(function (o) {
        return '<li data-o="' + esc_(o.orderId) + '"><div><b>' + esc_(o.storeName) + '</b><div class="sub">' +
          (o.open ? '進行中・截止 ' : '已截止・') + fmtTime_(o.deadline) + '</div></div>' +
          '<div class="right">' + o.peopleCount + ' 人 ›</div></li>';
      }).join('') + '</ul>' : '<div class="sub">還沒有訂單</div>') + '</div>');
    onClick_(function (ev) {
      var t = ev.target.closest('[data-o],#new,#monthly');
      if (!t) return;
      if (t.id === 'new') showNewOrder();
      else if (t.id === 'monthly') showMonthly();
      else showSummary(t.dataset.o);
    });
  }).catch(showError_);
}

// ---- 開單：選店家 ----
function showNewOrder() {
  render_('<div class="loading">載入中…</div>');
  return api('listStores', {}).then(function (stores) {
    render_(adminHeader_('開新單', true) +
      '<div class="card"><h3>已存的店家</h3>' + (stores.length ? '<ul class="list">' + stores.map(function (s, i) {
        return '<li data-store="' + i + '"><div><b>' + esc_(s.name) + '</b><div class="sub">菜單更新於 ' +
          esc_(String(s.updatedAt).slice(0, 10)) + '</div></div><div class="right">›</div></li>';
      }).join('') + '</ul>' : '<div class="sub">還沒有存過的店家</div>') + '</div>' +
      '<div class="card stack"><h3>新店家</h3><input id="store-name" placeholder="店名" maxlength="40">' +
      '<label class="ghost upload">📷 上傳菜單照片（最多 4 張）' +
      '<input type="file" id="photos" accept="image/*" multiple hidden></label>' +
      '<button class="ghost" id="paste">📋 貼上 Claude 整理好的菜單</button>' +
      '<button class="ghost" id="manual">手動輸入菜單</button></div>');

    function newName() {
      var name = document.getElementById('store-name').value.trim();
      if (!name) toast_('請先填店名');
      return name;
    }
    onClick_(function (ev) {
      var t = ev.target.closest('[data-store],#manual,#paste');
      if (!t) return;
      if (t.dataset.store) { showMenuEditor(stores[Number(t.dataset.store)]); return; }
      if (t.id === 'paste') { showPasteMenu_(document.getElementById('store-name').value.trim()); return; }
      var name = newName();
      if (name) showMenuEditor({ storeId: '', name: name, menu: blankMenu_() });
    });
    document.getElementById('photos').onchange = function (ev) {
      var files = Array.prototype.slice.call(ev.target.files || []);
      ev.target.value = '';
      if (!files.length) return;
      var name = newName();
      if (!name) return;
      if (files.length > 4) { toast_('最多 4 張照片'); return; }
      render_(adminHeader_('開新單', true) + '<div class="loading">AI 讀菜單中…（通常 10～60 秒；最多等 100 秒，超過會自動停下來）</div>');
      Promise.all(files.map(compressImage_)).then(function (images) {
        return api('readMenu', { images: images }, { timeoutMs: 100000 });
      }).then(function (r) {
        showMenuEditor({ storeId: '', name: name, menu: r.menu }, r.note);
      }).catch(function (e) {
        render_(adminHeader_('開新單', true) + '<div class="card"><div class="notice">' + esc_(e.message) + '</div>' +
          '<button class="primary" id="manual2">改用手動輸入</button></div>');
        onClick_(function (ev2) {
          if (ev2.target.closest('#manual2')) showMenuEditor({ storeId: '', name: name, menu: blankMenu_() });
        });
      });
    };
  }).catch(showError_);
}

// 把 Claude 在對話裡整理好的菜單整段貼上；店名沒填就用貼上內容裡的 name
function showPasteMenu_(name) {
  render_(adminHeader_('貼上菜單', true) +
    '<div class="card stack"><div class="sub">把 Claude 給你的那一整段菜單複製下來，整段貼在下面（前後有說明文字或 ``` 都沒關係）。</div>' +
    '<textarea id="paste-text" rows="10" placeholder="在這裡貼上"></textarea></div>' +
    '<div class="actions"><button class="primary" id="paste-go">匯入，下一步</button></div>');
  onClick_(function (ev) {
    if (!ev.target.closest('#paste-go')) return;
    try {
      var r = parseMenuPaste(document.getElementById('paste-text').value);
      showMenuEditor({ storeId: '', name: name || r.name, menu: r.menu }, '從貼上的菜單' + readNote_(null, r.menu));
    } catch (e) {
      toast_(e.message);
    }
  });
}

function blankMenu_() {
  return { categories: [{ name: '餐點', items: [{ id: '', name: '', variants: [], groups: [], unsure: false }] }] };
}

// 長邊縮到 1600px、轉 JPEG 0.8，回傳不含 dataURL 前綴的 base64
function compressImage_(file) {
  return new Promise(function (resolve, reject) {
    var url = URL.createObjectURL(file), img = new Image();
    img.onload = function () {
      var scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      var c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve({ mimeType: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.8).split(',')[1] });
    };
    img.onerror = function () { reject(codeError_('INVALID', '有照片讀不出來，請換一張')); };
    img.src = url;
  });
}

// ---- 開單：校對菜單 ----
// note：AI 讀菜單的摘要（模型、讀到幾項、有沒有截斷），手動輸入或選舊店時沒有
function showMenuEditor(store, note) {
  var model = store.menu.categories.map(function (c) {
    return {
      name: c.name,
      items: c.items.map(function (it) {
        return {
          id: it.id, name: it.name, unsure: !!it.unsure, error: '',
          variants: it.variants.length ? formatVariants(it.variants) : '',
          groups: formatGroups(it.groups || [])
        };
      })
    };
  });
  var storeName = store.name;

  function sync() {
    storeName = app_().querySelector('#m-name').value;
    app_().querySelectorAll('[data-cat-name]').forEach(function (el) { model[Number(el.dataset.catName)].name = el.value; });
    app_().querySelectorAll('.item').forEach(function (el) {
      var it = model[Number(el.dataset.ci)].items[Number(el.dataset.ii)];
      it.name = el.querySelector('.i-name').value;
      it.variants = el.querySelector('.i-var').value;
      it.groups = el.querySelector('.i-grp').value;
    });
  }

  function draw() {
    var unsure = 0;
    model.forEach(function (c) { c.items.forEach(function (it) { if (it.unsure) unsure++; }); });
    render_(adminHeader_('校對菜單', true) +
      (note ? '<div class="card sub">' + esc_(note) + '。請對照照片，確認每個分區都有讀到。</div>' : '') +
      (unsure ? '<div class="notice">⚠️ ' + unsure + ' 項看不清楚，請確認標黃的品項</div>' : '') +
      '<div class="card"><label class="sub">店名</label><input id="m-name" value="' + esc_(storeName) + '" maxlength="40"></div>' +
      model.map(function (c, ci) {
        return '<div class="card"><div class="cat-head"><input data-cat-name="' + ci + '" value="' + esc_(c.name) +
          '" placeholder="分類名稱"><button class="link plain" data-del-cat="' + ci + '">刪分類</button></div>' +
          c.items.map(function (it, ii) {
            return '<div class="item' + (it.unsure ? ' unsure' : '') + (it.error ? ' error' : '') + '" data-ci="' + ci + '" data-ii="' + ii + '">' +
              '<div class="item-row"><input class="i-name" placeholder="品名" value="' + esc_(it.name) + '">' +
              '<button class="x" data-del-item aria-label="刪除品項">×</button></div>' +
              '<input class="i-var" placeholder="價格，例：140 或 份 50 / 條 130" value="' + esc_(it.variants) + '">' +
              '<textarea class="i-grp" rows="1" placeholder="選項（沒有就空白）例：選兩種肉 2: 烤鴨、油雞、叉燒">' +
              esc_(it.groups) + '</textarea>' +
              (it.error ? '<div class="err">' + esc_(it.error) + '</div>' : '') + '</div>';
          }).join('') +
          '<button class="ghost small" data-add-item="' + ci + '">＋品項</button></div>';
      }).join('') +
      '<div class="card"><button class="ghost" id="add-cat">＋分類</button></div>' +
      '<div class="actions"><button class="primary" id="m-save">存菜單，下一步</button></div>');
  }

  function save(btn) {
    var errors = 0;
    var menu = {
      categories: model.map(function (c) {
        return {
          name: c.name,
          items: c.items.filter(function (it) { return it.name.trim(); }).map(function (it) {
            it.error = '';
            try {
              return { id: it.id, name: it.name, variants: parseVariants(it.variants), groups: parseGroups(it.groups) };
            } catch (e) {
              it.error = e.message;
              errors++;
              return null;
            }
          })
        };
      })
    };
    if (errors) { draw(); toast_(errors + ' 項有錯，請看紅字'); return; }
    busy_(btn, '儲存中…');
    api('saveStore', { storeId: store.storeId, name: storeName, menu: menu }).then(showDeadline_, function (e) {
      unbusy_(btn);
      toast_(e.message);
    });
  }

  onClick_(function (ev) {
    var t = ev.target.closest('[data-del-cat],[data-del-item],[data-add-item],#add-cat,#m-save');
    if (!t) return;
    sync();
    if (t.id === 'm-save') { save(t); return; }
    if (t.dataset.delCat) model.splice(Number(t.dataset.delCat), 1);
    else if (t.hasAttribute('data-del-item')) {
      var el = t.closest('.item');
      model[Number(el.dataset.ci)].items.splice(Number(el.dataset.ii), 1);
    } else if (t.dataset.addItem) {
      model[Number(t.dataset.addItem)].items.push({ id: '', name: '', variants: '', groups: '', unsure: false, error: '' });
    } else {
      model.push({ name: '', items: [{ id: '', name: '', variants: '', groups: '', unsure: false, error: '' }] });
    }
    draw();
  });
  draw();
}

// ---- 開單：截止時間 ----
function showDeadline_(store) {
  var today = taipeiIso(Date.now()).slice(0, 10);
  render_(adminHeader_('設定截止時間', true) +
    '<div class="card stack"><h3>' + esc_(store.name) + '</h3><label class="sub">截止時間</label>' +
    '<input type="datetime-local" id="dl" value="' + today + 'T11:00"></div>' +
    '<div class="actions"><button class="primary" id="create">開單</button></div>');
  onClick_(function (ev) {
    var btn = ev.target.closest('#create');
    if (!btn) return;
    var v = document.getElementById('dl').value;
    if (!v) { toast_('請選截止時間'); return; }
    busy_(btn, '開單中…');
    api('createOrder', { storeId: store.storeId, deadline: v + ':00+08:00' }).then(showShare_, function (e) {
      unbusy_(btn);
      toast_(e.message);
    });
  });
}

// ---- 發卡片到群組 ----
function buildOrderCard(order, url) {
  return {
    type: 'flex',
    altText: '🍱 ' + order.storeName + ' 開放點餐，' + fmtTime_(order.deadline) + ' 截止',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm', contents: [
          { type: 'text', text: '🍱 訂餐開放中', size: 'sm', color: '#06c755', weight: 'bold' },
          { type: 'text', text: order.storeName, size: 'xl', weight: 'bold', wrap: true },
          { type: 'text', text: '截止 ' + fmtTime_(order.deadline), size: 'sm', color: '#888888' }
        ]
      },
      footer: {
        type: 'box', layout: 'vertical', contents: [
          { type: 'button', style: 'primary', color: '#06c755', action: { type: 'uri', label: '點我點餐', uri: url } }
        ]
      }
    }
  };
}

function canShare_() {
  return !state.demo && liff.isApiAvailable('shareTargetPicker');
}

function showShare_(order) {
  var url = liffUrl('o=' + order.orderId);
  render_(adminHeader_('發到群組', true) +
    '<div class="card stack"><div class="preview-card"><div class="sub green">🍱 訂餐開放中</div>' +
    '<div class="title">' + esc_(order.storeName) + '</div><div class="sub">截止 ' + fmtTime_(order.deadline) + '</div>' +
    '<div class="fake-btn">點我點餐</div></div>' +
    (canShare_() ? '<button class="primary" id="share">選群組並發送</button>' :
      '<div class="sub">這裡不能直接發卡片，請複製連結貼到群組：</div><div class="url" id="url">' + esc_(url) + '</div>' +
      '<button class="ghost" id="copy">複製連結</button>') +
    (state.demo ? '<a class="ghost" href="' + linkWith_({ o: order.orderId }) + '">（demo）打開點餐頁</a>' : '') +
    '<button class="ghost" id="soldout">⏸ 暫停供應' + soldOutBadge_(order.soldOut) + '</button>' +
    '<button class="ghost" id="summary">看這張單的統計</button></div>');
  onClick_(function (ev) {
    var t = ev.target.closest('#share,#copy,#summary,#soldout');
    if (!t) return;
    if (t.id === 'summary') { showSummary(order.orderId); return; }
    if (t.id === 'soldout') { showSoldOut_(order, showShare_); return; }
    if (t.id === 'copy') {
      navigator.clipboard.writeText(url).then(function () { toast_('已複製'); }, function () { toast_('請長按連結複製'); });
      return;
    }
    liff.shareTargetPicker([buildOrderCard(order, url)]).then(function (res) {
      if (res) toast_('已發送');
    }, function (e) { toast_('發送失敗：' + e.message); });
  });
}

// ---- 統計 ----
function showSummary(orderId, tab) {
  tab = tab || 'store';
  render_('<div class="loading">載入中…</div>');
  return api('summary', { orderId: orderId }).then(function (s) {
    var o = s.order;
    var storeHtml = '<div class="card"><h3>共 ' + s.store.totalQty + ' 份・' + money_(s.store.totalAmount) + '</h3>' +
      (s.store.rows.length ? '<table class="grid">' + s.store.rows.map(function (r) {
        return '<tr><td>' + esc_(r.label) + '</td><td>×' + r.qty + '</td></tr>';
      }).join('') + '</table>' : '<div class="sub">還沒有人點</div>') +
      (s.store.notes.length ? '<h3 class="mt">備註</h3><table class="grid">' + s.store.notes.map(function (n) {
        return '<tr><td>' + esc_(n.text) + '</td><td>×' + n.count + '</td></tr>';
      }).join('') + '</table>' : '') + '</div>';
    var moneyHtml = '<div class="card"><h3>' + s.people.length + ' 人・' + money_(s.store.totalAmount) + '</h3>' +
      (s.people.length ? s.people.map(function (p) {
        return '<details class="person"><summary><span>' + esc_(p.userName) + '</span><b>' + money_(p.amount) + '</b></summary>' +
          '<table class="grid">' + p.lines.map(function (l) {
            return '<tr><td>' + esc_(l.label) + ' ×' + l.qty +
              (l.forWhom ? ' <span class="tag">幫 ' + esc_(l.forWhom) + '</span>' : '') +
              (l.note ? '<div class="sub">' + esc_(l.note) + '</div>' : '') + '</td><td>' + money_(l.unitPrice * l.qty) + '</td></tr>';
          }).join('') + '</table><button class="ghost small" data-edit="' + esc_(p.userId) + '">修改這個人的單</button></details>';
      }).join('') : '<div class="sub">還沒有人點</div>') + addPersonHtml_(s) + '</div>';

    render_(adminHeader_(o.storeName, true) +
      '<div class="card stack"><div class="sub">' + (o.open ? '進行中・截止 ' : '已截止・') + fmtTime_(o.deadline) + '</div>' +
      '<div class="inline-row"><input type="datetime-local" id="dl" value="' + esc_(o.deadline.slice(0, 16)) + '">' +
      '<button class="ghost" id="dl-save">改截止</button></div>' +
      (o.open ? '<button class="ghost" id="close-now">立即截止</button>' : '') +
      '<button class="ghost" id="soldout">⏸ 暫停供應' + soldOutBadge_(o.soldOut) + '</button>' +
      '<button class="ghost" id="reshare">再發一次卡片</button></div>' +
      (s.affected.length ? '<div class="notice bad-notice">⚠️ ' + s.affected.length + ' 人點了今日暫停的東西：' +
        s.affected.map(function (a) { return esc_(a.userName) + '（' + esc_(a.labels.join('、')) + '）'; }).join('、') +
        '。截止前他們自己打開點餐頁會看到提醒；也可以在「給收錢」幫他們改。</div>' : '') +
      '<nav class="tabs"><button data-tab="store" class="' + (tab === 'store' ? 'on' : '') + '">給店家</button>' +
      '<button data-tab="money" class="' + (tab === 'money' ? 'on' : '') + '">給收錢</button></nav>' +
      (tab === 'store' ? storeHtml : moneyHtml));

    function setDeadline(deadline, btn) {
      busy_(btn, '儲存中…');
      api('setDeadline', { orderId: orderId, deadline: deadline }).then(function () {
        toast_('已更新截止時間');
        showSummary(orderId, tab);
      }, function (e) { unbusy_(btn); toast_(e.message); });
    }
    onClick_(function (ev) {
      var t = ev.target.closest('[data-tab],[data-edit],#add-person,#dl-save,#close-now,#reshare,#soldout');
      if (!t) return;
      if (t.dataset.tab) showSummary(orderId, t.dataset.tab);
      else if (t.dataset.edit) showLinesEditor_(s, t.dataset.edit);
      else if (t.id === 'add-person') {
        var who = document.getElementById('person').value;
        if (who) showLinesEditor_(s, who); else toast_('請先選人');
      }
      else if (t.id === 'reshare') showShare_(o);
      else if (t.id === 'soldout') showSoldOut_(o, function () { showSummary(orderId, tab); });
      else if (t.id === 'close-now') setDeadline(taipeiIso(Date.now()), t);
      else {
        var v = document.getElementById('dl').value;
        if (v) setDeadline(v + ':00+08:00', t);
      }
    });
  }).catch(showError_);
}

// 「給收錢」底下：幫還沒點的人新增（只列打開過訂餐頁、已記進成員名單的人）
function addPersonHtml_(s) {
  var ordered = {};
  s.people.forEach(function (p) { ordered[p.userId] = true; });
  var others = s.members.filter(function (m) { return !ordered[m.userId]; });
  if (!others.length) return '';
  return '<div class="inline-row mt"><select id="person"><option value="">幫還沒點的人新增…</option>' +
    others.map(function (m) { return '<option value="' + esc_(m.userId) + '">' + esc_(m.name) + '</option>'; }).join('') +
    '</select><button class="ghost" id="add-person">新增</button></div>';
}

// 行政修改某人的單：不受截止限制；全部刪掉再儲存＝刪除這個人的單
function showLinesEditor_(summary, userId) {
  var o = summary.order;
  var person = summary.members.filter(function (m) { return m.userId === userId; })[0] ||
    { name: (summary.people.filter(function (p) { return p.userId === userId; })[0] || {}).userName || '' };
  person.userName = person.name;
  render_(adminHeader_('修改 ' + person.userName + ' 的點餐', true) + '<main id="editor"></main>');
  renderCartEditor(document.getElementById('editor'), o.menu,
    summary.lines.filter(function (l) { return l.userId === userId; }), {
      notice: '行政修改不受截止時間限制。全部刪掉再儲存＝刪除這個人的單。',
      title: (person ? person.userName : '') + ' 的點餐',
      saveLabel: function () { return '儲存'; },
      onSave: function (lines) {
        return api('setLinesFor', { orderId: o.orderId, userId: userId, lines: lines }).then(function () {
          toast_('已更新');
          showSummary(o.orderId, 'money');
        });
      }
    });
}

// ---- 月報 ----
function showMonthly(month) {
  month = month || taipeiIso(Date.now()).slice(0, 7);
  render_('<div class="loading">載入中…</div>');
  return api('monthly', { month: month }).then(function (r) {
    var total = r.people.reduce(function (sum, p) { return sum + p.amount; }, 0);
    render_(adminHeader_('月報', true) +
      '<div class="card"><input type="month" id="month" value="' + esc_(month) + '"></div>' +
      '<div class="card"><h3>每人花費・合計 ' + money_(total) + '</h3>' + (r.people.length ? '<table class="grid">' +
        r.people.map(function (p) { return '<tr><td>' + esc_(p.name) + '</td><td>' + money_(p.amount) + '</td></tr>'; }).join('') +
        '</table>' : '<div class="sub">這個月沒有資料</div>') + '</div>' +
      '<div class="card"><h3>店家被訂次數</h3>' + (r.stores.length ? '<table class="grid">' +
        r.stores.map(function (s) { return '<tr><td>' + esc_(s.storeName) + '</td><td>' + s.count + ' 次</td></tr>'; }).join('') +
        '</table>' : '<div class="sub">這個月沒有資料</div>') + '</div>');
    onClick_(function () {});
    document.getElementById('month').onchange = function (ev) {
      if (ev.target.value) showMonthly(ev.target.value);
    };
  }).catch(showError_);
}

// ---- 暫停供應：只對這張單有效，菜單庫不受影響 ----
function soldOutBadge_(soldOut) {
  var so = normalizeSoldOut(soldOut), n = so.items.length + so.choices.length;
  return n ? '（' + n + ' 項）' : '';
}

// 品項逐一列出；選項依「選項名」合併（同名選項在每個品項都一起停，例如「加料/波霸」）
function showSoldOut_(order, back) {
  var so = normalizeSoldOut(order.soldOut);
  var paused = {};
  so.items.forEach(function (id) { paused['i:' + id] = true; });
  so.choices.forEach(function (k) { paused['c:' + k] = true; });
  var groupNames = [], groupChoices = {};
  order.menu.categories.forEach(function (c) {
    c.items.forEach(function (it) {
      it.groups.forEach(function (g) {
        if (!groupChoices[g.name]) { groupChoices[g.name] = []; groupNames.push(g.name); }
        g.choices.forEach(function (ch) {
          if (groupChoices[g.name].indexOf(ch.label) < 0) groupChoices[g.name].push(ch.label);
        });
      });
    });
  });
  function chip(key, text) {
    return '<button class="chip' + (paused[key] ? ' off' : '') + '" data-key="' + esc_(key) + '">' + esc_(text) + '</button>';
  }
  render_(adminHeader_('暫停供應', true) +
    '<div class="card sub">只對「' + esc_(order.storeName) + '」這張單有效，菜單庫不受影響。點一下切換，灰色畫線＝今日暫停。</div>' +
    order.menu.categories.map(function (c) {
      return '<div class="card"><h3>' + esc_(c.name) + '</h3><div class="chips">' +
        c.items.map(function (it) { return chip('i:' + it.id, it.name); }).join('') + '</div></div>';
    }).join('') +
    (groupNames.length ? '<div class="card"><h3>選項</h3>' + groupNames.map(function (gn) {
      return '<div class="sub">' + esc_(gn) + '</div><div class="chips">' +
        groupChoices[gn].map(function (label) { return chip('c:' + gn + '/' + label, label); }).join('') + '</div>';
    }).join('') + '</div>' : '') +
    '<div class="actions"><button class="primary" id="so-save">儲存</button></div>');
  onClick_(function (ev) {
    var t = ev.target.closest('[data-key],#so-save');
    if (!t) return;
    if (t.dataset.key) { // 原地切換，不整頁重畫（菜單長時才不會跳回頂端）
      paused[t.dataset.key] = !paused[t.dataset.key];
      t.classList.toggle('off', paused[t.dataset.key]);
      return;
    }
    var next = { items: [], choices: [] };
    Object.keys(paused).forEach(function (k) {
      if (!paused[k]) return;
      if (k.indexOf('i:') === 0) next.items.push(k.slice(2)); else next.choices.push(k.slice(2));
    });
    busy_(t, '儲存中…');
    api('setSoldOut', { orderId: order.orderId, soldOut: next }).then(function () {
      toast_('已更新暫停供應');
      order.soldOut = next;
      back(order);
    }, function (e) { unbusy_(t); toast_(e.message); });
  });
}
