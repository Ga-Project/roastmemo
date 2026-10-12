// roastmemo — 404。static export では out/404.html に書き出される（GitHub Pages 404）。
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "404 — RoastMemo",
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <main className="notfound">
      <h1>ページが見つかりません</h1>
      <p>お探しのページは移動または削除された可能性があります。</p>
      <Link className="btn" href="/">
        記録計へ戻る
      </Link>
    </main>
  );
}
