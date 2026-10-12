/** @type {import('next').NextConfig} */
// サブパス配信（GitHub Pages プロジェクトページ = <owner>.github.io/roastmemo/）では
// basePath/assetPrefix が必須（未設定だと /_next/... がドメイン直下に解決され全アセット404）。
// ローカル確認では out/ をポート直下（ルート）で配信するため、既定（未設定）は空＝ルート配信。
// → env NEXT_PUBLIC_BASE_PATH で切替。Pages デプロイ時のみ "/roastmemo" を注入する。
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

const nextConfig = {
  reactStrictMode: true,
  // static export（out/ に静的書き出し）。サーバランタイム不要。
  output: "export",
  // export では Next の画像最適化サーバが使えないため無効化。
  images: { unoptimized: true },
  // 各ルートを /path/index.html として出力し、サブディレクトリ配信で 404 を避ける。
  trailingSlash: true,
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
};

export default nextConfig;
