/* 画像の読み取り結果（Claude が出力した CSV）の取り込み。
   1行1件、先頭の列が種類：
     支出,日付,金額,内容,口座,カテゴリ
     収入,日付,金額,内容,口座,カテゴリ
     残高,日付,金額,,口座,
     請求,引き落とし日,金額,サービス名,口座,
     給与明細,支給日,支給額合計,控除額合計,残業時間,時間外手当 */
(function (root) {
  "use strict";

  const isNode = typeof module !== "undefined" && module.exports;
  const D = isNode ? require("./dates.js") : root.KDates;
  const K = isNode ? require("./engine.js") : root.Kakeibo;

  const TYPES = {
    expense: "支出",
    income: "収入",
    balance: "残高",
    bill: "請求",
    payslip: "給与明細",
  };

  const TYPE_ALIASES = [
    ["payslip", /^(給与明細|給料明細|明細|payslip)$/i],
    ["expense", /^(支出|出金|支払い?|購入|レシート|expense)$/i],
    ["income", /^(収入|入金|income)$/i],
    ["balance", /^(残高|balance)$/i],
    ["bill", /^(請求|引き?落とし|引落|後払い|カード|bill)$/i],
  ];

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

  const typeOf = (s) => {
    const v = norm(s);
    const hit = TYPE_ALIASES.find(([, re]) => re.test(v));
    return hit ? hit[0] : null;
  };

  // 1行を列に分ける（"..." の中のカンマは区切りにしない。全角カンマ・タブも区切り）
  const splitLine = (line) => {
    const out = [];
    let cur = "";
    let q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (!q && (ch === "," || ch === "，" || ch === "\t")) {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out.map((c) => c.trim());
  };

  // 日付：2026-09-30 / 2026/9/30 / 2026年9月30日 / 9/30 / 9月30日。年がなければ今日に近い年にする
  const parseDate = (s, today) => {
    const v = norm(s);
    if (!v) return null;
    let m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(v);
    if (m) return D.ymd(Number(m[1]), Number(m[2]), Number(m[3]));
    m = /^(\d{1,2})[-/.月](\d{1,2})日?$/.exec(v);
    if (m) {
      let y = Number(today.slice(0, 4));
      let d = D.ymd(y, Number(m[1]), Number(m[2]));
      if (D.diffDays(today, d) > 62) d = D.ymd(y - 1, Number(m[1]), Number(m[2]));
      else if (D.diffDays(d, today) > 300) d = D.ymd(y + 1, Number(m[1]), Number(m[2]));
      return d;
    }
    return null;
  };

  const validDate = (d) => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) && D.fmt(D.parse(d)) === d;

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

  // 請求を定期ルール（PayPayあと払い など）の該当回に結びつける
  const matchBill = (state, label, date) => {
    const recs = state.recurrences.filter((r) => r.amount < 0 && !r.toAccountId);
    const r = bestByName(recs, label, (x) => x.label);
    if (!r) return null;
    const occ = K.expandRecurrence(r, D.addDays(date, -20), D.addDays(date, 20), state.settings);
    if (!occ.length) return null;
    const best = occ.reduce((a, b) => (Math.abs(D.diffDays(b.date, date)) < Math.abs(D.diffDays(a.date, date)) ? b : a));
    return { recurrenceId: r.id, original: best.original, label: r.label, accountId: r.accountId };
  };

  /**
   * CSV テキスト → 取り込み候補の行。行ごとに include（取り込むか）と warnings を持つ。
   * 見出し行・コードブロックの ``` ・空行・種類が読めない行は無視（読めない行は skipped に入れる）
   */
  const parseImport = (text, state, opts = {}) => {
    const today = opts.today || D.today();
    const rows = [];
    const skipped = [];
    String(text || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !/^```/.test(l))
      .forEach((line, i) => {
        const cols = splitLine(line.replace(/^[-*・]\s*/, ""));
        const type = typeOf(cols[0]);
        if (!type) {
          if (!/^(種類|type)$/i.test(norm(cols[0]))) skipped.push(line);
          return;
        }
        const warnings = [];
        let date = parseDate(cols[1], today);
        if (!validDate(date)) {
          if (cols[1]) warnings.push(`日付「${cols[1]}」を読めませんでした。今日にしています`);
          else warnings.push("日付がないので今日にしています");
          date = today;
        }
        const row = { line, index: i, type, date, warnings, include: true };

        if (type === "payslip") {
          row.gross = K.evalAmount(cols[2]);
          row.deductions = K.evalAmount(cols[3]);
          row.overtimeHours = Number(norm(cols[4]).replace(/[^\d.]/g, "")) || 0;
          row.overtimePay = K.evalAmount(cols[5]) || 0;
          if (Number.isNaN(row.gross) || !row.gross || Number.isNaN(row.deductions)) {
            warnings.push("支給額・控除額を読めませんでした");
            row.include = false;
          }
          if (state.payslips.some((p) => p.payDate === date)) {
            warnings.push("同じ支給日の明細がすでにあります");
            row.include = false;
          }
          row.accountId = state.settings.salaryAccountId || "";
          rows.push(row);
          return;
        }

        row.amount = Math.abs(K.evalAmount(cols[2]));
        if (Number.isNaN(row.amount) || !row.amount) {
          warnings.push(`金額「${cols[2] || ""}」を読めませんでした`);
          row.amount = 0;
          row.include = false;
        }
        row.label = norm(cols[3]);
        const acc = findAccount(state, cols[4]);
        if (cols[4] && !acc) warnings.push(`口座「${norm(cols[4])}」が見つかりません`);

        if (type === "balance") {
          row.accountId = acc ? acc.id : "";
          if (!acc) {
            if (!cols[4]) warnings.push("どの口座の残高か選んでください");
            row.include = false;
          }
        } else if (type === "bill") {
          const m = matchBill(state, row.label, date);
          row.match = m;
          row.accountId = acc ? acc.id : m ? m.accountId : state.settings.salaryAccountId || (state.accounts[0] || {}).id || "";
          row.categoryId = "cat_bnpl";
          if (!m) {
            const cat = findCategory(state, "expense", "", row.label);
            if (cat.id !== "cat_other") row.categoryId = cat.id;
          }
        } else {
          const kind = type === "income" ? "income" : "expense";
          const fallback = kind === "income" ? state.settings.salaryAccountId : state.settings.livingAccountId;
          row.accountId = acc ? acc.id : fallback || (state.accounts[0] || {}).id || "";
          const cat = findCategory(state, kind, cols[5], row.label);
          row.categoryId = cat.id;
          const signed = kind === "income" ? row.amount : -row.amount;
          const dup = state.transactions.find((t) => t.date === date && t.amount === signed && (!row.accountId || t.accountId === row.accountId));
          if (dup) {
            warnings.push(`同じ日・同じ金額の記録（${dup.label || "無題"}）がすでにあります`);
            row.include = false;
          }
        }
        if (!state.accounts.length) {
          warnings.push("先に口座を登録してください");
          row.include = false;
        }
        rows.push(row);
      });
    return { rows, skipped };
  };

  // 給与明細を登録し、必要なら手取りを給与口座に実績として記録（同じ頃の給与予定・定期ルールがあれば置き換え、二重計上はしない）
  const recordPayslip = (state, data, { record = true } = {}) => {
    const slip = Object.assign({ id: K.uid("slip"), memo: "", createdOn: D.today() }, data, { net: data.gross - data.deductions });
    state.payslips.push(slip);
    const acc = state.settings.salaryAccountId;
    if (!record || !acc) return slip;
    const near = (t) => Math.abs(D.diffDays(t.date, slip.payDate)) <= 5 && t.categoryId === "cat_salary" && t.amount > 0;
    if (state.transactions.some((t) => t.status === "actual" && near(t))) return slip;
    const planned = state.transactions.find((t) => t.status === "planned" && near(t));
    const salaryRec = state.recurrences.find((r) => r.categoryId === "cat_salary" && r.accountId === acc && r.amount > 0 && !r.toAccountId);
    const occ = salaryRec && K.expandRecurrence(salaryRec, D.addDays(slip.payDate, -5), D.addDays(slip.payDate, 5), state.settings).find((o) => !salaryRec.doneDates.includes(o.original));
    if (planned) K.updateTransaction(state, planned.id, { status: "actual", amount: slip.net, date: slip.payDate });
    else if (occ) K.overrideOccurrence(state, salaryRec.id, occ.original, { status: "actual", amount: slip.net, date: slip.payDate });
    else K.addTransaction(state, { accountId: acc, date: slip.payDate, amount: slip.net, categoryId: "cat_salary", label: "給与", status: "actual" });
    return slip;
  };

  // 取り込み候補（include のもの）を登録。結果の件数を種類ごとに返す
  const applyImport = (state, rows, opts = {}) => {
    const today = opts.today || D.today();
    const done = { expense: 0, income: 0, balance: 0, bill: 0, payslip: 0 };
    // 残高は「その時点の実際の残高」なので最後に合わせる（同時に取り込んだ入出金で残高がずれないように）
    const ordered = rows.filter((r) => r.include && r.type !== "balance").concat(rows.filter((r) => r.include && r.type === "balance"));
    ordered.forEach((r) => {
      if (r.type === "payslip") {
        recordPayslip(state, { payDate: r.date, gross: r.gross, deductions: r.deductions, overtimeHours: r.overtimeHours, overtimePay: r.overtimePay }, { record: r.recordNet !== false });
      } else if (r.type === "balance") {
        const a = K.accountById(state, r.accountId);
        if (!a) return;
        const diff = r.amount - Math.round(a.balance || 0);
        if (diff) K.addTransaction(state, { accountId: a.id, date: today, amount: diff, categoryId: "cat_other", label: "残高調整（画像取り込み）", status: "actual", balanceAlreadyReflected: true, adjustment: true });
        a.balance = r.amount;
      } else if (r.type === "bill") {
        if (r.match && r.useMatch !== false) {
          K.overrideOccurrence(state, r.match.recurrenceId, r.match.original, { amount: -r.amount, date: r.date });
        } else {
          K.addTransaction(state, { accountId: r.accountId, date: r.date, amount: -r.amount, categoryId: r.categoryId || "cat_bnpl", label: r.label || "請求", status: r.date > today ? "planned" : "actual" });
        }
      } else {
        const amount = r.type === "income" ? r.amount : -r.amount;
        K.addTransaction(state, { accountId: r.accountId, date: r.date, amount, categoryId: r.categoryId, label: r.label, status: r.date > today ? "planned" : "actual" });
      }
      done[r.type]++;
    });
    return done;
  };

  // Claude に画像と一緒に送る依頼文。口座名・カテゴリ名・今日の日付を入れて、そのまま使える候補で答えてもらう
  const buildPrompt = (state, opts = {}) => {
    const today = opts.today || D.today();
    const accs = state.accounts.map((a) => a.name).join("、") || "（未登録）";
    const exp = state.categories.filter((c) => c.kind === "expense").map((c) => c.name).join("、");
    const inc = state.categories.filter((c) => c.kind === "income").map((c) => c.name).join("、");
    const recs = state.recurrences.filter((r) => r.amount < 0 && !r.toAccountId).map((r) => r.label).join("、");
    return [
      "添付した画像を家計簿アプリに取り込みます。読み取った内容を次の形式のCSVだけで出力してください。説明文・見出し行・```は不要です。",
      "1行に1件。金額は数字だけ（円記号・カンマなし）。日付はYYYY-MM-DD。わからない欄は空欄。",
      "",
      "支出,日付,金額,内容,口座,カテゴリ",
      "収入,日付,金額,内容,口座,カテゴリ",
      "残高,日付,金額,,口座,",
      "請求,引き落とし日,金額,サービス名,口座,",
      "給与明細,支給日,支給額合計,控除額合計,残業時間,時間外手当",
      "",
      "・レシート、支払い完了画面 → 支出（合計を1行。品目ごとに分けない）",
      "・入金の通知や明細 → 収入",
      "・銀行、PayPay、証券などの残高画面 → 残高",
      "・後払い、カードなどの請求・引き落とし予定 → 請求",
      "・給与明細 → 給与明細",
      `口座の候補: ${accs}`,
      `支出カテゴリの候補: ${exp}`,
      `収入カテゴリの候補: ${inc}`,
      ...(recs ? [`請求のサービス名の候補: ${recs}`] : []),
      `今日は${today}です。年がない日付はこれを基準にしてください。`,
    ].join("\n");
  };

  const api = { TYPES, parseImport, applyImport, recordPayslip, buildPrompt, parseDate, splitLine };
  if (isNode) module.exports = api;
  else root.KImport = api;
})(typeof window !== "undefined" ? window : globalThis);
