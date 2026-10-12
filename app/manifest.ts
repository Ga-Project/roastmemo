import type { MetadataRoute } from "next";

// PWA マニフェスト。static export では build 時に /manifest.webmanifest として書き出される。
// サブパス配信のため start_url / scope / icons は NEXT_PUBLIC_BASE_PATH を前置する。
const base = process.env.NEXT_PUBLIC_BASE_PATH || "";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "RoastMemo — 焙煎プロファイル記録計",
    short_name: "RoastMemo",
    description:
      "自家焙煎の焙煎カーブを記録し、ロットを重ねて比較できる記録計。焙煎ログは端末内にのみ保存されます。",
    lang: "ja",
    dir: "ltr",
    start_url: `${base}/`,
    scope: `${base}/`,
    display: "standalone",
    orientation: "portrait",
    background_color: "#f2e6cf",
    theme_color: "#a5521c",
    categories: ["food", "utilities", "productivity"],
    icons: [
      {
        src: `${base}/icon.svg`,
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: `${base}/icon-maskable.svg`,
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ],
  };
}
