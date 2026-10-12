// RoastMemo — 焙煎ログのコアロジック（フレームワーク非依存の純関数群）。
//
// UI・IndexedDB・React に一切依存しない。時間×温度の計測点、イベント（ハゼ等）、
// 重量減少率、全文検索、タグ絞り込み、JSON バックアップの入出力をここに集約し、
// node:test で単体テストできるようにしている（描画とストレージは呼び出し側の責務）。

/** ロースト工程のイベント種別（時刻に打つマイルストーン）。 */
export type EventKind = "dry_end" | "first_crack" | "second_crack" | "drop";

/** イベントの表示名（盤面の旗ラベルや一覧で使う）。 */
export const EVENT_LABELS: Record<EventKind, string> = {
  dry_end: "乾燥終わり",
  first_crack: "1ハゼ",
  second_crack: "2ハゼ",
  drop: "ドロップ",
};

/** イベントの短縮ラベル（グラフ上の旗など狭い場所用）。 */
export const EVENT_SHORT: Record<EventKind, string> = {
  dry_end: "乾",
  first_crack: "1",
  second_crack: "2",
  drop: "⤓",
};

/** イベントの表示順（左→右で工程が進む）。 */
export const EVENT_ORDER: EventKind[] = [
  "dry_end",
  "first_crack",
  "second_crack",
  "drop",
];

/** 1つの計測点。t=経過秒、temp=豆温度(℃)。 */
export interface RoastPoint {
  t: number;
  temp: number;
}

/** 時刻に打つイベントマーカー。 */
export interface RoastEvent {
  kind: EventKind;
  t: number;
}

/** 焙煎の度合い（豆カードの色スウォッチに写像する）。 */
export type RoastLevel = "light" | "medium" | "medium_dark" | "dark";

export interface RoastLevelInfo {
  key: RoastLevel;
  label: string;
  /** 色スウォッチの色（生豆に近いタン〜濃いココアへ）。 */
  color: string;
}

export const ROAST_LEVELS: Record<RoastLevel, RoastLevelInfo> = {
  light: { key: "light", label: "ライト", color: "#c99a5b" },
  medium: { key: "medium", label: "ミディアム", color: "#a9702f" },
  medium_dark: {
    key: "medium_dark",
    label: "ミディアムダーク",
    color: "#7c4a22",
  },
  dark: { key: "dark", label: "ダーク", color: "#4a2d18" },
};

export const ROAST_LEVEL_ORDER: RoastLevel[] = [
  "light",
  "medium",
  "medium_dark",
  "dark",
];

/** 1回の焙煎ログ。 */
export interface RoastLog {
  id: string;
  beanName: string;
  date: string; // YYYY-MM-DD
  chargeWeight: number | null; // 投入量(g)
  dropWeight: number | null; // 排出量(g)
  points: RoastPoint[];
  events: RoastEvent[];
  cupping: string; // カッピング／所見メモ
  tags: string[]; // ユーザー定義フレーバータグ
  /** ユーザーが明示指定したロースト度合い。null なら減量率から推定する。 */
  roastLevel: RoastLevel | null;
  createdAt: number; // epoch ms
  updatedAt: number; // epoch ms
}

/** バックアップ JSON のスキーマ識別子とバージョン。 */
export const BACKUP_SCHEMA = "roastmemo.backup";
export const BACKUP_VERSION = 1;

/**
 * 計測時刻の許容上限（秒）。焙煎は分オーダーだが寛容に 24 時間まで。
 * これを超える時刻は入力・取り込みともに捨て、盤面の目盛りループ暴走
 * （巨大 tMax による大量 SVG 生成でのタブ凍結）や tMax の非有限化を根本から防ぐ。
 */
export const MAX_ROAST_SECONDS = 86400;

/* ------------------------------------------------------------------ 時間 */

/**
 * 時刻文字列を秒に変換する。"m:ss" / "mm:ss" / 純粋な秒数("90") を受ける。
 * 空・不正は null（呼び出し側で「入力なし」と区別できる）。
 */
export function parseClock(input: string): number | null {
  const s = input.trim();
  if (s === "") return null;
  // 有限かつ 0..MAX_ROAST_SECONDS の範囲内のみ受理（巨大値は盤面暴走の元なので拒否）。
  const inRange = (v: number): number | null =>
    Number.isFinite(v) && v >= 0 && v <= MAX_ROAST_SECONDS ? v : null;
  if (/^\d+$/.test(s)) {
    return inRange(Number(s));
  }
  const m = s.match(/^(\d+):([0-5]?\d)$/);
  if (!m) return null;
  const min = Number(m[1]);
  const sec = Number(m[2]);
  if (!Number.isFinite(min) || !Number.isFinite(sec)) return null;
  return inRange(min * 60 + sec);
}

/** 秒を "m:ss" 表記にする（負値は 0 に丸める）。 */
export function formatClock(totalSeconds: number): string {
  const t = Math.max(0, Math.round(totalSeconds));
  const min = Math.floor(t / 60);
  const sec = t % 60;
  return `${min}:${String(sec).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ 重量 */

/**
 * 重量減少率(%) を返す。投入量・排出量が正で drop<=charge のときのみ数値、
 * それ以外（未入力・非現実値）は null。小数第1位に丸める。
 */
export function weightLossPercent(
  charge: number | null,
  drop: number | null,
): number | null {
  if (charge == null || drop == null) return null;
  if (!Number.isFinite(charge) || !Number.isFinite(drop)) return null;
  if (charge <= 0 || drop < 0 || drop > charge) return null;
  return Math.round((1 - drop / charge) * 1000) / 10;
}

/* ------------------------------------------------------------------ 計測点 */

/**
 * 計測点列を整える: 有限値のみ・t 昇順・同一 t は後勝ちで1点に畳む。
 * （記録は時系列で描くので、順不同入力や打ち直しがあっても盤面が破綻しないようにする）
 */
export function normalizePoints(points: RoastPoint[]): RoastPoint[] {
  const byT = new Map<number, number>();
  for (const p of points) {
    if (!Number.isFinite(p.t) || !Number.isFinite(p.temp)) continue;
    if (p.t < 0 || p.t > MAX_ROAST_SECONDS) continue; // 範囲外の時刻は捨てる（盤面暴走防止）
    byT.set(p.t, p.temp); // 後勝ち
  }
  return [...byT.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, temp]) => ({ t, temp }));
}

/** 計測点を1つ足した新しい配列を返す（正規化込み・不変更新）。 */
export function addPoint(points: RoastPoint[], p: RoastPoint): RoastPoint[] {
  return normalizePoints([...points, p]);
}

/** イベントを1つ足す（同種は後勝ちで時刻更新・kind 順で安定ソート）。 */
export function addEvent(events: RoastEvent[], e: RoastEvent): RoastEvent[] {
  if (!Number.isFinite(e.t) || e.t < 0 || e.t > MAX_ROAST_SECONDS)
    return events;
  const byKind = new Map<EventKind, number>();
  for (const ev of events) byKind.set(ev.kind, ev.t);
  byKind.set(e.kind, e.t);
  return EVENT_ORDER.filter((k) => byKind.has(k)).map((k) => ({
    kind: k,
    t: byKind.get(k) as number,
  }));
}

export interface RoastDomain {
  tMax: number;
  tempMin: number;
  tempMax: number;
}

/**
 * 複数の点列をまとめて描くための座標域を返す（重ね比較で全ロットが収まるように）。
 * 空でも破綻しない既定域（0..12分 / 20..230℃）を返し、実データがあれば少し余白を付ける。
 *
 * tMax（時間軸）は温度点だけでなく **イベント時刻も含めて** 取る。最終温度点より後ろの
 * ドロップ等のイベントがあっても、その旗が盤面の外に切れないようにするため。
 */
export function roastDomain(
  pointArrays: RoastPoint[][],
  eventArrays: RoastEvent[][] = [],
): RoastDomain {
  let tMax = 0;
  let tempMin = Infinity;
  let tempMax = -Infinity;
  for (const arr of pointArrays) {
    for (const p of arr) {
      if (!Number.isFinite(p.t) || !Number.isFinite(p.temp)) continue;
      if (p.t > tMax) tMax = p.t;
      if (p.temp < tempMin) tempMin = p.temp;
      if (p.temp > tempMax) tempMax = p.temp;
    }
  }
  for (const evs of eventArrays) {
    for (const e of evs) {
      if (Number.isFinite(e.t) && e.t > tMax) tMax = e.t;
    }
  }
  // 時間軸は「点/イベントの最大時刻 + 余白」を60秒グリッドに切り上げる（下限2分）。
  const timeAxisMax = Math.max(120, Math.ceil((tMax + 30) / 60) * 60);
  if (!Number.isFinite(tempMin) || !Number.isFinite(tempMax)) {
    // 温度点が無いときは温度域を既定にするが、時間軸はスキャン済みのイベント時刻を覆う。
    // （点を打つ前に例えば 20:00 のイベントを入れても旗が盤面外に出ないように）
    return { tMax: tMax > 0 ? timeAxisMax : 720, tempMin: 20, tempMax: 230 };
  }
  const padTemp = Math.max(10, (tempMax - tempMin) * 0.12);
  return {
    tMax: timeAxisMax,
    tempMin: Math.max(0, Math.floor((tempMin - padTemp) / 10) * 10),
    tempMax: Math.ceil((tempMax + padTemp) / 10) * 10,
  };
}

/* ------------------------------------------------------------------ ロースト度合い */

/** 減量率(%) から焙煎度合いを推定する（明示指定が無いときの既定）。 */
export function deriveRoastLevel(
  lossPercent: number | null,
): RoastLevel | null {
  if (lossPercent == null) return null;
  if (lossPercent < 14) return "light";
  if (lossPercent < 16) return "medium";
  if (lossPercent < 18.5) return "medium_dark";
  return "dark";
}

/** ログの実効ロースト度合い（明示指定 > 減量率からの推定）。 */
export function effectiveRoastLevel(log: RoastLog): RoastLevel | null {
  if (log.roastLevel) return log.roastLevel;
  return deriveRoastLevel(weightLossPercent(log.chargeWeight, log.dropWeight));
}

/* ------------------------------------------------------------------ タグ */

/** タグ文字列を正規化する（前後空白除去・内部空白畳み・空は除外）。 */
export function normalizeTag(tag: string): string {
  return tag.trim().replace(/\s+/g, " ");
}

/** タグを1つ足す（正規化・重複排除・空は無視）。 */
export function addTag(tags: string[], tag: string): string[] {
  const t = normalizeTag(tag);
  if (t === "") return tags;
  if (tags.some((x) => x.toLowerCase() === t.toLowerCase())) return tags;
  return [...tags, t];
}

/** タグを外す。 */
export function removeTag(tags: string[], tag: string): string[] {
  return tags.filter((x) => x !== tag);
}

/** ログ集合に出現する全タグを、使用頻度の高い順→名前順で返す。 */
export function allTags(logs: RoastLog[]): string[] {
  const count = new Map<string, number>();
  for (const log of logs) {
    for (const t of log.tags) count.set(t, (count.get(t) ?? 0) + 1);
  }
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ja"))
    .map(([t]) => t);
}

/**
 * 選択タグでの絞り込み。選択が空なら全件。選択したタグを **すべて** 含むログのみ返す（AND）。
 */
export function filterByTags(logs: RoastLog[], selected: string[]): RoastLog[] {
  if (selected.length === 0) return logs;
  return logs.filter((log) =>
    selected.every((sel) => log.tags.some((t) => t === sel)),
  );
}

/* ------------------------------------------------------------------ 全文検索 */

/** ログを検索対象の1文字列に平坦化する（豆名・日付・メモ・タグ・イベント名を横断）。 */
function haystack(log: RoastLog): string {
  const events = log.events.map((e) => EVENT_LABELS[e.kind]).join(" ");
  return [log.beanName, log.date, log.cupping, log.tags.join(" "), events]
    .join(" ")
    .toLowerCase();
}

/**
 * インクリメンタル全文検索。空白区切りの各語を **すべて** 含むログを返す（AND・大小無視）。
 * 空クエリは全件（絞り込み解除）。
 */
export function searchLogs(logs: RoastLog[], query: string): RoastLog[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (terms.length === 0) return logs;
  return logs.filter((log) => {
    const hay = haystack(log);
    return terms.every((term) => hay.includes(term));
  });
}

/** 検索 → タグ絞り込みを合成する（一覧表示で使う既定の絞り込み）。 */
export function applyFilters(
  logs: RoastLog[],
  query: string,
  selectedTags: string[],
): RoastLog[] {
  return filterByTags(searchLogs(logs, query), selectedTags);
}

/* ------------------------------------------------------------------ ファクトリ／整形 */

/** 新しい空のログを作る。 */
export function emptyLog(id: string, date: string, now: number): RoastLog {
  return {
    id,
    beanName: "",
    date,
    chargeWeight: null,
    dropWeight: null,
    points: [],
    events: [],
    cupping: "",
    tags: [],
    roastLevel: null,
    createdAt: now,
    updatedAt: now,
  };
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 外部由来（インポート等）の生データを点検・整形して RoastLog にする。
 * 必須が壊れていれば null（呼び出し側でスキップ）。points は正規化して安定化する。
 */
export function sanitizeLog(raw: unknown): RoastLog | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" && r.id ? r.id : null;
  if (!id) return null;

  const points = Array.isArray(r.points)
    ? normalizePoints(
        r.points
          .map((p): RoastPoint | null => {
            if (typeof p !== "object" || p === null) return null;
            const pr = p as Record<string, unknown>;
            const t = numOrNull(pr.t);
            const temp = numOrNull(pr.temp);
            return t == null || temp == null ? null : { t, temp };
          })
          .filter((p): p is RoastPoint => p !== null),
      )
    : [];

  const events: RoastEvent[] = Array.isArray(r.events)
    ? r.events
        .map((e): RoastEvent | null => {
          if (typeof e !== "object" || e === null) return null;
          const er = e as Record<string, unknown>;
          const kind = er.kind;
          const t = numOrNull(er.t);
          // 入力パス(addEvent)と同様、範囲外の時刻は不正として捨てる（負の t が 0:00 と
          // 誤表示されたり、巨大な t が盤面の目盛りを暴走させるのを防ぐ）。
          if (t == null || t < 0 || t > MAX_ROAST_SECONDS) return null;
          if (
            kind !== "dry_end" &&
            kind !== "first_crack" &&
            kind !== "second_crack" &&
            kind !== "drop"
          ) {
            return null;
          }
          return { kind, t };
        })
        .filter((e): e is RoastEvent => e !== null)
    : [];

  const tags = Array.isArray(r.tags)
    ? r.tags.reduce<string[]>(
        (acc, t) => (typeof t === "string" ? addTag(acc, t) : acc),
        [],
      )
    : [];

  const roastLevel =
    r.roastLevel === "light" ||
    r.roastLevel === "medium" ||
    r.roastLevel === "medium_dark" ||
    r.roastLevel === "dark"
      ? r.roastLevel
      : null;

  // updatedAt が欠落/非有限なら「マージで勝てない古い値(0)」にする。
  // Date.now() を波及させると、{id} だけの部分レコードが「より新しい」と誤判定され、
  // 完全なローカルログを空既定で上書きしてしまう（データ毀損）。createdAt にも now を使わない。
  const updatedAt = numOrNull(r.updatedAt);
  const createdAt = numOrNull(r.createdAt);
  return {
    id,
    beanName: typeof r.beanName === "string" ? r.beanName : "",
    date:
      typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date)
        ? r.date
        : "",
    chargeWeight: numOrNull(r.chargeWeight),
    dropWeight: numOrNull(r.dropWeight),
    points,
    events: sortEvents(events),
    cupping: typeof r.cupping === "string" ? r.cupping : "",
    tags,
    roastLevel,
    createdAt: createdAt ?? updatedAt ?? 0,
    updatedAt: updatedAt ?? 0,
  };
}

/** イベントを工程順に並べる（表示の安定化・重複種別は後勝ち）。 */
export function sortEvents(events: RoastEvent[]): RoastEvent[] {
  const byKind = new Map<EventKind, number>();
  for (const e of events) byKind.set(e.kind, e.t);
  return EVENT_ORDER.filter((k) => byKind.has(k)).map((k) => ({
    kind: k,
    t: byKind.get(k) as number,
  }));
}

/* ------------------------------------------------------------------ バックアップ入出力 */

/** ログ配列を人が読める JSON バックアップ文字列にする。 */
export function exportLogs(logs: RoastLog[], now: number = Date.now()): string {
  return JSON.stringify(
    {
      schema: BACKUP_SCHEMA,
      version: BACKUP_VERSION,
      exportedAt: new Date(now).toISOString(),
      count: logs.length,
      logs,
    },
    null,
    2,
  );
}

export interface ImportResult {
  logs: RoastLog[];
  error: string | null;
  skipped: number;
}

/**
 * バックアップ文字列を取り込む。スキーマ違い・壊れた要素は握りつぶさず
 * error / skipped で報告する（サイレントに空へ倒さない）。
 */
export function parseImport(text: string): ImportResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { logs: [], error: "JSON として読み取れませんでした。", skipped: 0 };
  }
  // 受理する形式:
  //   1. 生の配列（旧/簡易形式）… schema を問わず後方互換のため受理する。
  //   2. ラップ形式 { schema, version, logs } … schema/version を照合し、
  //      既知スキーマかつ互換バージョン（<= 現行）でなければ受理しない。
  //      未知フィールドを空既定にサニタイズして degraded なレコードを永続化するのを防ぐ。
  let rawList: unknown[];
  if (Array.isArray(data)) {
    rawList = data;
  } else if (typeof data === "object" && data !== null) {
    const obj = data as Record<string, unknown>;
    if (obj.schema !== BACKUP_SCHEMA) {
      return {
        logs: [],
        error: "焙煎ログのバックアップ形式ではありません。",
        skipped: 0,
      };
    }
    const version = obj.version;
    if (
      typeof version !== "number" ||
      !Number.isInteger(version) ||
      version < 1
    ) {
      return {
        logs: [],
        error: "バックアップのバージョンを判別できませんでした。",
        skipped: 0,
      };
    }
    if (version > BACKUP_VERSION) {
      return {
        logs: [],
        error: `新しいバージョン（v${version}）のバックアップは取り込めません。アプリを更新してください。`,
        skipped: 0,
      };
    }
    if (!Array.isArray(obj.logs)) {
      return {
        logs: [],
        error: "焙煎ログのバックアップ形式ではありません。",
        skipped: 0,
      };
    }
    rawList = obj.logs as unknown[];
  } else {
    return {
      logs: [],
      error: "焙煎ログのバックアップ形式ではありません。",
      skipped: 0,
    };
  }
  const logs: RoastLog[] = [];
  let skipped = 0;
  for (const raw of rawList) {
    const log = sanitizeLog(raw);
    if (log) logs.push(log);
    else skipped++;
  }
  if (logs.length === 0) {
    return {
      logs: [],
      error: "取り込めるログがありませんでした。",
      skipped,
    };
  }
  return { logs, error: null, skipped };
}

/**
 * 1件を挿入/置換する（id 一致は無条件で置換、無ければ末尾に追記）。
 * 端末内での直接編集/保存はこちらを使う。updatedAt の新旧調停はしない
 * （クロック先行端末からインポートした未来 updatedAt のログを編集しても、
 *  こちらは常に新しい入力を採用し、UI/エクスポートが stale にならない）。
 */
export function upsertLog(logs: RoastLog[], log: RoastLog): RoastLog[] {
  const idx = logs.findIndex((l) => l.id === log.id);
  if (idx === -1) return [...logs, log];
  const next = logs.slice();
  next[idx] = log;
  return next;
}

/**
 * 保存/編集時の updatedAt を **単調増加** にする（直前版より厳密に大きい値を返す）。
 * クロック先行端末からインポートしたログ（updatedAt がローカル時計より未来）を編集しても、
 * `Date.now()` に退行させず prev+1 以上にすることで、後で元 backup を再取り込みしても
 * mergeImportLogs/pickNewer で編集が勝ち続ける（巻き戻らない）。新規は prev=null で now。
 */
export function nextUpdatedAt(
  now: number,
  prevUpdatedAt: number | null,
): number {
  return Math.max(now, (prevUpdatedAt ?? 0) + 1);
}

/**
 * 同一 id の2レコードのうち残すべき方を返す（マージの勝敗判定・純関数）。
 * 現ストレージ(existing)に取り込み(incoming)より新しい版があるとき、古い incoming で
 * 上書きしないため **incoming は厳密に新しい(updatedAt が大きい)ときだけ勝つ**（同値は existing 維持）。
 * DB の原子マージ(mergeImportLogs)で id ごとに使う。
 */
export function pickNewer(existing: RoastLog, incoming: RoastLog): RoastLog {
  return incoming.updatedAt > existing.updatedAt ? incoming : existing;
}

/**
 * 同一 id を1件へ畳む（同一 id 内は pickNewer で新しい版へ集約）。
 * DB マージ前に呼ぶ。トランザクション内で全 get が put より先にキューされる都合上、
 * import 配列内に重複 id があると「最後のエントリが updatedAt 無視で書かれる」ため、
 * 事前に畳んでおくことで import 内重複でも updatedAt 調停が効く。順序は初出 id を保つ。
 */
export function dedupeById(logs: RoastLog[]): RoastLog[] {
  const map = new Map<string, RoastLog>();
  for (const log of logs) {
    const cur = map.get(log.id);
    map.set(log.id, cur ? pickNewer(cur, log) : log);
  }
  return [...map.values()];
}

/**
 * 既存ログへ取り込みログを統合する（id 一致は updatedAt が新しい方を採用・追記は末尾）。
 * 端末間移行で同じログを二重化させないための決定的マージ。**インポート専用**。
 */
export function mergeLogs(
  existing: RoastLog[],
  incoming: RoastLog[],
): RoastLog[] {
  const map = new Map<string, RoastLog>();
  for (const log of existing) map.set(log.id, log);
  for (const log of incoming) {
    const cur = map.get(log.id);
    if (!cur || log.updatedAt >= cur.updatedAt) map.set(log.id, log);
  }
  return [...map.values()];
}

/** 一覧表示の既定並び（新しい日付→新しい更新時刻）。 */
export function sortLogsForDisplay(logs: RoastLog[]): RoastLog[] {
  return [...logs].sort(
    (a, b) => b.date.localeCompare(a.date) || b.updatedAt - a.updatedAt,
  );
}
