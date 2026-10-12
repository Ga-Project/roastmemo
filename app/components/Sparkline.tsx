// RoastMemo — 一覧の各ロット用の極小カーブ（inline SVG・依存なし）。

import { roastDomain, type RoastPoint } from "../../lib/roast";

interface Props {
  points: RoastPoint[];
  active?: boolean;
}

const W = 120;
const H = 40;
const PAD = 3;

export default function Sparkline({ points, active = false }: Props) {
  if (points.length < 2) {
    return (
      <svg className="spark" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
        <line
          x1={PAD}
          y1={H - PAD}
          x2={W - PAD}
          y2={H - PAD}
          className="spark-base"
        />
      </svg>
    );
  }
  const { tMax, tempMin, tempMax } = roastDomain([points]);
  const spanT = Math.max(1, tMax);
  const spanTemp = Math.max(1, tempMax - tempMin);
  const X = (t: number) => PAD + (t / spanT) * (W - PAD * 2);
  const Y = (temp: number) =>
    H - PAD - ((temp - tempMin) / spanTemp) * (H - PAD * 2);
  const d = points
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"}${X(p.t).toFixed(1)},${Y(p.temp).toFixed(1)}`,
    )
    .join(" ");
  return (
    <svg
      className={`spark${active ? " is-active" : ""}`}
      viewBox={`0 0 ${W} ${H}`}
      aria-hidden="true"
    >
      <path d={d} className="spark-curve" />
    </svg>
  );
}
