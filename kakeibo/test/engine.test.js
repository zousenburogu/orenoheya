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

test("確定の取り消し：予定に戻り、残高も元に戻る", () => {
  const s = setup();
  const t = K.addTransaction(s, { accountId: "bank", date: "2026-09-30", amount: -38000, categoryId: "cat_extra", label: "退去費", status: "planned" });
  K.confirmTransaction(s, t.id);
  assert.equal(K.accountById(s, "bank").balance, 62000);
  K.unconfirmTransaction(s, t.id);
  assert.equal(K.accountById(s, "bank").balance, 100000);
  assert.equal(s.transactions[0].status, "planned");
  assert.equal(K.canUnconfirm(s.transactions[0]), false);
  // 「残高は更新済み」で確定した場合も残高は動かない
  K.confirmTransaction(s, t.id, { reflect: false });
  K.unconfirmTransaction(s, t.id);
  assert.equal(K.accountById(s, "bank").balance, 100000);
  // 手入力の実績は取り消し対象外（編集・削除で対応）
  const a = K.addTransaction(s, { accountId: "bank", date: "2026-09-28", amount: -500, label: "コーヒー" });
  assert.equal(K.canUnconfirm(a), false);
});

test("定期の『済』の取り消し：その回が予定として復活", () => {
  const s = setup();
  s.recurrences.push({ id: "yt", label: "YouTube", amount: -1280, days: [28], accountId: "bank", categoryId: "cat_subsc", adjust: "none", doneDates: [] });
  const t = K.completeOccurrence(s, "yt", "2026-09-28");
  assert.equal(K.accountById(s, "bank").balance, 98720);
  K.unconfirmTransaction(s, t.id);
  assert.equal(K.accountById(s, "bank").balance, 100000);
  assert.equal(s.transactions.length, 0);
  assert.equal(K.forecast(s, { today: "2026-09-28", end: "2026-09-29" }).events.length, 1);
});

test("今日の実績は予測に二重計上せず、今日の行に表示用として付く", () => {
  const s = setup();
  K.addTransaction(s, { accountId: "bank", date: "2026-09-28", amount: -7777, categoryId: "cat_extra", label: "今日の臨時" });
  K.addTransaction(s, { accountId: "paypay", date: "2026-09-28", amount: -500, categoryId: "cat_extra", label: "合計外" });
  const f = K.forecast(s, { today: "2026-09-28", end: "2026-09-30" });
  assert.equal(f.startBalance, 162223);
  assert.equal(f.days[0].balance, 162223);
  assert.deepEqual(f.days[0].actuals.map((t) => t.label), ["今日の臨時"]);
  assert.equal(f.days[1].actuals.length, 0);
});

test("未来日付の予定を支払済にすると今日の日付で計上、予定に戻すと元の日付に戻る", () => {
  const s = setup();
  const t = K.addTransaction(s, { accountId: "bank", date: "2026-09-30", amount: -25916, categoryId: "cat_extra", label: "臨時", status: "planned" });
  K.confirmTransaction(s, t.id, { today: "2026-09-28" });
  assert.equal(t.date, "2026-09-28");
  assert.equal(K.accountById(s, "bank").balance, 74084);
  K.unconfirmTransaction(s, t.id, "2026-09-28");
  assert.equal(t.date, "2026-09-30");
  assert.equal(t.status, "planned");
  assert.equal(K.accountById(s, "bank").balance, 100000);
});

test("未来日付の実績（旧データ）：今日の行に表示され、予定に戻せる", () => {
  const s = setup();
  const t = K.addTransaction(s, { accountId: "bank", date: "2026-09-30", amount: -25916, categoryId: "cat_extra", label: "臨時", status: "actual" });
  const f = K.forecast(s, { today: "2026-09-28", end: "2026-10-05" });
  assert.deepEqual(f.days[0].actuals.map((x) => x.label), ["臨時"]);
  assert.equal(f.startBalance, 144084);
  assert.equal(K.canUnconfirm(t, "2026-09-28"), true);
  K.unconfirmTransaction(s, t.id, "2026-09-28");
  const g = K.forecast(s, { today: "2026-09-28", end: "2026-10-05" });
  assert.equal(g.days[2].events[0].amount, -25916);
  assert.equal(g.days[2].balance, 144084);
});

test("金額欄の計算式", () => {
  const cases = [
    ["=1+2", 3], ["1+2", 3], ["12,000-3500", 8500], ["=(1200+800)*3", 6000], ["10000/3", 3333],
    ["２万＋３０００", 23000], ["=１５０００－２５００×２", 10000], ["1.5万", 15000], ["5千", 5000],
    ["25,916円", 25916], ["¥3,000", 3000], ["-500", -500], ["=-(100+50)", -150], ["300ー100", 200],
    ["", 0], ["  ", 0], ["=", 0], ["=1+", NaN], ["1/0", NaN], ["abc", NaN], ["(1+2", NaN], ["alert(1)", NaN],
  ];
  cases.forEach(([src, want]) => {
    const got = K.evalAmount(src);
    if (Number.isNaN(want)) assert.ok(Number.isNaN(got), `${src} -> ${got}`);
    else assert.equal(got, want, src);
  });
  assert.equal(K.isFormula("=1+2"), true);
  assert.equal(K.isFormula("2万"), true);
  assert.equal(K.isFormula("25,916"), false);
  assert.equal(K.isFormula("-500"), false);
});

test("目標：誕生日と何歳まで・いつからで期日と必要額を計算", () => {
  const s = setup();
  s.settings.birthday = "2000-05-12";
  assert.equal(K.ageOn("2000-05-12", "2026-09-30"), 26);
  assert.equal(K.ageOn("2000-05-12", "2030-05-11"), 29);
  assert.equal(K.ageOn("2000-05-12", "2030-05-12"), 30);
  assert.equal(K.birthdayAtAge("2000-02-29", 30), "2030-02-28");
  const goal = { targetAmount: 8000000, targetAge: 30, startDate: "", accountIds: [] };
  const p = K.goalPlan(s, goal, { today: "2026-09-30" });
  assert.equal(p.targetDate, "2030-05-12");
  assert.equal(p.startDate, "2026-09-30");
  assert.equal(p.ageNow, 26);
  assert.equal(p.targetAge, 30);
  // 貯め始めを先にすると期間が短くなり、月の必要額が増える
  const later = K.goalPlan(s, Object.assign({}, goal, { startDate: "2027-04-01" }), { today: "2026-09-30" });
  assert.equal(later.notStarted, true);
  assert.ok(later.months < p.months);
  assert.ok(later.requiredMonthly > p.requiredMonthly);
  // 年齢指定がなければ日付指定を使う（従来どおり）
  assert.equal(K.goalTargetDate({ targetDate: "2031-01-01" }, s.settings), "2031-01-01");
});

test("実績と見込みの二重計上をしない：今日の生活費・今月の雑費枠", () => {
  const s = setup();
  Object.assign(s.settings, { livingAccountId: "life", weekdayCost: 1000, holidayCost: 3000, miscMonthly: 10000, includeTodayLiving: true });
  // 2026-09-30(水)。今日すでに生活費 700円、今月の雑費 6,000円を使った
  K.addTransaction(s, { accountId: "life", date: "2026-09-30", amount: -700, categoryId: "cat_living", label: "コンビニ" });
  K.addTransaction(s, { accountId: "life", date: "2026-09-10", amount: -6000, categoryId: "cat_misc", label: "日用品" });
  const ev = K.collectEvents(s, "2026-09-30", "2026-10-31", { today: "2026-09-30" });
  const living930 = ev.filter((e) => e.source === "living" && e.date === "2026-09-30");
  assert.deepEqual(living930.map((e) => e.amount), [-300]); // 1,000 − 実績700
  const misc = (m) => ev.filter((e) => e.source === "misc" && e.date.startsWith(m)).reduce((a, e) => a + e.amount, 0);
  assert.equal(misc("2026-09"), -4000); // 10,000 − 実績6,000 を今日1日で
  assert.equal(misc("2026-10"), -10000); // 来月は枠どおり
  // 実績が見込みを超えたら、見込みは0（マイナスにはしない）
  K.addTransaction(s, { accountId: "life", date: "2026-09-30", amount: -5000, categoryId: "cat_misc", label: "服" });
  K.addTransaction(s, { accountId: "life", date: "2026-09-30", amount: -2000, categoryId: "cat_living", label: "外食" });
  const ev2 = K.collectEvents(s, "2026-09-30", "2026-09-30", { today: "2026-09-30" });
  assert.equal(ev2.filter((e) => e.source === "living" || e.source === "misc").length, 0);
});

test("記録のリマインダー：21時を過ぎて今日の記録がなければ知らせる", () => {
  const s = setup();
  const now = (time) => ({ date: "2026-09-30", time });
  assert.equal(s.settings.reminderTime, "21:00");
  assert.equal(K.needsReminder(s, now("20:59")), false);
  assert.equal(K.needsReminder(s, now("21:00")), true);
  // 今日の日付の実績を記録したら不要
  K.addTransaction(s, { accountId: "bank", date: "2026-09-30", amount: -500, label: "昼食", createdOn: "2026-09-30" });
  assert.equal(K.needsReminder(s, now("21:30")), false);
  // 「今日は使っていない」でも不要
  const s2 = setup();
  K.markNoSpend(s2, "2026-09-30");
  assert.equal(K.needsReminder(s2, now("22:00")), false);
  // 今日入力した未来の予定も「記録した」とみなす
  const s3 = setup();
  K.addTransaction(s3, { accountId: "bank", date: "2026-10-15", amount: -38000, status: "planned", createdOn: "2026-09-30" });
  assert.equal(K.recordedOn(s3, "2026-09-30"), true);
  // 時刻を空にするとリマインダーなし
  s.settings.reminderTime = "";
  assert.equal(K.needsReminder(setup(), now("23:00")), true);
});

test("着金したら着金待ちの比較は出なくなる（残高更新済みなら二重に足さない）", () => {
  const s = setup();
  const t = K.addTransfer(s, { fromId: "fx", toId: "bank", amount: 30000, date: "2026-10-02", status: "pending" });
  assert.equal(K.hasInFlightInScope(s, "total"), true);
  assert.equal(K.inFlightTotal(s, "total"), 30000);
  K.completeTransfer(s, t.id);
  assert.equal(K.hasInFlightInScope(s, "total"), false);
  assert.equal(K.inFlightTotal(s, "total"), 0);
  assert.equal(K.accountById(s, "bank").balance, 130000);
  // 残高を先に手で更新していた場合
  const s2 = setup();
  const t2 = K.addTransfer(s2, { fromId: "fx", toId: "bank", amount: 30000, date: "2026-10-02", status: "pending" });
  K.accountById(s2, "bank").balance = 130000;
  K.completeTransfer(s2, t2.id, { reflect: false });
  assert.equal(K.accountById(s2, "bank").balance, 130000);
  assert.equal(K.hasInFlightInScope(s2, "total"), false);
});

test("稼ぐ目安カレンダー：不足額を平日数で割り、額面・残業時間に換算", () => {
  const s = setup();
  s.payslips.push({ payDate: "2026-09-25", gross: 300000, deductions: 60000, net: 240000, overtimeHours: 20, overtimePay: 50000 });
  const goal = { targetAmount: 8000000, targetDate: "2030-05-12", accountIds: [], manualMonthlyPace: 100000 };
  const plan = K.goalPlan(s, goal, { today: "2026-09-30" });
  const cal = K.earningsCalendar(s, goal, { today: "2026-09-30", month: "2026-10", plan });
  // 2026年10月の平日：31日 − 土日9日 − スポーツの日(10/12) = 21日
  assert.equal(cal.workdays, 21);
  assert.equal(cal.gapMonthly, plan.gapMonthly);
  assert.equal(cal.perDayNet, Math.ceil(plan.gapMonthly / 21));
  assert.equal(cal.perDayGross, Math.ceil(cal.perDayNet / 0.8)); // 控除率20%
  assert.equal(cal.overtimeRate, 2500);
  assert.equal(cal.perDayHours, Math.ceil((cal.perDayGross / 2500) * 10) / 10);
  assert.equal(cal.days.find((d) => d.date === "2026-10-12").workday, false);
  assert.equal(cal.hasPrev, true); // 10月からは今月（9月）に戻れる
  assert.equal(cal.hasNext, true);
  assert.equal(K.earningsCalendar(s, goal, { today: "2026-09-30", month: "2026-09", plan }).hasPrev, false);
  // 給与明細がなければ額面・時間は出さない
  const s2 = setup();
  const cal2 = K.earningsCalendar(s2, goal, { today: "2026-09-30", month: "2026-10" });
  assert.equal(cal2.perDayGross, null);
  assert.equal(cal2.perDayHours, null);
  // 期日より後の平日は数えない
  const cal3 = K.earningsCalendar(s, goal, { today: "2026-09-30", month: "2030-05" });
  assert.equal(cal3.days.find((d) => d.date === "2030-05-13").workday, false);
  assert.equal(cal3.hasNext, false);
});

test("稼ぐ目安カレンダー：今月は月の平日すべてで割る（残り1日に不足を詰め込まない）", () => {
  const s = setup();
  const goal = { targetAmount: 8000000, targetDate: "2030-05-12", startDate: "2026-09-30", accountIds: [], manualMonthlyPace: 100000 };
  const cal = K.earningsCalendar(s, goal, { today: "2026-09-30", month: "2026-09" });
  // 2026年9月の平日：30日 − 土日8日 − 祝日3日(21,22,23) = 19日
  assert.equal(cal.workdays, 19);
  assert.equal(cal.perDayNet, Math.ceil(cal.gapMonthly / 19));
  assert.deepEqual(cal.days.filter((d) => d.target).map((d) => d.date), ["2026-09-30"]);
});

test("年収目標の稼ぐ目安（来年以降の月）：ボーナスを差し引いて月の平日で割る", () => {
  const s = setup();
  Object.assign(s.settings, { annualIncomeTarget: 4000000, baseMonthlyPay: 180000, annualBonus: 400000, payday: 25 });
  const cal = K.incomeCalendar(s, { today: "2026-09-30", month: "2027-02" });
  assert.equal(cal.thisYear, false);
  // (400万 − 40万) ÷ 12 = 30万 − 基本給18万 = 月12万。2027年2月の平日：28 − 土日8 − 祝日2(11,23) = 18日
  assert.equal(cal.extraMonthly, 120000);
  assert.equal(cal.workdays, 18);
  assert.equal(cal.perDayGross, Math.ceil(120000 / 18));
  // 明細がないときは基本給から残業単価を推定：180000 ÷ (8 × 20.4166…) × 1.25 ≒ 1,378
  assert.equal(cal.rateSource, "estimate");
  assert.equal(cal.overtimeRate, 1378);
});

test("年収目標の稼ぐ目安（今年）：もらった給料・残りの基本給・未受取ボーナスを反映", () => {
  const s = setup();
  Object.assign(s.settings, { annualIncomeTarget: 4000000, baseMonthlyPay: 180000, annualBonus: 400000, payday: 25, paydayAdjust: "none" });
  // 8月・9月は明細あり、7月は入金（手取り）だけ、1〜6月は記録なし（基本給で仮定）
  s.payslips.push({ payDate: "2026-08-25", gross: 250000, deductions: 50000, overtimeHours: 20, overtimePay: 40000 });
  s.payslips.push({ payDate: "2026-09-25", gross: 270000, deductions: 54000, overtimeHours: 30, overtimePay: 60000 });
  K.addTransaction(s, { accountId: "bank", date: "2026-07-25", amount: 200000, categoryId: "cat_salary", label: "給与" });
  K.addTransaction(s, { accountId: "bank", date: "2026-07-10", amount: 240000, categoryId: "cat_bonus", label: "夏のボーナス" });
  const ytd = K.incomeYearToDate(s, { today: "2026-09-30" });
  const src = Object.fromEntries(ytd.months.map((m) => [m.month, m.source]));
  assert.equal(src["2026-01"], "assumed");
  assert.equal(src["2026-07"], "deposit");
  assert.equal(src["2026-08"], "payslip");
  assert.equal(src["2026-10"], "future");
  assert.equal(ytd.deductionRate, 0.2);
  assert.equal(ytd.months.find((m) => m.month === "2026-07").gross, 250000); // 20万 ÷ 0.8
  assert.equal(ytd.bonusReceived, 300000); // 24万 ÷ 0.8
  const cal = K.incomeCalendar(s, { today: "2026-09-30", month: "2026-10" });
  const ytdGross = 180000 * 6 + 250000 + 250000 + 270000; // 1,850,000
  assert.equal(cal.ytd.gross, ytdGross);
  assert.equal(cal.remainingPaychecks, 3);
  assert.equal(cal.bonusRemaining, 100000);
  assert.equal(cal.extraNeeded, 4000000 - ytdGross - 300000 - 180000 * 3 - 100000); // 1,210,000
  // 今日(9/30)から年末までの平日：9月1 + 10月21 + 11月19 + 12月23(31日−土日8) = 64
  assert.equal(cal.remainingWorkdays, 64);
  assert.equal(cal.perDayGross, Math.ceil(1210000 / 64));
  assert.equal(cal.rateSource, "payslip");
  // 給料が増えると1日あたりが下がる
  s.payslips.find((p) => p.payDate === "2026-09-25").gross = 370000;
  assert.ok(K.incomeCalendar(s, { today: "2026-09-30", month: "2026-10" }).perDayGross < cal.perDayGross);
});