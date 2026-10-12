// RoastMemo — IndexedDB の薄い Promise ラッパ（外部ライブラリなし・端末内保存）。
//
// 焙煎ログは端末の IndexedDB に保存する（サーバ不要・全クライアント完結）。
// ここはブラウザ専用モジュール。すべての実処理は関数内でのみ indexedDB に触れ、
// モジュール読み込み時（SSR/プリレンダ）には副作用を持たない。

import { dedupeById, pickNewer, type RoastLog } from "./roast";

const DB_NAME = "roastmemo";
const DB_VERSION = 1;
const STORE = "logs";

/** IndexedDB が使える環境か（プライベートモード等で無いこともある）。 */
export function isStorageAvailable(): boolean {
  try {
    return typeof indexedDB !== "undefined";
  } catch {
    return false;
  }
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!isStorageAvailable()) {
      reject(new Error("この端末では IndexedDB が使えません。"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error("DB を開けませんでした。"));
  });
}

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE);
}

/** 全ログを読み出す。 */
export async function loadAllLogs(): Promise<RoastLog[]> {
  const db = await openDB();
  try {
    return await new Promise<RoastLog[]>((resolve, reject) => {
      const req = tx(db, "readonly").getAll();
      req.onsuccess = () => resolve((req.result ?? []) as RoastLog[]);
      req.onerror = () =>
        reject(req.error ?? new Error("読み出しに失敗しました。"));
    });
  } finally {
    db.close();
  }
}

/** 1件を保存（存在すれば上書き）。 */
export async function putLog(log: RoastLog): Promise<void> {
  const db = await openDB();
  try {
    // トランザクションの complete まで待つ。put リクエストの success で resolve すると
    // まだコミット前で、コミット時に abort すると「保存した」と表示して実際は永続化されない。
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE, "readwrite");
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error ?? new Error("保存に失敗しました。"));
      t.onabort = () => reject(t.error ?? new Error("保存が中断されました。"));
      t.objectStore(STORE).put(log);
    });
  } finally {
    db.close();
  }
}

/**
 * 取り込みを **現ストレージに対して原子的にマージ**する。
 * 単一の readwrite トランザクション内で、取り込み対象の id ごとに既存レコードを get し、
 * pickNewer で調停して **勝者(＝取り込みが厳密に新しいときだけ)のみ put** する。
 * 取り込みに含まれない未関与レコードは一切書き換えない（別タブが更新した新しい版を、
 * 当該タブの stale スナップショットで全件上書きして消すのを防ぐ）。
 */
export async function mergeImportLogs(imported: RoastLog[]): Promise<void> {
  if (imported.length === 0) return;
  // tx を開く前に import 内の重複 id を畳む（同一 id の複数エントリが全て取込前値と比較され、
  // updatedAt を無視して最後のエントリが勝つ取りこぼしを防ぐ）。
  const logs = dedupeById(imported);
  const db = await openDB();
  try {
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE, "readwrite");
      t.oncomplete = () => resolve();
      t.onerror = () =>
        reject(t.error ?? new Error("取り込みに失敗しました。"));
      t.onabort = () =>
        reject(t.error ?? new Error("取り込みが中断されました。"));
      const store = t.objectStore(STORE);
      for (const inc of logs) {
        const getReq = store.get(inc.id);
        getReq.onsuccess = () => {
          const existing = getReq.result as RoastLog | undefined;
          // 既存が無ければ追加。あれば新しい方を選び、勝者が既存と異なる時だけ書き込む。
          if (!existing) {
            store.put(inc);
          } else if (pickNewer(existing, inc) === inc) {
            store.put(inc);
          }
        };
      }
    });
  } finally {
    db.close();
  }
}

/** 1件を削除。 */
export async function deleteLog(id: string): Promise<void> {
  const db = await openDB();
  try {
    // 削除もトランザクションの complete を待つ（commit 前の success で resolve しない）。
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE, "readwrite");
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error ?? new Error("削除に失敗しました。"));
      t.onabort = () => reject(t.error ?? new Error("削除が中断されました。"));
      t.objectStore(STORE).delete(id);
    });
  } finally {
    db.close();
  }
}
