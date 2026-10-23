// 週ごとの定期ルール（毎週・N週ごと・曜日指定）と、生活費の「まとめ買い」のテスト。金額・口座名は架空
const test = require("node:test");
const assert = require("node:assert/strict");
const K = require("../js/engine.js");
const P = require("../js/periods.js");
const E = require("../js/edits.js");

const TODAY = "2026-10-12"; // 月曜

const setup = ({ weekday = 0, holiday = 0 } = {}) => {
  const s = K.emptyState();
  s.accounts.push({ id: "main", name: "テスト銀行", balance: 50000, includeInTotal: true });
  s.accounts.push({ id: "save", name: "テスト貯金", balance: 0, includeInTotal: false });
  Object.assign(s.settings, { livingAccountIds: ["main"], livingAccountId: "main", salaryAccountId: "main", weekdayCost: weekday, holidayCost: holiday });
  return s;
};
const bulk = (extra = {}) => Object.assign({
  id: "rec_bulk", label: "まとめ買い", amount: -4000, days: [1], weeks: 1, weekday: 6, adjust: "none",
  accountId: "main", categoryId: "cat_living", startDate: "2026-10-01", endDate: "", doneDates: [],
}, extra);

test("毎週土曜のルールは土曜だけに展開される", () => {
  const dates = K.expandRecurrence(bulk(), "2026-10-12", "2026-11-08").map((o) => o.date);
  assert.deepEqual(dates, ["2026-10-17", "2026-10-24", "2026-10-31", "2026-11-07"]);
});

test("2週ごとの月曜は開始日を起点に数え、終了日で止まる", () => {
  const r = bulk({ weeks: 2, weekday: 1, startDate: "2026-11-30", endDate: "2027-01-31" });
  assert.deepEqual(K.expandRecurrence(r, "2026-12-10", "2027-03-31").map((o) => o.date), ["2026-12-14", "2026-12-28", "2027-01-11", "2027-01-25"]);
});

test("週ごとのルールも休日の調整ができる（original は調整前の日付）", () => {
  // 2027-01-11 は成人の日（月曜）→ 翌営業日の火曜
  const r = bulk({ weeks: 1, weekday: 1, startDate: "2027-01-04", adjust: "next" });
  const out = K.expandRecurrence(r, "2027-01-10", "2027-01-12");
  assert.deepEqual(out, [{ date: "2027-01-12", original: "2027-01-11" }]);
});

test("まとめ買いは予測でその曜日にまとめて減る（日割り0円）", () => {
  const s = setup();
  s.recurrences.push(bulk());
  const f = K.forecast(s, { today: TODAY, end: "2026-10-24" });
  const at = (d) => f.days.find((x) => x.date === d).balance;
  assert.equal(at("2026-10-16"), 50000);
  assert.equal(at("2026-10-17"), 46000);
  assert.equal(at("2026-10-23"), 46000);
  assert.equal(at("2026-10-24"), 42000);
});

test("まとめ買いを「済」にしても、その日の日割り生活費は減らない（二重に差し引かない）", () => {
  const s = setup({ weekday: 500, holiday: 500 });
  s.recurrences.push(bulk({ weekday: 1 })); // 今日（月曜）がまとめ買いの日
  K.completeOccurrence(s, "rec_bulk", TODAY);
  const f = K.forecast(s, { today: TODAY, end: TODAY });
  const living = f.events.filter((e) => e.source === "living").reduce((a, e) => a + e.amount, 0);
  assert.equal(living, -500);
  assert.equal(f.events.filter((e) => e.source === "recurrence").length, 0);
});

test("毎週の振替（貯金）は出金元から入金先へ動く", () => {
  const s = setup();
  s.recurrences.push(bulk({ id: "rec_save", label: "毎週の貯金", amount: -1000, weekday: 1, categoryId: "", toAccountId: "save" }));
  const f = K.forecast(s, { today: TODAY, end: "2026-10-26", scope: ["main", "save"] });
  const last = f.days[f.days.length - 1].byAccount;
  assert.equal(last.main, 47000); // 10/12・10/19・10/26 の3回
  assert.equal(last.save, 3000);
});

test("給料期間の集計：生活費は日割り＋まとめ買い。済にした回も入る", () => {
  const s = setup({ weekday: 100, holiday: 100 });
  s.recurrences.push(bulk());
  const p = P.periodAt(s.settings, "2026-10-26"); // 10/23〜11/24
  const before = P.summarize(s, p.start, p.end);
  assert.equal(before.bulk, 5 * 4000); // 10/24・10/31・11/7・11/14・11/21
  assert.equal(before.living, before.livingDaily + before.bulk);
  assert.equal(before.livingDaily, before.days * 100);
  K.completeOccurrence(s, "rec_bulk", "2026-10-24");
  const after = P.summarize(s, p.start, p.end);
  assert.equal(after.bulk, before.bulk);
  assert.equal(after.total, before.total);
});

test("初期データ：weeks・weekday の定期ルールと、toOther の定期振替を読み込める", () => {
  P.loadInitial({
    settings: { weekdayCost: 0, holidayCost: 0 },
    recurrences: [
      { label: "まとめ買い", amount: -4000, weeks: 1, weekday: 6, categoryId: "cat_living", startDate: "2026-10-01" },
      { label: "毎週の貯金", amount: 1000, weeks: 1, weekday: 1, toOther: true, startDate: "2026-11-30" },
      { label: "サブスク", amount: -500, days: [24], categoryId: "cat_subsc", startDate: "2026-10-01" },
    ],
  });
  const s = setup();
  const res = P.applyInitialData(s, { mainId: "main", otherId: "save", today: TODAY });
  assert.equal(res.recurrences, 3);
  const save = s.recurrences.find((r) => r.label === "毎週の貯金");
  assert.equal(save.toAccountId, "save");
  assert.equal(save.amount, -1000);
  assert.equal(save.weeks, 1);
  assert.equal(K.expandRecurrence(save, "2026-11-01", "2026-12-08").map((o) => o.date).join(","), "2026-11-30,2026-12-07");
  // もう一度入れても重複しない
  assert.equal(P.applyInitialData(s, { mainId: "main", otherId: "save", today: TODAY }).recurrences, 0);
});

test("初期データ：週ごとのルールで曜日が正しくないと読み込まない", () => {
  assert.throws(() => P.loadInitial({ recurrences: [{ label: "x", amount: -1, weeks: 1, weekday: 7, startDate: "2026-10-01" }] }));
  assert.throws(() => P.loadInitial({ recurrences: [{ label: "x", amount: -1, weeks: 0, weekday: 6, startDate: "2026-10-01" }] }));
});

test("修正ファイル：週ごとのルールの1回分を金額変更できる", () => {
  const s = setup();
  s.recurrences.push(bulk());
  const r = E.apply(s, [{ action: "change", target: "まとめ買い", from: { date: "2026-10-17", amount: 4000 }, to: { amount: 3500 } }], { today: TODAY });
  assert.equal(r.count.change, 1);
  const f = K.forecast(s, { today: TODAY, end: "2026-10-17" });
  assert.equal(f.days[f.days.length - 1].balance, 46500);
});
