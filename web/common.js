// 共用：LIFF 登入、api()、路由、小工具。
// 網址加 ?demo=1 進 demo 模式：用 MemDb + handle() 在瀏覽器裡模擬後端，不用 LINE 也能操作（&as=admin 當行政、&reset=1 清資料）。

var state = { me: null, params: null, demo: false, identity: null, db: null, demoRaw: null, onRelogin: null };
var DEMO_KEY_ = 'line-order-demo';

function boot() {
  state.params = new URLSearchParams(location.search);
  state.demo = state.params.get('demo') === '1';
  (state.demo ? demoInit_() : liffInit_()).then(function () {
    state.params = new URLSearchParams(location.search); // LIFF 會用 liff.state 轉址，init 完才讀參數
    var o = state.params.get('o');
    if (state.params.get('admin') === '1') return o ? showSummary(o) : showAdmin();
    if (o) return showOrder(o);
    return api('bootstrap', {}).then(function (b) {
      state.me = b.me;
      if (b.me.isAdmin) return showAdmin();
      render_('<div class="empty">請從群組裡的訂餐卡片點進來</div>');
    });
  }).catch(showError_);
}

function liffInit_() {
  return liff.init({ liffId: CONFIG.LIFF_ID }).then(function () {
    if (!liff.isLoggedIn()) {
      liff.login({ redirectUri: location.href });
      return new Promise(function () {}); // 等轉址
    }
  });
}

// opts.timeoutMs：超過就放棄等待（後端可能還在跑，但結果不要了），回 code TIMEOUT
function api(action, payload, opts) {
  var call = withTimeout_(state.demo ? demoApi_(action, payload || {}) :
    fetch(CONFIG.GAS_URL, { // 不加自訂 header → simple request，GAS 不用處理 CORS preflight
      method: 'POST',
      body: JSON.stringify({ action: action, payload: payload || {}, idToken: liff.getIDToken() })
    }).then(function (r) { return r.json(); }, function () {
      throw codeError_('NETWORK', '連線失敗，請稍後再試');
    }).then(function (r) {
      if (r && r.ok) return r.data;
      throw codeError_(r && r.code, (r && r.error) || '連線失敗，請稍後再試');
    }), opts && opts.timeoutMs);
  return call.catch(function (e) {
    if (e.code !== 'UNAUTHORIZED') throw e;
    if (!shouldAutoRelogin_(Date.now())) {
      throw codeError_('UNAUTHORIZED', '登入失敗，請關閉這個頁面後重新打開；一直失敗請通知行政');
    }
    if (state.onRelogin) state.onRelogin();
    if (state.demo) location.reload();
    else { liff.logout(); location.reload(); } // LIFF 瀏覽器重開會自動重新登入、拿新 token
    return new Promise(function () {});
  });
}

function withTimeout_(promise, ms) {
  if (!ms) return promise;
  return Promise.race([promise, new Promise(function (resolve, reject) {
    setTimeout(function () {
      reject(codeError_('TIMEOUT', '等了 ' + Math.round(ms / 1000) + ' 秒還沒有回應，Google 可能很忙，請稍後再試，或改用手動輸入'));
    }, ms);
  })]);
}

// 60 秒內第二次被要求重新登入就停下來：設定錯誤（例如 Channel ID 填錯）時才不會無限重整
function shouldAutoRelogin_(nowMs) {
  var last = Number(sessionStorage.getItem('lastAutoRelogin') || 0);
  if (nowMs - last < 60000) return false;
  sessionStorage.setItem('lastAutoRelogin', String(nowMs));
  return true;
}

function codeError_(code, message) {
  var e = new Error(message);
  e.code = code;
  return e;
}

// ---- demo 模式 ----
function demoInit_() {
  if (state.params.get('reset') === '1') localStorage.removeItem(DEMO_KEY_);
  var as = state.params.get('as') || 'alice';
  state.identity = as === 'admin' ? { userId: 'UA', name: '行政小美' } : { userId: 'U_' + as, name: as };
  return fetch('../tests/fixtures/shaolai-menu.json').then(function (r) { return r.json(); }).then(function (raw) {
    state.demoRaw = raw;
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(DEMO_KEY_)); } catch (e) { /* 沒存過 */ }
    if (saved) { state.db = MemDb(saved); return; }
    var menu = normalizeMenu(raw, { clearUnsure: true });
    var today = taipeiIso(Date.now()).slice(0, 10);
    state.db = MemDb({
      members: [{ userId: 'UA', name: '行政小美', isAdmin: true }],
      stores: [{ storeId: 's1', name: '燒臘教父', menu: menu, updatedAt: today + 'T09:00:00+08:00' }],
      orders: [{ orderId: 'demo1', storeId: 's1', storeName: '燒臘教父', menu: menu,
        deadline: today + 'T23:59:00+08:00', createdBy: 'UA', createdAt: today + 'T09:00:00+08:00' }]
    });
    saveDemo_();
  });
}

function saveDemo_() {
  try { localStorage.setItem(DEMO_KEY_, JSON.stringify(state.db.dump())); } catch (e) { /* 無痕模式存不了就算了 */ }
}

function demoApi_(action, payload) {
  return new Promise(function (r) { setTimeout(r, action === 'readMenu' ? 1000 : 120); }).then(function () {
    if (action === 'saveMyLines' && state.params.get('expire') === 'always') throw codeError_('UNAUTHORIZED', '登入已過期');
    if (action === 'saveMyLines' && state.params.get('expire') === '1' && !sessionStorage.getItem('demoExpired')) {
      sessionStorage.setItem('demoExpired', '1');
      throw codeError_('UNAUTHORIZED', '登入已過期');
    }
    var deps = { db: state.db, readMenu: function () { return state.demoRaw; } };
    var data = handle(action, JSON.parse(JSON.stringify(payload)), state.identity, deps, Date.now());
    saveDemo_();
    return JSON.parse(JSON.stringify(data));
  });
}

// ---- 畫面小工具 ----
function render_(html) {
  document.getElementById('app').innerHTML = html;
  window.scrollTo(0, 0);
}

function esc_(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function money_(n) {
  return '$' + Number(n).toLocaleString('en-US');
}

// '2026-11-04T11:00:00+08:00' → '11/04 11:00'
function fmtTime_(iso) {
  return iso.slice(5, 7) + '/' + iso.slice(8, 10) + ' ' + iso.slice(11, 16);
}

// 保留 demo 等參數，只換掉指定的
function linkWith_(changes) {
  var p = new URLSearchParams(location.search);
  ['o', 'admin', 'reset', 'expire'].forEach(function (k) { p.delete(k); });
  Object.keys(changes).forEach(function (k) { if (changes[k] != null) p.set(k, changes[k]); });
  return '?' + p.toString();
}

function liffUrl(query) {
  return 'https://liff.line.me/' + CONFIG.LIFF_ID + '?' + query;
}

function toast_(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast_.timer);
  toast_.timer = setTimeout(function () { t.hidden = true; }, 2500);
}

function showError_(e) {
  console.warn(e);
  render_('<div class="empty">' + esc_(e.code === 'FORBIDDEN' ? '你不是行政，無法使用這一頁' : e.message || '發生錯誤') + '</div>');
}
