// RoastMemo — 焙煎記録計の盤面（inline SVG・外部チャートライブラリ非依存）。
//
// ストリップチャート式サーモグラフ。暖色のグラフ用紙に、ロースト段階のティント帯を敷き、
// 温度でサーマルグラデーション（琥珀→残り火レッド）した焙煎カーブを引く。
// マイルストーン旗を時刻に立て、比較ロットは半透明ゴースト線で重畳する。

import {
  EVENT_SHORT,
  EVENT_LABELS,
  formatClock,
  type RoastDomain,
  type RoastEvent,
  type RoastPoint,
} from "../../lib/roast";

export interface GhostCurve {
  id: string;
  name: string;
  points: RoastPoint[];
}

// 比較ロットごとに色相と破線を振り分ける（同色同破線だと2件以上で見分けられない）。
// 色は globals.css の CSS 変数（light/dark で別値・盤面に対し十分なコントラスト）で持つ。
export interface GhostStyle {
  colorVar: string;
  dash: string;
}
export const GHOST_STYLES: GhostStyle[] = [
  { colorVar: "--ghost-1", dash: "7 4" },
  { colorVar: "--ghost-2", dash: "2 4" },
  { colorVar: "--ghost-3", dash: "9 3 2 3" },
  { colorVar: "--ghost-4", dash: "5 5" },
  { colorVar: "--ghost-5", dash: "12 4" },
];
/** i 番目の比較ロットのスタイル（色相＋破線）。盤面と凡例で同じ対応を使う。 */
export const ghostStyle = (i: number): GhostStyle =>
  GHOST_STYLES[i % GHOST_STYLES.length]!;

interface Props {
  points: RoastPoint[];
  events: RoastEvent[];
  domain: RoastDomain;
  ghosts?: GhostCurve[];
}

// viewBox 座標系（レスポンシブは CSS の width:100% に委ねる）。
// bottom は「目盛りラベル行 + 軸タイトル行」を縦に分けて置くための余白を確保する。
const VW = 1000;
const VH = 582;
const PAD = { top: 22, right: 18, bottom: 66, left: 58 };
const PLOT = {
  x0: PAD.left,
  y0: PAD.top,
  x1: VW - PAD.right,
  y1: VH - PAD.bottom,
};
const PLOT_W = PLOT.x1 - PLOT.x0;
const PLOT_H = PLOT.y1 - PLOT.y0;

// ロースト段階のティント帯（温度域→生豆グリーン→イエロー→タン→ココア）。
const STAGE_BANDS: { from: number; to: number; fill: string; label: string }[] =
  [
    { from: 0, to: 150, fill: "var(--stage-green)", label: "乾燥" },
    { from: 150, to: 175, fill: "var(--stage-yellow)", label: "イエロー" },
    { from: 175, to: 200, fill: "var(--stage-tan)", label: "タン" },
    { from: 200, to: 999, fill: "var(--stage-cocoa)", label: "ココア" },
  ];

export default function RoastChart({
  points,
  events,
  domain,
  ghosts = [],
}: Props) {
  const { tMax, tempMin, tempMax } = domain;
  const spanT = Math.max(1, tMax);
  const spanTemp = Math.max(1, tempMax - tempMin);

  const X = (t: number) => PLOT.x0 + (t / spanT) * PLOT_W;
  const Y = (temp: number) => PLOT.y1 - ((temp - tempMin) / spanTemp) * PLOT_H;

  const toPath = (pts: RoastPoint[]) =>
    pts
      .map(
        (p, i) =>
          `${i === 0 ? "M" : "L"}${X(p.t).toFixed(1)},${Y(p.temp).toFixed(1)}`,
      )
      .join(" ");

  const last = points.length > 0 ? points[points.length - 1] : undefined;

  // 時間軸の目盛: 刻み幅を段階から選び、本数に固定上限を設ける。
  // tMax がいくら大きくても要素数が有界（≒MAX_TIME_TICKS 本）になり、
  // 巨大 tMax による大量 SVG 生成でのタブ凍結（DoS）を防ぐ。
  const tickEvery = pickTimeStep(spanT);
  const timeTicks: number[] = [];
  for (
    let t = 0;
    t <= tMax + 0.5 && timeTicks.length <= MAX_TIME_TICKS;
    t += tickEvery
  ) {
    timeTicks.push(t);
  }

  // 温度軸の目盛（およそ5本・上限も設ける）。
  const tempStep = niceStep(spanTemp / 5);
  const tempTicks: number[] = [];
  for (
    let v = Math.ceil(tempMin / tempStep) * tempStep;
    v <= tempMax + 0.5 && tempTicks.length <= 20;
    v += tempStep
  ) {
    tempTicks.push(v);
  }

  const hasData = points.length > 0;

  return (
    <svg
      className="chart"
      viewBox={`0 0 ${VW} ${VH}`}
      role="img"
      aria-label={
        hasData
          ? `焙煎カーブ 計測点${points.length}点${ghosts.length ? `・重ね${ghosts.length}件` : ""}`
          : "焙煎カーブ（計測前）"
      }
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        {/* 温度で色が変わるサーマルグラデーション（下=琥珀 → 上=残り火レッド）。 */}
        <linearGradient
          id="thermal"
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1={PLOT.y1}
          x2="0"
          y2={PLOT.y0}
        >
          <stop offset="0" stopColor="var(--thermal-0)" />
          <stop offset="0.5" stopColor="var(--thermal-1)" />
          <stop offset="1" stopColor="var(--thermal-2)" />
        </linearGradient>
      </defs>

      {/* 盤面（グラフ用紙） */}
      <rect
        x={PLOT.x0}
        y={PLOT.y0}
        width={PLOT_W}
        height={PLOT_H}
        rx="6"
        className="chart-paper"
      />

      {/* ロースト段階のティント帯 */}
      {STAGE_BANDS.map((band) => {
        const top = Math.min(
          PLOT.y1,
          Math.max(PLOT.y0, Y(Math.min(band.to, tempMax))),
        );
        const bottom = Math.min(
          PLOT.y1,
          Math.max(PLOT.y0, Y(Math.max(band.from, tempMin))),
        );
        const h = bottom - top;
        if (h <= 0.5) return null;
        return (
          <g key={band.label}>
            <rect
              x={PLOT.x0}
              y={top}
              width={PLOT_W}
              height={h}
              fill={band.fill}
            />
            <text
              x={PLOT.x1 - 8}
              y={top + h / 2}
              className="stage-label"
              textAnchor="end"
              dominantBaseline="middle"
            >
              {band.label}
            </text>
          </g>
        );
      })}

      {/* グリッド線 + 目盛 */}
      {timeTicks.map((t) => (
        <g key={`vt-${t}`}>
          <line
            x1={X(t)}
            y1={PLOT.y0}
            x2={X(t)}
            y2={PLOT.y1}
            className="grid"
          />
          <text
            x={X(t)}
            y={PLOT.y1 + 26}
            className="axis-num num"
            textAnchor="middle"
          >
            {formatClock(t)}
          </text>
        </g>
      ))}
      {tempTicks.map((v) => (
        <g key={`ht-${v}`}>
          <line
            x1={PLOT.x0}
            y1={Y(v)}
            x2={PLOT.x1}
            y2={Y(v)}
            className="grid"
          />
          <text
            x={PLOT.x0 - 10}
            y={Y(v)}
            className="axis-num num"
            textAnchor="end"
            dominantBaseline="middle"
          >
            {Math.round(v)}
          </text>
        </g>
      ))}

      {/* 軸キャプション: X タイトルは目盛りラベル行（PLOT.y1+26）より下に置き、
          盤面幅の中央寄せにして左端の「0:00」等と水平にも重ならないようにする。 */}
      <text
        x={PLOT.x0 + PLOT_W / 2}
        y={PLOT.y1 + 52}
        className="axis-cap"
        textAnchor="middle"
      >
        時間（分:秒）
      </text>
      <text
        x={16}
        y={PLOT.y0 + PLOT_H / 2}
        className="axis-cap"
        textAnchor="middle"
        transform={`rotate(-90 16 ${PLOT.y0 + PLOT_H / 2})`}
      >
        豆温度（℃）
      </text>

      {/* 比較ロット（ゴースト線）: ロットごとに色相＋破線を変え、端点に豆名ラベルを添える。 */}
      {ghosts.map((g, i) => {
        if (g.points.length < 2) return null;
        const st = ghostStyle(i);
        const lp = g.points[g.points.length - 1]!;
        const ex = X(lp.t);
        const ey = Y(lp.temp);
        // ラベルは端点の外側に置く。右端に近ければ内向き（end 揃え）にして盤面外へ切れないようにする。
        const flip = ex > PLOT.x1 - 96;
        const lx = flip ? ex - 8 : ex + 8;
        const ly = Math.min(PLOT.y1 - 6, Math.max(PLOT.y0 + 12, ey));
        return (
          <g key={g.id} style={{ color: `var(${st.colorVar})` }}>
            <path
              d={toPath(g.points)}
              className="ghost-curve"
              style={{ strokeDasharray: st.dash }}
            />
            <circle cx={ex} cy={ey} r="3.4" className="ghost-end" />
            <text
              x={lx}
              y={ly}
              className="ghost-label"
              textAnchor={flip ? "end" : "start"}
            >
              {g.name}
            </text>
          </g>
        );
      })}

      {/* イベントのマイルストーン旗（右端に近い旗は内向きに反転し、盤面外へ切れないようにする）。 */}
      {events.map((e) => {
        const x = X(e.t);
        const FLAG_W = 26;
        const flip = x > PLOT.x1 - (FLAG_W + 2);
        const rectX = flip ? x - FLAG_W : x;
        return (
          <g key={e.kind} className="flag">
            <line
              x1={x}
              y1={PLOT.y0}
              x2={x}
              y2={PLOT.y1}
              className="flag-stem"
            />
            <rect
              x={rectX}
              y={PLOT.y0 + 2}
              width={FLAG_W}
              height="18"
              rx="3"
              className="flag-body"
            />
            <text
              x={rectX + FLAG_W / 2}
              y={PLOT.y0 + 11}
              className="flag-text"
              textAnchor="middle"
              dominantBaseline="middle"
            >
              {EVENT_SHORT[e.kind]}
            </text>
            <title>{`${EVENT_LABELS[e.kind]} ${formatClock(e.t)}`}</title>
          </g>
        );
      })}

      {/* 焙煎カーブ本体 */}
      {points.length === 1 && last ? (
        <circle cx={X(last.t)} cy={Y(last.temp)} r="5" className="pen-dot" />
      ) : null}
      {points.length >= 2 ? (
        <path d={toPath(points)} className="roast-curve" />
      ) : null}

      {/* 計測点マーカー */}
      {points.map((p, i) => (
        <circle
          key={i}
          cx={X(p.t)}
          cy={Y(p.temp)}
          r="3.2"
          className="point-mark"
        />
      ))}

      {/* 記録ペン（最新点） */}
      {last ? (
        <g className="pen">
          <circle
            cx={X(last.t)}
            cy={Y(last.temp)}
            r="6.5"
            className="pen-dot"
          />
          <circle
            cx={X(last.t)}
            cy={Y(last.temp)}
            r="12"
            className="pen-halo"
          />
        </g>
      ) : null}

      {/* 空状態のガイド（記録中カーブも比較ロットも無いときだけ） */}
      {!hasData && ghosts.length === 0 ? (
        <text x={VW / 2} y={VH / 2} className="chart-empty" textAnchor="middle">
          時間と温度を記録するとカーブが描かれます
        </text>
      ) : null}
    </svg>
  );
}

/** 目盛の刻み幅を 1/2/5×10ⁿ の見やすい値へ丸める。 */
function niceStep(raw: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(1, raw))));
  const n = raw / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

// 時間軸の目盛本数の上限と、選択可能な刻み幅（秒）の段階。
const MAX_TIME_TICKS = 40;
const TIME_STEPS = [
  30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 43200, 86400, 172800,
];

/** span(秒) に対し、目盛が MAX_TIME_TICKS 本以内に収まる最小の刻み幅を返す。 */
function pickTimeStep(span: number): number {
  for (const s of TIME_STEPS) {
    if (span / s <= MAX_TIME_TICKS) return s;
  }
  // どの段階でも上限を超える場合は、上限本数に収まる刻みを算出する（要素数を必ず有界に）。
  return Math.max(30, Math.ceil(span / MAX_TIME_TICKS));
}
