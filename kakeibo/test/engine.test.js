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

test("立て替え口座：残高が足りない支出の不足分を順に別口座から払う", () => {
  const s = setup();
  s.settings.livingAccountIds = [];
  s.settings.livingAccountId = "";
  s.accounts.find((a) => a.id === "bank").balance = 10000;
  s.accounts.find((a) => a.id === "life").balance = 5000;
  const w = [{ id: "w", date: "2026-09-26", amount: -30000, accountId: "bank", label: "家電" }];
  const none = K.forecast(s, { today: "2026-09-25", end: "2026-09-27", whatIf: w });
  assert.equal(none.days[1].byAccount.bank, -20000);
  K.setCoverAccounts(s, ["life", "fx"]);
  const f = K.forecast(s, { today: "2026-09-25", end: "2026-09-27", whatIf: w });
  const d = f.days[1].byAccount;
  assert.equal(d.bank, 0);
  assert.equal(d.life, 0);
  assert.equal(d.fx, 35000);
  assert.equal(f.endBalance, none.endBalance);
  assert.equal(f.days[1].events.length, 3);
  K.setCoverAccounts(s, ["life"]);
  assert.equal(K.forecast(s, { today: "2026-09-25", end: "2026-09-27", whatIf: w }).days[1].byAccount.bank, -15000);
});

test("What-if：仮の支出は反映されるが保存されない", () => {
  const s = setup();
  const w = [{ id: "w", date: "2026-09-26", amount: -30000, accountId: "bank", label: "イヤホン" }];
  const f = K.forecast(s, { today: "2026-09-25", end: "2026-09-27", whatIf: w });
  assert.equal(f.endBalance, 140000);
  assert.equal(s.transactions.length, 0);
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

test("確定申告アラートは出さない（臨時収入が年20万円を超えても）", () => {
  const s = setup();
  K.addTransaction(s, { accountId: "fx", date: "2026-03-01", amount: 150000, categoryId: K.WINDFALL, label: "FX利益" });
  K.addTransaction(s, { accountId: "fx", date: "2026-08-01", amount: 60000, categoryId: K.WINDFALL, label: "リベート" });
  assert.ok(!K.alerts(s, { today: "2026-09-25" }).some((a) => a.kind === "tax"));
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

test("生活費を複数口座から払う：残高がなくなったら次の口座、全部なくなったら警告", () => {
  const s = setup(); // bank 100,000 / life 20,000 / paypay 5,000(合計外) / fx 50,000
  K.setLivingAccounts(s, ["paypay", "life"]);
  Object.assign(s.settings, { weekdayCost: 3000, holidayCost: 3000, miscMonthly: 0 });
  assert.equal(s.settings.livingAccountId, "paypay");
  // 1回分を払えない口座はギリギリまで使わず、次の口座へ移る
  const f = K.forecast(s, { today: "2026-10-01", end: "2026-10-07" });
  assert.equal(f.days[0].byAccount.paypay, 2000); // 1日目は PayPay
  assert.equal(f.days[1].byAccount.paypay, 2000); // 2日目は残り 2,000 で払えないので生活費口座へ
  assert.equal(f.days[1].byAccount.life, 17000);
  const day2 = f.days[1].events.filter((e) => e.source === "living");
  assert.deepEqual(day2.map((e) => [e.accountId, e.amount]), [["life", -3000]]);
  assert.equal(f.livingShortage, null);
  // 生活費口座も 6日分（18,000）で残り 2,000 → 8日目は払える口座がなく不足
  const g = K.forecast(s, { today: "2026-10-01", end: "2026-10-20" });
  assert.equal(g.livingShortage.date, "2026-10-08");
  assert.ok(K.alerts(s, { today: "2026-10-01" }).some((a) => a.kind === "living-shortage"));
  // 以前の1口座の設定は自動で移る
  const old = K.normalizeState({ settings: { livingAccountId: "x" } });
  assert.deepEqual(old.settings.livingAccountIds, ["x"]);
});

test("残高のない口座はエラー", () => {
  const s = setup();
  K.accountById(s, "paypay").balance = 0;
  assert.match(K.balanceError(s, "paypay", 100), /残高がありません/);
  assert.match(K.balanceError(s, "life", 30000), /残高（¥20,000）が足りません/);
  assert.equal(K.balanceError(s, "life", 20000), null);
});

test("残高調整はカテゴリ分析に出ない", () => {
  const s = setup();
  K.addTransaction(s, { accountId: "bank", date: "2026-10-01", amount: -3000, categoryId: "cat_other", label: "残高調整", balanceAlreadyReflected: true, adjustment: true });
  K.addTransaction(s, { accountId: "bank", date: "2026-10-01", amount: -500, categoryId: "cat_other", label: "ガム" });
  const c = K.categorySummary(s, "2026-10-01", "2026-10-31", { today: "2026-10-01" });
  assert.equal(c.total, 500);
});

test("バックアップの促し：書き出しから7日で表示、書き出すと消える", () => {
  const s = setup();
  assert.equal(K.backupStatus(s, "2026-10-01").due, false); // 使い始めの日が未設定
  s.settings.backupSince = "2026-10-01";
  assert.equal(K.backupStatus(s, "2026-10-07").due, false);
  const b = K.backupStatus(s, "2026-10-08");
  assert.equal(b.due, true);
  assert.equal(b.exported, false);
  s.settings.lastExportOn = "2026-10-08";
  assert.equal(K.backupStatus(s, "2026-10-14").due, false);
  assert.equal(K.backupStatus(s, "2026-10-15").due, true);
  assert.equal(K.backupStatus(K.emptyState(), "2026-10-20").due, false);
});

test("updateTransfer：日付とメモだけ変わり、口座の残高は動かない", () => {
  const s = K.emptyState();
  s.accounts.push({ id: "fx", name: "テストFX", balance: 50000, includeInTotal: true, balanceSet: true });
  s.accounts.push({ id: "bank", name: "テスト銀行", balance: 10000, includeInTotal: true, balanceSet: true });
  const t = K.addTransfer(s, { fromId: "fx", toId: "bank", amount: 30000, date: "2026-10-02", status: "pending", label: "出金" });
  assert.deepEqual(s.accounts.map((a) => a.balance), [20000, 10000]);
  K.updateTransfer(s, t.id, { date: "2026-10-05", label: "  FX出金テスト " });
  assert.deepEqual([t.date, t.label, t.status, t.amount], ["2026-10-05", "FX出金テスト", "pending", 30000]);
  assert.deepEqual(s.accounts.map((a) => a.balance), [20000, 10000]);
  assert.equal(K.updateTransfer(s, "nope", { date: "2026-10-06" }), null);
  K.completeTransfer(s, t.id);
  assert.deepEqual(s.accounts.map((a) => a.balance), [20000, 40000]);
});
