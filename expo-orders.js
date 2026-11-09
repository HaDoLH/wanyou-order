/* =========================================================
   訂購單（業務送來的 5KG 以上訂單）— 櫃台端
   ---------------------------------------------------------
   流程：業務送單 → 這裡即時出現 → 櫃台收款按「完成並送出」
   櫃台不能改金額，有問題按「退回業務」。
   這裡的任何錯誤都不能影響一般現場結帳，所以全部包在 try/catch，
   沒網路或沒登入時，只有「訂購單」按鈕不能用，其他照常。
   ========================================================= */

const EXPO_PAY_MAP = { '現金': '付現', '刷卡': '刷卡', 'LINE Pay': 'LINE Pay', '其他': '匯款' };

let expoOrders = [];       // 雲端全部訂單
let expoUser = null;       // 登入狀態
let expoTab = 'pending';   // 目前的分頁
let expoPendingSeen = null;

// 訂購單編號長得像 1114-A-007（現場結帳是 20261114-143015）
function isExpoNo(no) { return /^\d{4}-[A-Z0-9]{1,2}-\d{3}/.test(no); }

/* 水果特調庫存放在雲端（stock/fruit），業務送單時就佔用、取消／刪除／作廢自動歸還，
   櫃台不用另外扣。總庫存在「庫存修改」裡改（只有結帳平板能改）。 */
let fruitStock = null;   // { 品號: { name, total, reserved } }；null＝還沒登入或沒網路

/** 水果特調卡片與庫存修改要顯示的數字（index.html 會呼叫） */
function fruitInfo(id) {
  if (!fruitStock) return null;
  const it = fruitStock[id] || { total: 0, reserved: 0 };
  return { total: it.total, reserved: it.reserved, left: it.total - it.reserved };
}

function expoEsc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function paintExpoCount() {
  const n = expoOrders.filter(o => o.status === 'pending').length;
  $('#expoCount').textContent = n ? String(n) : '';
  $('#expoBtn').classList.toggle('has-orders', n > 0);
  if (expoPendingSeen !== null && n > expoPendingSeen) showToast('有新的訂購單待結帳', 'success');
  expoPendingSeen = n;
}

function renderExpoList() {
  const q = $('#expoSearch').value.trim();
  const inTab = o => expoTab === 'other' ? !['pending', 'paid', 'deleted'].includes(o.status) : o.status === expoTab;
  const list = expoOrders
    .filter(o => inTab(o) && (!q || [o.no, o.name, o.phone].some(v => String(v).includes(q))))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const box = $('#expoList');
  if (!list.length) { box.innerHTML = '<div class="cart-empty">目前沒有訂單</div>'; return; }
  box.innerHTML = list.map(o => `
    <div class="order-card">
      <div class="ord-head">
        <span class="ord-time">${expoEsc(o.no)}</span>
        <span class="ord-pay">${STATUS_LABEL[o.status]}</span>
        <span class="ord-total">$${Number(o.total).toLocaleString()}</span>
      </div>
      <div class="ord-items">${expoEsc(o.name)}　${expoEsc(o.phone)}　經手：${expoEsc(o.staff) || '—'}</div>
      <div class="ord-foot">
        <span class="ord-inv">${o.status === 'paid' ? `${expoEsc(o.paid.method)}${o.paid.invoice ? '　發票 ' + expoEsc(o.paid.invoice) : ''}` : expoEsc(o.returnReason || o.voidReason || '')}</span>
        <div class="ord-actions">
          ${['pending', 'returned', 'cancelled'].includes(o.status) ? `<button class="btn-sm danger-text" data-expodel="${expoEsc(o.no)}">刪除訂單</button>` : ''}
          ${o.status === 'pending' ? `<button class="btn-sm danger-text" data-exporeturn="${expoEsc(o.no)}">退回業務</button>` : ''}
          ${o.status === 'pending' ? `<button class="btn-sm" data-expopay="${expoEsc(o.no)}">結帳</button>` : ''}
          ${o.status === 'paid' ? `<button class="btn-sm danger-text" data-expovoid="${expoEsc(o.no)}">作廢</button>` : ''}
        </div>
      </div>
    </div>`).join('');
}

function paintExpoPanel() {
  $('#expoLogin').hidden = !!expoUser;
  $('#expoMain').hidden = !expoUser;
  if (expoUser) renderExpoList();
}

/** 借用現有的結帳視窗：金額鎖定、不顯示折扣，多一個「退回業務」 */
function openExpoCheckout(no) {
  const rec = expoOrders.find(o => o.no === no);
  if (!rec) return;
  closeExpo();
  expoPay = { rec, total: rec.total };

  const o = rec.order;
  const line = (left, right) => `<div class="modal-line"><span>${left}</span><span>${right}</span></div>`;
  $('#modalLines').innerHTML =
    `<div class="modal-note">${expoEsc(rec.no)}　${expoEsc(rec.name)}　${expoEsc(rec.phone)}　經手：${expoEsc(rec.staff) || '—'}</div>` +
    o.rows.map(r => line(`${expoEsc(r.name)} <span class="m-qty">${expoEsc(r.spec)}（$${r.price}/${r.per || 'kg'}）</span>`, `$${r.subtotal.toLocaleString()}`)).join('') +
    o.extras.map(x => line(`${expoEsc(x.name)} <span class="m-qty">${x.kg}KG（$${x.price}/kg）</span>`, `$${x.subtotal.toLocaleString()}`)).join('') +
    line(o.island ? '運費（離島配送）' : '運費', o.islandQuote ? '另行報價' : (o.shipping ? `$${o.shipping.toLocaleString()}` : '免運')) +
    (o.gifts.length ? `<div class="modal-note">滿額贈品：${o.gifts.map(expoEsc).join('、')}</div>` : '');

  setupPosBox(rec.total);
  // 付款方式預設帶業務填的，櫃台可以改
  const pay = EXPO_PAY_MAP[o.customer.payment];
  if (pay) document.querySelector(`#payToggle [data-pay="${pay}"]`).click();
  $('#discountRow').hidden = true;
  $('#modalReturn').hidden = false;
  $('#overlay').classList.add('show');
}

/** 確認付款：先更新雲端，成功才記進本機營收 */
async function confirmExpoPay() {
  const { rec, total } = expoPay;
  const btn = $('#modalConfirm');
  if (btn.disabled) return;

  let invoice = '';
  if ($('#invoiceOn').checked) invoice = $('#invPrefix').value.trim() + $('#invNo').value.trim();

  btn.disabled = true;
  try {
    await Sync.pay(rec.no, rec.version, { method: selectedPayment, invoice, at: Date.now() });
    if ($('#invoiceOn').checked) {
      const no = $('#invNo').value.trim();
      localStorage.setItem(KEY_INV_PREFIX, $('#invPrefix').value.trim());
      if (no) localStorage.setItem(KEY_INV_NO, incNumStr(no));
    }
    sales.push({
      time: new Date().toLocaleString('zh-TW', { hour12: false }),
      orderNo: rec.no, id: 'order', name: `訂購單 ${rec.name}`,
      qty: 1, price: total, subtotal: total,
      category: '訂購單', payment: selectedPayment, invoice,
    });
    saveSales();
    updateStats();
    closeCheckout();
    showToast('已確認付款', 'success');
  } catch (e) {
    console.error(e);
    closeCheckout();
    showToast(syncErrorText(e), 'warn');
  }
  btn.disabled = false;
}

/** 退回業務：清單卡片上直接按（帶編號），或在結帳視窗裡按（用視窗那張單） */
async function returnExpoOrder(no) {
  const rec = no ? expoOrders.find(o => o.no === no) : expoPay && expoPay.rec;
  if (!rec) return;
  const reason = prompt(`退回 ${rec.no}（${rec.name}）給業務修改。\n退回原因（業務會看到）：`, '金額有誤，請確認');
  if (reason === null) return;
  try {
    await Sync.giveBack(rec.no, rec.version, reason.trim());
    showToast('已退回業務', 'success');
  } catch (e) {
    console.error(e);
    showToast(syncErrorText(e), 'warn');
  }
  if (!no) closeCheckout();
}

/** 作廢已付款的單：雲端標記作廢，本機補一筆負金額，退款紀錄留在 CSV */
async function voidExpoOrder(no) {
  const rec = expoOrders.find(o => o.no === no);
  if (!rec) return;
  const reason = prompt(`作廢 ${no}（$${Number(rec.total).toLocaleString()}），請先退款給客人。\n作廢原因：`, '客人改單');
  if (reason === null) return;
  try {
    await Sync.voidOrder(no, reason.trim());
    sales.push({
      time: new Date().toLocaleString('zh-TW', { hour12: false }),
      orderNo: `${no}-作廢`, id: 'order', name: `訂購單作廢 ${rec.name}`,
      qty: 1, price: -rec.total, subtotal: -rec.total,
      category: '訂購單', payment: rec.paid.method, invoice: '',
    });
    saveSales();
    updateStats();
    showToast('已作廢，業務可以複製成新單', 'success');
  } catch (e) {
    console.error(e);
    showToast(syncErrorText(e), 'warn');
  }
}

/** 刪除還沒付款的單：清單不再顯示，雲端留紀錄（按錯還救得回來） */
async function deleteExpoOrder(no) {
  const rec = expoOrders.find(o => o.no === no);
  if (!rec) return;
  if (!confirm(`確定刪除 ${no}（${rec.name}，$${Number(rec.total).toLocaleString()}）？\n刪除後請業務重新填單。`)) return;
  try {
    await Sync.remove(no);
    showToast('已刪除訂單', 'success');
  } catch (e) {
    console.error(e);
    showToast(syncErrorText(e), 'warn');
  }
}

function openExpo() { paintExpoPanel(); $('#expoOverlay').classList.add('show'); }
function closeExpo() { $('#expoOverlay').classList.remove('show'); }

function startStockWatch() {
  Sync.watchStock(items => { fruitStock = items; refresh(); }, e => console.error(e)).catch(console.error);
}

function startExpoWatch() {
  Sync.watch(list => {
    expoOrders = list;
    paintExpoCount();
    if ($('#expoOverlay').classList.contains('show')) renderExpoList();
  }, e => console.error(e)).catch(console.error);
}

function initExpo() {
  $('#expoBtn').addEventListener('click', openExpo);
  $('#expoClose').addEventListener('click', closeExpo);
  $('#expoSearch').addEventListener('input', renderExpoList);
  $('#expoTabs').addEventListener('click', e => {
    const b = e.target.closest('.pay-btn');
    if (!b) return;
    expoTab = b.dataset.tab;
    document.querySelectorAll('#expoTabs .pay-btn').forEach(x => x.classList.toggle('active', x === b));
    renderExpoList();
  });
  $('#expoList').addEventListener('click', e => {
    const pay = e.target.closest('[data-expopay]');
    const voidBtn = e.target.closest('[data-expovoid]');
    const del = e.target.closest('[data-expodel]');
    const back = e.target.closest('[data-exporeturn]');
    if (back) returnExpoOrder(back.dataset.exporeturn);
    if (pay) openExpoCheckout(pay.dataset.expopay);
    if (voidBtn) voidExpoOrder(voidBtn.dataset.expovoid);
    if (del) deleteExpoOrder(del.dataset.expodel);
  });
  $('#expoLogin').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#expoErr');
    err.hidden = true;
    try {
      await Sync.login($('#expoPass').value.trim());
      $('#expoPass').value = '';
    } catch (ex) {
      console.error(ex);
      err.textContent = String(ex.code || '').includes('invalid') ? '密碼錯誤，請再試一次' : '連線失敗，請檢查網路';
      err.hidden = false;
    }
  });

  let watching = false;
  Sync.onUser(user => {
    expoUser = user;
    if (user && !watching) { watching = true; startExpoWatch(); startStockWatch(); }
    if ($('#expoOverlay').classList.contains('show')) paintExpoPanel();
  }).catch(console.error);  // 沒網路：一般結帳不受影響
}

initExpo();
