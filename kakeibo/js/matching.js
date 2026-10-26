/* 名前の照合（口座・カテゴリ）と重複判定。修正ファイル（edits.js）が使う。
   表記ゆれ（全角半角・空白・括弧・「あと払い／後払い」など）を吸収して照合する。 */
(function (root) {
  "use strict";

  const isNode = typeof module !== "undefined" && module.exports;
  const K = isNode ? require("./engine.js") : root.Kakeibo;

  const norm = (s) => String(s ?? "").normalize("NFKC").trim();
  // 名前の照合用：表記ゆれ（後払い／あと払い、ペイペイ／PayPay など）をそろえる
  const key = (s) =>
    norm(s)
      .toLowerCase()
      .replace(/[\s・()（）「」\-_]/g, "")
      .replace(/あと払い|後払い|後払/g, "後払")
      .replace(/ペイペイ/g, "paypay")
      .replace(/ドコモ|docomo/g, "d")
      .replace(/銀行$/, "");

  // 2文字ずつの一致率（0〜1）。完全一致・部分一致で見つからないときの予備
  const similarity = (a, b) => {
    const grams = (x) => {
      const out = [];
      for (let i = 0; i < x.length - 1; i++) out.push(x.slice(i, i + 2));
      return out;
    };
    const ga = grams(a);
    const gb = grams(b);
    if (!ga.length || !gb.length) return 0;
    let hit = 0;
    const pool = [...gb];
    ga.forEach((g) => {
      const j = pool.indexOf(g);
      if (j >= 0) {
        hit++;
        pool.splice(j, 1);
      }
    });
    return (2 * hit) / (ga.length + gb.length);
  };

  // 完全一致 → 部分一致 → 似ている順
  const bestByName = (items, name, getName) => {
    const k = key(name);
    if (!k) return null;
    return (
      items.find((x) => key(getName(x)) === k) ||
      items.find((x) => key(getName(x)).includes(k) || k.includes(key(getName(x)))) ||
      items
        .map((x) => [x, similarity(k, key(getName(x)))])
        .filter(([, v]) => v >= 0.5)
        .sort((p, q) => q[1] - p[1])
        .map(([x]) => x)[0] ||
      null
    );
  };

  // 同じ日・同じ金額（口座が決まっていれば同じ口座）の記録
  const findDuplicate = (state, date, signedAmount, accountId) =>
    state.transactions.find((t) => t.date === date && t.amount === signedAmount && (!accountId || t.accountId === accountId));

  const findAccount = (state, name) => bestByName(state.accounts, name, (a) => a.name);

  const CATEGORY_KEYWORDS = [
    ["cat_housing", /家賃|寮|住居|管理費/],
    ["cat_telecom", /携帯|スマホ|通信|docomo|ドコモ|au|softbank|ソフトバンク|楽天モバイル|ahamo|povo|linemo|wifi|光回線/i],
    ["cat_subsc", /サブスク|youtube|netflix|spotify|claude|chatgpt|prime|amazonプライム|apple|icloud|disney|u-next|abema/i],
    ["cat_bnpl", /paypay|d払い|後払い|あと払い|キャシャカリ|カード|クレジット|メルペイ|atone|paidy/i],
    ["cat_misc", /日用品|ドラッグ|薬|衣|服|ユニクロ|gu|無印|ダイソー|100均|雑貨/i],
    ["cat_living", /コンビニ|セブン|ローソン|ファミ|スーパー|食|弁当|カフェ|外食|ランチ|飲|マック|すき家|吉野家/i],
    ["cat_salary", /給与|給料|賃金/],
    ["cat_bonus", /賞与|ボーナス/],
    [K.WINDFALL, /fx|利益|リベート|臨時|返済|仕送り|キャッシュバック|ポイント/i],
  ];

  const findCategory = (state, kind, name, label) => {
    const cats = state.categories.filter((c) => c.kind === kind);
    const c = bestByName(cats, name, (x) => x.name);
    if (c) return { id: c.id, guessed: false };
    const text = `${norm(name)} ${norm(label)}`;
    const hit = CATEGORY_KEYWORDS.find(([id, re]) => cats.some((c) => c.id === id) && re.test(text));
    if (hit) return { id: hit[0], guessed: true };
    return { id: kind === "income" ? K.WINDFALL : "cat_other", guessed: true };
  };

  const api = { key, findAccount, findCategory, findDuplicate };
  if (isNode) module.exports = api;
  else root.KMatch = api;
})(typeof window !== "undefined" ? window : globalThis);
