const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../js/dates.js");
const K = require("../js/engine.js");

const setup = () => {
  const s = K.emptyState();
  s.accounts.push({ id: "bank", name: "給料口座", balance: 100000, includeInTotal: true });
  s.accounts.push({ id: "life", name: "生活費口座", balance: 20000, includeInTotal: true });
  s.accounts.push({ id: "paypay", name: "PayPay残高", balance: 5000, includeInTotal: false });
  s.accounts.push({ id: "fx", name: "FX口座", balance: 50000, includeInTotal: true });
  return s;
};

test("祝日：2026年の国民の休日・振替休日", () => {
  assert.equal(D.holidayName("2026-09-21"), "敬老の日");
  assert.equal(D.holidayName("2026-09-22"), "国民の休日");
  assert.equal(D.holidayName("2026-09-23"), "秋分の日");
  assert.equal(D.holidayName("2026-05-06"), "振替休日"); // 5/3 が日曜
  assert.equal(D.holidayName("2026-03-20"), "春分の日");
  assert.equal(D.holidayName("2026-09-24"), null);
});

test("営業日調整：土日祝の給料日は前営業日", () => {
  // 2026-10-25 は日曜 → 10/23(金)
  assert.equal(D.adjustBusinessDay("2026-10-25", "prev"), "2026-10-23");
  assert.equal(D.adjustBusinessDay("2026-10-25", "next"), "2026-10-26");
  assert.equal(K.nextPayday({ payday: 25, paydayAdjust: "prev" }, "2026-09-25"), "2026-09-25");
  assert.equal(K.nextPayday({ payday: 25, paydayAdjust: "prev" }, "2026-09-26"), "2026-10-23");
});

test("定期ルール：月2回・末日クランプ・隔月", () => {
  const r = { id: "r", days: [5, 31], adjust: "none", doneDates: [], startDate: "2026-01-01" };
  const occ = K.expandRecurrence(r, "2026-02-01", "2026-03-10").map((o) => o.date);
  assert.deepEqual(occ, ["2026-02-05", "2026-02-28", "2026-03-05"]);
  const bi = { id: "b", days: [10], adjust: "none", doneDates: [], intervalMonths: 2, startDate: "2026-01-10" };
  assert.deepEqual(K.expandRecurrence(bi, "2026-01-01", "2026-06-30").map((o) => o.date), ["2026-01-10", "2026-03-10", "2026-05-10"]);
});

test("予測：生活費は平日・休日単価、口座外（PayPay）は合計に影響しない", () => {
  const s = setup();
  Object.assign(s.settings, { livingAccountId: "life", weekdayCost: 1000, holidayCost: 3000, includeTodayLiving: true });
  s.recurrences.push({ id: "pp", label: "PayPay払い", amount: -4000, days: [27], accountId: "paypay", categoryId: "cat_bnpl", adjust: "none", doneDates: [] });
  // 2026-09-25(金), 26(土), 27(日)
  const f = K.forecast(s, { today: "2026-09-25", start: "2026-09-25", end: "2026-09-27" });
  assert.equal(f.startBalance, 170000);
  assert.deepEqual(f.days.map((d) => d.balance), [169000, 166000, 163000]);
  assert.equal(f.days[2].byAccount.paypay, 1000);
  assert.deepEqual(f.min, { date: "2026-09-27", balance: 163000 });
});

test("予測：雑費の日割りは月合計と一致する", () => {
  const s = setup();
  Object.assign(s.settings, { livingAccountId: "life", miscMonthly: 10000 });
  const ev = K.collectEvents(s, "2026-10-01", "2026-10-31", { today: "2026-10-01" });
  assert.equal(ev.filter((e) => e.source === "misc").reduce((a, e) => a + e.amount, 0), -10000);
});

test("予測：最低残高と閾値割れを検出", () => {
  const s = setup();
  s.settings.threshold = 20000;
  s.recurrences.push({ id: "rent", label: "寮費", amount: -150000, days: [27], accountId: "bank", categoryId: "cat_housing", adjust: "none", doneDates: [] });
  s.recurrences.push({ id: "sal", label: "給料", amount: 200000, days: [30], accountId: "bank", categoryId: "cat_salary", adjust: "none", doneDates: [] });
  const f = K.forecast(s, { today: "2026-09-25", start: "2026-09-25", end: "2026-10-05" });
  assert.deepEqual(f.min, { date: "2026-09-27", balance: 20000 });
  assert.equal(f.firstBelow, null);
  s.settings.threshold = 30000;
  const g = K.forecast(s, { today: "2026-09-25", start: "2026-09-25", end: "2026-10-05" });
  assert.equal(g.firstBelow.date, "2026-09-27");
});

test("定期ルールの『済』：残高に反映され、予測から外れる", () => {
  const s = setup();
  s.recurrences.push({ id: "yt", label: "YouTube Premium", amount: -1280, days: [25], accountId: "bank", categoryId: "cat_subsc", adjust: "none", doneDates: [] });
  K.completeOccurrence(s, "yt", "2026-09-25");
  assert.equal(K.accountById(s, "bank").balance, 98720);
  const f = K.forecast(s, { today: "2026-09-25", start: "2026-09-25", end: "2026-09-26" });
  assert.equal(f.events.length, 0);
  // 取り消すと元に戻る
  K.removeTransaction(s, s.transactions[0].id);
  assert.equal(K.accountById(s, "bank").balance, 100000);
  assert.equal(K.forecast(s, { today: "2026-09-25", start: "2026-09-25", end: "2026-09-26" }).events.length, 1);
});

test("定期ルールの1回分だけ金額を変更・スキップ", () => {
  const s = setup();
  s.recurrences.push({ id: "d", label: "d払い", amount: -5000, days: [26, 28], accountId: "bank", categoryId: "cat_bnpl", adjust: "none", doneDates: [] });
  K.overrideOccurrence(s, "d", "2026-09-26", { amount: -12340 });
  K.skipOccurrence(s, "d", "2026-09-28");
  const f = K.forecast(s, { today: "2026-09-25", end: "2026-09-30" });
  assert.deepEqual(f.events.map((e) => [e.date, e.amount, e.source]), [["2026-09-26", -12340, "planned"]]);
  assert.equal(K.accountById(s, "bank").balance, 100000);
});

test("振替：着金待ちは楽観/悲観の2パターン、着金済みで両口座に反映", () => {
  const s = setup();
  const t = K.addTransfer(s, { fromId: "fx", toId: "bank", amount: 30000, date: "2026-09-28", status: "pending" });
  assert.equal(K.accountById(s, "fx").balance, 20000);
  assert.equal(K.accountById(s, "bank").balance, 100000);
  const opt = K.forecast(s, { today: "2026-09-25", end: "2026-09-30", scenario: "optimistic" });
  const pes = K.forecast(s, { today: "2026-09-25", end: "2026-09-30", scenario: "pessimistic" });
  assert.equal(opt.endBalance - pes.endBalance, 30000);
  assert.ok(K.hasInFlightInScope(s, "total"));
  K.setTransferStatus(s, t.id, "done");
  assert.equal(K.accountById(s, "bank").balance, 130000);
  K.removeTransfer(s, t.id);
  assert.equal(K.accountById(s, "bank").balance, 100000);
  assert.equal(K.accountById(s, "fx").balance, 50000);
});

test("定期の振替：合計は変わらず、口座別に移動。済で残高に反映", () => {
  const s = setup();
  s.recurrences.push({ id: "mv", label: "生活費へ", amount: -40000, days: [26], accountId: "bank", toAccountId: "life", adjust: "none", doneDates: [] });
  const f = K.forecast(s, { today: "2026-09-25", end: "2026-09-27" });
  assert.equal(f.endBalance, f.startBalance);
  assert.equal(f.days[1].byAccount.life, 60000);
  const lifeOnly = K.forecast(s, { today: "2026-09-25", end: "2026-09-27", scope: ["life"] });
  assert.equal(lifeOnly.endBalance, 60000);
  K.overrideOccurrence(s, "mv", "2026-09-26", { amount: -30000 });
  assert.equal(K.forecast(s, { today: "2026-09-25", end: "2026-09-27", scope: ["life"] }).endBalance, 50000);
  K.completeOccurrence(s, "mv", "2026-09-26");
  assert.equal(K.accountById(s, "life").balance, 50000);
  assert.equal(K.accountById(s, "bank").balance, 70000);
  assert.equal(K.forecast(s, { today: "2026-09-25", end: "2026-09-27", scope: ["life"] }).endBalance, 50000);
  K.removeTransfer(s, s.transfers[0].id);
  assert.equal(K.accountById(s, "life").balance, 20000);
  assert.deepEqual(s.recurrences[0].doneDates, []);
});

test("振替：着金予定日超過でアラート", () => {
  const s = setup();
  K.addTransfer(s, { fromId: "fx", toId: "bank", amount: 30000, date: "2026-09-20", status: "requested" });
  const a = K.alerts(s, { today: "2026-09-25" });
  assert.ok(a.some((x) => x.kind === "overdue-transfer"));
});

test("What-if：仮の支出は反映されるが保存されない", () => {
  const s = setup();
  const w = [{ id: "w", date: "2026-09-26", amount: -30000, accountId: "bank", label: "イヤホン" }];
  const f = K.forecast(s, { today: "2026-09-25", end: "2026-09-27", whatIf: w });
  assert.equal(f.endBalance, 140000);
  assert.equal(s.transactions.length, 0);
});

test("給与：残業の時給換算と次回見込み", () => {
  const slips = [
    { payDate: "2026-08-25", gross: 300000, deductions: 60000, overtimeHours: 20, overtimePay: 40000 },
    { payDate: "2026-09-25", gross: 320000, deductions: 64000, overtimeHours: 30, overtimePay: 60000 },
  ];
  assert.deepEqual(K.overtimeRate(slips), { average: 2000, latest: 2000, samples: 2 });
  const est = K.estimateNextPay(slips, 10);
  assert.equal(est.baseGross, 260000);
  assert.equal(est.gross, 280000);
  assert.equal(est.deductions, 56000);
  assert.equal(est.net, 224000);
});

test("目標：必要な月間貯金額と予測ペース（臨時収入の除外）", () => {
  const s = setup();
  s.recurrences.push({ id: "sav", label: "給料", amount: 100000, days: [25], accountId: "bank", categoryId: "cat_salary", adjust: "none", doneDates: [] });
  s.transactions.push({ id: "fxp", accountId: "fx", date: "2026-12-01", amount: 120000, categoryId: K.WINDFALL, status: "planned", label: "FX利益" });
  const goal = { targetAmount: 8000000, targetDate: "2030-09-25", includeWindfall: false, accountIds: [] };
  const p = K.goalPlan(s, goal, { today: "2026-09-26" });
  assert.equal(p.current, 170000);
  assert.equal(p.windfallExcluded, 120000);
  assert.equal(p.forecastPace, 100000);
  assert.equal(p.onTrack, false);
  const p2 = K.goalPlan(s, Object.assign({}, goal, { includeWindfall: true }), { today: "2026-09-26" });
  assert.equal(p2.forecastPace, 110000);
});

test("カテゴリ集計：実績＋予定", () => {
  const s = setup();
  K.addTransaction(s, { accountId: "bank", date: "2026-09-10", amount: -5000, categoryId: "cat_bnpl", label: "d払い" });
  K.addTransaction(s, { accountId: "bank", date: "2026-09-11", amount: -2000, categoryId: "cat_bnpl", label: "PayPay後払い" });
  K.addTransaction(s, { accountId: "bank", date: "2026-09-12", amount: -8000, categoryId: "cat_telecom", label: "スマホ" });
  s.recurrences.push({ id: "yt", label: "YouTube", amount: -1280, days: [28], accountId: "bank", categoryId: "cat_subsc", adjust: "none", doneDates: [] });
  const sum = K.categorySummary(s, "2026-09-01", "2026-09-30", { today: "2026-09-25", includePlanned: true });
  assert.equal(sum.total, 16280);
  assert.equal(sum.groups[0].categoryId, "cat_telecom");
  assert.equal(sum.groups.find((g) => g.categoryId === "cat_bnpl").total, 7000);
});

test("確定申告アラート：臨時収入が年20万円超", () => {
  const s = setup();
  K.addTransaction(s, { accountId: "fx", date: "2026-03-01", amount: 150000, categoryId: K.WINDFALL, label: "FX利益" });
  K.addTransaction(s, { accountId: "fx", date: "2026-08-01", amount: 60000, categoryId: K.WINDFALL, label: "リベート" });
  assert.ok(K.alerts(s, { today: "2026-09-25" }).some((a) => a.kind === "tax" && a.level === "warning"));
});
