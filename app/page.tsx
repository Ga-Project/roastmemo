"use client";

// RoastMemo — 自家焙煎の焙煎プロファイル記録計。
// 世界観: ストリップチャート式サーモグラフ。盤面（焙煎カーブ）が主役。
// 保存はすべて端末内の IndexedDB（サーバ不要・全クライアント完結・無料）。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import RoastChart, {
  ghostStyle,
  type GhostCurve,
} from "./components/RoastChart";
import Sparkline from "./components/Sparkline";
import {
  ROAST_LEVELS,
  ROAST_LEVEL_ORDER,
  EVENT_LABELS,
  EVENT_ORDER,
  addEvent,
  addPoint,
  addTag,
  allTags,
  applyFilters,
  effectiveRoastLevel,
  emptyLog,
  exportLogs,
  formatClock,
  nextUpdatedAt,
  parseClock,
  parseImport,
  removeTag,
  roastDomain,
  sortLogsForDisplay,
  upsertLog,
  weightLossPercent,
  type EventKind,
  type RoastEvent,
  type RoastLevel,
  type RoastLog,
  type RoastPoint,
} from "../lib/roast";
import {
  deleteLog as dbDelete,
  isStorageAvailable,
  loadAllLogs,
  mergeImportLogs,
  putLog,
} from "../lib/db";

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function newId(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID)
      return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseNum(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

type Loading = "loading" | "ready" | "error";

export default function Home() {
  const [phase, setPhase] = useState<Loading>("loading");
  const [logs, setLogs] = useState<RoastLog[]>([]);

  // 編集中の焙煎（ドラフト）
  const [editingId, setEditingId] = useState<string | null>(null);
  const [createdAt, setCreatedAt] = useState<number>(0);
  // 編集対象の元 updatedAt（保存時の単調増加の基準）。新規は 0。
  const [editingUpdatedAt, setEditingUpdatedAt] = useState<number>(0);
  const [beanName, setBeanName] = useState("");
  const [date, setDate] = useState(todayISO());
  const [charge, setCharge] = useState("");
  const [drop, setDrop] = useState("");
  const [points, setPoints] = useState<RoastPoint[]>([]);
  const [events, setEvents] = useState<RoastEvent[]>([]);
  const [cupping, setCupping] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [roastLevel, setRoastLevel] = useState<RoastLevel | null>(null);

  // 入力レール
  const [timeInput, setTimeInput] = useState("");
  const [tempInput, setTempInput] = useState("");
  const [tagInput, setTagInput] = useState("");

  // 一覧の絞り込み・重ね比較
  const [query, setQuery] = useState("");
  const [filterTags, setFilterTags] = useState<string[]>([]);
  const [overlay, setOverlay] = useState<string[]>([]);

  // バックアップ
  const [exportText, setExportText] = useState("");
  const [importText, setImportText] = useState("");

  const [message, setMessage] = useState("");
  // 全 DB mutation（保存/インポート/削除）を相互排他にする単一の in-flight フラグ。
  // 保存の in-flight 中にインポートすると stale な logs に対して merge→上書きし、確定済み
  // 編集が巻き戻る等のレースを防ぐ。
  const [busy, setBusy] = useState(false);
  const msgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((m: string) => {
    setMessage(m);
    if (msgTimer.current) clearTimeout(msgTimer.current);
    msgTimer.current = setTimeout(() => setMessage(""), 3000);
  }, []);

  // 初期読み込み（IndexedDB）。
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!isStorageAvailable()) {
        if (alive) setPhase("error");
        return;
      }
      try {
        const loaded = await loadAllLogs();
        if (!alive) return;
        setLogs(loaded);
        setPhase("ready");
      } catch {
        if (alive) setPhase("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const draftLog: RoastLog = useMemo(
    () => ({
      id: editingId ?? "draft",
      beanName,
      date,
      chargeWeight: parseNum(charge),
      dropWeight: parseNum(drop),
      points,
      events,
      cupping,
      tags,
      roastLevel,
      createdAt: createdAt || Date.now(),
      updatedAt: Date.now(),
    }),
    [
      editingId,
      beanName,
      date,
      charge,
      drop,
      points,
      events,
      cupping,
      tags,
      roastLevel,
      createdAt,
    ],
  );

  const loss = weightLossPercent(parseNum(charge), parseNum(drop));
  const level = effectiveRoastLevel(draftLog);

  // ドラフトの内容シグネチャ（volatile な createdAt/updatedAt は除く）。
  // 保存中に別フィールドを編集/別行の編集を始めた場合、保存後の無条件リセットで
  // 新しい入力が黙って消えるのを防ぐため、「保存開始時と同一のドラフトが残っている時だけ」
  // リセットする判定に使う。ref で最新値を保持し、保存完了後に開始時と比較する。
  const draftSignature = useMemo(
    () =>
      JSON.stringify([
        editingId,
        beanName,
        date,
        charge,
        drop,
        points,
        events,
        cupping,
        tags,
        roastLevel,
      ]),
    [
      editingId,
      beanName,
      date,
      charge,
      drop,
      points,
      events,
      cupping,
      tags,
      roastLevel,
    ],
  );
  const draftSigRef = useRef(draftSignature);
  draftSigRef.current = draftSignature;

  // 削除の draft リセット判定で「最新の」編集対象を読むための ref
  // （await をまたぐ間にクロージャ齢の editingId に依存しないため）。
  const editingIdRef = useRef(editingId);
  editingIdRef.current = editingId;

  const tagPalette = useMemo(() => allTags(logs), [logs]);

  // palette に存在しないタグでの絞り込みは無効化する（例: 最後の該当ログを削除/編集し、
  // そのタグが palette から消えた場合）。放置すると未タグのログが全部隠れ、フィルタUIごと
  // 消えてリロードしないと解除できない「スタックする絞り込み」になる。
  const effectiveFilterTags = useMemo(
    () => filterTags.filter((t) => tagPalette.includes(t)),
    [filterTags, tagPalette],
  );

  // palette 変化時に filterTags 自体からもゴーストタグを刈り取る（状態を掃除する）。
  // 変化が無ければ同一参照を返し、setState を発火させずレンダーループを避ける。
  useEffect(() => {
    setFilterTags((prev) => {
      const next = prev.filter((t) => tagPalette.includes(t));
      return next.length === prev.length ? prev : next;
    });
  }, [tagPalette]);

  const displayed = useMemo(
    () => sortLogsForDisplay(applyFilters(logs, query, effectiveFilterTags)),
    [logs, query, effectiveFilterTags],
  );

  const overlayLogs = useMemo(
    () =>
      overlay
        .map((id) => logs.find((l) => l.id === id))
        .filter((l): l is RoastLog => Boolean(l)),
    [overlay, logs],
  );

  const ghosts: GhostCurve[] = useMemo(
    () =>
      overlayLogs.map((l) => ({
        id: l.id,
        name: l.beanName || "無名",
        points: l.points,
      })),
    [overlayLogs],
  );

  // ドメインは温度点だけでなく **イベント時刻も含めて** tMax を取る（最終温度点より後の
  // ドロップ等の旗が盤面外へ切れないように）。重ね表示中は overlay 各ログの点・イベントも含める。
  const domain = useMemo(
    () =>
      roastDomain(
        [points, ...overlayLogs.map((l) => l.points)],
        [events, ...overlayLogs.map((l) => l.events)],
      ),
    [points, events, overlayLogs],
  );

  const latest = points.length > 0 ? points[points.length - 1] : undefined;
  const latestEvent = events.length > 0 ? events[events.length - 1] : undefined;

  /* ------------------------------------------------------- 入力操作 */

  const onPlot = useCallback(() => {
    const t = parseClock(timeInput);
    const temp = parseNum(tempInput);
    if (t == null || temp == null) {
      flash("時間（分:秒）と温度（℃）を入れてください");
      return;
    }
    setPoints((prev) => addPoint(prev, { t, temp }));
    setTempInput("");
  }, [timeInput, tempInput, flash]);

  const onStamp = useCallback(
    (kind: EventKind) => {
      // 時刻欄が空のときだけ最終点(なければ0)へフォールバックする。
      // 非空で不正（例 1:99 / abc）なら、無言で壊れた時刻に記録せずエラーを出す。
      let t: number;
      if (timeInput.trim() === "") {
        t = latest?.t ?? 0;
      } else {
        const parsed = parseClock(timeInput);
        if (parsed == null) {
          flash("時間は 分:秒 で入力してください");
          return;
        }
        t = parsed;
      }
      setEvents((prev) => addEvent(prev, { kind, t }));
      flash(`${EVENT_LABELS[kind]} を ${formatClock(t)} に記録`);
    },
    [timeInput, latest, flash],
  );

  const onAddTag = useCallback(() => {
    setTags((prev) => addTag(prev, tagInput));
    setTagInput("");
  }, [tagInput]);

  const resetDraft = useCallback(() => {
    setEditingId(null);
    setCreatedAt(0);
    setEditingUpdatedAt(0);
    setBeanName("");
    setDate(todayISO());
    setCharge("");
    setDrop("");
    setPoints([]);
    setEvents([]);
    setCupping("");
    setTags([]);
    setRoastLevel(null);
    setTimeInput("");
    setTempInput("");
    setTagInput("");
  }, []);

  const onSave = useCallback(async () => {
    // 多重実行/他 mutation との相互排他: 連打で editingId=null のまま newId() が別IDを作る重複や、
    // インポート/削除との競合を防ぐ。
    if (busy) return;
    if (beanName.trim() === "") {
      flash("豆の名前を入れてください");
      return;
    }
    const now = Date.now();
    const id = editingId ?? newId();
    const log: RoastLog = {
      id,
      beanName: beanName.trim(),
      date,
      chargeWeight: parseNum(charge),
      dropWeight: parseNum(drop),
      points,
      events,
      cupping,
      tags,
      roastLevel,
      createdAt: editingId ? createdAt || now : now,
      // updatedAt は単調増加（編集は直前版より厳密に新しく → 古い backup 再取り込みで巻き戻らない）。
      updatedAt: nextUpdatedAt(now, editingId ? editingUpdatedAt : null),
    };
    const sigAtStart = draftSignature; // 保存開始時のドラフト内容
    setBusy(true);
    try {
      // DB へ書けたときだけ list 更新とドラフトリセットを行う。失敗時はドラフト（入力中の点/
      // フィールド）を保持し、list への楽観追加もしない（リロードで消える幽霊行を作らない）。
      await putLog(log);
    } catch {
      flash("保存に失敗しました（端末のストレージを確認してください）");
      return;
    } finally {
      setBusy(false);
    }
    // 直接編集/保存は upsert（id 一致は無条件置換）。mergeLogs の updatedAt 調停はインポート専用。
    setLogs((prev) => upsertLog(prev, log));
    flash(editingId ? "更新しました" : "保存しました");
    // 保存中にドラフトが変更されていなければリセット。変更されていたら（別フィールド編集や
    // 別行の編集開始）新しい入力を保持し、黙って消さない。
    if (draftSigRef.current === sigAtStart) resetDraft();
  }, [
    busy,
    beanName,
    date,
    charge,
    drop,
    points,
    events,
    cupping,
    tags,
    roastLevel,
    editingId,
    createdAt,
    editingUpdatedAt,
    draftSignature,
    flash,
    resetDraft,
  ]);

  const onEdit = useCallback((log: RoastLog) => {
    setEditingId(log.id);
    setCreatedAt(log.createdAt);
    setEditingUpdatedAt(log.updatedAt);
    setBeanName(log.beanName);
    setDate(log.date || todayISO());
    setCharge(log.chargeWeight == null ? "" : String(log.chargeWeight));
    setDrop(log.dropWeight == null ? "" : String(log.dropWeight));
    setPoints(log.points);
    setEvents(log.events);
    setCupping(log.cupping);
    setTags(log.tags);
    setRoastLevel(log.roastLevel);
    if (typeof window !== "undefined")
      window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const onDelete = useCallback(
    async (id: string) => {
      if (busy) return; // 他 mutation と相互排他
      // DB から消せたときだけ画面から消す（消せていないのに消えたように見せると、
      // リロードで復活して利用者を混乱させる）。失敗は通知する。
      setBusy(true);
      try {
        await dbDelete(id);
      } catch {
        flash("削除に失敗しました（端末のストレージを確認してください）");
        return;
      } finally {
        setBusy(false);
      }
      setLogs((prev) => prev.filter((l) => l.id !== id));
      setOverlay((prev) => prev.filter((x) => x !== id));
      // 削除開始時のクロージャ値ではなく「現在」編集中の行が削除対象と一致する時だけリセットする
      // （busy 中は Edit も無効化しているので通常は変わらないが、二重の安全策）。
      if (editingIdRef.current === id) resetDraft();
      flash("削除しました");
    },
    [busy, resetDraft, flash],
  );

  const toggleOverlay = useCallback((id: string) => {
    setOverlay((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);

  const toggleFilterTag = useCallback((tag: string) => {
    setFilterTags((prev) =>
      prev.includes(tag) ? prev.filter((x) => x !== tag) : [...prev, tag],
    );
  }, []);

  /* ------------------------------------------------------- バックアップ */

  const onExport = useCallback(async () => {
    // 書き出しは in-memory snapshot ではなく **IndexedDB から全件を新規読込** して直列化する。
    // 別タブが保存/削除/インポートした最新の committed 状態も正しく反映され、陳腐/不完全な
    // backup を「成功」として出さない。
    let all: RoastLog[];
    try {
      all = await loadAllLogs();
    } catch {
      flash("書き出しに失敗しました（端末のストレージを確認してください）");
      return;
    }
    const text = exportLogs(all);
    setExportText(text);
    try {
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `roastmemo-backup-${todayISO()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      /* ダウンロード不可でもテキストは画面に出す */
    }
    flash(`${all.length}件を書き出しました`);
  }, [flash]);

  // 取り込みコア（busy は呼び出し側が既に立てている前提）。
  // 永続化は「全件上書き」ではなく mergeImportLogs で **現ストレージに対し id ごとに原子的にマージ**し、
  // 未関与レコードや別タブが更新した新しい版を stale スナップショットで潰さない。
  // 確定後は IndexedDB から再読込して state を更新する（stale な merged を state に入れない）。
  const runImport = useCallback(
    async (text: string): Promise<boolean> => {
      const res = parseImport(text);
      if (res.error) {
        flash(res.error);
        return false;
      }
      let fresh: RoastLog[];
      try {
        await mergeImportLogs(res.logs);
        fresh = await loadAllLogs();
      } catch {
        flash("取り込みに失敗しました（端末のストレージを確認してください）");
        return false;
      }
      setLogs(fresh);
      flash(
        `${res.logs.length}件を取り込みました${res.skipped ? `（${res.skipped}件はスキップ）` : ""}`,
      );
      return true;
    },
    [flash],
  );

  const onImportText = useCallback(async () => {
    if (busy) return; // 他 mutation と相互排他
    setBusy(true);
    try {
      const ok = await runImport(importText);
      if (ok) setImportText("");
    } finally {
      setBusy(false);
    }
  }, [busy, importText, runImport]);

  const onImportFile = useCallback(
    async (file: File) => {
      if (busy) return;
      // busy は file.text() の **前** に立てる（大きいファイルの読み取り中に save/delete/別 import が
      // 開始でき、かつ stale な logs を掴むのを防ぐ）。
      setBusy(true);
      try {
        const text = await file.text();
        await runImport(text);
      } catch {
        flash("ファイルを読み取れませんでした。");
      } finally {
        setBusy(false);
      }
    },
    [busy, runImport, flash],
  );

  /* ------------------------------------------------------- 描画 */

  return (
    <>
      <a className="skip-link" href="#deck">
        本文へスキップ
      </a>

      <div className="recorder">
        {/* サーモカプル読み取りバー（製品名は刻印風） */}
        <header className="thermobar">
          <div className="brand">
            <span className="brand-plate" aria-hidden="true">
              <span className="brand-probe" />
            </span>
            <span className="brand-name">RoastMemo</span>
            <span className="brand-sub">焙煎プロファイル記録計</span>
          </div>
          <div className="readout">
            <div className="readout-cell">
              <span className="readout-num num">
                {latest ? `${Math.round(latest.temp)}` : "––"}
              </span>
              <span className="readout-unit">℃</span>
            </div>
            <div className="readout-cell">
              <span className="readout-num num">
                {latest ? formatClock(latest.t) : "–:––"}
              </span>
            </div>
            <div className="readout-tag">
              {latestEvent ? EVENT_LABELS[latestEvent.kind] : "計測待機"}
            </div>
          </div>
          <ThemeToggle />
        </header>

        <main id="deck" className="deck" tabIndex={-1}>
          <h1 className="visually-hidden">
            RoastMemo — 焙煎プロファイル記録計
          </h1>

          <p className="live-msg" role="status" aria-live="polite">
            {message}
          </p>

          {phase === "loading" && (
            <div className="panel chart-panel">
              <div className="chart-skeleton" aria-hidden="true" />
              <p className="muted">記録計を準備しています…</p>
            </div>
          )}

          {phase === "error" && (
            <div className="panel error-box" role="alert">
              <p>この端末では焙煎ログを保存できませんでした。</p>
              <p className="muted">
                プライベートブラウズや保存制限を解除すると使えます。入力した焙煎ログ（豆名・カーブ・メモ・タグ）は端末内にのみ保存され、外部サーバーへ送信・アップロードされません。
              </p>
              <button className="btn" onClick={() => location.reload()}>
                再読み込み
              </button>
            </div>
          )}

          {phase === "ready" && (
            <>
              {/* 記録計盤面（主役） */}
              <section
                className="panel chart-panel"
                aria-label="焙煎カーブ盤面"
              >
                <RoastChart
                  points={points}
                  events={events}
                  domain={domain}
                  ghosts={ghosts}
                />
                <div className="chart-foot">
                  <ChartLegend />
                  {overlay.length > 0 && (
                    <p className="overlay-caption">
                      重ね比較 <b className="num">{overlay.length}</b> 件
                      <button
                        className="linkish"
                        onClick={() => setOverlay([])}
                      >
                        解除
                      </button>
                    </p>
                  )}
                </div>
                {ghosts.length > 0 && (
                  <ul
                    className="ghost-legend"
                    aria-label="重ねているロットと色の対応"
                  >
                    {ghosts.map((g, i) => {
                      const st = ghostStyle(i);
                      return (
                        <li key={g.id}>
                          <span
                            className="ghost-swatch"
                            aria-hidden="true"
                            style={{ color: `var(${st.colorVar})` }}
                          />
                          <span className="ghost-legend-name">{g.name}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              {/* 計測点／イベントの入力レール */}
              <section className="panel rail" aria-label="計測入力レール">
                {/* busy（保存/インポート/削除中）は入力レール全体を native disable し、
                    mutation 進行中の並行ドラフト編集を不可にする。 */}
                <fieldset className="form-lock" disabled={busy}>
                  <div className="rail-row">
                    <label className="field field-time">
                      <span className="field-label">時間 分:秒</span>
                      <input
                        className="num"
                        type="text"
                        inputMode="numeric"
                        placeholder="1:30"
                        value={timeInput}
                        onChange={(e) => setTimeInput(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && onPlot()}
                        aria-label="計測時刻（分:秒）"
                      />
                    </label>
                    <label className="field field-temp">
                      <span className="field-label">温度 ℃</span>
                      <input
                        className="num"
                        type="number"
                        inputMode="decimal"
                        placeholder="185"
                        value={tempInput}
                        onChange={(e) => setTempInput(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && onPlot()}
                        aria-label="豆温度（℃）"
                      />
                    </label>
                    <button
                      className="btn btn-plot"
                      onClick={onPlot}
                      aria-label="計測点を記録"
                    >
                      点を記録
                    </button>
                  </div>
                  <div
                    className="rail-events"
                    role="group"
                    aria-label="イベントマーカー"
                  >
                    {EVENT_ORDER.map((kind) => (
                      <button
                        key={kind}
                        className="btn-event"
                        onClick={() => onStamp(kind)}
                      >
                        {EVENT_LABELS[kind]}
                      </button>
                    ))}
                  </div>
                  <p className="rail-hint muted">
                    現在 <b className="num">{points.length}</b> 点
                    {events.length > 0 && (
                      <>
                        {" ／ "}
                        {events
                          .map(
                            (e) =>
                              `${EVENT_LABELS[e.kind]} ${formatClock(e.t)}`,
                          )
                          .join("・")}
                      </>
                    )}
                  </p>
                </fieldset>
              </section>

              {/* 豆カード（データプレート） */}
              <section className="panel bean" aria-label="豆のデータプレート">
                <fieldset className="form-lock" disabled={busy}>
                  <div className="bean-head">
                    <label className="field field-bean">
                      <span className="field-label">豆の名前</span>
                      <input
                        type="text"
                        placeholder="例: エチオピア イルガチェフェ"
                        value={beanName}
                        onChange={(e) => setBeanName(e.target.value)}
                        aria-label="豆の名前"
                      />
                    </label>
                    <label className="field field-date">
                      <span className="field-label">日付</span>
                      <input
                        type="date"
                        value={date}
                        onChange={(e) => setDate(e.target.value)}
                        aria-label="焙煎日"
                      />
                    </label>
                  </div>

                  <div className="bean-weights">
                    <label className="field">
                      <span className="field-label">投入量 g</span>
                      <input
                        className="num"
                        type="number"
                        inputMode="decimal"
                        placeholder="220"
                        value={charge}
                        onChange={(e) => setCharge(e.target.value)}
                        aria-label="投入量（g）"
                      />
                    </label>
                    <label className="field">
                      <span className="field-label">排出量 g</span>
                      <input
                        className="num"
                        type="number"
                        inputMode="decimal"
                        placeholder="188"
                        value={drop}
                        onChange={(e) => setDrop(e.target.value)}
                        aria-label="排出量（g）"
                      />
                    </label>
                    <div className="loss" aria-live="polite">
                      <span className="field-label">減量率</span>
                      <span className="loss-num num" aria-label="重量減少率">
                        {loss == null ? "—" : `${loss}`}
                        <span className="loss-unit">%</span>
                      </span>
                    </div>
                    <div className="roast-swatch">
                      <span className="field-label">焙煎度</span>
                      <span className="swatch-row">
                        <span
                          className="swatch"
                          aria-hidden="true"
                          style={{
                            background: level
                              ? ROAST_LEVELS[level].color
                              : "transparent",
                          }}
                        />
                        <select
                          value={roastLevel ?? ""}
                          onChange={(e) =>
                            setRoastLevel(
                              (e.target.value || null) as RoastLevel | null,
                            )
                          }
                          aria-label="焙煎度合い"
                        >
                          <option value="">
                            自動
                            {level ? `（${ROAST_LEVELS[level].label}）` : ""}
                          </option>
                          {ROAST_LEVEL_ORDER.map((k) => (
                            <option key={k} value={k}>
                              {ROAST_LEVELS[k].label}
                            </option>
                          ))}
                        </select>
                      </span>
                    </div>
                  </div>

                  <label className="field field-cup">
                    <span className="field-label">カッピング・所見メモ</span>
                    <textarea
                      rows={3}
                      placeholder="焙煎直後の香り・狙い・気づきを自由に。"
                      value={cupping}
                      onChange={(e) => setCupping(e.target.value)}
                      aria-label="カッピングメモ"
                    />
                  </label>

                  <div className="field field-tags">
                    <span className="field-label">フレーバータグ</span>
                    <div className="tag-input-row">
                      <input
                        type="text"
                        placeholder="ベリー / チョコ / 柑橘 …"
                        value={tagInput}
                        onChange={(e) => setTagInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            onAddTag();
                          }
                        }}
                        aria-label="フレーバータグを追加"
                      />
                      <button
                        className="btn-ghost"
                        onClick={onAddTag}
                        aria-label="タグを追加"
                      >
                        追加
                      </button>
                    </div>
                    {(tags.length > 0 || tagPalette.length > 0) && (
                      <div className="chips">
                        {tags.map((t) => (
                          <button
                            key={t}
                            className="chip chip-on"
                            onClick={() =>
                              setTags((prev) => removeTag(prev, t))
                            }
                            aria-label={`タグ ${t} を外す`}
                          >
                            {t}
                            <span aria-hidden="true"> ✕</span>
                          </button>
                        ))}
                        {tagPalette
                          .filter((t) => !tags.includes(t))
                          .slice(0, 8)
                          .map((t) => (
                            <button
                              key={t}
                              className="chip chip-suggest"
                              onClick={() => setTags((prev) => addTag(prev, t))}
                              aria-label={`タグ ${t} を付ける`}
                            >
                              + {t}
                            </button>
                          ))}
                      </div>
                    )}
                  </div>

                  <div className="bean-actions">
                    <button
                      className="btn btn-save"
                      onClick={onSave}
                      disabled={busy}
                    >
                      {editingId ? "更新して保存" : "この焙煎を保存"}
                    </button>
                    <button className="btn-ghost btn-new" onClick={resetDraft}>
                      {editingId ? "編集をやめる" : "入力をクリア"}
                    </button>
                  </div>
                </fieldset>
              </section>

              {/* ログ一覧（検索・タグ絞込・重ね比較） */}
              <section className="panel logs" aria-label="焙煎ログ一覧">
                <div className="logs-head">
                  <h2 className="logs-title">記録した焙煎</h2>
                  <label className="search">
                    <span className="visually-hidden">焙煎ログを検索</span>
                    <input
                      type="search"
                      placeholder="豆名・メモ・タグを検索"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      aria-label="焙煎ログを検索"
                    />
                  </label>
                </div>

                {(tagPalette.length > 0 || filterTags.length > 0) && (
                  <div
                    className="filter-tags"
                    role="group"
                    aria-label="タグで絞り込み"
                  >
                    {tagPalette.map((t) => (
                      <button
                        key={t}
                        className={`chip filter-chip${effectiveFilterTags.includes(t) ? " chip-on" : ""}`}
                        aria-pressed={effectiveFilterTags.includes(t)}
                        onClick={() => toggleFilterTag(t)}
                      >
                        {t}
                      </button>
                    ))}
                    {filterTags.length > 0 && (
                      <button
                        className="linkish"
                        onClick={() => setFilterTags([])}
                      >
                        絞り込み解除
                      </button>
                    )}
                  </div>
                )}

                {logs.length === 0 ? (
                  <div className="empty">
                    <p className="empty-title">まだ焙煎ログがありません</p>
                    <p className="muted">
                      上のレールで時間と温度を記録し、豆の名前を付けて「この焙煎を保存」すると、ここに焙煎カーブが並びます。
                    </p>
                  </div>
                ) : displayed.length === 0 ? (
                  <p className="muted empty-filter">
                    条件に合う焙煎ログはありません。
                  </p>
                ) : (
                  <ul className="log-list">
                    {displayed.map((log) => (
                      <LogItem
                        key={log.id}
                        log={log}
                        overlaid={overlay.includes(log.id)}
                        editing={editingId === log.id}
                        busy={busy}
                        onToggleOverlay={() => toggleOverlay(log.id)}
                        onEdit={() => onEdit(log)}
                        onDelete={() => onDelete(log.id)}
                      />
                    ))}
                  </ul>
                )}
              </section>

              {/* バックアップ（端末間移行） */}
              <details className="panel backup">
                <summary>バックアップ（書き出し・取り込み）</summary>
                <div className="backup-body">
                  <p className="muted">
                    焙煎ログはこの端末の中だけに保存されます。別の端末へ移す・控えを取るには
                    JSON で書き出し、取り込んでください。
                  </p>
                  <div className="backup-col">
                    <button
                      className="btn-ghost btn-export"
                      onClick={onExport}
                      disabled={busy}
                    >
                      JSONに書き出す
                    </button>
                    <textarea
                      className="num"
                      rows={4}
                      readOnly
                      placeholder="「JSONに書き出す」でここに内容が出ます（ファイルも保存されます）"
                      value={exportText}
                      aria-label="バックアップデータ"
                    />
                  </div>
                  <div className="backup-col">
                    <div className="backup-import-head">
                      <span className="field-label">取り込み</span>
                      <label className="file-btn">
                        ファイルを選ぶ
                        <input
                          type="file"
                          accept="application/json,.json"
                          disabled={busy}
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) onImportFile(f);
                            e.target.value = "";
                          }}
                          aria-label="バックアップファイルを選ぶ"
                        />
                      </label>
                    </div>
                    <textarea
                      className="num"
                      rows={4}
                      placeholder="バックアップJSONを貼り付けて「取り込む」"
                      value={importText}
                      onChange={(e) => setImportText(e.target.value)}
                      disabled={busy}
                      aria-label="復元データを貼り付け"
                    />
                    <button
                      className="btn-ghost btn-import"
                      onClick={onImportText}
                      disabled={busy}
                    >
                      取り込む
                    </button>
                  </div>
                </div>
              </details>
            </>
          )}
        </main>

        <footer className="foot">
          <p>
            自家焙煎の焙煎プロファイルを記録・比較するためのツールです。入力した焙煎ログ（豆名・焙煎カーブ・メモ・タグ）はお使いの端末内（IndexedDB）にのみ保存され、外部サーバーへ送信・アップロードされません。
          </p>
        </footer>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ 部品 */

function ChartLegend() {
  return (
    <ul className="legend" aria-label="盤面の凡例">
      <li>
        <span className="lg-line lg-curve" aria-hidden="true" /> 焙煎カーブ
      </li>
      <li>
        <span className="lg-line lg-ghost" aria-hidden="true" /> 比較ロット
      </li>
      <li>
        <span className="lg-flag" aria-hidden="true" /> マイルストーン
      </li>
    </ul>
  );
}

function LogItem({
  log,
  overlaid,
  editing,
  busy,
  onToggleOverlay,
  onEdit,
  onDelete,
}: {
  log: RoastLog;
  overlaid: boolean;
  editing: boolean;
  busy: boolean;
  onToggleOverlay: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const loss = weightLossPercent(log.chargeWeight, log.dropWeight);
  const level = effectiveRoastLevel(log);
  // 削除は誤操作で唯一の記録を恒久破棄しないよう行内2段階確認にする（サーバ復旧手段が無いため）。
  const [confirming, setConfirming] = useState(false);
  const revertTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearRevert = () => {
    if (revertTimer.current) clearTimeout(revertTimer.current);
    revertTimer.current = null;
  };
  useEffect(() => clearRevert, []);
  const askDelete = () => {
    setConfirming(true);
    clearRevert();
    revertTimer.current = setTimeout(() => setConfirming(false), 5000); // 数秒で自動復帰
  };
  const cancelDelete = () => {
    clearRevert();
    setConfirming(false);
  };
  const confirmDelete = () => {
    clearRevert();
    setConfirming(false);
    onDelete();
  };
  return (
    <li
      className={`log-item${editing ? " is-editing" : ""}${overlaid ? " is-overlaid" : ""}`}
    >
      <div className="log-spark">
        <Sparkline points={log.points} active={overlaid} />
      </div>
      <div className="log-main">
        <div className="log-title-row">
          <span
            className="log-swatch"
            aria-hidden="true"
            style={{
              background: level ? ROAST_LEVELS[level].color : "var(--line)",
            }}
          />
          <span className="log-name">{log.beanName || "（無名の焙煎）"}</span>
          <span className="log-date num">{log.date}</span>
        </div>
        <div className="log-meta num">
          <span>{log.points.length} 点</span>
          {loss != null && <span>減量 {loss}%</span>}
          {level && <span>{ROAST_LEVELS[level].label}</span>}
        </div>
        {log.cupping && <p className="log-cup">{log.cupping}</p>}
        {log.tags.length > 0 && (
          <div className="log-tags">
            {log.tags.map((t) => (
              <span key={t} className="chip chip-static">
                {t}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="log-actions">
        <button
          className={`btn-overlay${overlaid ? " is-on" : ""}`}
          aria-pressed={overlaid}
          onClick={onToggleOverlay}
        >
          {overlaid ? "重ね中" : "重ねる"}
        </button>
        <button className="btn-ghost small" onClick={onEdit} disabled={busy}>
          編集
        </button>
        {confirming ? (
          <div className="del-confirm" role="group" aria-label="削除の確認">
            <button
              className="btn-ghost small danger"
              onClick={confirmDelete}
              disabled={busy}
              autoFocus
              aria-label={`${log.beanName || "焙煎ログ"}を本当に削除する`}
            >
              本当に削除
            </button>
            <button
              className="btn-ghost small"
              onClick={cancelDelete}
              disabled={busy}
            >
              やめる
            </button>
          </div>
        ) : (
          <button
            className="btn-ghost small danger"
            onClick={askDelete}
            disabled={busy}
            aria-label={`${log.beanName || "焙煎ログ"}を削除`}
          >
            削除
          </button>
        )}
      </div>
    </li>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    let saved: "light" | "dark" | null = null;
    try {
      const v = localStorage.getItem("roastmemo:theme");
      if (v === "light" || v === "dark") saved = v;
    } catch {
      /* noop */
    }
    setTheme(saved);
    if (saved) document.documentElement.setAttribute("data-theme", saved);
  }, []);

  const toggle = () => {
    const current =
      document.documentElement.getAttribute("data-theme") ??
      (window.matchMedia?.("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light");
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("roastmemo:theme", next);
    } catch {
      /* noop */
    }
    setTheme(next);
  };

  const isDark =
    mounted &&
    (theme === "dark" ||
      (theme === null &&
        typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-color-scheme: dark)").matches));

  return (
    <button
      className="theme-toggle"
      onClick={toggle}
      aria-label="明暗を切り替える"
      title="明暗を切り替える"
    >
      <span aria-hidden="true">{isDark ? "☀" : "☾"}</span>
    </button>
  );
}
