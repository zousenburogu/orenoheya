/* 修正ファイル（JSON）による予定・収入の一括「追加・変更・削除」。DOM 非依存。
   { "edits": [
       { "action": "add", "type": "income", "date": "2026-10-09", "amount": 1000, "label": "名前", "account": "口座名", "category": "カテゴリ名" },
       { "action": "change", "target": "名前", "from": { "date": "2026-10-05", "amount": 500 }, "to": { "date": "2026-10-09", "amount": 600 } },
       { "action": "delete", "target": "名前", "date": "2026-10-05", "amount": 500 } ] }
   金額の符号は見ない（絶対値で照合し、変更では元の符号を保つ）。edits を上から順に適用する。 */
(function (root) {
  "use strict";

  const isNode = typeof module !== "undefined" && module.exports;
  const D = isNode ? require("./dates.js") : root.KDates;
  const K = isNode ? require("./engine.js") : root.Kakeibo;
  const I = isNode ? require("./importer.js") : root.KImport;

  const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && D.fmt(D.parse(v)) === v;
  const absAmount = (v) => {
    if (v === undefined || v === null || v === "") return NaN;
    const n = typeof v === "number" ? v : Number(String(v).normalize("NFKC").replace(/[,¥円\s]/g, ""));
    return Number.isFinite(n) ? Math.abs(Math.round(n)) : NaN;
  };
  const md = (d) => `${d.slice(5, 7)}/${d.slice(8, 10)}`;
  const TYPES = { income: "income", 収入: "income", 入金: "income", expense: "expense", 支出: "expense", 出金: "expense" };

  // 2: 名前が同じ、1: 一方がもう一方を含む（表記ゆれは importer の照合と同じ）、0: 一致しない
  const nameScore = (target, label) => {
    const a = I.key(target);
    const b = I.key(label);
    if (!a || !b) return 0;
    if (a === b) return 2;
    return a.includes(b) || b.includes(a) ? 1 : 0;
  };

  const parseEdits = (text) => {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error("JSONを読み込めませんでした（書き方を確認してください）");
    }
    const edits = Array.isArray(data) ? data : data && data.edits;
    if (!Array.isArray(edits) || !edits.length) throw new Error("修正ファイルの形式が正しくありません（\"edits\" の配列が必要です）");
    return edits;
  };

  // 名前・日付・金額で既存の予定を探す。取引（予定・実績）と、まだ取引になっていない定期ルールの回が対象
  const findTarget = (state, target, date, abs) => {
    const hits = [];
    state.transactions.forEach((t) => {
      const score = t.date === date && Math.abs(t.amount) === abs ? nameScore(target, t.label) : 0;
      if (score) hits.push({ kind: "tx", t, score, label: t.label, signed: t.amount });
    });
    state.recurrences.forEach((r) => {
      const score = Math.abs(r.amount) === abs ? nameScore(target, r.label) : 0;
      if (!score) return;
      K.expandRecurrence(r, D.addDays(date, -35), D.addDays(date, 35), state.settings).forEach((o) => {
        if (o.date !== date || r.doneDates.includes(o.original)) return;
        const linked = [...state.transactions, ...state.transfers].some((x) => x.recurrenceId === r.id && x.occurrenceDate === o.original);
        if (!linked) hits.push({ kind: "rec", r, original: o.original, score, label: r.label, signed: r.amount });
      });
    });
    const top = Math.max(0, ...hits.map((h) => h.score));
    return hits.filter((h) => h.score === top);
  };

  const describeHit = (h, date) => `「${h.label || "無題"}」${md(date)} ${K.yen(h.signed)}`;

  // state を直接書き換えながら edits を上から順に適用する。プレビューは複製に対して呼ぶ
  const run = (state, edits, { today } = {}) => {
    const t0 = today || D.today();
    return edits.map((e, i) => {
      const item = { index: i + 1, action: e && e.action, status: "fail", text: "", notes: [] };
      const fail = (text) => Object.assign(item, { status: "fail", text });
      const ok = (text) => Object.assign(item, { status: "ok", text });
      if (!e || typeof e !== "object") return fail("形式が正しくない行です");

      if (e.action === "add") {
        const kind = TYPES[String(e.type || "").trim().toLowerCase()];
        const abs = absAmount(e.amount);
        const label = String(e.label || "").trim();
        if (!kind) return fail(`追加できません: type は income か expense にしてください（${e.type ?? "未指定"}）`);
        if (!isDate(e.date)) return fail(`追加できません: 日付が正しくありません（${e.date ?? "未指定"}）`);
        if (!(abs > 0)) return fail("追加できません: 金額が正しくありません");
        if (!label) return fail("追加できません: label（名前）がありません");
        let acc;
        if (e.account) {
          acc = I.findAccount(state, e.account);
          if (!acc) return fail(`追加できません: 口座「${e.account}」が見つかりません`);
        } else {
          const fallback = kind === "income" ? state.settings.salaryAccountId : K.livingAccounts(state)[0];
          acc = K.accountById(state, fallback) || state.accounts[0];
          if (!acc) return fail("追加できません: 口座がありません");
          item.notes.push(`口座の指定がないため「${acc.name}」にしました`);
        }
        const cat = I.findCategory(state, kind, e.category, label);
        if (e.category && cat.guessed) item.notes.push(`カテゴリ「${e.category}」が見つからないため「${(K.categoryById(state, cat.id) || {}).name}」にしました`);
        const signed = kind === "income" ? abs : -abs;
        const head = `${md(e.date)} ${kind === "income" ? "収入" : "支出"} ${K.yen(abs)}「${label}」（${acc.name}・${(K.categoryById(state, cat.id) || {}).name || cat.id}）`;
        const dup = I.findDuplicate(state, e.date, signed, acc.id);
        if (dup) return Object.assign(item, { status: "skip", text: `スキップ（同じ日・同じ金額の「${dup.label || "無題"}」があります）: ${head}` });
        const planned = e.date > t0;
        K.addTransaction(state, { accountId: acc.id, date: e.date, amount: signed, categoryId: cat.id, label, status: planned ? "planned" : "actual" });
        if (!planned) item.notes.push("過去の日付なので実績として記録し、口座の残高も動きます");
        return ok(`追加: ${head}`);
      }

      if (e.action === "change" || e.action === "delete") {
        const del = e.action === "delete";
        const from = del ? { date: e.date, amount: e.amount } : e.from || {};
        const verb = del ? "削除" : "変更";
        const abs = absAmount(from.amount);
        if (!String(e.target || "").trim()) return fail(`${verb}できません: target（名前）がありません`);
        if (!isDate(from.date) || !(abs > 0)) return fail(`${verb}できません: 「${e.target}」の${del ? "" : "from の"}日付・金額が正しくありません`);
        let toDate = from.date;
        let toAbs = abs;
        if (!del) {
          const to = e.to || {};
          if (to.date !== undefined && !isDate(to.date)) return fail(`変更できません: 「${e.target}」の to の日付が正しくありません`);
          if (to.amount !== undefined && !(absAmount(to.amount) > 0)) return fail(`変更できません: 「${e.target}」の to の金額が正しくありません`);
          if (to.date === undefined && to.amount === undefined) return fail(`変更できません: 「${e.target}」の to に日付か金額が必要です`);
          toDate = to.date || from.date;
          toAbs = to.amount !== undefined ? absAmount(to.amount) : abs;
        }
        const label = `「${e.target}」${md(from.date)} ${K.yen(abs)}`;
        const hits = findTarget(state, e.target, from.date, abs);
        if (!hits.length) return fail(`見つかりません（適用しません）: ${label}`);
        if (hits.length > 1) return fail(`複数見つかりました（適用しません）: ${label} → ${hits.map((h) => `「${h.label || "無題"}」`).join("、")}`);
        const h = hits[0];
        const sign = h.signed < 0 ? -1 : 1;
        const where = h.kind === "rec" ? "定期の1回分" : h.t.status === "actual" ? "実績" : "予定";
        if (h.kind === "tx" && h.t.status === "actual") item.notes.push("実績なので口座の残高も動きます");
        if (del) {
          if (h.kind === "tx") {
            const { recurrenceId, occurrenceDate } = h.t;
            K.removeTransaction(state, h.t.id);
            if (recurrenceId && occurrenceDate) K.skipOccurrence(state, recurrenceId, occurrenceDate);
          } else K.skipOccurrence(state, h.r.id, h.original);
          return ok(`削除: ${describeHit(h, from.date)}（${where}）`);
        }
        if (toDate === from.date && toAbs === abs) return Object.assign(item, { status: "skip", text: `スキップ（変更がありません）: ${describeHit(h, from.date)}` });
        if (h.kind === "tx") K.updateTransaction(state, h.t.id, { date: toDate, amount: sign * toAbs });
        else K.overrideOccurrence(state, h.r.id, h.original, { date: toDate, amount: sign * toAbs });
        return ok(`変更: 「${h.label || "無題"}」${md(from.date)} ${K.yen(h.signed)} → ${md(toDate)} ${K.yen(sign * toAbs)}（${where}）`);
      }

      return fail(`action は add・change・delete のどれかにしてください（${e.action ?? "未指定"}）`);
    });
  };

  const clone = (state) => K.normalizeState(JSON.parse(JSON.stringify(state)));

  // 適用した場合の結果を、今のデータを変えずに返す
  const preview = (state, edits, opts) => summarize(run(clone(state), edits, opts));

  const summarize = (items) => {
    const count = { add: 0, change: 0, delete: 0, skip: 0, fail: 0 };
    items.forEach((it) => {
      if (it.status === "ok") count[it.action]++;
      else count[it.status]++;
    });
    return { items, count, applicable: count.add + count.change + count.delete };
  };

  const apply = (state, edits, opts) => summarize(run(state, edits, opts));

  const api = { parseEdits, preview, apply };
  if (isNode) module.exports = api;
  else root.KEdits = api;
})(typeof window !== "undefined" ? window : globalThis);
