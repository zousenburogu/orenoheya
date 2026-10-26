/* 修正ファイル（JSON）による予定・収入の一括「追加・変更・削除」。DOM 非依存。
   { "edits": [
       { "action": "add", "type": "income", "date": "2026-10-09", "amount": 1000, "label": "名前", "account": "口座名", "category": "カテゴリ名" },
       { "action": "add", "type": "expense", "date": "2026-10-09", "amount": 300, "label": "名前", "reflected": true },  // 残高に反映済みの実績（残高は動かさない）
       { "action": "change", "target": "名前", "from": { "date": "2026-10-05", "amount": 500 }, "to": { "date": "2026-10-09", "amount": 600, "label": "新しい名前", "category": "カテゴリ名" } },
       { "action": "change", "target": "FX出金", "from": { "date": "2026-10-27", "amount": 50000 }, "to": { "date": "2026-10-28" } },  // 振替は日付・メモだけ
       { "action": "delete", "target": "名前", "date": "2026-10-05", "amount": 500 },
       { "action": "add-account", "name": "口座名", "includeInTotal": false, "balance": 0, "note": "メモ" },
       { "action": "transfer", "date": "2026-10-27", "amount": 50000, "from": "FX口座", "to": "銀行", "label": "FX出金", "status": "着金待ち", "reflected": "from" },
       { "action": "add-recurrence", "label": "電気代", "type": "expense", "amount": 10000, "account": "口座名", "category": "固定費", "nth": 1, "weekday": "金", "adjust": "next", "start": "2026-11-01" },
       { "action": "fx", "date": "2026-10-25", "pl": 12000, "rebate": 3000 } ] }
   金額の符号は見ない（絶対値で照合し、変更では元の符号を保つ）。edits を上から順に適用する。 */
(function (root) {
  "use strict";

  const isNode = typeof module !== "undefined" && module.exports;
  const D = isNode ? require("./dates.js") : root.KDates;
  const K = isNode ? require("./engine.js") : root.Kakeibo;
  const I = isNode ? require("./matching.js") : root.KMatch;

  const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && D.fmt(D.parse(v)) === v;
  const absAmount = (v) => {
    if (v === undefined || v === null || v === "") return NaN;
    const n = typeof v === "number" ? v : Number(String(v).normalize("NFKC").replace(/[,¥円\s]/g, ""));
    return Number.isFinite(n) ? Math.abs(Math.round(n)) : NaN;
  };
  const md = (d) => `${d.slice(5, 7)}/${d.slice(8, 10)}`;
  const TYPES = { income: "income", 収入: "income", 入金: "income", expense: "expense", 支出: "expense", 出金: "expense" };
  const STATUS = { scheduled: "scheduled", 予定: "scheduled", requested: "requested", 申請中: "requested", pending: "pending", 着金待ち: "pending", done: "done", 着金済み: "done", 着金済: "done" };
  const ADJUST = { none: "none", そのまま: "none", next: "next", 翌営業日: "next", prev: "prev", 前営業日: "prev" };
  const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
  const parseWeekday = (v) => {
    if (typeof v === "number") return Number.isInteger(v) && v >= 0 && v <= 6 ? v : NaN;
    const t = String(v ?? "").trim().replace(/曜日?$/, "");
    if (/^[0-6]$/.test(t)) return Number(t);
    const i = WEEKDAYS.indexOf(t);
    return i >= 0 ? i : NaN;
  };
  const parseDays = (v) => {
    const list = Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : String(v).split(/[,、，\s]+/);
    return list.map((d) => (/^末/.test(String(d)) ? 31 : Number(d))).filter((d) => Number.isInteger(d) && d >= 1 && d <= 31);
  };
  const signedYen = (n) => (n > 0 ? `+${K.yen(n)}` : K.yen(n));

  // 2: 名前が同じ、1: 一方がもう一方を含む（表記ゆれは matching.js の照合）、0: 一致しない
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
  // withTransfers: 振替も対象にする（メモか口座名で照合。change で日付・メモを直す用）
  const findTarget = (state, target, date, abs, { withTransfers = false } = {}) => {
    const hits = [];
    if (withTransfers) {
      const accName = (id) => (K.accountById(state, id) || {}).name || "";
      state.transfers.forEach((x) => {
        if (x.date !== date || x.amount !== abs) return;
        const score = nameScore(target, x.label) || Math.min(1, Math.max(nameScore(target, accName(x.fromId)), nameScore(target, accName(x.toId))));
        if (score) hits.push({ kind: "trf", x, score, label: x.label || `${accName(x.fromId)} → ${accName(x.toId)}`, signed: x.amount });
      });
    }
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
    // 口座の追加は他の行より先に（同じファイルの予定が新しい口座を使えるように）。結果は元の順で返す
    const order = edits.map((e, i) => i).sort((a, b) => Number(!(edits[a] && edits[a].action === "add-account")) - Number(!(edits[b] && edits[b].action === "add-account")));
    const items = [];
    order.forEach((i) => (items[i] = runOne(state, edits[i], i, t0)));
    return items;
  };

  const runOne = (state, e, i, t0) => {
    {
      const item = { index: i + 1, action: e && e.action, status: "fail", text: "", notes: [] };
      const fail = (text) => Object.assign(item, { status: "fail", text });
      const ok = (text) => Object.assign(item, { status: "ok", text });
      if (!e || typeof e !== "object") return fail("形式が正しくない行です");

      if (e.action === "add-account") {
        const name = String(e.name ?? "").trim();
        if (!name) return fail("口座を追加できません: name（口座名）がありません");
        if (e.includeInTotal !== undefined && typeof e.includeInTotal !== "boolean") return fail(`口座「${name}」を追加できません: includeInTotal は true か false にしてください`);
        const hasBalance = e.balance !== undefined && e.balance !== null && e.balance !== "";
        let balance = 0;
        if (hasBalance) {
          balance = typeof e.balance === "number" ? e.balance : Number(String(e.balance).normalize("NFKC").replace(/[,¥円\s]/g, ""));
          if (!Number.isFinite(balance) || (typeof e.balance === "string" && !/\d/.test(e.balance))) return fail(`口座「${name}」を追加できません: balance が数字ではありません（${e.balance}）`);
          balance = Math.round(balance);
        }
        const same = state.accounts.find((a) => I.key(a.name) === I.key(name));
        if (same) return Object.assign(item, { status: "skip", text: `既にあるためスキップ: 口座「${name}」（${same.name}）` });
        const includeInTotal = e.includeInTotal !== false;
        state.accounts.push({ id: K.uid("acc"), name, balance, includeInTotal, note: String(e.note ?? "").trim(), balanceSet: hasBalance });
        if (!hasBalance) item.notes.push("残高は未記入のままです（あとで入力してください）");
        return ok(`口座の追加: 「${name}」（${includeInTotal ? "合計に含める" : "合計に含めない"}・残高 ${hasBalance ? K.yen(balance) : "未記入"}）`);
      }

      if (e.action === "add") {
        const kind = TYPES[String(e.type || "").trim().toLowerCase()];
        const abs = absAmount(e.amount);
        const label = String(e.label || "").trim();
        if (!kind) return fail(`追加できません: type は income か expense にしてください（${e.type ?? "未指定"}）`);
        if (!isDate(e.date)) return fail(`追加できません: 日付が正しくありません（${e.date ?? "未指定"}）`);
        if (!(abs > 0)) return fail("追加できません: 金額が正しくありません");
        if (!label) return fail("追加できません: label（名前）がありません");
        if (e.reflected !== undefined && typeof e.reflected !== "boolean") return fail(`追加できません: reflected は true か false にしてください（${e.reflected}）`);
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
        const reflected = !planned && e.reflected === true;
        K.addTransaction(state, Object.assign({ accountId: acc.id, date: e.date, amount: signed, categoryId: cat.id, label, status: planned ? "planned" : "actual" }, reflected ? { balanceAlreadyReflected: true } : {}));
        if (reflected) item.notes.push("残高に反映済みの実績として記録します（口座の残高は動きません）");
        else if (!planned) item.notes.push("過去の日付なので実績として記録し、口座の残高も動きます");
        if (planned && e.reflected === true) item.notes.push("未来の日付なので予定として記録します（reflected は使いません）");
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
        let toLabel;
        let toCategory;
        if (!del) {
          const to = e.to || {};
          if (to.date !== undefined && !isDate(to.date)) return fail(`変更できません: 「${e.target}」の to の日付が正しくありません`);
          if (to.amount !== undefined && !(absAmount(to.amount) > 0)) return fail(`変更できません: 「${e.target}」の to の金額が正しくありません`);
          if (to.label !== undefined && !String(to.label).trim()) return fail(`変更できません: 「${e.target}」の to の名前が空です`);
          if (to.category !== undefined && !String(to.category).trim()) return fail(`変更できません: 「${e.target}」の to のカテゴリが空です`);
          if (to.date === undefined && to.amount === undefined && to.label === undefined && to.category === undefined) return fail(`変更できません: 「${e.target}」の to に日付・金額・名前・カテゴリのどれかが必要です`);
          toDate = to.date || from.date;
          toAbs = to.amount !== undefined ? absAmount(to.amount) : abs;
          if (to.label !== undefined) toLabel = String(to.label).trim();
          if (to.category !== undefined) toCategory = String(to.category).trim();
        }
        const label = `「${e.target}」${md(from.date)} ${K.yen(abs)}`;
        const hits = findTarget(state, e.target, from.date, abs, { withTransfers: !del });
        if (!hits.length) return fail(`見つかりません（適用しません）: ${label}`);
        if (hits.length > 1) return fail(`複数見つかりました（適用しません）: ${label} → ${hits.map((h) => `「${h.label || "無題"}」`).join("、")}`);
        const h = hits[0];
        // 振替は日付（着金予定日）とメモだけ変えられる。残高は状態で決まるので動かない
        if (h.kind === "trf") {
          if (toAbs !== abs) return fail(`変更できません: 振替の金額は変えられません（アプリで「取り消し」て入れ直してください）: ${label}`);
          if (toCategory !== undefined) return fail(`変更できません: 振替にはカテゴリがありません: ${label}`);
          const sameMemo = toLabel === undefined || toLabel === h.x.label;
          const head = `振替「${h.label}」${md(from.date)} ${K.yen(abs)}`;
          if (toDate === from.date && sameMemo) return Object.assign(item, { status: "skip", text: `スキップ（変更がありません）: ${head}` });
          K.updateTransfer(state, h.x.id, Object.assign({ date: toDate }, sameMemo ? {} : { label: toLabel }));
          item.notes.push("振替の日付・メモだけを変えます（口座の残高は動きません）");
          return ok(`変更: ${head} → ${md(toDate)}${sameMemo ? "" : `・メモ「${toLabel}」`}（${K.TRANSFER_STATUS[h.x.status]}）`);
        }
        const sign = h.signed < 0 ? -1 : 1;
        const where = h.kind === "rec" ? "定期の1回分" : h.t.status === "actual" ? (h.t.adjustment ? "残高調整" : "実績") : "予定";
        if (!del && h.kind === "rec" && (toLabel !== undefined || toCategory !== undefined)) return fail(`変更できません: 定期ルールの1回分は名前・カテゴリを変えられません（ルールの画面で変えてください）: ${label}`);
        const moves = h.kind === "tx" && h.t.status === "actual" && (del || toAbs !== abs);
        if (moves) item.notes.push(h.t.balanceAlreadyReflected ? "残高に反映済みの記録なので、口座の残高は動きません" : "実績なので口座の残高も動きます");
        if (del) {
          if (h.kind === "tx") {
            const { recurrenceId, occurrenceDate } = h.t;
            K.removeTransaction(state, h.t.id);
            if (recurrenceId && occurrenceDate) K.skipOccurrence(state, recurrenceId, occurrenceDate);
          } else K.skipOccurrence(state, h.r.id, h.original);
          return ok(`削除: ${describeHit(h, from.date)}（${where}）`);
        }
        let catId;
        if (toCategory !== undefined) {
          const cat = I.findCategory(state, sign < 0 ? "expense" : "income", toCategory, toLabel || h.label);
          if (cat.guessed) item.notes.push(`カテゴリ「${toCategory}」が見つからないため「${(K.categoryById(state, cat.id) || {}).name}」にしました`);
          catId = cat.id;
        }
        const sameLabel = toLabel === undefined || toLabel === h.t.label;
        const sameCat = catId === undefined || catId === h.t.categoryId;
        if (toDate === from.date && toAbs === abs && sameLabel && sameCat) return Object.assign(item, { status: "skip", text: `スキップ（変更がありません）: ${describeHit(h, from.date)}` });
        if (h.kind === "tx") {
          const patch = { date: toDate, amount: sign * toAbs };
          if (!sameLabel) patch.label = toLabel;
          if (!sameCat) patch.categoryId = catId;
          const wasAdjustment = !!h.t.adjustment;
          K.updateTransaction(state, h.t.id, patch);
          // 名前かカテゴリを付けた残高調整は、ふつうの記録として集計に入れる（残高反映済みのままなので残高は動かない）
          if (wasAdjustment && (!sameLabel || !sameCat)) {
            delete h.t.adjustment;
            item.notes.push("残高調整をふつうの記録にしました（集計に入ります。口座の残高は動きません）");
          }
        } else K.overrideOccurrence(state, h.r.id, h.original, { date: toDate, amount: sign * toAbs });
        const extra = [!sameLabel ? `名前「${toLabel}」` : "", !sameCat ? `カテゴリ「${(K.categoryById(state, catId) || {}).name || catId}」` : ""].filter(Boolean).join("・");
        return ok(`変更: 「${h.label || "無題"}」${md(from.date)} ${K.yen(h.signed)} → ${md(toDate)} ${K.yen(sign * toAbs)}${extra ? `・${extra}` : ""}（${where}）`);
      }

      if (e.action === "transfer") {
        const abs = absAmount(e.amount);
        if (!isDate(e.date)) return fail(`振替できません: 日付が正しくありません（${e.date ?? "未指定"}）`);
        if (!(abs > 0)) return fail("振替できません: 金額が正しくありません");
        const from = I.findAccount(state, e.from);
        const to = I.findAccount(state, e.to);
        if (!from) return fail(`振替できません: 出金元の口座「${e.from ?? "未指定"}」が見つかりません`);
        if (!to) return fail(`振替できません: 入金先の口座「${e.to ?? "未指定"}」が見つかりません`);
        if (from.id === to.id) return fail("振替できません: 出金元と入金先が同じ口座です");
        const status = e.status === undefined ? (e.date > t0 ? "scheduled" : "done") : STATUS[String(e.status).trim()];
        if (!status) return fail(`振替できません: status は 予定・申請中・着金待ち・着金済み のどれかにしてください（${e.status}）`);
        const refl = e.reflected === true ? "both" : e.reflected === undefined || e.reflected === false ? "" : String(e.reflected);
        if (!["", "from", "to", "both"].includes(refl)) return fail(`振替できません: reflected は "from"・"to"・"both" のどれかにしてください（${e.reflected}）`);
        const label = String(e.label || "").trim();
        const head = `${md(e.date)} ${from.name} → ${to.name} ${K.yen(abs)}${label ? `「${label}」` : ""}（${K.TRANSFER_STATUS[status]}）`;
        const dup = state.transfers.find((x) => x.date === e.date && x.amount === abs && x.fromId === from.id && x.toId === to.id);
        if (dup) return Object.assign(item, { status: "skip", text: `スキップ（同じ日・同じ金額の振替があります）: ${head}` });
        const tr = { id: K.uid("trf"), fromId: from.id, toId: to.id, amount: abs, date: e.date, label, status: "scheduled", fromApplied: false, toApplied: false };
        // 残高にもう反映済みの側は、先に「反映済み」にしておき残高を動かさない
        if (refl === "both") tr.noBalance = true;
        if (refl === "from" && status !== "scheduled") tr.fromApplied = true;
        if (refl === "to" && status === "done") tr.toApplied = true;
        state.transfers.push(tr);
        K.setTransferStatus(state, tr.id, status);
        if (refl === "both") item.notes.push("両方の口座の残高に反映済みとして記録します（残高は動きません）");
        else if (refl) item.notes.push(`${refl === "from" ? from.name : to.name}の残高には反映済みとして記録します（その口座の残高は動きません）`);
        const moved = [tr.fromApplied && refl !== "from" && refl !== "both" ? `${from.name} −${K.yen(abs)}` : "", tr.toApplied && refl !== "to" && refl !== "both" ? `${to.name} +${K.yen(abs)}` : ""].filter(Boolean);
        if (moved.length) item.notes.push(`口座の残高が動きます（${moved.join("、")}）`);
        return ok(`振替: ${head}`);
      }

      if (e.action === "add-recurrence") {
        const label = String(e.label || "").trim();
        const abs = absAmount(e.amount);
        const typeKey = String(e.type || "").trim().toLowerCase();
        const kind = typeKey === "transfer" || typeKey === "振替" ? "transfer" : TYPES[typeKey];
        if (!label) return fail("定期ルールを追加できません: label（名前）がありません");
        if (!kind) return fail(`定期ルールを追加できません: type は income・expense・transfer のどれかにしてください（${e.type ?? "未指定"}）`);
        if (!(abs > 0)) return fail(`定期ルールを追加できません: 「${label}」の金額が正しくありません`);
        const adjust = e.adjust === undefined ? "none" : ADJUST[String(e.adjust).trim()];
        if (!adjust) return fail(`定期ルールを追加できません: adjust は none・next・prev のどれかにしてください（${e.adjust}）`);
        const start = e.start === undefined || e.start === "" ? t0 : e.start;
        if (!isDate(start) || (e.end && !isDate(e.end))) return fail(`定期ルールを追加できません: 「${label}」の start・end の日付が正しくありません`);
        let acc;
        if (e.account) {
          acc = I.findAccount(state, e.account);
          if (!acc) return fail(`定期ルールを追加できません: 口座「${e.account}」が見つかりません`);
        } else {
          acc = K.accountById(state, kind === "income" ? state.settings.salaryAccountId : K.livingAccounts(state)[0]) || state.accounts[0];
          if (!acc) return fail("定期ルールを追加できません: 口座がありません");
          item.notes.push(`口座の指定がないため「${acc.name}」にしました`);
        }
        let toAcc = null;
        if (kind === "transfer") {
          toAcc = I.findAccount(state, e.to);
          if (!toAcc) return fail(`定期ルールを追加できません: 振替の入金先「${e.to ?? "未指定"}」が見つかりません`);
          if (toAcc.id === acc.id) return fail("定期ルールを追加できません: 出金元と入金先が同じ口座です");
        }
        const rule = { id: K.uid("rec"), label, amount: kind === "income" ? abs : -abs, days: [Number(state.settings.payday) || 25], onPayday: false, intervalMonths: Math.max(1, Math.round(Number(e.everyMonths) || 1)), adjust, accountId: acc.id, categoryId: "cat_other", startDate: start, endDate: e.end || "", doneDates: [] };
        let when;
        if (e.payday === true) {
          rule.onPayday = true;
          when = "毎月 給料日";
        } else if (e.nth !== undefined) {
          const wd = parseWeekday(e.weekday);
          if (![1, 2, 3, 4, -1].includes(Number(e.nth)) || Number.isNaN(wd)) return fail(`定期ルールを追加できません: 「${label}」の nth（1〜4、最終は -1）か weekday が正しくありません`);
          Object.assign(rule, { nth: Number(e.nth), weekday: wd });
          when = `毎月 ${Number(e.nth) === -1 ? "最終" : `第${e.nth}`}${WEEKDAYS[wd]}曜`;
        } else if (e.weeks !== undefined) {
          const wd = parseWeekday(e.weekday);
          const weeks = Math.round(Number(e.weeks));
          if (!(weeks >= 1 && weeks <= 4) || Number.isNaN(wd)) return fail(`定期ルールを追加できません: 「${label}」の weeks（1〜4）か weekday が正しくありません`);
          Object.assign(rule, { weeks, weekday: wd });
          when = `${weeks > 1 ? `${weeks}週ごと` : "毎週"} ${WEEKDAYS[wd]}曜`;
        } else {
          const days = parseDays(e.days !== undefined ? e.days : e.day);
          if (!days.length) return fail(`定期ルールを追加できません: 「${label}」の日（day・days）か payday・nth・weeks のどれかが必要です`);
          rule.days = [...new Set(days)].sort((a, b) => a - b);
          when = `毎月 ${rule.days.map((d) => (d >= 31 ? "末日" : `${d}日`)).join("・")}`;
        }
        if (rule.intervalMonths > 1 && !rule.weeks) when = when.replace("毎月", `${rule.intervalMonths}か月ごと`);
        if (kind === "transfer") rule.toAccountId = toAcc.id;
        else {
          const cat = I.findCategory(state, kind, e.category, label);
          if (e.category && cat.guessed) item.notes.push(`カテゴリ「${e.category}」が見つからないため「${(K.categoryById(state, cat.id) || {}).name}」にしました`);
          rule.categoryId = cat.id;
        }
        const head = `「${label}」${K.yen(abs)} ${when}${adjust === "next" ? "（休日は翌営業日）" : adjust === "prev" ? "（休日は前営業日）" : ""}・${acc.name}${toAcc ? ` → ${toAcc.name}` : `・${(K.categoryById(state, rule.categoryId) || {}).name || ""}`}（${md(start)}〜${rule.endDate ? md(rule.endDate) : ""}）`;
        const dup = state.recurrences.find((r) => nameScore(label, r.label) === 2 && Math.abs(r.amount) === abs && r.accountId === acc.id && (r.toAccountId || "") === (rule.toAccountId || ""));
        if (dup) return Object.assign(item, { status: "skip", text: `スキップ（同じ名前・金額の定期ルールがあります）: ${head}` });
        state.recurrences.push(rule);
        // 同じ名前の単発の予定が残っていると二重になるので知らせる
        const occ = new Set(K.expandRecurrence(rule, start, D.addDays(start, 400), state.settings).map((o) => o.date));
        const twins = state.transactions.filter((x) => x.status === "planned" && !x.recurrenceId && occ.has(x.date) && nameScore(label, x.label));
        if (twins.length) item.notes.push(`同じ名前の単発の予定が${twins.length}件あります（${twins.map((x) => md(x.date)).join("・")}）。二重にならないよう削除してください`);
        return ok(`定期ルール: ${head}`);
      }

      if (e.action === "fx") {
        if (!isDate(e.date)) return fail(`FXを記録できません: 日付が正しくありません（${e.date ?? "未指定"}）`);
        if (e.date > t0) return fail(`FXを記録できません: 今日より後の日付です（${e.date}）`);
        const num = (v) => (v === undefined || v === null || v === "" ? 0 : typeof v === "number" ? Math.round(v) : Math.round(Number(String(v).normalize("NFKC").replace(/[,¥円\s]/g, "").replace(/^[−ー]/, "-"))));
        const pl = num(e.pl);
        const rebate = num(e.rebate);
        if (!Number.isFinite(pl) || !Number.isFinite(rebate)) return fail(`FXを記録できません: ${md(e.date)}の pl・rebate が数字ではありません`);
        if (!pl && !rebate) return fail(`FXを記録できません: ${md(e.date)}の pl も rebate も 0 です`);
        if (rebate < 0) return fail(`FXを記録できません: ${md(e.date)}の rebate がマイナスです`);
        let acc;
        if (e.account) {
          acc = I.findAccount(state, e.account);
          if (!acc) return fail(`FXを記録できません: 口座「${e.account}」が見つかりません`);
        } else {
          acc = K.accountById(state, K.fxAccountId(state));
          if (!acc) return fail("FXを記録できません: FX口座が見つかりません（account で口座名を指定してください）");
        }
        const head = `${md(e.date)} ${signedYen(pl + rebate)}（損益 ${signedYen(pl)}${rebate ? `・リベート ${K.yen(rebate)}` : ""}・${acc.name}）`;
        const same = state.transactions.filter((x) => x.fx && x.date === e.date);
        if (same.length) {
          const cur = { pl: 0, rebate: 0 };
          same.forEach((x) => (cur[x.fx === "rebate" ? "rebate" : "pl"] += x.amount));
          if (cur.pl === pl && cur.rebate === rebate) return Object.assign(item, { status: "skip", text: `スキップ（同じ日のFXの記録があります）: ${head}` });
          return fail(`FXを記録できません: ${md(e.date)}の記録がもうあります（損益 ${signedYen(cur.pl)}・リベート ${K.yen(cur.rebate)}）。アプリの「FXの記録」で消してから入れ直してください`);
        }
        K.addFxDay(state, { date: e.date, pl, rebate, accountId: acc.id, reflected: e.reflected === true });
        item.notes.push(e.reflected === true ? "FX口座の残高に反映済みとして記録します（残高は動きません）" : `${acc.name}の残高が ${signedYen(pl + rebate)} 動きます`);
        return ok(`FX: ${head}`);
      }

      return fail(`action は add・change・delete・add-account・transfer・add-recurrence・fx のどれかにしてください（${e.action ?? "未指定"}）`);
    }
  };

  const clone = (state) => K.normalizeState(JSON.parse(JSON.stringify(state)));

  // 適用した場合の結果を、今のデータを変えずに返す
  const preview = (state, edits, opts) => summarize(run(clone(state), edits, opts));

  const summarize = (items) => {
    const count = { account: 0, add: 0, change: 0, delete: 0, skip: 0, fail: 0 };
    items.forEach((it) => {
      if (it.status === "ok") count[it.action === "add-account" ? "account" : ["transfer", "add-recurrence", "fx"].includes(it.action) ? "add" : it.action]++;
      else count[it.status]++;
    });
    return { items, count, applicable: count.account + count.add + count.change + count.delete };
  };

  const apply = (state, edits, opts) => summarize(run(state, edits, opts));

  const api = { parseEdits, preview, apply };
  if (isNode) module.exports = api;
  else root.KEdits = api;
})(typeof window !== "undefined" ? window : globalThis);
