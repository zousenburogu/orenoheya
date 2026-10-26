/* 家計簿の計算エンジン（純粋関数のみ。DOM には触らない） */
(function (root) {
  "use strict";

  const D = typeof module !== "undefined" && module.exports ? require("./dates.js") : root.KDates;

  const uid = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

  const WINDFALL = "cat_windfall";

  // group は給料期間の集計での区分（fixed: 固定費 / repay: 返済 / living: 生活費 / misc: 雑費）
  const defaultCategories = () => [
    { id: "cat_fixed", name: "固定費", color: "#2a78d6", kind: "expense", group: "fixed" },
    { id: "cat_repay", name: "返済", color: "#eb6834", kind: "expense", group: "repay" },
    { id: "cat_housing", name: "住居費", color: "#2a78d6", kind: "expense", group: "fixed" },
    { id: "cat_telecom", name: "通信費", color: "#eb6834", kind: "expense", group: "fixed" },
    { id: "cat_subsc", name: "サブスク", color: "#1baf7a", kind: "expense", group: "fixed" },
    { id: "cat_bnpl", name: "後払い決済", color: "#eda100", kind: "expense", group: "repay" },
    { id: "cat_living", name: "生活費", color: "#e87ba4", kind: "expense", group: "living" },
    { id: "cat_misc", name: "雑費", color: "#008300", kind: "expense", group: "misc" },
    { id: "cat_extra", name: "臨時支出", color: "#4a3aa7", kind: "expense", group: "fixed" },
    { id: "cat_other", name: "その他", color: "#e34948", kind: "expense", group: "fixed" },
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
      livingAccountIds: [],
      coverAccountIds: [],
      lastExportOn: "",
      backupSince: "",
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
      reminderTime: "21:00",
      noSpendDates: [],
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
    // 後から増えた標準カテゴリ（固定費・返済など）と区分を補う
    const defaults = defaultCategories();
    defaults.forEach((d, i) => {
      if (!s.categories.some((c) => c.id === d.id)) s.categories.splice(Math.min(i, s.categories.length), 0, d);
    });
    s.categories.forEach((c) => {
      if (c.kind === "expense" && !c.group) c.group = (defaults.find((d) => d.id === c.id) || {}).group || "fixed";
    });
    // 生活費を払う口座：以前の1口座の設定を、優先順の複数口座の設定に移す
    if (!Array.isArray(s.settings.livingAccountIds) || !s.settings.livingAccountIds.length) {
      s.settings.livingAccountIds = s.settings.livingAccountId ? [s.settings.livingAccountId] : [];
    }
    s.recurrences.forEach((r) => {
      if (!Array.isArray(r.doneDates)) r.doneDates = [];
      if (!Array.isArray(r.days)) r.days = [Number(r.days) || 1];
      if (r.weeks !== undefined && !(Number(r.weeks) > 0)) delete r.weeks;
      if (r.nth !== undefined && ![1, 2, 3, 4, -1].includes(Number(r.nth))) delete r.nth;
    });
    return s;
  };

  /* 金額欄の計算式（例: "=1+2", "12,000-3500", "2万+3000", "(1200+800)*3"）を整数の円にする。
     eval は使わず、四則演算とかっこだけを解釈する。空欄は 0、読めない式は NaN */
  const evalAmount = (input) => {
    const src = String(input ?? "")
      .normalize("NFKC") // 全角数字・記号を半角に
      .replace(/[−‐ー―]/g, "-")
      .replace(/×/g, "*")
      .replace(/÷/g, "/")
      .replace(/[,\s円¥￥]/g, "")
      .replace(/^=+|=+$/g, "");
    if (src === "") return 0;
    let i = 0;
    const peek = () => src[i];
    const number = () => {
      const m = /^\d+(\.\d+)?|^\.\d+/.exec(src.slice(i));
      if (!m) throw new Error("number");
      i += m[0].length;
      let v = Number(m[0]);
      if (peek() === "万") { v *= 10000; i++; }
      else if (peek() === "千") { v *= 1000; i++; }
      return v;
    };
    const factor = () => {
      const c = peek();
      if (c === "-") { i++; return -factor(); }
      if (c === "+") { i++; return factor(); }
      if (c === "(") {
        i++;
        const v = expr();
        if (peek() !== ")") throw new Error("paren");
        i++;
        return v;
      }
      return number();
    };
    const term = () => {
      let v = factor();
      while (peek() === "*" || peek() === "/") {
        const op = src[i++];
        const r = factor();
        if (op === "/" && r === 0) throw new Error("div0");
        v = op === "*" ? v * r : v / r;
      }
      return v;
    };
    const expr = () => {
      let v = term();
      while (peek() === "+" || peek() === "-") {
        const op = src[i++];
        const r = term();
        v = op === "+" ? v + r : v - r;
      }
      return v;
    };
    try {
      const v = expr();
      if (i !== src.length || !Number.isFinite(v)) return NaN;
      return Math.round(v);
    } catch (e) {
      return NaN;
    }
  };

  // 数字だけでなく演算子を含むか（入力欄に計算結果のプレビューを出すかどうか）
  const isFormula = (input) => /[+\-*/×÷＋－（）()=＝万千]/.test(String(input ?? "").trim().replace(/^[-−]\d[\d,]*$/, ""));

  const yen = (n) => {
    const v = Math.round(n || 0);
    return (v < 0 ? "-¥" : "¥") + Math.abs(v).toLocaleString("ja-JP");
  };

  const accountById = (state, id) => state.accounts.find((a) => a.id === id);

  // 生活費を払う口座（優先順。存在する口座だけ）
  const livingAccounts = (state) => {
    const st = state.settings;
    const ids = Array.isArray(st.livingAccountIds) && st.livingAccountIds.length ? st.livingAccountIds : st.livingAccountId ? [st.livingAccountId] : [];
    return [...new Set(ids)].filter((id) => accountById(state, id));
  };

  // その口座から amount 円払えるか。払えなければエラー文（残高 0 以下なら「残高がありません」）
  const balanceError = (state, accountId, amount = 0) => {
    const a = accountById(state, accountId);
    if (!a) return null;
    const bal = Math.round(a.balance || 0);
    if (bal <= 0) return `「${a.name}」は残高がありません（${yen(bal)}）`;
    if (amount > bal) return `「${a.name}」の残高（${yen(bal)}）が足りません`;
    return null;
  };

  const setLivingAccounts = (state, ids) => {
    state.settings.livingAccountIds = [...new Set(ids)].filter((id) => accountById(state, id));
    state.settings.livingAccountId = state.settings.livingAccountIds[0] || "";
  };
  // 残高が足りないとき不足分を立て替える口座（優先順）
  const coverAccounts = (state) => {
    const ids = Array.isArray(state.settings.coverAccountIds) ? state.settings.coverAccountIds : [];
    return [...new Set(ids)].filter((id) => accountById(state, id));
  };
  const setCoverAccounts = (state, ids) => {
    state.settings.coverAccountIds = [...new Set(ids)].filter((id) => accountById(state, id));
  };
  // バックアップ（JSON書き出し）の促し。最後に書き出した日（なければ使い始めた日）から7日以上たったら due
  const BACKUP_DAYS = 7;
  const backupStatus = (state, today) => {
    const base = state.settings.lastExportOn || state.settings.backupSince;
    if (!state.accounts.length || !base) return { due: false, days: 0, exported: !!state.settings.lastExportOn };
    const days = D.diffDays(base, today);
    return { due: days >= BACKUP_DAYS, days, exported: !!state.settings.lastExportOn };
  };
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
    const t = Object.assign({ id: uid("tx"), status: "actual", label: "", categoryId: "cat_other", createdOn: D.today() }, tx);
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

  // 予定を「支払済／入金済」にする。today を渡すと、未来日付の予定は今日の日付で計上する（元の日付は plannedDate に残す）
  const confirmTransaction = (state, id, { reflect = true, today } = {}) => {
    const t = state.transactions.find((x) => x.id === id);
    if (!t) return null;
    const patch = { status: "actual", balanceAlreadyReflected: !reflect, confirmedFrom: "planned" };
    if (today && t.date > today) Object.assign(patch, { plannedDate: t.date, date: today });
    return updateTransaction(state, id, patch);
  };

  // 「支払済」「済」を取り消して予定に戻す（口座残高も元に戻る）。未来日付の実績も予定に戻せる
  const canUnconfirm = (t, today) =>
    !!t && t.status === "actual" && !t.adjustment &&
    (t.confirmedFrom === "planned" || !!t.fromOccurrence || (!!today && t.date > today));

  const unconfirmTransaction = (state, id, today) => {
    const t = state.transactions.find((x) => x.id === id);
    if (!canUnconfirm(t, today)) return null;
    if (t.fromOccurrence) {
      // 定期ルールの「済」で作られた取引は削除すれば、その回が予定として復活する
      removeTransaction(state, id);
      return null;
    }
    const u = updateTransaction(state, id, Object.assign({ status: "planned", balanceAlreadyReflected: false }, t.plannedDate ? { date: t.plannedDate } : {}));
    delete u.confirmedFrom;
    delete u.plannedDate;
    return u;
  };

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
      fromOccurrence: true,
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

  // 着金待ちの振替を「着金済み」にする。reflect=false は「入金先の残高は手入力で更新済み」（二重に足さない）
  // actualAmount: 実際に入った額。振替の額と違えば、差を入金先の「着金額の差」として記録する（FX口座からの振替ならFXの損益に入れる）
  const completeTransfer = (state, id, { reflect = true, actualAmount, today } = {}) => {
    const t = state.transfers.find((x) => x.id === id);
    if (!t) return null;
    if (!reflect) t.toApplied = true;
    const done = setTransferStatus(state, id, "done");
    const actual = actualAmount === undefined || actualAmount === null || actualAmount === "" ? NaN : Math.round(Number(actualAmount));
    if (Number.isFinite(actual) && actual > 0 && actual !== t.amount) {
      const diff = actual - t.amount;
      const fromFx = !!t.fromId && t.fromId === fxAccountId(state);
      addTransaction(state, Object.assign({
        accountId: t.toId, date: today || D.today(), amount: diff, categoryId: diff > 0 ? WINDFALL : "cat_other",
        label: `着金額の差（${t.label || "振替"}）`, status: "actual", balanceAlreadyReflected: !reflect,
      }, fromFx ? { fx: "pl" } : {}));
    }
    return done;
  };

  // 着金待ち・申請中で、入金先が対象の口座に入っている振替の合計
  const inFlightTotal = (state, scope) => {
    const ids = resolveScope(state, scope);
    return state.transfers.filter((t) => IN_FLIGHT.includes(t.status) && ids.includes(t.toId)).reduce((s, t) => s + t.amount, 0);
  };

  // 振替の日付（着金予定日）とメモだけを変える。口座の残高は状態で決まるので、日付やメモを変えても動かない
  const updateTransfer = (state, id, patch = {}) => {
    const t = state.transfers.find((x) => x.id === id);
    if (!t) return null;
    if (patch.date !== undefined) t.date = patch.date;
    if (patch.label !== undefined) t.label = String(patch.label ?? "").trim();
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
  // その月の給料日（休日なら設定に従って前後の営業日）
  const paydayOfMonth = (settings = {}, ym) => {
    const y = Number(ym.slice(0, 4));
    const m = Number(ym.slice(5, 7));
    const day = Number(settings.payday) || 25;
    return D.adjustBusinessDay(D.ymd(y, m, Math.min(day, D.daysInMonth(y, m))), settings.paydayAdjust || "prev");
  };

  // 週ごとのルール（weeks: 何週ごと、weekday: 曜日 0=日〜6=土）。起点は開始日以降で最初のその曜日
  const isWeekly = (r) => Number(r && r.weeks) > 0;
  const expandWeekly = (r, start, end) => {
    const out = [];
    const step = Math.max(1, Math.round(Number(r.weeks))) * 7;
    const wd = ((Math.round(Number(r.weekday)) % 7) + 7) % 7;
    const base = r.startDate || start;
    let d = D.addDays(base, (wd - D.dow(base) + 7) % 7);
    // 範囲より前は回数をまとめて飛ばす（営業日調整で前にずれる分の余裕を1回分残す）
    const behind = D.diffDays(d, start);
    if (behind > step) d = D.addDays(d, (Math.floor(behind / step) - 1) * step);
    for (; d <= D.addDays(end, 7); d = D.addDays(d, step)) {
      if (r.endDate && d > r.endDate) break;
      const date = D.adjustBusinessDay(d, r.adjust);
      if (date >= start && date <= end) out.push({ date, original: d });
    }
    return out;
  };

  // 月ごとの「第N曜日」ルール（nth: 1〜4、-1 は最終。weekday: 0=日〜6=土）
  const isNthWeekday = (r) => !isWeekly(r) && !!r && [1, 2, 3, 4, -1].includes(Number(r.nth)) && r.weekday !== undefined && r.weekday !== "";
  const nthWeekdayOfMonth = (y, m, nth, weekday) => {
    const wd = ((Math.round(Number(weekday)) % 7) + 7) % 7;
    const dim = D.daysInMonth(y, m);
    if (Number(nth) === -1) {
      const last = D.ymd(y, m, dim);
      return D.ymd(y, m, dim - ((D.dow(last) - wd + 7) % 7));
    }
    const day = 1 + ((wd - D.dow(D.ymd(y, m, 1)) + 7) % 7) + (Number(nth) - 1) * 7;
    return day <= dim ? D.ymd(y, m, day) : null;
  };

  // settings は「毎月の給料日」ルール（onPayday）の日付計算に使う
  const expandRecurrence = (r, start, end, settings) => {
    if (isWeekly(r)) return expandWeekly(r, start, end);
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
      if (monthsFromAnchor % interval === 0 && r.onPayday) {
        // 毎月の給料日と同じ日（電気代など給料のあとに払うもの）
        const date = paydayOfMonth(settings || { payday: 25, paydayAdjust: "prev" }, cursor.slice(0, 7));
        const inRange = (!r.startDate || date >= r.startDate.slice(0, 7)) && (!r.endDate || date.slice(0, 7) <= r.endDate.slice(0, 7));
        if (inRange && date >= start && date <= end) out.push({ date, original: date });
      } else if (monthsFromAnchor % interval === 0 && isNthWeekday(r)) {
        const original = nthWeekdayOfMonth(y, m, r.nth, r.weekday);
        if (original && !(r.startDate && original < r.startDate) && !(r.endDate && original > r.endDate)) {
          const date = D.adjustBusinessDay(original, r.adjust);
          if (date >= start && date <= end) out.push({ date, original });
        }
      } else if (monthsFromAnchor % interval === 0) {
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
      expandRecurrence(r, start < today ? today : start, end, state.settings).forEach(({ date, original }) => {
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
    const payFrom = livingAccounts(state);
    if (payFrom.length) {
      let d = start < today ? today : start;
      if (!st.includeTodayLiving && d === today) d = D.addDays(d, 1);
      const extra = st.extraHolidays || [];
      const misc = Math.round(Number(st.miscMonthly) || 0);
      // 実績で使った分は見込みから差し引く（実績と見込みの二重計上を防ぐ）
      // 定期ルール（まとめ買いなど）の回として記録した分は、そのルールの予定と相殺されるので日割りからは引かない
      const spent = (categoryId, from, to) =>
        state.transactions
          .filter((t) => t.status === "actual" && t.categoryId === categoryId && t.amount < 0 && !t.adjustment && !t.recurrenceId && t.date >= from && t.date <= to)
          .reduce((sum, t) => sum - t.amount, 0);
      const livingToday = spent("cat_living", today, today);
      // 今月の雑費は「月の枠 − 今月の実績」を残りの日数で割る。来月以降は月の枠をそのまま日割り
      const firstMiscDay = d;
      const monthStart = `${today.slice(0, 7)}-01`;
      const miscLeftThisMonth = Math.max(0, misc - spent("cat_misc", monthStart, today));
      const daysLeftThisMonth = D.diffDays(firstMiscDay, D.endOfMonth(today)) + 1;
      for (; d <= end; d = D.addDays(d, 1)) {
        const off = D.isDayOff(d, extra);
        let cost = Math.round(Number(off ? st.holidayCost : st.weekdayCost) || 0);
        if (d === today) cost = Math.max(0, cost - livingToday);
        if (cost) push({ date: d, accountId: payFrom[0], payFrom, amount: -cost, label: off ? "生活費（休日）" : "生活費（平日）", categoryId: "cat_living", source: "living" });
        if (misc) {
          const y = Number(d.slice(0, 4));
          const m = Number(d.slice(5, 7));
          const day = Number(d.slice(8, 10));
          const dim = D.daysInMonth(y, m);
          let share;
          if (d.slice(0, 7) === today.slice(0, 7)) {
            // 今月の残り枠を残り日数で割る（端数は累積で調整して合計を一致させる）
            const k = D.diffDays(firstMiscDay, d) + 1;
            share = Math.round((miscLeftThisMonth * k) / daysLeftThisMonth) - Math.round((miscLeftThisMonth * (k - 1)) / daysLeftThisMonth);
          } else {
            // 月額を日数で割り、端数は累積で調整して月合計をぴったり一致させる
            share = Math.round((misc * day) / dim) - Math.round((misc * (day - 1)) / dim);
          }
          if (share) push({ date: d, accountId: payFrom[0], payFrom, amount: -share, label: "雑費（日割り）", categoryId: "cat_misc", source: "misc" });
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

    // 今日（と未来日付）で記録済みの実績は残高に反映済み。予測には足さず、表示用に今日の行へ付ける
    const actualsToday = state.transactions
      .filter((t) => t.status === "actual" && t.date >= today && !t.adjustment && ids.includes(t.accountId))
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    const cover = coverAccounts(state);
    const days = [];
    let i = 0;
    let livingShortage = null;
    for (let d = start; d <= end; d = D.addDays(d, 1)) {
      const dayEvents = [];
      while (i < events.length && events[i].date === d) {
        const e = events[i++];
        if (e.payFrom && e.amount < 0) {
          // 生活費・雑費は1回分をまるごと払える最初の口座から払う（残高をギリギリまで使わず、払えなければ次の口座へ）。どれも払えなければ最後の口座がマイナス
          const need = -e.amount;
          const id = e.payFrom.find((x) => balances[x] !== undefined && balances[x] >= need);
          if (!id && !livingShortage) livingShortage = { date: d, accountIds: e.payFrom.slice() };
          const to = id || e.payFrom[e.payFrom.length - 1];
          if (balances[to] === undefined) continue;
          balances[to] -= need;
          if (ids.includes(to)) dayEvents.push(Object.assign({}, e, { accountId: to }));
          continue;
        }
        if (balances[e.accountId] === undefined) continue;
        if (cover.length && e.amount < 0 && !e.transfer && -e.amount > Math.max(0, balances[e.accountId])) {
          // 残高が足りない支出は、立て替え口座から順に不足分を払う（全部足りなければ元の口座がマイナス）
          let need = -e.amount - Math.max(0, balances[e.accountId]);
          const covers = [];
          cover.forEach((id) => {
            if (need <= 0 || id === e.accountId || balances[id] === undefined) return;
            const take = Math.min(need, Math.max(0, balances[id]));
            if (take <= 0) return;
            balances[id] -= take;
            need -= take;
            covers.push({ id, take });
          });
          const own = e.amount + covers.reduce((s, c) => s + c.take, 0);
          balances[e.accountId] += own;
          if (ids.includes(e.accountId)) dayEvents.push(Object.assign({}, e, { amount: own }));
          covers.forEach((c) => {
            if (ids.includes(c.id)) dayEvents.push(Object.assign({}, e, { accountId: c.id, amount: -c.take, label: `${e.label}（${(accountById(state, e.accountId) || {}).name || "?"}の不足分）` }));
          });
          continue;
        }
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
        actuals: d === today ? actualsToday : [],
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
      livingShortage,
    };
  };

  // 着金待ちの振替が予測範囲の口座に入ってくるか
  const hasInFlightInScope = (state, scope, end) => {
    const ids = resolveScope(state, scope);
    return state.transfers.some((t) => IN_FLIGHT.includes(t.status) && ids.includes(t.toId) && (!end || t.date <= end));
  };

  /* ---------- 給与明細 ---------- */

  const categorySummary = (state, start, end, opts = {}) => {
    const today = opts.today || D.today();
    const scopeIds = opts.accountIds || null;
    const items = [];
    state.transactions.forEach((t) => {
      if (t.status !== "actual" || t.amount >= 0 || t.adjustment || t.fx) return;
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

  /* ---------- FXの記録（日ごとの損益・リベート） ---------- */

  // FXの記録は FX口座の実績（t.fx: "pl" 損益 / "rebate" リベート）。口座残高は動くが、支出・収入の集計には入れない
  const FX_LABEL = { pl: "FX損益", rebate: "FXリベート" };

  const fxAccountId = (state) => {
    const id = state.settings.fxAccountId;
    if (id && accountById(state, id)) return id;
    const a = state.accounts.find((x) => /fx|ＦＸ|エフエックス/i.test(x.name));
    return a ? a.id : "";
  };

  // pl（損益・マイナス可）と rebate（リベート）をその日の記録として追加。0 の項目は作らない
  const addFxDay = (state, { date, pl = 0, rebate = 0, accountId, reflected = false }) => {
    const acc = accountId || fxAccountId(state);
    const out = [];
    [["pl", Math.round(Number(pl) || 0)], ["rebate", Math.round(Number(rebate) || 0)]].forEach(([kind, amount]) => {
      if (!amount) return;
      out.push(addTransaction(state, { accountId: acc, date, amount, categoryId: WINDFALL, label: FX_LABEL[kind], status: "actual", fx: kind, balanceAlreadyReflected: !!reflected }));
    });
    return out;
  };

  const windfallOfYear = (state, year) =>
    state.transactions
      .filter((t) => t.categoryId === WINDFALL && t.amount > 0 && t.date.startsWith(String(year)))
      .reduce((s, t) => s + t.amount, 0);

  const alerts = (state, opts = {}) => {
    const today = opts.today || D.today();
    const out = [];
    const horizon = opts.horizonDays || 60;
    // 着金待ちは着金予定日に入る前提（optimistic）で判定する。着金予定日を過ぎた分は下の「未着金」で知らせる
    if (state.accounts.length) {
      const f = forecast(state, { today, start: today, end: D.addDays(today, horizon), scenario: "optimistic" });
      const threshold = Number(state.settings.threshold) || 0;
      if (f.firstNegative) {
        out.push({ level: "critical", kind: "negative", message: `${D.dayLabelLong(f.firstNegative.date)}に残高がマイナス（${yen(f.firstNegative.balance)}）になる予測です`, date: f.firstNegative.date });
      } else if (f.min.balance < threshold) {
        out.push({ level: "warning", kind: "threshold", message: `${D.dayLabelLong(f.min.date)}に残高が${yen(f.min.balance)}まで下がります（目安 ${yen(threshold)}）`, date: f.min.date });
      }
    }
    // 今日が着金予定日の振替を、入金先の口座ごとにまとめて知らせる
    const arrivals = new Map();
    state.transfers.forEach((t) => {
      if (t.status === "done" || t.date !== today) return;
      const cur = arrivals.get(t.toId) || { amount: 0, count: 0 };
      cur.amount += t.amount;
      cur.count += 1;
      arrivals.set(t.toId, cur);
    });
    arrivals.forEach((v, toId) => {
      const to = accountById(state, toId);
      out.push({ level: "info", kind: "arrival-today", message: `今日（${D.dayLabelLong(today)}）は${to ? to.name : "?"}に${yen(v.amount)}が着金予定です${v.count > 1 ? `（${v.count}件）` : ""}。届いたら「着金した」を押してください`, date: today, accountId: toId, amount: v.amount });
    });
    if (state.accounts.length) {
      const f2 = forecast(state, { today, start: today, end: D.addDays(today, horizon), scenario: "optimistic" });
      if (f2.livingShortage) {
        const names = f2.livingShortage.accountIds.map((id) => (accountById(state, id) || {}).name).join("・");
        out.push({ level: "critical", kind: "living-shortage", message: `${D.dayLabelLong(f2.livingShortage.date)}に生活費を払う口座（${names}）の残高がなくなります`, date: f2.livingShortage.date });
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
    return out;
  };

  /* ---------- 記録のリマインダー ---------- */

  // その日に何か記録したか（その日に入力した取引・その日付の実績・「今日は使っていない」）
  const recordedOn = (state, date) =>
    (state.settings.noSpendDates || []).includes(date) ||
    state.transactions.some((t) => t.createdOn === date || (t.status === "actual" && t.date === date));

  // リマインダー時刻（"21:00"）を過ぎていて、今日まだ何も記録していなければ true
  const needsReminder = (state, { date, time }) => {
    const at = state.settings.reminderTime;
    if (!at) return false;
    return time >= at && !recordedOn(state, date);
  };

  const markNoSpend = (state, date) => {
    const list = state.settings.noSpendDates || (state.settings.noSpendDates = []);
    if (!list.includes(date)) list.push(date);
    // 古い記録はためこまない
    state.settings.noSpendDates = list.filter((d) => d >= D.addDays(date, -60));
  };

  const api = {
    recordedOn, needsReminder, markNoSpend,
    uid, yen, evalAmount, isFormula, WINDFALL, TRANSFER_STATUS, IN_FLIGHT,
    defaultCategories, emptyState, normalizeState,
    accountById, categoryById, livingAccounts, setLivingAccounts, coverAccounts, setCoverAccounts, backupStatus, balanceError, totalAccountIds, sumBalances,
    addTransaction, removeTransaction, updateTransaction, confirmTransaction, completeOccurrence,
    canUnconfirm, unconfirmTransaction,
    overrideOccurrence, skipOccurrence,
    addTransfer, updateTransfer, removeTransfer, setTransferStatus, completeTransfer, inFlightTotal,
    expandRecurrence, isWeekly, nextPayday, paydayOfMonth, collectEvents, forecast, hasInFlightInScope, resolveScope,
    categorySummary, windfallOfYear, alerts,
    FX_LABEL, fxAccountId, addFxDay, isNthWeekday, nthWeekdayOfMonth,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Kakeibo = api;
})(typeof window !== "undefined" ? window : globalThis);
