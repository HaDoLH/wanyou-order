/* =========================================================
   雲端訂單箱（訂購單、結帳系統共用同一份）
   ---------------------------------------------------------
   比喻：這支程式是跑腿的人，負責把訂單送進雲端、把最新狀態帶回來。
   改這個檔案時，兩邊的 sync.js 要保持一樣。

   下面的設定本來就可以公開，保護資料的是「登入」和 Firestore 規則。
   訂單狀態：pending 待付款 / paid 已付款 / returned 已退回
            void 已作廢 / cancelled 已取消 / deleted 已刪除（清單不顯示，雲端留紀錄）

   水果特調庫存（stock/fruit）：
     items[品號] = { name, total 總庫存KG, reserved 已被訂單佔用KG }
     待付款／已退回／已付款的單會佔用，取消／刪除／作廢就歸還。
     佔用跟訂單狀態在「同一個交易」裡改，兩人同時送單也不會超賣。
   ========================================================= */
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDyhn05DhieDqmnNzdkjrxYxgxbXMUpbL0',
  authDomain: 'wanyou-expo.firebaseapp.com',
  projectId: 'wanyou-expo',
  storageBucket: 'wanyou-expo.firebasestorage.app',
  messagingSenderId: '1096909202731',
  appId: '1:1096909202731:web:8f7058014a55ec9ab0516e',
};

const STATUS_LABEL = {
  pending: '待付款', paid: '已付款', returned: '已退回', void: '已作廢', cancelled: '已取消', deleted: '已刪除',
};

const Sync = (() => {
  const SDK = 'https://www.gstatic.com/firebasejs/11.0.2/';
  const STAFF_EMAIL = 'wanyu.staff@example.com'; // 共用帳號，同事只要輸入密碼
  let fa, ff, auth, db, ready = null;

  // 用到才下載 Firebase，下載失敗（沒網路）不影響其他功能
  function load() {
    if (!ready) {
      ready = (async () => {
        const { initializeApp } = await import(SDK + 'firebase-app.js');
        fa = await import(SDK + 'firebase-auth.js');
        ff = await import(SDK + 'firebase-firestore.js');
        const app = initializeApp(FIREBASE_CONFIG);
        auth = fa.getAuth(app);
        db = ff.getFirestore(app);
      })().catch((e) => { ready = null; throw e; });
    }
    return ready;
  }

  const clean = (o) => JSON.parse(JSON.stringify(o)); // 雲端不收 undefined
  const ref = (no) => ff.doc(db, 'orders', no);
  const stockRef = () => ff.doc(db, 'stock', 'fruit');
  const fail = (code, cur) => Object.assign(new Error(code), { syncCode: code, current: cur });
  const HOLD = ['pending', 'returned', 'paid']; // 這些狀態的單會佔用水果特調庫存

  /** 一張單佔用的水果特調公斤數 { 品號: KG } */
  const fruitKg = (order, status) => {
    const m = {};
    if (!HOLD.includes(status)) return m;
    ((order && order.rows) || []).filter((r) => r.fruit).forEach((r) => { m[r.id] = (m[r.id] || 0) + r.kg; });
    return m;
  };

  /** 在交易裡調整佔用量；只有「增加」時檢查夠不夠（減少一定可以） */
  async function moveStock(tx, before, after, names) {
    const ids = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    const diff = ids.map((id) => [id, (after[id] || 0) - (before[id] || 0)]).filter(([, d]) => d);
    if (!diff.length) return null;
    const snap = await tx.get(stockRef());
    const items = { ...((snap.exists() && snap.data().items) || {}) };
    diff.forEach(([id, d]) => {
      const it = { name: names[id] || id, total: 0, reserved: 0, ...items[id] };
      if (d > 0 && it.total - it.reserved < d) {
        throw fail('stock', { id, name: it.name, left: Math.max(0, it.total - it.reserved) });
      }
      items[id] = { ...it, reserved: Math.max(0, it.reserved + d) };
    });
    return () => tx.set(stockRef(), { items, updatedAt: Date.now() });
  }
  const namesOf = (...orders) => Object.fromEntries(orders.flatMap((o) => ((o && o.rows) || []).map((r) => [r.id, r.name])));

  /** 改訂單狀態。只有目前狀態符合、版本相同才會寫入，避免收到舊金額或重複收款 */
  async function change(no, version, allowed, patch) {
    await load();
    return ff.runTransaction(db, async (tx) => {
      const snap = await tx.get(ref(no));
      if (!snap.exists()) throw fail('missing');
      const cur = snap.data();
      if (!allowed.includes(cur.status)) throw fail('status', cur);
      if (version !== null && cur.version !== version) throw fail('version', cur);
      const next = {
        ...clean(typeof patch === 'function' ? patch(cur) : patch),
        version: cur.version + 1,
        updatedAt: Date.now(),
      };
      const after = { ...cur, ...next };
      // 讀完才能寫（交易規定）：先算好庫存，再一起寫入
      const writeStock = await moveStock(tx, fruitKg(cur.order, cur.status), fruitKg(after.order, after.status),
        namesOf(cur.order, after.order));
      tx.update(ref(no), next);
      if (writeStock) writeStock();
      return after;
    });
  }

  return {
    /** 登入狀態有變化時通知（已登入過的裝置會自動登入） */
    async onUser(cb) { await load(); fa.onAuthStateChanged(auth, cb); },
    async login(password) {
      await load();
      await fa.signInWithEmailAndPassword(auth, STAFF_EMAIL, password);
    },
    /** 即時收到全部訂單 */
    async watch(cb, onError) {
      await load();
      return ff.onSnapshot(ff.collection(db, 'orders'), (s) => cb(s.docs.map((d) => d.data())), onError);
    },
    /** 新增訂單；編號已被別人用走時回傳 false，不會蓋掉對方 */
    async create(rec) {
      await load();
      return ff.runTransaction(db, async (tx) => {
        if ((await tx.get(ref(rec.no))).exists()) return false;
        const writeStock = await moveStock(tx, {}, fruitKg(rec.order, rec.status), namesOf(rec.order));
        tx.set(ref(rec.no), clean(rec));
        if (writeStock) writeStock();
        return true;
      });
    },
    /** 業務修改／重新送單（已付款的單會被擋下） */
    update: (no, version, patch) =>
      change(no, version, ['pending', 'returned'], { ...patch, status: 'pending', returnReason: '' }),
    cancel: (no, version) => change(no, version, ['pending', 'returned'], { status: 'cancelled' }),
    /** 櫃台：確認付款／退回業務／作廢／更正付款方式 */
    pay: (no, version, paid) => change(no, version, ['pending'], { status: 'paid', paid }),
    giveBack: (no, version, reason) => change(no, version, ['pending'], { status: 'returned', returnReason: reason }),
    voidOrder: (no, reason) => change(no, null, ['paid'], { status: 'void', voidReason: reason, voidAt: Date.now() }),
    setPayMethod: (no, method) => change(no, null, ['paid'], (cur) => ({ paid: { ...cur.paid, method } })),
    /** 即時收到水果特調庫存 { 品號: { name, total, reserved } } */
    async watchStock(cb, onError) {
      await load();
      return ff.onSnapshot(stockRef(), (s) => cb((s.exists() && s.data().items) || {}), onError);
    },
    /** 櫃台：設定某支水果特調的總庫存（已佔用的不變） */
    async setFruitTotal(id, name, total) {
      await load();
      return ff.runTransaction(db, async (tx) => {
        const snap = await tx.get(stockRef());
        const items = { ...((snap.exists() && snap.data().items) || {}) };
        items[id] = { reserved: 0, ...items[id], name, total: Math.max(0, Number(total) || 0) };
        tx.set(stockRef(), { items, updatedAt: Date.now() });
      });
    },
    /** 櫃台：刪除還沒付款的單（只是從清單移除，雲端留紀錄；已付款要走作廢） */
    remove: (no) => change(no, null, ['pending', 'returned', 'cancelled'], { status: 'deleted', deletedAt: Date.now() }),
  };
})();

/** 把同步失敗的原因換成看得懂的話 */
function syncErrorText(e) {
  if (e.syncCode === 'version') return '這張單剛被別人改過，請回訂單列表重新開啟';
  if (e.syncCode === 'status') return `這張單已經是「${STATUS_LABEL[e.current.status]}」，不能再操作`;
  if (e.syncCode === 'missing') return '雲端找不到這張單';
  if (e.syncCode === 'stock') return `水果特調「${e.current.name}」庫存不足，只剩 ${e.current.left} KG 可以訂`;
  return '連線失敗，請檢查網路';
}
