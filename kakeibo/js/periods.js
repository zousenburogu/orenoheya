/* 給料期間（給料日〜次の給料日の前日）ごとの集計・予算枠・リボ返済シミュレーター・初期データ */
(function (root) {
  "use strict";

  const isNode = typeof module !== "undefined" && module.exports;
  const D = isNode ? require("./dates.js") : root.KDates;
  const K = isNode ? require("./engine.js") : root.Kakeibo;

  const GROUP_LABEL = { income: "収入", living: "生活費", misc: "雑費", fixed: "固定費", repay: "返済" };

  const ymOf = (d) => d.slice(0, 7);
  const prevYm = (ym) => D.addMonths(`${ym}-01`, -1).slice(0, 7);
  const nextYm = (ym) => D.addMonths(`${ym}-01`, 1).slice(0, 7);

  // 日付 date を含む給料期間
  const periodAt = (settings, date) => {
    let start = K.paydayOfMonth(settings, ymOf(date));
    if (start > date) start = K.paydayOfMonth(settings, prevYm(ymOf(date)));
    return periodFrom(settings, start);
  };

  // 給料日 start から始まる給料期間
  const periodFrom = (settings, start) => {
    let next = K.paydayOfMonth(settings, nextYm(ymOf(start)));
    if (next <= start) next = K.paydayOfMonth(settings, nextYm(nextYm(ymOf(start))));
    return { start, end: D.addDays(next, -1), next };
  };

  /**
   * 表示する給料期間の一覧。既定は今日以降に始まる期間から（今日が給料日ならその期間から）。
   * includeCurrent なら今日を含む期間から
   */
  const listPeriods = (settings, { today, count = 6, includeCurrent = false }) => {
    let p = periodAt(settings, today);
    if (!includeCurrent && p.start < today) p = periodFrom(settings, p.next);
    const out = [];
    for (let i = 0; i < count; i++) {
      out.push(p);
      p = periodFrom(settings, p.next);
    }
    return out;
  };

  const groupOf = (state, categoryId, amount) => {
    if (amount > 0) return "income";
    const c = K.categoryById(state, categoryId);
    return (c && c.group) || "fixed";
  };

  /**
   * 期間内の予定（定期ルールの各回・単発の予定・記録済みの実績）。別口座（合計に含めない口座）の分は other: true
   * 生活費・雑費のカテゴリの取引はルール計算と二重になるので含めない。口座間の振替・残高調整も含めない
   */
  const periodItems = (state, start, end) => {
    const items = [];
    const linked = new Set(state.transactions.filter((t) => t.recurrenceId).map((t) => `${t.recurrenceId}|${t.occurrenceDate}`));
    const otherAcc = (id) => {
      const a = K.accountById(state, id);
      return !!a && a.includeInTotal === false;
    };
    state.recurrences.forEach((r) => {
      if (r.toAccountId) return;
      K.expandRecurrence(r, start, end, state.settings).forEach(({ date, original }) => {
        if (r.doneDates.includes(original) || linked.has(`${r.id}|${original}`)) return;
        items.push({ date, label: r.label, amount: r.amount, group: groupOf(state, r.categoryId, r.amount), other: otherAcc(r.accountId), accountId: r.accountId, source: "recurrence", refId: r.id, original });
      });
    });
    state.transactions.forEach((t) => {
      if (t.adjustment || t.date < start || t.date > end) return;
      const group = groupOf(state, t.categoryId, t.amount);
      if (group === "living" || group === "misc") return;
      items.push({ date: t.date, label: t.label || (K.categoryById(state, t.categoryId) || {}).name || "", amount: t.amount, group, other: otherAcc(t.accountId), accountId: t.accountId, source: t.status === "planned" ? "planned" : "actual", refId: t.id });
    });
    return items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  };

  // 平日・休日の日数（休日 ＝ 土日・祝日・手動で追加した日）
  const countDays = (state, start, end) => {
    let weekdays = 0;
    let holidays = 0;
    for (let d = start; d <= end; d = D.addDays(d, 1)) {
      if (D.isDayOff(d, state.settings.extraHolidays || [])) holidays++;
      else weekdays++;
    }
    return { weekdays, holidays, days: weekdays + holidays };
  };

  const livingCost = (state, counts) =>
    counts.weekdays * Math.round(Number(state.settings.weekdayCost) || 0) + counts.holidays * Math.round(Number(state.settings.holidayCost) || 0);

  // 雑費：給料期間1つにつき月の雑費額。期間の途中からなら日数で日割り
  const miscFor = (state, start, end) => {
    const z = Math.round(Number(state.settings.miscMonthly) || 0);
    const p = periodAt(state.settings, start);
    if (p.start === start && p.end === end) return z;
    const len = D.diffDays(p.start, p.end) + 1;
    return Math.round((z * (D.diffDays(start, end) + 1)) / len);
  };

  const summarize = (state, start, end) => {
    const counts = countDays(state, start, end);
    const items = periodItems(state, start, end);
    const sum = (g) => items.filter((i) => !i.other && i.group === g).reduce((a, i) => a + Math.abs(i.amount), 0);
    const income = sum("income");
    const living = livingCost(state, counts);
    const misc = miscFor(state, start, end);
    const fixed = sum("fixed");
    const repay = sum("repay");
    const total = living + misc + fixed + repay;
    return { start, end, ...counts, income, living, misc, fixed, repay, total, saving: income - total, items };
  };

  // 給料期間ごとの集計（累計つき）
  const periodTable = (state, opts) => {
    let cumulative = 0;
    return listPeriods(state.settings, opts).map((p) => {
      const row = summarize(state, p.start, p.end);
      cumulative += row.saving;
      return Object.assign(row, { cumulative });
    });
  };

  // 予算枠モード：期間と使える額から、1日あたり・生活費ルールの見込み・過不足
  const budgetMode = (state, { start, end, amount, includeMisc }) => {
    if (!start || !end || end < start) return null;
    const counts = countDays(state, start, end);
    const living = livingCost(state, counts);
    const misc = miscFor(state, start, end);
    const expected = living + (includeMisc ? misc : 0);
    const avail = Math.round(Number(amount) || 0);
    return { start, end, ...counts, amount: avail, perDay: counts.days ? Math.floor(avail / counts.days) : 0, living, misc, includeMisc: !!includeMisc, expected, diff: avail - expected };
  };

  // カレンダー用：月の予定（別口座も含む）と給料日
  const monthItems = (state, ym) => {
    const start = `${ym}-01`;
    const end = D.endOfMonth(start);
    return { items: periodItems(state, start, end), payday: K.paydayOfMonth(state.settings, ym) };
  };

  /**
   * リボ返済シミュレーター。利息 ＝ 残高 × 年利 × その月の日数 ÷ 365（円未満切り捨て）
   * lumpMonth（"YYYY-MM"）の回に残りを一括返済。空欄・0 は null を返す
   */
  const revolving = ({ balance, payment, apr, startMonth, lumpMonth }) => {
    let bal = Math.round(Number(balance) || 0);
    const pay = Math.round(Number(payment) || 0);
    const rate = Number(apr) || 0;
    if (bal <= 0 || pay <= 0) return null;
    let ym = startMonth || D.today().slice(0, 7);
    const rows = [];
    let totalInterest = 0;
    for (let i = 0; i < 600 && bal > 0; i++) {
      const days = D.daysInMonth(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)));
      const interest = Math.floor((bal * (rate / 100) * days) / 365);
      const lump = lumpMonth && ym === lumpMonth;
      if (!lump && pay <= interest) return { rows, totalInterest, neverEnds: true, payment: pay };
      const amount = lump ? bal + interest : Math.min(pay, bal + interest);
      const principal = amount - interest;
      bal -= principal;
      totalInterest += interest;
      rows.push({ month: ym, payment: amount, interest, principal, balance: bal, lump: !!lump });
      ym = nextYm(ym);
    }
    return { rows, totalInterest, totalPaid: rows.reduce((a, r) => a + r.payment, 0), months: rows.length, neverEnds: bal > 0 };
  };

  /* ---------- 指示書の初期データ ---------- */

  const INITIAL = {
    settings: { weekdayCost: 700, holidayCost: 2500, miscMonthly: 15000, payday: 25, paydayAdjust: "prev" },
    extraHolidays: ["2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03"],
    budget: { start: "2026-10-01", end: "2026-10-22", amount: 37797, includeMisc: false },
    recurrences: [
      { label: "楽天モバイル", amount: -3281, days: [15], categoryId: "cat_fixed", startDate: "2026-11-01" },
      { label: "電気代", amount: -11000, onPayday: true, days: [25], categoryId: "cat_fixed", startDate: "2026-10-01", tentative: "概算" },
      { label: "YouTube Premium", amount: -980, days: [25], categoryId: "cat_fixed", startDate: "2026-10-01" },
      { label: "Cashacari", amount: -7710, days: [7], categoryId: "cat_repay", startDate: "2026-11-01", endDate: "2027-01-31" },
      { label: "給料", amount: 180000, onPayday: true, days: [25], categoryId: "cat_salary", startDate: "2026-10-01", overrides: { "2026-11": 190000, "2026-12": 200000 } },
    ],
    oneOffs: [
      { date: "2026-10-05", label: "入金", amount: 27853, categoryId: "cat_windfall" },
      { date: "2026-10-05", label: "d払い", amount: -12990, categoryId: "cat_repay", other: true },
      { date: "2026-10-07", label: "Cashacari", amount: -13490, categoryId: "cat_repay", other: true },
      { date: "2026-10-15", label: "楽天モバイル", amount: -3281, categoryId: "cat_fixed", other: true },
      { date: "2026-10-27", label: "PayPay", amount: -2203, categoryId: "cat_repay" },
      { date: "2026-11-05", label: "d払い", amount: -12343, categoryId: "cat_repay" },
      { date: "2026-11-27", label: "PayPay（リボ）", amount: -5300, categoryId: "cat_repay", tentative: "利息込みの概算" },
      { date: "2026-12-05", label: "d払い", amount: -15500, categoryId: "cat_repay", tentative: "概算" },
      { date: "2026-12-27", label: "PayPay（リボ残りをボーナスで完済）", amount: -13200, categoryId: "cat_repay", tentative: "利息込みの概算" },
      { date: "2026-12-04", label: "ボーナス", amount: 400000, categoryId: "cat_bonus", tentative: "12月上旬・日付は仮" },
    ],
  };

  const key = (s) => String(s || "").normalize("NFKC").toLowerCase().replace(/[\s（）()・]/g, "");

  /**
   * 初期データを今のデータに追加する（置き換えない）。同じ名前・金額の定期ルール、同じ日・金額の予定はとばす。
   * mainId: メイン口座、otherId: 別口座（合計に含めない口座）。otherId が空なら「別口座」を作る
   */
  const applyInitialData = (state, { mainId, otherId, today } = {}) => {
    const added = { recurrences: 0, oneOffs: 0, skipped: [] };
    if (!mainId || !K.accountById(state, mainId)) throw new Error("メイン口座を選んでください");
    let other = otherId && K.accountById(state, otherId);
    if (!other) {
      other = { id: K.uid("acc"), name: "別口座", balance: 0, includeInTotal: false, note: "集計から除外する支払い用", balanceSet: false };
      state.accounts.push(other);
    }
    Object.assign(state.settings, INITIAL.settings);
    if (!state.settings.salaryAccountId) state.settings.salaryAccountId = mainId;
    state.settings.extraHolidays = [...new Set([...(state.settings.extraHolidays || []), ...INITIAL.extraHolidays])].sort();
    state.settings.budget = Object.assign({}, INITIAL.budget);

    INITIAL.recurrences.forEach((src) => {
      const dup = state.recurrences.find((r) => key(r.label) === key(src.label) && r.amount === src.amount && !!r.onPayday === !!src.onPayday);
      if (dup) {
        added.skipped.push(src.label);
        return;
      }
      const r = {
        id: K.uid("rec"), label: src.label, amount: src.amount, days: src.days, onPayday: !!src.onPayday,
        intervalMonths: 1, adjust: "none", accountId: mainId, categoryId: src.categoryId,
        startDate: src.startDate, endDate: src.endDate || "", doneDates: [],
        ...(src.tentative ? { tentative: src.tentative } : {}),
      };
      state.recurrences.push(r);
      added.recurrences++;
      Object.entries(src.overrides || {}).forEach(([ym, amount]) => {
        const date = K.paydayOfMonth(state.settings, ym);
        K.overrideOccurrence(state, r.id, date, { amount, date });
      });
    });
    INITIAL.oneOffs.forEach((src) => {
      const acc = src.other ? other.id : mainId;
      const dup = state.transactions.find((t) => t.date === src.date && t.amount === src.amount);
      if (dup) {
        added.skipped.push(`${src.date.slice(5).replace("-", "/")} ${src.label}`);
        return;
      }
      K.addTransaction(state, {
        accountId: acc, date: src.date, amount: src.amount, categoryId: src.categoryId, label: src.label,
        status: src.date > (today || D.today()) ? "planned" : "actual",
        ...(src.tentative ? { tentative: src.tentative } : {}),
      });
      added.oneOffs++;
    });
    return added;
  };

  // まっさらな状態から初期データを入れる（口座は残高未記入のメイン口座と別口座）
  const freshStart = ({ today } = {}) => {
    const state = K.normalizeState(null);
    const main = { id: K.uid("acc"), name: "メイン口座", balance: 0, includeInTotal: true, note: "給料の入金・支払い", balanceSet: false };
    state.accounts.push(main);
    state.settings.salaryAccountId = main.id;
    state.settings.livingAccountId = main.id;
    const added = applyInitialData(state, { mainId: main.id, otherId: "", today });
    return { state, added };
  };

  /**
   * 未記入のチェックリスト。level: required（必須）/ check（仮・概算の確認）/ optional（任意。「使わない」で消せる）
   */
  const setupChecklist = (state, { today } = {}) => {
    const t = today || D.today();
    const out = [];
    state.accounts.filter((a) => a.balanceSet === false).forEach((a) => {
      out.push({ key: `balance:${a.id}`, level: "required", text: `「${a.name}」の今の残高`, target: { type: "balance", id: a.id } });
    });
    const tentative = [
      ...state.transactions.filter((x) => x.tentative && x.status === "planned" && x.date >= t).map((x) => ({ id: x.id, kind: "tx", label: x.label, note: x.tentative, date: x.date })),
      ...state.recurrences.filter((r) => r.tentative).map((r) => ({ id: r.id, kind: "rec", label: r.label, note: r.tentative })),
    ];
    if (tentative.length) out.push({ key: "tentative", level: "check", text: `仮・概算の予定 ${tentative.length}件（${tentative.map((x) => x.label).join("、")}）`, target: { type: "tentative" }, items: tentative });
    const dismissed = state.settings.dismissedSetup || [];
    const optional = [
      [!Number(state.settings.annualBonus), "annualBonus", "年間のボーナス額（稼ぐ目安カレンダー）", { type: "earncal" }],
      [!state.goals.length, "goal", "貯金の目標（誕生日・何歳まで）", { type: "goals" }],
      [!state.payslips.length, "payslip", "給与明細（残業の時給換算・年収の実績に使う）", { type: "payslips" }],
    ];
    optional.forEach(([missing, key, text, target]) => {
      if (missing && !dismissed.includes(key)) out.push({ key, level: "optional", text, target });
    });
    return out;
  };

  const api = { GROUP_LABEL, freshStart, setupChecklist, periodAt, periodFrom, listPeriods, periodItems, countDays, summarize, periodTable, budgetMode, monthItems, revolving, applyInitialData, INITIAL };
  if (isNode) module.exports = api;
  else root.KPeriods = api;
})(typeof window !== "undefined" ? window : globalThis);
