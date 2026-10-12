import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

// サブパス配信（GitHub Pages プロジェクトページ）でも PWA アイコン等が解決できるよう basePath を前置する。
const base = process.env.NEXT_PUBLIC_BASE_PATH || "";

const title = "RoastMemo — 焙煎プロファイル記録計";
const description =
  "自家焙煎コーヒーの焙煎カーブ（時間×温度）を記録し、ロット同士を重ねて比較できる記録計。ハゼなどのイベント、重量減少率、カッピングメモ、フレーバータグ、全文検索に対応。焙煎ログは端末内にだけ保存され、外部サーバーへ送信・アップロードされません。";

export const metadata: Metadata = {
  title,
  description,
  applicationName: "RoastMemo",
  manifest: `${base}/manifest.webmanifest`,
  icons: {
    icon: [{ url: `${base}/icon.svg`, type: "image/svg+xml" }],
    apple: [{ url: `${base}/icon.svg` }],
  },
  appleWebApp: {
    capable: true,
    title: "RoastMemo",
    statusBarStyle: "black-translucent",
  },
  openGraph: {
    title,
    description,
    type: "website",
    locale: "ja_JP",
    siteName: "RoastMemo",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#a5521c" },
    { media: "(prefers-color-scheme: dark)", color: "#17110b" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>
        {/* アクセス解析（cookieless・秘密キー不要）。製品ごとの数値は path で区別される。 */}
        <script
          data-goatcounter="https://ga-project.goatcounter.com/count"
          async
          src="//gc.zgo.at/count.js"
        />
        {children}
      </body>
    </html>
  );
}
