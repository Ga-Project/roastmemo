// RoastMemo — コアロジックの単体テスト（node:test・追加依存なし）。
// 実行: pnpm test（= node --test / Node の型ストリップで .ts を直接 import）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseClock,
  formatClock,
  weightLossPercent,
  normalizePoints,
  addPoint,
  addEvent,
  roastDomain,
  deriveRoastLevel,
  effectiveRoastLevel,
  normalizeTag,
  addTag,
  removeTag,
  allTags,
  filterByTags,
  searchLogs,
  applyFilters,
  exportLogs,
  parseImport,
  mergeLogs,
  upsertLog,
  nextUpdatedAt,
  pickNewer,
  dedupeById,
  sanitizeLog,
  sortLogsForDisplay,
  emptyLog,
  MAX_ROAST_SECONDS,
} from "../lib/roast.ts";

/** テスト用のログを作る（既定は正規化済みの現実的な値）。 */
function mkLog(over = {}) {
  return {
    id: "id-1",
    beanName: "エチオピア",
    date: "2026-08-01",
    chargeWeight: 220,
    dropWeight: 188,
    points: [
      { t: 0, temp: 180 },
      { t: 60, temp: 120 },
      { t: 300, temp: 175 },
      { t: 600, temp: 205 },
    ],
    events: [{ kind: "first_crack", t: 540 }],
    cupping: "ベリーの甘い香り",
    tags: ["ベリー", "浅煎り"],
    roastLevel: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  };
}

/* ---- 時間 ---- */
test("parseClock: mm:ss と純秒の両方を秒に直す", () => {
  assert.equal(parseClock("1:30"), 90);
  assert.equal(parseClock("12:05"), 725);
  assert.equal(parseClock("90"), 90);
  assert.equal(parseClock("0:00"), 0);
});
test("parseClock: 空・不正は null", () => {
  assert.equal(parseClock(""), null);
  assert.equal(parseClock("  "), null);
  assert.equal(parseClock("1:99"), null); // 秒が 60 以上
  assert.equal(parseClock("abc"), null);
});
test("parseClock: 上限超の巨大値は null（DoS 対策）", () => {
  assert.equal(parseClock("1000000000"), null); // 桁数が巨大
  assert.equal(parseClock(String(MAX_ROAST_SECONDS)), MAX_ROAST_SECONDS); // 上限ちょうどは可
  assert.equal(parseClock(String(MAX_ROAST_SECONDS + 1)), null); // 上限+1 は不可
  assert.equal(parseClock("99999:59"), null); // mm:ss でも上限超は不可
});
test("formatClock: 秒を m:ss にする（負値は 0）", () => {
  assert.equal(formatClock(90), "1:30");
  assert.equal(formatClock(725), "12:05");
  assert.equal(formatClock(-5), "0:00");
});

/* ---- 重量減少率 ---- */
test("weightLossPercent: 220→188 は 14.5%", () => {
  assert.equal(weightLossPercent(220, 188), 14.5);
});
test("weightLossPercent: 未入力・非現実値は null", () => {
  assert.equal(weightLossPercent(null, 188), null);
  assert.equal(weightLossPercent(220, null), null);
  assert.equal(weightLossPercent(0, 0), null); // charge<=0
  assert.equal(weightLossPercent(200, 260), null); // drop>charge
});

/* ---- 計測点 ---- */
test("normalizePoints: t 昇順・同一 t 後勝ち・非有限除外", () => {
  const out = normalizePoints([
    { t: 300, temp: 175 },
    { t: 0, temp: 180 },
    { t: 300, temp: 176 }, // 後勝ち
    { t: NaN, temp: 1 },
    { t: 60, temp: 120 },
  ]);
  assert.deepEqual(out, [
    { t: 0, temp: 180 },
    { t: 60, temp: 120 },
    { t: 300, temp: 176 },
  ]);
});
test("normalizePoints: 範囲外(負・上限超)の t は捨てる（DoS 対策）", () => {
  const out = normalizePoints([
    { t: -1, temp: 100 },
    { t: MAX_ROAST_SECONDS + 1, temp: 200 },
    { t: 1e12, temp: 210 },
    { t: 60, temp: 120 },
    { t: MAX_ROAST_SECONDS, temp: 205 }, // 上限ちょうどは残る
  ]);
  assert.deepEqual(out, [
    { t: 60, temp: 120 },
    { t: MAX_ROAST_SECONDS, temp: 205 },
  ]);
});
test("addPoint: 追加して正規化", () => {
  const out = addPoint([{ t: 60, temp: 120 }], { t: 0, temp: 180 });
  assert.deepEqual(out, [
    { t: 0, temp: 180 },
    { t: 60, temp: 120 },
  ]);
});
test("addEvent: 同種は後勝ち・工程順に整列", () => {
  let e = [];
  e = addEvent(e, { kind: "drop", t: 720 });
  e = addEvent(e, { kind: "dry_end", t: 300 });
  e = addEvent(e, { kind: "first_crack", t: 540 });
  e = addEvent(e, { kind: "first_crack", t: 545 }); // 後勝ち
  assert.deepEqual(e, [
    { kind: "dry_end", t: 300 },
    { kind: "first_crack", t: 545 },
    { kind: "drop", t: 720 },
  ]);
});

/* ---- 座標域 ---- */
test("roastDomain: 空でも既定域・データがあれば収まる", () => {
  const empty = roastDomain([[]]);
  assert.ok(empty.tMax >= 120 && empty.tempMax > empty.tempMin);
  const d = roastDomain([
    [
      { t: 0, temp: 180 },
      { t: 600, temp: 210 },
    ],
  ]);
  assert.ok(d.tMax >= 600);
  assert.ok(d.tempMax >= 210);
  assert.ok(d.tempMin <= 180);
});
test("roastDomain: 最終温度点より後のイベント時刻まで tMax が伸びる", () => {
  const points = [
    { t: 0, temp: 190 },
    { t: 540, temp: 205 }, // 最終温度点 9:00
  ];
  const events = [{ kind: "drop", t: 720 }]; // ドロップ 12:00（温度点より後）
  const withoutEvents = roastDomain([points]);
  const withEvents = roastDomain([points], [events]);
  // イベントを渡すと tMax がイベント時刻以上まで伸びる（旗が盤面外に切れない）
  assert.ok(withEvents.tMax >= 720, `tMax>=720 必要: ${withEvents.tMax}`);
  assert.ok(
    withEvents.tMax > withoutEvents.tMax,
    "イベントで tMax が拡張される",
  );
  // 温度域はイベントの影響を受けない
  assert.equal(withEvents.tempMin, withoutEvents.tempMin);
  assert.equal(withEvents.tempMax, withoutEvents.tempMax);
});
test("roastDomain: 温度点ゼロでもイベント時刻を覆う（フォールバック域も拡張）", () => {
  // 点を打つ前に 20:00(1200s) のイベントだけがある状態
  const d = roastDomain([[]], [[{ kind: "drop", t: 1200 }]]);
  assert.ok(d.tMax >= 1200, `tMax>=1200 必要: ${d.tMax}`);
  // 温度点も無いので温度域は既定
  assert.equal(d.tempMin, 20);
  assert.equal(d.tempMax, 230);
  // 点もイベントも無いときのみ従来の固定既定（約12分）に戻る
  const empty = roastDomain([[]], [[]]);
  assert.equal(empty.tMax, 720);
});
test("roastDomain: 上限時刻の入力でも域は有限（非有限化しない）", () => {
  const d = roastDomain(
    [[{ t: MAX_ROAST_SECONDS, temp: 200 }]],
    [[{ kind: "drop", t: MAX_ROAST_SECONDS }]],
  );
  assert.ok(Number.isFinite(d.tMax));
  assert.ok(Number.isFinite(d.tempMin));
  assert.ok(Number.isFinite(d.tempMax));
  assert.ok(d.tMax >= MAX_ROAST_SECONDS);
});

/* ---- 焙煎度合い ---- */
test("deriveRoastLevel: 減量率で段階が上がる", () => {
  assert.equal(deriveRoastLevel(null), null);
  assert.equal(deriveRoastLevel(13), "light");
  assert.equal(deriveRoastLevel(15), "medium");
  assert.equal(deriveRoastLevel(17.5), "medium_dark");
  assert.equal(deriveRoastLevel(20), "dark");
});
test("effectiveRoastLevel: 明示 > 減量率からの推定", () => {
  assert.equal(effectiveRoastLevel(mkLog({ roastLevel: "dark" })), "dark");
  assert.equal(effectiveRoastLevel(mkLog({ roastLevel: null })), "medium"); // 14.5% → medium
});

/* ---- タグ ---- */
test("normalizeTag / addTag / removeTag", () => {
  assert.equal(normalizeTag("  柑 橘  "), "柑 橘");
  assert.deepEqual(addTag(["ベリー"], "ベリー"), ["ベリー"]); // 重複無視
  assert.deepEqual(addTag(["ベリー"], " チョコ "), ["ベリー", "チョコ"]);
  assert.deepEqual(addTag(["ベリー"], "  "), ["ベリー"]); // 空無視
  assert.deepEqual(removeTag(["ベリー", "チョコ"], "ベリー"), ["チョコ"]);
});
test("allTags: 使用頻度順に集約", () => {
  const logs = [
    mkLog({ id: "a", tags: ["チョコ", "ナッツ"] }),
    mkLog({ id: "b", tags: ["チョコ"] }),
    mkLog({ id: "c", tags: ["ベリー"] }),
  ];
  assert.deepEqual(allTags(logs), ["チョコ", "ナッツ", "ベリー"]);
});
test("filterByTags: 選択タグを全て含む（AND）・空は全件", () => {
  const logs = [
    mkLog({ id: "a", tags: ["チョコ", "ナッツ"] }),
    mkLog({ id: "b", tags: ["チョコ"] }),
  ];
  assert.equal(filterByTags(logs, []).length, 2);
  assert.deepEqual(
    filterByTags(logs, ["チョコ", "ナッツ"]).map((l) => l.id),
    ["a"],
  );
});

/* ---- 全文検索 ---- */
test("searchLogs: 豆名・メモ・タグ・イベントを横断（AND・大小無視）", () => {
  const logs = [
    mkLog({
      id: "a",
      beanName: "ケニア",
      cupping: "黒糖のコク",
      tags: ["チョコ"],
    }),
    mkLog({
      id: "b",
      beanName: "エチオピア",
      cupping: "ベリー",
      tags: ["浅煎り"],
    }),
  ];
  assert.deepEqual(
    searchLogs(logs, "ベリー").map((l) => l.id),
    ["b"],
  );
  assert.deepEqual(
    searchLogs(logs, "黒糖").map((l) => l.id),
    ["a"],
  );
  assert.deepEqual(searchLogs(logs, "1ハゼ").length, 2); // イベント名も対象
  assert.deepEqual(
    searchLogs(logs, "ケニア チョコ").map((l) => l.id),
    ["a"],
  ); // AND
  assert.equal(searchLogs(logs, "  ").length, 2); // 空は全件
});
test("applyFilters: 検索 → タグ絞り込みの合成", () => {
  const logs = [
    mkLog({ id: "a", beanName: "ケニア", tags: ["チョコ"] }),
    mkLog({ id: "b", beanName: "ケニア", tags: ["ベリー"] }),
  ];
  assert.deepEqual(
    applyFilters(logs, "ケニア", ["ベリー"]).map((l) => l.id),
    ["b"],
  );
});

/* ---- バックアップ入出力 ---- */
test("exportLogs / parseImport: round-trip で一致する", () => {
  const logs = [mkLog({ id: "a" }), mkLog({ id: "b", roastLevel: "dark" })];
  const json = exportLogs(logs, 1700000000000);
  const res = parseImport(json);
  assert.equal(res.error, null);
  assert.equal(res.skipped, 0);
  assert.deepEqual(res.logs, logs);
});
test("parseImport: 生の配列も受ける・壊れた要素は skipped で報告", () => {
  const logs = [mkLog({ id: "a" })];
  const res = parseImport(JSON.stringify([...logs, { nope: true }, 42]));
  assert.equal(res.error, null);
  assert.equal(res.logs.length, 1);
  assert.equal(res.skipped, 2);
});
test("parseImport: 不正 JSON / 非対応形式は error（サイレントに空へ倒さない）", () => {
  assert.match(parseImport("{").error ?? "", /読み取れ/);
  assert.match(parseImport('{"foo":1}').error ?? "", /形式/);
  assert.match(parseImport("[]").error ?? "", /ありません/);
});
test("parseImport: 非互換（新しい）バージョンのラップ backup は拒否する", () => {
  const future = JSON.stringify({
    schema: "roastmemo.backup",
    version: 999,
    logs: [mkLog({ id: "a" })],
  });
  const res = parseImport(future);
  assert.notEqual(res.error, null);
  assert.equal(res.logs.length, 0);
  assert.match(res.error ?? "", /バージョン/);
});
test("parseImport: ラップ形式で schema 不一致は拒否・現行 backup は受理", () => {
  // schema 不一致（{logs:[...]} だけ）は degraded 取り込みを防ぐため拒否する
  const noSchema = JSON.stringify({ logs: [mkLog({ id: "a" })] });
  assert.match(parseImport(noSchema).error ?? "", /形式/);
  // 現行スキーマ・現行バージョンのラップ backup は従来どおり受理できる
  const ok = JSON.stringify({
    schema: "roastmemo.backup",
    version: 1,
    logs: [mkLog({ id: "a" })],
  });
  const res = parseImport(ok);
  assert.equal(res.error, null);
  assert.equal(res.logs.length, 1);
});
test("sanitizeLog: id 無しは null・points 正規化・不正イベント除外", () => {
  assert.equal(sanitizeLog({ beanName: "x" }), null);
  const s = sanitizeLog({
    id: "z",
    beanName: "x",
    date: "bad-date",
    points: [
      { t: 60, temp: 120 },
      { t: 0, temp: 180 },
    ],
    events: [
      { kind: "unknown", t: 1 },
      { kind: "drop", t: 700 },
    ],
    tags: ["a", "a", "  "],
  });
  assert.equal(s.date, ""); // 不正日付は空へ
  assert.deepEqual(s.points, [
    { t: 0, temp: 180 },
    { t: 60, temp: 120 },
  ]);
  assert.deepEqual(s.events, [{ kind: "drop", t: 700 }]);
  assert.deepEqual(s.tags, ["a"]);
});
test("sanitizeLog: 負の時刻のイベントは捨てる（入力パスと同じ扱い）", () => {
  const s = sanitizeLog({
    id: "neg",
    beanName: "x",
    events: [
      { kind: "dry_end", t: -5 },
      { kind: "drop", t: 600 },
    ],
  });
  // 負の t のイベントは盤面外へ描かれ 0:00 と誤表示されるため取り込まない。
  assert.deepEqual(s.events, [{ kind: "drop", t: 600 }]);
});
test("sanitizeLog: 上限超の巨大 t の点・イベントは捨てる（DoS 対策）", () => {
  const s = sanitizeLog({
    id: "big",
    beanName: "x",
    points: [
      { t: 60, temp: 120 },
      { t: 1e12, temp: 200 }, // 巨大 t の点
    ],
    events: [
      { kind: "dry_end", t: MAX_ROAST_SECONDS + 1 }, // 上限超のイベント
      { kind: "drop", t: 600 },
    ],
  });
  assert.deepEqual(s.points, [{ t: 60, temp: 120 }]);
  assert.deepEqual(s.events, [{ kind: "drop", t: 600 }]);
});
test("sanitizeLog: updatedAt 欠落は Date.now() を波及させず 0（データ毀損防止）", () => {
  const s = sanitizeLog({ id: "a" }); // updatedAt / createdAt なし
  assert.equal(s.updatedAt, 0);
  assert.equal(s.createdAt, 0);
});
test("mergeLogs: updatedAt 欠落の {id} は既存の完全な新ローカルログに勝たない", () => {
  // 完全なローカルログ（updatedAt=1000）に、部分レコード {id} を取り込んでも上書きされない。
  const full = mkLog({ id: "a", updatedAt: 1000, beanName: "完全なログ" });
  const partial = sanitizeLog({ id: "a" }); // updatedAt=0 になる
  const out = mergeLogs([full], [partial]);
  assert.equal(out.length, 1);
  assert.equal(out[0].beanName, "完全なログ"); // 空既定で潰されない
});

/* ---- マージ・整列 ---- */
test("mergeLogs: 同 id は updatedAt 新しい方・追記は末尾", () => {
  const a = mkLog({ id: "a", updatedAt: 100 });
  const aNew = mkLog({ id: "a", updatedAt: 200, beanName: "新" });
  const b = mkLog({ id: "b", updatedAt: 50 });
  const out = mergeLogs([a], [aNew, b]);
  assert.equal(out.length, 2);
  assert.equal(out.find((l) => l.id === "a").beanName, "新");
});
test("upsertLog: 同 id は updatedAt に関わらず無条件置換・無ければ末尾追記", () => {
  // クロック先行端末からの未来 updatedAt を、より小さい updatedAt の直接編集で上書きできる
  // （mergeLogs なら古い方=未来 updatedAt が残るが、upsert は常に新しい入力を採用）。
  const existing = mkLog({ id: "a", updatedAt: 9_999, beanName: "未来" });
  const edited = mkLog({ id: "a", updatedAt: 100, beanName: "編集後" });
  const out = upsertLog([existing], edited);
  assert.equal(out.length, 1);
  assert.equal(out[0].beanName, "編集後");
  // 新規 id は末尾へ追記
  const b = mkLog({ id: "b" });
  const out2 = upsertLog(out, b);
  assert.deepEqual(
    out2.map((l) => l.id),
    ["a", "b"],
  );
});
test("nextUpdatedAt: 単調増加（未来 updatedAt の編集でも直前版より厳密に新しい）", () => {
  // now がローカル時計、prev=9999 が未来（now より大）のケース → prev+1 を採用
  assert.equal(nextUpdatedAt(1000, 9999), 10000);
  assert.ok(nextUpdatedAt(1000, 9999) > 9999);
  // 通常（now が prev より大）は now
  assert.equal(nextUpdatedAt(5000, 1000), 5000);
  // 新規（prev=null）は now
  assert.equal(nextUpdatedAt(5000, null), 5000);
  // 同値でも厳密に増える
  assert.ok(nextUpdatedAt(2000, 2000) > 2000);
});
test("pickNewer: 現ストレージに新しい版がある id は import の古い版で上書きしない", () => {
  const storageNew = mkLog({
    id: "x",
    updatedAt: 2000,
    beanName: "別タブの新版",
  });
  const importOld = mkLog({
    id: "x",
    updatedAt: 1000,
    beanName: "取り込みの旧版",
  });
  // 取り込みが古い → 既存(ストレージ)を維持
  assert.equal(pickNewer(storageNew, importOld), storageNew);
  // 取り込みが厳密に新しい → 取り込みを採用
  const importNew = mkLog({ id: "x", updatedAt: 3000 });
  assert.equal(pickNewer(storageNew, importNew), importNew);
  // 同値は既存維持（不要な上書きをしない）
  const importSame = mkLog({ id: "x", updatedAt: 2000 });
  assert.equal(pickNewer(storageNew, importSame), storageNew);
});
test("dedupeById: 同一 id の重複は pickNewer で新版へ集約（順不同でも新版が残る）", () => {
  const newVer = mkLog({ id: "x", updatedAt: 2000, beanName: "新版" });
  const oldPartial = mkLog({ id: "x", updatedAt: 1000, beanName: "旧部分" });
  // 新版→旧部分の順（今回のバグの再現順）でも新版が残る
  const a = dedupeById([newVer, oldPartial]);
  assert.equal(a.length, 1);
  assert.equal(a[0].beanName, "新版");
  // 逆順でも新版
  const b = dedupeById([oldPartial, newVer]);
  assert.equal(b.length, 1);
  assert.equal(b[0].beanName, "新版");
  // 別 id は保持し、初出順を保つ
  const c = dedupeById([
    mkLog({ id: "a" }),
    mkLog({ id: "b" }),
    mkLog({ id: "a" }),
  ]);
  assert.deepEqual(
    c.map((l) => l.id),
    ["a", "b"],
  );
});
test("sortLogsForDisplay: 日付降順 → 更新時刻降順", () => {
  const logs = [
    mkLog({ id: "old", date: "2026-07-01" }),
    mkLog({ id: "new", date: "2026-08-10" }),
  ];
  assert.deepEqual(
    sortLogsForDisplay(logs).map((l) => l.id),
    ["new", "old"],
  );
});

/* ---- ファクトリ ---- */
test("emptyLog: 空の初期ログ", () => {
  const e = emptyLog("nid", "2026-08-04", 12345);
  assert.equal(e.id, "nid");
  assert.equal(e.date, "2026-08-04");
  assert.deepEqual(e.points, []);
  assert.equal(e.createdAt, 12345);
  assert.equal(e.updatedAt, 12345);
});
