/**
 * RoastMemo 受入E2E — コンソール check_items の機械実行版。
 * キーは check_items.key と一致させること（ずれるとランナーが警告を出す）。
 *
 * 方針: 実装内部を覗かず、利用者の操作（入力・クリック・貼り付け）だけで主要機能を判定する。
 *       保存は端末内 IndexedDB。各項目は独立コンテキスト（空の状態）から自分でデータを作る。
 */

const SEL = {
  time: 'input[aria-label="計測時刻（分:秒）"]',
  temp: 'input[aria-label="豆温度（℃）"]',
  plot: "button.btn-plot",
  bean: 'input[aria-label="豆の名前"]',
  charge: 'input[aria-label="投入量（g）"]',
  drop: 'input[aria-label="排出量（g）"]',
  cup: 'textarea[aria-label="カッピングメモ"]',
  tagIn: 'input[aria-label="フレーバータグを追加"]',
  tagAdd: 'button[aria-label="タグを追加"]',
  save: "button.btn-save",
  search: 'input[aria-label="焙煎ログを検索"]',
  theme: "button.theme-toggle",
  exportBtn: "button.btn-export",
  importBtn: "button.btn-import",
  exportArea: 'textarea[aria-label="バックアップデータ"]',
  importArea: 'textarea[aria-label="復元データを貼り付け"]',
};

/** 1つの計測点を記録する（時間 分:秒・温度 ℃）。 */
async function plot(h, clock, temp) {
  await h.fill(SEL.time, clock);
  await h.fill(SEL.temp, temp);
  await h.click(SEL.plot);
  await h.wait(120);
}

/** 複数点をまとめて記録する。 */
async function plotAll(h, points) {
  for (const [clock, temp] of points) await plot(h, clock, temp);
}

/** タグを1つ足す。 */
async function addTag(h, name) {
  await h.fill(SEL.tagIn, name);
  await h.click(SEL.tagAdd);
  await h.wait(80);
}

/** 焙煎を1件作って保存する。 */
async function saveRoast(h, { name, charge = null, drop = null, points = [], tags = [], cup = "" }) {
  await plotAll(h, points);
  if (charge != null) await h.fill(SEL.charge, charge);
  if (drop != null) await h.fill(SEL.drop, drop);
  if (cup) await h.fill(SEL.cup, cup);
  for (const t of tags) await addTag(h, t);
  await h.fill(SEL.bean, name);
  await h.click(SEL.save);
  await h.wait(220);
}

/** バックアップ欄への貼り付け（native setter = ペースト操作の再現・React に input を通知）。 */
async function pasteInto(h, selector, text) {
  await h.page.$eval(
    selector,
    (el, val) => {
      const proto =
        el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, val);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    text,
  );
}

/** filter-chip を表示名で正確にクリックする（編集欄の候補チップと取り違えないため）。 */
async function clickFilterChip(h, label) {
  const clicked = await h.page.evaluate((text) => {
    const b = Array.from(document.querySelectorAll("button.filter-chip")).find(
      (x) => x.textContent.trim() === text,
    );
    if (b) {
      b.click();
      return true;
    }
    return false;
  }, label);
  if (!clicked) throw new Error(`タグ「${label}」の絞り込みチップが見つかりません`);
}

export const items = {
  /** 計測点を数点入力すると焙煎カーブが描画される（中核機能・blocking） */
  "record-curve": async (h) => {
    await h.goto("/");
    await plotAll(h, [
      ["0:00", 180],
      ["1:00", 120],
      ["5:00", 178],
      ["9:00", 205],
    ]);
    await h.expectSelector("path.roast-curve");
    await h.expectMatch(/現在\s*4\s*点/, "計測点数");
    await h.expectMatch(/205\s*℃|205/, "最新温度の読み取り");
    h.note("4点入力でカーブ描画・読み取りに反映");
  },

  /** 投入量と排出量から重量減少率が自動計算・表示される */
  "weight-loss": async (h) => {
    await h.goto("/");
    await h.fill(SEL.charge, 220);
    await h.fill(SEL.drop, 188);
    await h.wait(120);
    await h.expectMatch(/14\.5\s*%/, "重量減少率");
    h.note("220g→188g で 14.5%");
  },

  /** メモとタグを付けて保存すると一覧に出る */
  "save-list": async (h) => {
    await h.goto("/");
    await saveRoast(h, {
      name: "モカ マタリ",
      charge: 200,
      drop: 170,
      points: [
        ["0:00", 185],
        ["4:00", 172],
        ["8:00", 200],
      ],
      tags: ["チョコ"],
      cup: "甘い香りと重いボディ",
    });
    await h.expectText("保存しました");
    await h.expectText("記録した焙煎");
    await h.expectText("モカ マタリ");
    await h.expectMatch(/減量\s*15\s*%/, "一覧の減量率");
    h.note("保存後に一覧へ反映（減量15%）");
  },

  /** 豆名・メモ・タグを横断して全文検索で絞り込める */
  search: async (h) => {
    await h.goto("/");
    await saveRoast(h, { name: "ケニア ニエリ", points: [["0:00", 180], ["3:00", 165]] });
    await saveRoast(h, { name: "エチオピア ゲイシャ", points: [["0:00", 182], ["3:00", 168]] });
    await h.expectText("ケニア ニエリ");
    await h.expectText("エチオピア ゲイシャ");
    await h.fill(SEL.search, "ケニア");
    await h.wait(160);
    await h.expectText("ケニア ニエリ");
    await h.expectNoText("エチオピア ゲイシャ");
    h.note("「ケニア」で1件に絞り込み");
  },

  /** フレーバータグで絞り込める */
  "tag-filter": async (h) => {
    await h.goto("/");
    await saveRoast(h, { name: "ブラジル セラード", points: [["0:00", 180], ["3:00", 165]], tags: ["ナッツ"] });
    await saveRoast(h, { name: "パナマ ゲイシャ", points: [["0:00", 182], ["3:00", 168]], tags: ["フローラル"] });
    await clickFilterChip(h, "ナッツ");
    await h.wait(160);
    await h.expectText("ブラジル セラード");
    await h.expectNoText("パナマ ゲイシャ");
    h.note("タグ「ナッツ」で絞り込み");
  },

  /** 2件を選んでカーブを重ねて比較できる（中核機能・blocking） */
  "overlay-compare": async (h) => {
    await h.goto("/");
    await saveRoast(h, { name: "ロットA", points: [["0:00", 180], ["4:00", 170], ["8:00", 200]] });
    await saveRoast(h, { name: "ロットB", points: [["0:00", 178], ["4:00", 173], ["8:00", 206]] });
    await h.clickText("重ねる"); // 1件目
    await h.wait(160);
    await h.clickText("重ねる"); // 2件目（1件目は「重ね中」になり残りが選ばれる）
    await h.wait(220);
    await h.expectMatch(/重ね比較\s*2\s*件/, "重ね件数");
    await h.expectSelector("path.ghost-curve");
    h.note("2ロットをゴースト線で重畳");
  },

  /** JSONで書き出し・取り込み（バックアップ・端末間移行）ができる */
  "backup-export-import": async (h) => {
    await h.goto("/");
    await saveRoast(h, {
      name: "バックアップ豆",
      points: [["0:00", 185], ["5:00", 175]],
      tags: ["黒糖"],
      cup: "コクのある甘さ",
    });
    // バックアップ欄（折りたたみ）を開く
    await h.clickText("バックアップ（書き出し・取り込み）");
    await h.wait(120);
    // 書き出し: 内容に豆名が含まれ、妥当な JSON であること
    await h.click(SEL.exportBtn);
    await h.wait(200);
    const exported = await h.page.$eval(SEL.exportArea, (el) => el.value);
    if (!exported.includes("バックアップ豆")) throw new Error("書き出し内容に豆名が含まれていません");
    JSON.parse(exported); // 壊れていれば throw
    // 取り込み: 別端末のバックアップを貼り付けて復元 → 一覧に現れる
    const backup = JSON.stringify({
      schema: "roastmemo.backup",
      version: 1,
      logs: [
        {
          id: "imp-e2e-1",
          beanName: "取り込みロット",
          date: "2026-08-01",
          chargeWeight: 210,
          dropWeight: 181,
          points: [
            { t: 0, temp: 190 },
            { t: 300, temp: 176 },
          ],
          events: [],
          cupping: "端末間移行テスト",
          tags: ["柑橘"],
          roastLevel: null,
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    });
    await pasteInto(h, SEL.importArea, backup);
    await h.wait(80);
    await h.click(SEL.importBtn);
    await h.wait(260);
    await h.expectText("取り込みロット");
    h.note(`書き出し${exported.length}文字・取り込み1件`);
  },

  /** 明るい/暗い表示を切り替えられる */
  theme: async (h) => {
    await h.goto("/");
    const before = await h.bgColor();
    await h.click(SEL.theme);
    await h.wait(320);
    const after = await h.bgColor();
    if (before === after) throw new Error(`配色が変わりません（${before} のまま）`);
    h.note(`背景色 ${before} → ${after}`);
  },
};

/**
 * デザイン確認用の画面（受入の合否には関与しない）。
 * 代表はここで撮れた画像だけを見て違和感を判定するので、空の盤面ではなく
 * 「カーブが引かれ、値が入り、一覧が並んだ」＝この製品でいちばん人が見る画面を作る。
 */
export const designStates = {
  "main-populated": async (h) => {
    await h.goto("/");
    await saveRoast(h, {
      name: "ケニア キリニャガ AA",
      charge: 225,
      drop: 191,
      points: [
        ["0:00", 188],
        ["1:10", 118],
        ["5:00", 176],
        ["8:30", 202],
      ],
      tags: ["ベリー", "黒糖"],
      cup: "華やかなベリーの酸と黒糖の甘み。狙いより1ハゼが早かった。",
    });
    await saveRoast(h, {
      name: "グアテマラ アンティグア",
      charge: 230,
      drop: 196,
      points: [
        ["0:00", 190],
        ["1:20", 122],
        ["6:00", 180],
        ["9:00", 208],
      ],
      tags: ["チョコ", "ナッツ"],
      cup: "チョコレートのコクとナッツの余韻。",
    });
    // 記録中のドラフト（主役の盤面にカーブを描く）
    await plotAll(h, [
      ["0:00", 186],
      ["1:00", 120],
      ["4:30", 172],
      ["8:00", 204],
    ]);
    await h.fill(SEL.charge, 220);
    await h.fill(SEL.drop, 188);
    await h.fill(SEL.bean, "本日の焙煎（記録中）");
    // 保存済みの1件を重ねてゴースト比較を見せる
    await h.clickText("重ねる");
    await h.wait(320);
  },
  dark: async (h) => {
    await h.click(SEL.theme);
    await h.wait(400);
  },
};
