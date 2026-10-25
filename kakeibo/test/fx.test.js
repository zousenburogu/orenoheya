// FXの記録（日ごとの損益・リベート）、第N曜日の定期ルール、修正ファイルの transfer・add-recurrence・fx のテスト。金額・口座名は架空
const test = require("node:test");
const assert = require("node:assert/strict");
const K = require("../js/engine.js");
const P = require("../js/periods.js");
const E = require("../js/edits.js");

const TODAY = "2026-10-25"; // 日曜

const setup = () => {
  const s = K.emptyState();
  s.accounts.push({ id: "bank", name: "テスト銀行", balance: 100000, includeInTotal: true, balanceSet: true });
  s.accounts.push({ id: "fx", name: "テストFX口座", balance: 0, includeInTotal: true, balanceSet: true });
  Object.assign(s.settings, { livingAccountIds: ["bank"], livingAccountId: "bank", salaryAccountId: "bank" });
  return s;
};

/* ---------- 第N曜日 ---------- */

test("第N曜日：第1金曜・最終金曜を返し、第5がない月は null", () => {
  assert.equal(K.nthWeekdayOfMonth(2026, 11, 1, 5), "2026-11-06");
  assert.equal(K.nthWeekdayOfMonth(2026, 12, 1, 5), "2026-12-04");
  assert.equal(K.nthWeekdayOfMonth(2026, 12, -1, 5), "2026-12-25");
  assert.equal(K.nthWeekdayOfMonth(2026, 11, 4, 0), "2026-11-22");
});

test("第N曜日のルール：毎月の第1金曜に展開し、休日は翌営業日にずらす（original は元の日）", () => {
  const r = { id: "r", label: "電気代テスト", amount: -9000, days: [1], nth: 1, weekday: 5, adjust: "next", intervalMonths: 1, accountId: "bank", categoryId: "cat_fixed", startDate: "2026-11-01", endDate: "", doneDates: [] };
  const occ = K.expandRecurrence(r, "2026-10-01", "2027-02-28", {});
  assert.deepEqual(occ.map((o) => o.date), ["2026-11-06", "2026-12-04", "2027-01-04", "2027-02-05"]);
  assert.equal(occ[2].original, "2027-01-01");
  assert.ok(K.isNthWeekday(r));
  // 保存・読み込みしても残り、不正な nth は消える
  const s = K.normalizeState({ recurrences: [r, Object.assign({}, r, { id: "bad", nth: 9 })] });
  assert.equal(s.recurrences[0].nth, 1);
  assert.equal(s.recurrences[1].nth, undefined);
});

/* ---------- FXの記録 ---------- */

test("FXの記録：FX口座の残高が動き、支出・期間の集計には入らず、合計と1日平均を出す", () => {
  const s = setup();
  K.addFxDay(s, { date: "2026-10-22", pl: 40000 });
  K.addFxDay(s, { date: "2026-10-23", pl: 7000, rebate: 9000 });
  K.addFxDay(s, { date: "2026-10-24", pl: -30000, rebate: 2000 });
  K.addFxDay(s, { date: "2026-10-25", pl: 35000, rebate: 10000, reflected: true });
  assert.equal(K.accountById(s, "fx").balance, 40000 + 16000 - 28000);
  const f = K.fxSummary(s, { today: TODAY });
  assert.deepEqual([f.start, f.dayCount, f.total, f.pl, f.rebate, f.average, f.yearTotal], ["2026-10-22", 4, 73000, 52000, 21000, 18250, 73000]);
  assert.deepEqual(f.days.map((d) => d.total), [40000, 16000, -28000, 45000]);
  // 損失は支出のカテゴリ集計に出ない
  assert.equal(K.categorySummary(s, "2026-10-01", "2026-10-31", { today: TODAY }).total, 0);
  // 給料期間の集計（収入）にも入らない
  assert.ok(!P.periodItems(s, "2026-10-01", "2026-10-31").some((i) => /FX/.test(i.label)));
  // 起点日を変えると日数と平均が変わる
  s.settings.fxStartDate = "2026-10-24";
  const g = K.fxSummary(s, { today: TODAY });
  assert.deepEqual([g.dayCount, g.total, g.average], [2, 17000, 8500]);
  // その日の記録を消すと残高も戻る（反映済みの分は動かない）
  K.removeFxDay(s, "2026-10-24");
  assert.equal(K.accountById(s, "fx").balance, 40000 + 16000);
  assert.equal(K.fxAccountId(s), "fx");
});

/* ---------- 修正ファイル: transfer ---------- */

test("transfer：着金済みは両方の残高、着金待ちは出金元だけ動く。reflected で反映済みの側は動かさない", () => {
  const s = setup();
  s.accounts[1].balance = 200000;
  const r = E.apply(s, [
    { action: "transfer", date: "2026-10-22", amount: 50000, from: "テスト銀行", to: "テストFX口座", label: "FX入金" },
    { action: "transfer", date: "2026-10-23", amount: 30000, from: "テスト銀行", to: "テストFX口座", label: "FX入金", reflected: "from" },
    { action: "transfer", date: "2026-10-27", amount: 60000, from: "テストFX口座", to: "テスト銀行", label: "FX出金", status: "着金待ち" },
    { action: "transfer", date: "2026-10-26", amount: 1000, from: "テストFX口座", to: "テスト銀行", status: "着金待ち", reflected: "from" },
    { action: "transfer", date: "2026-10-24", amount: 7000, from: "テストFX口座", to: "テスト銀行", reflected: "both" },
    { action: "transfer", date: "2026-10-22", amount: 50000, from: "テスト銀行", to: "テストFX口座" },
    { action: "transfer", date: "2026-10-22", amount: 10, from: "テスト銀行", to: "テスト銀行" },
    { action: "transfer", date: "2026-10-22", amount: 10, from: "テスト銀行", to: "ないQQQ" },
    { action: "transfer", date: "2026-10-22", amount: 10, from: "テスト銀行", to: "テストFX口座", status: "途中" },
    { action: "transfer", date: "2026-10-22", amount: 10, from: "テスト銀行", to: "テストFX口座", reflected: "right" },
  ], { today: TODAY });
  assert.deepEqual(r.items.map((i) => i.status), ["ok", "ok", "ok", "ok", "ok", "skip", "fail", "fail", "fail", "fail"]);
  assert.deepEqual(r.count, { account: 0, add: 5, change: 0, delete: 0, skip: 1, fail: 4 });
  // 銀行：−50,000（1行目）。2行目は反映済み。着金待ちはまだ入らない
  assert.equal(K.accountById(s, "bank").balance, 50000);
  // FX：+50,000 +30,000 −60,000 −0（4行目は反映済み）
  assert.equal(K.accountById(s, "fx").balance, 200000 + 80000 - 60000);
  const pend = s.transfers.find((x) => x.amount === 60000);
  assert.equal(pend.status, "pending");
  assert.equal(K.inFlightTotal(s, ["bank"]), 61000);
  // 着金済みにすると銀行に入る
  K.completeTransfer(s, pend.id);
  assert.equal(K.accountById(s, "bank").balance, 110000);
  assert.equal(s.transfers.find((x) => x.amount === 7000).noBalance, true);
});

/* ---------- 修正ファイル: add-recurrence ---------- */

test("add-recurrence：給料日・第N曜日・日にち・週ごと・振替のルールを作り、同じルールはスキップ、単発の予定が残っていれば知らせる", () => {
  const s = setup();
  K.addTransaction(s, { accountId: "bank", date: "2026-11-24", amount: -1500, categoryId: "cat_subsc", label: "動画サブスク", status: "planned" });
  const r = E.apply(s, [
    { action: "add-recurrence", label: "給料テスト", type: "income", amount: 200000, account: "テスト銀行", category: "給与", payday: true, start: "2026-11-01" },
    { action: "add-recurrence", label: "電気代テスト", type: "expense", amount: 10000, account: "テスト銀行", category: "固定費", nth: 1, weekday: "金", adjust: "翌営業日", start: "2026-11-01" },
    { action: "add-recurrence", label: "動画サブスク", type: "expense", amount: 1500, account: "テスト銀行", category: "サブスク", day: 24, start: "2026-11-01" },
    { action: "add-recurrence", label: "後払いテスト", type: "expense", amount: 3000, category: "返済", days: [27], start: "2026-11-01", end: "2027-03-27" },
    { action: "add-recurrence", label: "週の積立テスト", type: "transfer", amount: 10000, account: "テスト銀行", to: "テストFX口座", weeks: 1, weekday: 1, start: "2026-10-26" },
    { action: "add-recurrence", label: "給料テスト", type: "income", amount: 200000, account: "テスト銀行", payday: true },
    { action: "add-recurrence", label: "日なし", type: "expense", amount: 100 },
    { action: "add-recurrence", label: "第9", type: "expense", amount: 100, nth: 9, weekday: 5 },
    { action: "add-recurrence", label: "曜日不正", type: "expense", amount: 100, weeks: 1, weekday: "月火" },
    { action: "add-recurrence", label: "種類不正", type: "gift", amount: 100, day: 1 },
  ], { today: TODAY });
  assert.deepEqual(r.items.map((i) => i.status), ["ok", "ok", "ok", "ok", "ok", "skip", "fail", "fail", "fail", "fail"]);
  assert.equal(s.recurrences.length, 5);
  const [pay, elec, sub, bnpl, weekly] = s.recurrences;
  assert.deepEqual([pay.onPayday, pay.amount, pay.categoryId], [true, 200000, "cat_salary"]);
  assert.deepEqual([elec.nth, elec.weekday, elec.adjust, elec.amount, elec.categoryId], [1, 5, "next", -10000, "cat_fixed"]);
  assert.deepEqual([sub.days, sub.categoryId], [[24], "cat_subsc"]);
  assert.deepEqual([bnpl.accountId, bnpl.endDate, bnpl.categoryId], ["bank", "2027-03-27", "cat_repay"]);
  assert.deepEqual([weekly.weeks, weekly.weekday, weekly.toAccountId], [1, 1, "fx"]);
  assert.ok(r.items[2].notes.some((n) => /単発の予定が1件/.test(n)));
  assert.ok(r.items[3].notes.some((n) => /口座の指定がない/.test(n)));
  // 予測に出る（給料日・第1金曜）
  const ev = K.collectEvents(s, TODAY, "2026-12-31", { today: TODAY }).filter((e) => e.source === "recurrence");
  assert.ok(ev.some((e) => e.label === "給料テスト" && e.date === "2026-11-25"));
  assert.ok(ev.some((e) => e.label === "電気代テスト" && e.date === "2026-12-04"));
  // 1回分の上書き（change）も使える
  const c = E.apply(s, [{ action: "change", target: "電気代テスト", from: { date: "2027-01-04", amount: 10000 }, to: { date: "2027-01-08" } }], { today: TODAY });
  assert.equal(c.items[0].status, "ok");
  assert.ok(s.transactions.some((x) => x.label === "電気代テスト" && x.date === "2027-01-08" && x.occurrenceDate === "2027-01-01"));
});

/* ---------- 修正ファイル: fx ---------- */

test("fx：FX口座に記録し、同じ内容はスキップ、違う内容・未来・0 はエラー", () => {
  const s = setup();
  const r = E.apply(s, [
    { action: "fx", date: "2026-10-24", pl: -30000, rebate: 2000 },
    { action: "fx", date: "2026-10-25", pl: "35,000", rebate: 10000, account: "テストFX口座" },
    { action: "fx", date: "2026-10-24", pl: -30000, rebate: 2000 },
    { action: "fx", date: "2026-10-24", pl: 100 },
    { action: "fx", date: "2026-10-26", pl: 100 },
    { action: "fx", date: "2026-10-20", pl: 0, rebate: 0 },
    { action: "fx", date: "2026-10-20", pl: 10, account: "ないQQQ" },
  ], { today: TODAY });
  assert.deepEqual(r.items.map((i) => i.status), ["ok", "ok", "skip", "fail", "fail", "fail", "fail"]);
  assert.equal(r.count.add, 2);
  assert.equal(K.accountById(s, "fx").balance, -28000 + 45000);
  assert.deepEqual(K.fxSummary(s, { today: TODAY }).days.map((d) => [d.date, d.pl, d.rebate]), [["2026-10-24", -30000, 2000], ["2026-10-25", 35000, 10000]]);
});

/* ---------- 着金額の差・着金待ちのアラート ---------- */

test("着金した：実際の額が違えば差を入金先に記録し、FX口座からならFXの損益に入る", () => {
  const s = setup();
  s.accounts[1].balance = 100000;
  const a = K.addTransfer(s, { fromId: "fx", toId: "bank", amount: 60000, date: "2026-10-27", status: "pending", label: "FX出金" });
  const b = K.addTransfer(s, { fromId: "bank", toId: "fx", amount: 1000, date: "2026-10-27", status: "pending", label: "テスト" });
  assert.equal(K.accountById(s, "fx").balance, 100000 - 60000 + 0);
  K.completeTransfer(s, a.id, { actualAmount: 59800, today: "2026-10-27" });
  assert.equal(K.accountById(s, "bank").balance, 100000 - 1000 + 59800);
  const diff = s.transactions.find((t) => /着金額の差/.test(t.label));
  assert.deepEqual([diff.amount, diff.fx, diff.accountId, diff.date], [-200, "pl", "bank", "2026-10-27"]);
  assert.equal(K.fxSummary(s, { today: "2026-10-27", start: "2026-10-27" }).total, -200);
  // 同じ額なら差は記録しない。FX口座以外からなら fx にしない
  K.completeTransfer(s, b.id, { actualAmount: 1100, today: "2026-10-27" });
  const d2 = s.transactions.filter((t) => /着金額の差/.test(t.label))[1];
  assert.deepEqual([d2.amount, d2.fx, d2.categoryId], [100, undefined, K.WINDFALL]);
  // 残高はもう更新した場合は、差も残高を動かさない
  const c = K.addTransfer(s, { fromId: "fx", toId: "bank", amount: 500, date: "2026-10-27", status: "pending", label: "FX出金" });
  const before = K.accountById(s, "bank").balance;
  K.completeTransfer(s, c.id, { reflect: false, actualAmount: 480, today: "2026-10-27" });
  assert.equal(K.accountById(s, "bank").balance, before);
  assert.equal(s.transactions.filter((t) => /着金額の差/.test(t.label)).length, 3);
});

test("アラート：着金待ちは入る前提で判定し、入らないとマイナスになるときはお知らせだけ出す", () => {
  const s = setup();
  s.accounts[0].balance = 3000;
  s.accounts[1].balance = 50000;
  K.addTransaction(s, { accountId: "bank", date: "2026-10-27", amount: -3500, categoryId: "cat_repay", label: "後払いテスト", status: "planned" });
  K.addTransfer(s, { fromId: "fx", toId: "bank", amount: 50000, date: "2026-10-26", status: "pending", label: "FX出金" });
  const al = K.alerts(s, { today: TODAY });
  assert.ok(!al.some((a) => a.kind === "negative"));
  const info = al.find((a) => a.kind === "inflight-risk");
  assert.equal(info.level, "info");
  assert.match(info.message, /入らなかった場合/);
  // 着金予定日を過ぎると「未着金」も出る
  assert.ok(K.alerts(s, { today: "2026-10-28" }).some((a) => a.kind === "overdue-transfer"));
});
