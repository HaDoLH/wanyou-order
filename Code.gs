/*  萬友咖啡 · 台中咖啡展點單系統 — Google Apps Script（後端橋樑）
 *  ===================================================================
 *  這支程式「綁在你的 Google 試算表上」，當作網頁與試算表之間的窗口：
 *    - doGet()  ：網頁載入時呼叫 → 回傳商品清單 + 即時剩餘庫存
 *    - doPost() ：按「完成並送出」時呼叫 → 把這筆銷售寫進「銷售紀錄」分頁
 *
 *  使用前你需要在試算表建立兩個分頁（詳見 README.md）：
 *    分頁「商品」    欄位：id | cat | 品名 | 單價 | 單位 | 庫存總量 | 低庫存門檻
 *                       （cat：beans=生豆販售、gift=贈品，贈品單價填 0）
 *    分頁「銷售紀錄」欄位：時間 | 訂單編號 | 品項id | 品名 | 數量 | 單價 | 小計 | 類別
 *                       （類別：銷售 / 公關贈送 / 滿額贈 / 扭蛋獎品）
 *
 *  剩餘庫存 = 期初庫存 − 該品項在「銷售紀錄」的數量總和（由本程式計算）。
 *  =================================================================== */

// 分頁名稱（如果你改了分頁名字，這裡也要跟著改）
const SHEET_PRODUCTS = '商品';
const SHEET_SALES    = '銷售紀錄';

/* -------------------------------------------------------------------
 * doGet：回傳商品 + 即時剩餘庫存（網頁載入時呼叫）
 * ------------------------------------------------------------------- */
function doGet() {
  try {
    const products = getProductsWithRemaining();
    return jsonOutput({ ok: true, products: products });
  } catch (err) {
    return jsonOutput({ ok: false, message: String(err) });
  }
}

/* -------------------------------------------------------------------
 * doPost：寫入一筆銷售（按「完成並送出」時呼叫）
 *   前端送來的內容（JSON 字串放在 e.postData.contents）：
 *   { items:[{id,name,qty,price,subtotal}], total, time }
 * ------------------------------------------------------------------- */
function doPost(e) {
  // 用鎖避免兩台平板同時寫入造成資料錯亂
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const order = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const salesSheet = ss.getSheetByName(SHEET_SALES);

    // 產生一個訂單編號（用時間，方便人看）
    const now = new Date();
    const orderNo = Utilities.formatDate(now, 'Asia/Taipei', 'yyyyMMdd-HHmmss');

    // 每個品項寫一列，方便之後按品項/日期/類別做統計
    order.items.forEach(function (it) {
      salesSheet.appendRow([
        now,                 // 時間（試算表會顯示成日期時間）
        orderNo,             // 訂單編號
        it.id,               // 品項id
        it.name,             // 品名
        it.qty,              // 數量
        it.price,            // 單價
        it.subtotal,         // 小計
        it.category || '銷售' // 類別：銷售 / 公關贈送 / 滿額贈 / 扭蛋獎品
      ]);
    });

    // 回傳更新後的庫存，讓網頁即時刷新剩餘數量
    const products = getProductsWithRemaining();
    return jsonOutput({ ok: true, orderNo: orderNo, products: products });
  } catch (err) {
    return jsonOutput({ ok: false, message: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/* -------------------------------------------------------------------
 * 共用：讀「商品」分頁，並用「銷售紀錄」算出每項剩餘庫存
 * ------------------------------------------------------------------- */
function getProductsWithRemaining() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const pSheet = ss.getSheetByName(SHEET_PRODUCTS);
  const sSheet = ss.getSheetByName(SHEET_SALES);

  // 1) 先把「銷售紀錄」的數量依品項id加總（id → 已售數量）
  const soldById = {};
  if (sSheet && sSheet.getLastRow() > 1) {
    // 取 品項id(第3欄) 與 數量(第5欄)
    const salesData = sSheet.getRange(2, 3, sSheet.getLastRow() - 1, 3).getValues();
    salesData.forEach(function (row) {
      const id = String(row[0]).trim();   // 第3欄：品項id
      const qty = Number(row[2]) || 0;    // 第5欄：數量
      if (id) soldById[id] = (soldById[id] || 0) + qty;
    });
  }

  // 2) 讀「商品」分頁，算 remaining = 期初庫存 − 已售
  const products = [];
  if (pSheet && pSheet.getLastRow() > 1) {
    const rows = pSheet.getRange(2, 1, pSheet.getLastRow() - 1, 7).getValues();
    rows.forEach(function (r) {
      const id = String(r[0]).trim();
      if (!id) return;                    // 跳過空白列
      const stock = Number(r[5]) || 0;    // 庫存總量（補貨就把這格數字加大）
      const sold = soldById[id] || 0;
      products.push({
        id: id,
        cat: String(r[1]).trim(),         // beans / goods
        name: String(r[2]).trim(),
        price: Number(r[3]) || 0,
        unit: String(r[4]).trim() || '件',
        stock: stock,
        lowAt: Number(r[6]) || 5,         // 低庫存門檻
        remaining: Math.max(0, stock - sold)
      });
    });
  }
  return products;
}

/* -------------------------------------------------------------------
 * 共用：輸出 JSON
 * ------------------------------------------------------------------- */
function jsonOutput(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}