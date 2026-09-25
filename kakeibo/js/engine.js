/* 家計簿の計算エンジン（純粋関数のみ。DOM には触らない） */
(function (root) {
  "use strict";

  const D = typeof module !== "undefined" && module.exports ? require("./dates.js") : root.KDates;

  const uid = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

  const WINDFALL = "cat_windfall";

  const defaultCategories = () => [
    { id: "cat_housing", name: "住居費", color: "#2a78d6", kind: "expense" },
    { id: "cat_telecom", name: "通信費", color: "#eb6834", kind: "expense" },
    { id: "cat_subsc", name: "サブスク", color: "#1baf7a", kind: "expense" },
    { id: "cat_bnpl", name: "後払い決済", color: "#eda100", kind: "expense" },
    { id: "cat_living", name: "生活費", color: "#e87ba4", kind: "expense" },
    { id: "cat_misc", name: "雑費", color: "#008300", kind: "expense" },
    { id: "cat_extra", name: "臨時支出", color: "#4a3aa7", kind: "expense" },
    { id: "cat_other", name: "その他", color: "#e34948", kind: "expense" },
    { id: "cat_salary", name: "給与", color: "#2a78d6", kind: "income" },
    { id: "cat_bonus", name: "ボーナス", color: "#1baf7a", kind: "income" },
    { id: WINDFALL, name: "臨時収入", color: "#eda100", kind: "income" },
  ];

  const emptyState = () => ({
    version: 1,
    accounts: [],
    categories: defaultCategories(),
    transactions: [],
    recurrences: [],
    transfers: [],
    goals: [],
    payslips: [],
    settings: {
      livingAccountId: "",
      weekdayCost: 0,
      holidayCost: 0,
      miscMonthly: 0,
      includeTodayLiving: true,
      threshold: 20000,
      payday: 25,
      paydayAdjust: "prev",
      salaryAccountId: "",
      extraHolidays: [],
      taxThreshold: 200000,
    },
  });

  // 保存データの欠損を補う（古い形式や手で編集された JSON 向け）
  const normalizeState = (raw) => {
    const base = emptyState();
    const s = Object.assign(base, raw || {});
    s.settings = Object.assign(emptyState().settings, (raw && raw.settings) || {});
    ["accounts", "transactions", "recurrences", "transfers", "goals", "payslips"].forEach((k) => {
      if (!Array.isArray(s[k])) s[k] = [];
    });
    if (!Array.isArray(s.categories) || s.categories.length === 0) s.categories = defaultCategories();
    s.recurrences.forEach((r) => {
      if (!Array.isArray(r.doneDates)) r.doneDates = [];
      if (!Array.isArray(r.days)) r.days = [Number(r.days) || 1];
    });
    return s;
  };

  const yen = (n) => {
    const v = Math.round(n || 0);
    return (v < 0 ? "-¥" : "¥") + Math.abs(v).toLocaleString("ja-JP");
  };

  const accountById = (state, id) => state.accounts.find((a) => a.id === id);
  const categoryById = (state, id) => state.categories.find((c) => c.id === id);

  const totalAccountIds = (state) => state.accounts.filter((a) => a.includeInTotal !== false).map((a) => a.id);

  const sumBalances = (state, ids) =>
    ids.reduce((sum, id) => sum + (accountById(state, id) ? Math.round(accountById(state, id).balance || 0) : 0), 0);

  /* ---------- 残高の反映（実績の追加・取消・振替のステータス変更） ---------- */

  const applyToAccount = (state, accountId, amount) => {
    const a = accountById(state, accountId);
    if (a) a.balance = Math.round((a.balance || 0) + amount);
  };

  const addTransaction = (state, tx) => {
    const t = Object.assign({ id: uid("tx"), status: "actual", label: "", categoryId: "cat_other" }, tx);
    t.amount = Math.round(t.amount);
    state.transactions.push(t);
    if (t.status === "actual" && !t.balanceAlreadyReflected) applyToAccount(state, t.accountId, t.amount);
    return t;
  };

  const removeTransaction = (state, id) => {
    const t = state.transactions.find((x) => x.id === id);
    if (!t) return;
    if (t.status === "actual" && !t.balanceAlreadyReflected) applyToAccount(state, t.accountId, -t.amount);
    if (t.recurrenceId && t.occurrenceDate) {
      const r = state.recurrences.find((x) => x.id === t.recurrenceId);
      if (r) r.doneDates = r.doneDates.filter((d) => d !== t.occurrenceDate);
    }
    state.transactions = state.transactions.filter((x) => x.id !== id);
  };

  const updateTransaction = (state, id, patch) => {
    const t = state.transactions.find((x) => x.id === id);
    if (!t) return null;
    if (t.status === "actual" && !t.balanceAlreadyReflected) applyToAccount(state, t.accountId, -t.amount);
    Object.assign(t, patch);
    t.amount = Math.round(t.amount);
    if (t.status === "actual" && !t.balanceAlreadyReflected) applyToAccount(state, t.accountId, t.amount);
    return t;
  };

  const confirmTransaction = (state, id, { reflect = true } = {}) =>
    updateTransaction(state, id, { status: "actual", balanceAlreadyReflected: !reflect });

  // 定期ルールの1回分を「済」にする。reflect=false は「残高はすでに手入力で更新済み」
  const completeOccurrence = (state, recurrenceId, date, { reflect = true } = {}) => {
    const r = state.recurrences.find((x) => x.id === recurrenceId);
    if (!r || r.doneDates.includes(date)) return null;
    r.doneDates.push(date);
    if (r.toAccountId) {
      const existing = state.transfers.find((t) => t.recurrenceId === r.id && t.occurrenceDate === date);
      if (existing) {
        if (!reflect) existing.noBalance = true;
        return setTransferStatus(state, existing.id, "done");
      }
      return addTransfer(state, {
        fromId: r.accountId, toId: r.toAccountId, amount: Math.abs(r.amount), date, status: "done",
        label: r.label, recurrenceId: r.id, occurrenceDate: date, noBalance: !reflect,
      });
    }
    return addTransaction(state, {
      accountId: r.accountId,
      date,
      amount: r.amount,
      categoryId: r.categoryId,
      label: r.label,
      status: "actual",
      recurrenceId: r.id,
      occurrenceDate: date,
      balanceAlreadyReflected: !reflect,
    });
  };

  // 定期ルールの1回分だけ金額や日付を変える（例：今月のd払いは 12,340 円）
  const overrideOccurrence = (state, recurrenceId, original, patch) => {
    const r = state.recurrences.find((x) => x.id === recurrenceId);
    if (!r) return null;
    if (r.toAccountId) {
      const ex = state.transfers.find((t) => t.recurrenceId === r.id && t.occurrenceDate === original);
      const amount = patch.amount !== undefined ? Math.abs(Math.round(patch.amount)) : undefined;
      if (ex) {
        const status = ex.status;
        setTransferStatus(state, ex.id, "scheduled");
        Object.assign(ex, patch.date ? { date: patch.date } : {}, amount !== undefined ? { amount } : {});
        return setTransferStatus(state, ex.id, patch.status === "actual" ? "done" : status);
      }
      return addTransfer(state, {
        fromId: r.accountId, toId: r.toAccountId, amount: amount !== undefined ? amount : Math.abs(r.amount),
        date: patch.date || D.adjustBusinessDay(original, r.adjust), status: patch.status === "actual" ? "done" : "scheduled",
        label: r.label, recurrenceId: r.id, occurrenceDate: original,
      });
    }
    const existing = state.transactions.find((t) => t.recurrenceId === r.id && t.occurrenceDate === original);
    if (existing) return updateTransaction(state, existing.id, patch);
    return addTransaction(state, Object.assign({
      accountId: r.accountId,
      date: D.adjustBusinessDay(original, r.adjust),
      amount: r.amount,
      categoryId: r.categoryId,
      label: r.label,
      status: "planned",
      recurrenceId: r.id,
      occurrenceDate: original,
    }, patch));
  };

  // 今回は発生しない回としてスキップ
  const skipOccurrence = (state, recurrenceId, original) => {
    const r = state.recurrences.find((x) => x.id === recurrenceId);
    if (r && !r.doneDates.includes(original)) r.doneDates.push(original);
  };

  // 振替ステータス:scheduled(予定) → requested(申請中) → pending(着金待ち) → done(着金済み)
  const TRANSFER_STATUS = { scheduled: "予定", requested: "申請中", pending: "着金待ち", done: "着金済み" };
  const IN_FLIGHT = ["requested", "pending"];

  const transferApplied = (status) => ({
    from: status !== "scheduled",
    to: status === "done",
  });

  const setTransferStatus = (state, id, status) => {
    const t = state.transfers.find((x) => x.id === id);
    if (!t) return null;
    const want = transferApplied(status);
    const cur = { from: !!t.fromApplied, to: !!t.toApplied };
    // noBalance: 残高は手入力で更新済みの記録用。口座残高は動かさない
    if (!t.noBalance && want.from !== cur.from) applyToAccount(state, t.fromId, want.from ? -t.amount : t.amount);
    if (!t.noBalance && want.to !== cur.to) applyToAccount(state, t.toId, want.to ? t.amount : -t.amount);
    t.fromApplied = want.from;
    t.toApplied = want.to;
    t.status = status;
    return t;
  };

  const addTransfer = (state, tr) => {
    const t = Object.assign({ id: uid("trf"), status: "scheduled", label: "", fromApplied: false, toApplied: false }, tr);
    t.amount = Math.round(t.amount);
    const status = t.status;
    t.status = "scheduled";
    state.transfers.push(t);
    setTransferStatus(state, t.id, status);
    return t;
  };

  const removeTransfer = (state, id) => {
    const t = state.transfers.find((x) => x.id === id);
    if (!t) return;
    if (t.recurrenceId && t.occurrenceDate) {
      const r = state.recurrences.find((x) => x.id === t.recurrenceId);
      if (r) r.doneDates = r.doneDates.filter((d) => d !== t.occurrenceDate);
    }
    setTransferStatus(state, id, "scheduled");
    state.transfers = state.transfers.filter((x) => x.id !== id);
  };

  /* ---------- 定期ルールの展開 ---------- */

  // [start, end] 内の発生日（営業日調整後）を返す。original は調整前の日付（済み管理用キー）
  const expandRecurrence = (r, start, end) => {
    const out = [];
    const interval = Math.max(1, Number(r.intervalMonths) || 1);
    const anchor = r.startDate || "2000-01-01";
    const aY = Number(anchor.slice(0, 4));
    const aM = Number(anchor.slice(5, 7));
    // 営業日調整で月をまたぐ可能性があるので前後1か月広めに走査
    let cursor = D.addMonths(D.ymd(Number(start.slice(0, 4)), Number(start.slice(5, 7)), 1), -1);
    const stop = D.addMonths(D.ymd(Number(end.slice(0, 4)), Number(end.slice(5, 7)), 1), 1);
    while (cursor <= stop) {
      const y = Number(cursor.slice(0, 4));
      const m = Number(cursor.slice(5, 7));
      const monthsFromAnchor = (y - aY) * 12 + (m - aM);
      if (monthsFromAnchor % interval === 0) {
        const dim = D.daysInMonth(y, m);
        [...new Set(r.days.map((d) => Math.min(Number(d), dim)))].forEach((day) => {
          const original = D.ymd(y, m, day);
          if (r.startDate && original < r.startDate) return;
          if (r.endDate && original > r.endDate) return;
          const date = D.adjustBusinessDay(original, r.adjust);
          if (date >= start && date <= end) out.push({ date, original });
        });
      }
      cursor = D.addMonths(cursor, 1);
    }
    return out.sort((a, b) => (a.date < b.date ? -1 : 1));
  };

  const nextPayday = (settings, from) => {
    const day = Number(settings.payday) || 25;
    const make = (s) => {
      const y = Number(s.slice(0, 4));
      const m = Number(s.slice(5, 7));
      return D.adjustBusinessDay(D.ymd(y, m, Math.min(day, D.daysInMonth(y, m))), settings.paydayAdjust || "prev");
    };
    let d = make(from);
    let probe = from;
    let guard = 0;
    while (d < from && guard++ < 3) {
      probe = D.addMonths(D.ymd(Number(probe.slice(0, 4)), Number(probe.slice(5, 7)), 1), 1);
      d = make(probe);
    }
    return d;
  };

  /* ---------- 予測 ---------- */

  // 予測期間内に発生するすべての入出金イベント
  const collectEvents = (state, start, end, opts = {}) => {
    const today = opts.today || start;
    const scenario = opts.scenario || "optimistic";
    const ev = [];
    const push = (e) => ev.push(Object.assign({ categoryId: "cat_other", windfall: false }, e));

    // 予定の取引（過去日付の未確定分は今日に計上）
    state.transactions.forEach((t) => {
      if (t.status !== "planned") return;
      const date = t.date < today ? start : t.date;
      if (date < start || date > end) return;
      push({
        date, accountId: t.accountId, amount: t.amount, label: t.label, categoryId: t.categoryId,
        source: "planned", refId: t.id, overdue: t.date < today, windfall: t.categoryId === WINDFALL,
      });
    });

    // 定期ルール（今日以降の未完了分）。取引に紐付いた回（済み・金額上書き）は取引側で計上する
    const linked = new Set([...state.transactions, ...state.transfers].filter((t) => t.recurrenceId).map((t) => `${t.recurrenceId}|${t.occurrenceDate}`));
    state.recurrences.forEach((r) => {
      expandRecurrence(r, start < today ? today : start, end).forEach(({ date, original }) => {
        if (r.doneDates.includes(original) || linked.has(`${r.id}|${original}`)) return;
        if (r.toAccountId) {
          // 定期の振替（給料口座 → 生活費口座など）は両方の口座に反映
          const amt = Math.abs(r.amount);
          const base = { date, label: r.label, source: "recurrence", refId: r.id, original, transfer: true };
          push(Object.assign({ accountId: r.accountId, amount: -amt }, base));
          push(Object.assign({ accountId: r.toAccountId, amount: amt }, base));
          return;
        }
        push({
          date, accountId: r.accountId, amount: r.amount, label: r.label, categoryId: r.categoryId,
          source: "recurrence", refId: r.id, original, windfall: r.categoryId === WINDFALL,
        });
      });
    });

    // 振替
    state.transfers.forEach((t) => {
      const date = t.date < today ? start : t.date;
      if (date < start || date > end) return;
      const label = t.label || `${(accountById(state, t.fromId) || {}).name || "?"} → ${(accountById(state, t.toId) || {}).name || "?"}`;
      if (t.status === "scheduled") {
        push({ date, accountId: t.fromId, amount: -t.amount, label, source: "transfer", refId: t.id, transfer: true });
        push({ date, accountId: t.toId, amount: t.amount, label, source: "transfer", refId: t.id, transfer: true });
      } else if (IN_FLIGHT.includes(t.status) && scenario === "optimistic") {
        push({ date, accountId: t.toId, amount: t.amount, label: `${label}（着金予定）`, source: "transfer", refId: t.id, transfer: true, inFlight: true });
      }
    });

    // 日割りの生活費・雑費
    const st = state.settings;
    if (st.livingAccountId && accountById(state, st.livingAccountId)) {
      let d = start < today ? today : start;
      if (!st.includeTodayLiving && d === today) d = D.addDays(d, 1);
      const extra = st.extraHolidays || [];
      const misc = Math.round(Number(st.miscMonthly) || 0);
      for (; d <= end; d = D.addDays(d, 1)) {
        const off = D.isDayOff(d, extra);
        const cost = Math.round(Number(off ? st.holidayCost : st.weekdayCost) || 0);
        if (cost) push({ date: d, accountId: st.livingAccountId, amount: -cost, label: off ? "生活費（休日）" : "生活費（平日）", categoryId: "cat_living", source: "living" });
        if (misc) {
          const y = Number(d.slice(0, 4));
          const m = Number(d.slice(5, 7));
          const day = Number(d.slice(8, 10));
          const dim = D.daysInMonth(y, m);
          // 月額を日数で割り、端数は累積で調整して月合計をぴったり一致させる
          const share = Math.round((misc * day) / dim) - Math.round((misc * (day - 1)) / dim);
          if (share) push({ date: d, accountId: st.livingAccountId, amount: -share, label: "雑費（日割り）", categoryId: "cat_misc", source: "misc" });
        }
      }
    }

    // What-if（保存されない仮の支出・収入）
    (opts.whatIf || []).forEach((w) => {
      if (w.date < start || w.date > end) return;
      push({ date: w.date, accountId: w.accountId, amount: Math.round(w.amount), label: `もしも: ${w.label || "仮の支出"}`, categoryId: w.categoryId || "cat_extra", source: "whatif", refId: w.id });
    });

    return ev.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  };

  // scope: 'total' | 口座IDの配列
  const resolveScope = (state, scope) => {
    if (!scope || scope === "total") return totalAccountIds(state);
    return Array.isArray(scope) ? scope : [scope];
  };

  const forecast = (state, opts = {}) => {
    const today = opts.today || D.today();
    const start = opts.start || today;
    const end = opts.end || D.addDays(start, 30);
    const ids = resolveScope(state, opts.scope);
    const events = collectEvents(state, start, end, Object.assign({}, opts, { today }));

    const balances = {};
    state.accounts.forEach((a) => (balances[a.id] = Math.round(a.balance || 0)));
    const startBalance = sumBalances(state, ids);

    const days = [];
    let i = 0;
    for (let d = start; d <= end; d = D.addDays(d, 1)) {
      const dayEvents = [];
      while (i < events.length && events[i].date === d) {
        const e = events[i++];
        if (balances[e.accountId] === undefined) continue;
        balances[e.accountId] += e.amount;
        if (ids.includes(e.accountId)) dayEvents.push(e);
      }
      const balance = ids.reduce((s, id) => s + (balances[id] || 0), 0);
      days.push({
        date: d,
        balance,
        byAccount: Object.assign({}, balances),
        events: dayEvents,
        dayOff: D.isDayOff(d, state.settings.extraHolidays || []),
        holiday: D.holidayName(d),
      });
    }

    let min = days[0] || { date: start, balance: startBalance };
    days.forEach((d) => {
      if (d.balance < min.balance) min = d;
    });
    const threshold = Number(state.settings.threshold) || 0;
    const firstBelow = days.find((d) => d.balance < threshold) || null;
    const firstNegative = days.find((d) => d.balance < 0) || null;

    return {
      start, end, scope: ids, startBalance, days, events,
      endBalance: days.length ? days[days.length - 1].balance : startBalance,
      min: { date: min.date, balance: min.balance },
      firstBelow: firstBelow && { date: firstBelow.date, balance: firstBelow.balance },
      firstNegative: firstNegative && { date: firstNegative.date, balance: firstNegative.balance },
    };
  };

  // 着金待ちの振替が予測範囲の口座に入ってくるか
  const hasInFlightInScope = (state, scope, end) => {
    const ids = resolveScope(state, scope);
    return state.transfers.some((t) => IN_FLIGHT.includes(t.status) && ids.includes(t.toId) && (!end || t.date <= end));
  };

  /* ---------- 給与明細 ---------- */

  const sortedPayslips = (state) => [...state.payslips].sort((a, b) => (a.payDate < b.payDate ? -1 : 1));

  const overtimeRate = (payslips) => {
    const withOt = payslips.filter((p) => Number(p.overtimeHours) > 0 && Number(p.overtimePay) > 0);
    if (!withOt.length) return null;
    const hours = withOt.reduce((s, p) => s + Number(p.overtimeHours), 0);
    const pay = withOt.reduce((s, p) => s + Number(p.overtimePay), 0);
    const last = withOt[withOt.length - 1];
    return {
      average: Math.round(pay / hours),
      latest: Math.round(Number(last.overtimePay) / Number(last.overtimeHours)),
      samples: withOt.length,
    };
  };

  // 残業時間から次回の手取りを見込む。控除率は直近の明細と同じと仮定（多めに見積もる側に倒れる）
  const estimateNextPay = (payslips, hours) => {
    if (!payslips.length) return null;
    const sorted = [...payslips].sort((a, b) => (a.payDate < b.payDate ? -1 : 1));
    const last = sorted[sorted.length - 1];
    const rate = overtimeRate(sorted);
    const gross = Number(last.gross) || 0;
    if (!gross) return null;
    const baseGross = gross - (Number(last.overtimePay) || 0);
    const otPay = rate ? Math.round(rate.average * (Number(hours) || 0)) : 0;
    const estGross = baseGross + otPay;
    const deductionRate = (Number(last.deductions) || 0) / gross;
    const estDeductions = Math.round(estGross * deductionRate);
    return {
      rate: rate ? rate.average : 0,
      baseGross,
      overtimePay: otPay,
      gross: estGross,
      deductions: estDeductions,
      net: estGross - estDeductions,
      deductionRate,
      basedOn: last.payDate,
    };
  };

  /* ---------- 目標 ---------- */

  const monthsBetween = (a, b) => D.diffDays(a, b) / (365.2425 / 12);

  const goalPlan = (state, goal, opts = {}) => {
    const today = opts.today || D.today();
    const ids = goal.accountIds && goal.accountIds.length ? goal.accountIds : totalAccountIds(state);
    const current = sumBalances(state, ids);
    const target = Math.round(Number(goal.targetAmount) || 0);
    const remaining = Math.max(0, target - current);
    const months = Math.max(0, monthsBetween(today, goal.targetDate));
    const years = months / 12;
    const requiredMonthly = months > 0 ? Math.ceil(remaining / months) : remaining;
    const requiredYearly = years > 0 ? Math.ceil(remaining / years) : remaining;

    // 今後12か月の予測から月あたりの貯金ペースを出す
    const end = D.addDays(today, 364);
    const f = forecast(state, { today, start: today, end, scope: ids, scenario: "pessimistic" });
    const windfall = f.events.filter((e) => e.windfall && ids.includes(e.accountId)).reduce((s, e) => s + e.amount, 0);
    const change = f.endBalance - f.startBalance - (goal.includeWindfall ? 0 : windfall);
    const forecastPace = Math.round(change / 12);
    const manual = goal.manualMonthlyPace !== null && goal.manualMonthlyPace !== undefined && goal.manualMonthlyPace !== "";
    const pace = manual ? Math.round(Number(goal.manualMonthlyPace)) : forecastPace;
    const projected = Math.round(current + pace * months);

    return {
      current, target, remaining, months, years, requiredMonthly, requiredYearly,
      forecastPace, pace, paceSource: manual ? "manual" : "forecast",
      windfallExcluded: goal.includeWindfall ? 0 : windfall,
      projected,
      onTrack: remaining === 0 || pace >= requiredMonthly,
      gapMonthly: Math.max(0, requiredMonthly - pace),
      progress: target > 0 ? Math.min(1, Math.max(0, current / target)) : 0,
    };
  };

  /* ---------- カテゴリ別集計 ---------- */

  const categorySummary = (state, start, end, opts = {}) => {
    const today = opts.today || D.today();
    const scopeIds = opts.accountIds || null;
    const items = [];
    state.transactions.forEach((t) => {
      if (t.status !== "actual" || t.amount >= 0) return;
      if (t.date < start || t.date > end) return;
      if (scopeIds && !scopeIds.includes(t.accountId)) return;
      items.push({ date: t.date, label: t.label, amount: -t.amount, categoryId: t.categoryId, accountId: t.accountId, kind: "actual" });
    });
    if (opts.includePlanned) {
      const from = start < today ? today : start;
      if (from <= end) {
        collectEvents(state, from, end, { today, scenario: "pessimistic" }).forEach((e) => {
          if (e.amount >= 0 || e.transfer) return;
          if (scopeIds && !scopeIds.includes(e.accountId)) return;
          items.push({ date: e.date, label: e.label, amount: -e.amount, categoryId: e.categoryId, accountId: e.accountId, kind: "planned" });
        });
      }
    }
    const groups = new Map();
    items.forEach((it) => {
      const cid = categoryById(state, it.categoryId) ? it.categoryId : "cat_other";
      if (!groups.has(cid)) groups.set(cid, { categoryId: cid, total: 0, items: [] });
      const g = groups.get(cid);
      g.total += it.amount;
      g.items.push(it);
    });
    const list = [...groups.values()].sort((a, b) => b.total - a.total);
    list.forEach((g) => g.items.sort((a, b) => (a.date < b.date ? -1 : 1)));
    return { total: list.reduce((s, g) => s + g.total, 0), groups: list };
  };

  /* ---------- アラート ---------- */

  const windfallOfYear = (state, year) =>
    state.transactions
      .filter((t) => t.categoryId === WINDFALL && t.amount > 0 && t.date.startsWith(String(year)))
      .reduce((s, t) => s + t.amount, 0);

  const alerts = (state, opts = {}) => {
    const today = opts.today || D.today();
    const out = [];
    const horizon = opts.horizonDays || 60;
    if (state.accounts.length) {
      const f = forecast(state, { today, start: today, end: D.addDays(today, horizon), scenario: "pessimistic" });
      const threshold = Number(state.settings.threshold) || 0;
      if (f.firstNegative) {
        out.push({ level: "critical", kind: "negative", message: `${D.dayLabelLong(f.firstNegative.date)}に残高がマイナス（${yen(f.firstNegative.balance)}）になる予測です`, date: f.firstNegative.date });
      } else if (f.min.balance < threshold) {
        out.push({ level: "warning", kind: "threshold", message: `${D.dayLabelLong(f.min.date)}に残高が${yen(f.min.balance)}まで下がります（目安 ${yen(threshold)}）`, date: f.min.date });
      }
    }
    state.transfers.forEach((t) => {
      if (IN_FLIGHT.includes(t.status) && t.date < today) {
        const to = accountById(state, t.toId);
        out.push({ level: "serious", kind: "overdue-transfer", message: `${to ? to.name : "?"}への${yen(t.amount)}が着金予定日（${D.dayLabel(t.date)}）を過ぎても未着金です`, refId: t.id });
      }
    });
    const overdue = state.transactions.filter((t) => t.status === "planned" && t.date < today);
    if (overdue.length) out.push({ level: "warning", kind: "overdue-planned", message: `日付を過ぎた未確定の予定が${overdue.length}件あります` });

    const year = Number(today.slice(0, 4));
    const windfall = windfallOfYear(state, year);
    const limit = Number(state.settings.taxThreshold) || 200000;
    if (windfall > limit) {
      out.push({ level: "warning", kind: "tax", message: `${year}年の臨時収入が${yen(windfall)}です。給与以外の所得が${yen(limit)}を超えると確定申告が必要になる可能性があります` });
    } else if (windfall > limit * 0.8) {
      out.push({ level: "info", kind: "tax", message: `${year}年の臨時収入が${yen(windfall)}です（確定申告の目安 ${yen(limit)} まであと${yen(limit - windfall)}）` });
    }
    return out;
  };

  const api = {
    uid, yen, WINDFALL, TRANSFER_STATUS, IN_FLIGHT,
    defaultCategories, emptyState, normalizeState,
    accountById, categoryById, totalAccountIds, sumBalances,
    addTransaction, removeTransaction, updateTransaction, confirmTransaction, completeOccurrence,
    overrideOccurrence, skipOccurrence,
    addTransfer, removeTransfer, setTransferStatus,
    expandRecurrence, nextPayday, collectEvents, forecast, hasInFlightInScope, resolveScope,
    sortedPayslips, overtimeRate, estimateNextPay,
    goalPlan, categorySummary, windfallOfYear, alerts,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Kakeibo = api;
})(typeof window !== "undefined" ? window : globalThis);
