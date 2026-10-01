const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../js/dates.js");
const K = require("../js/engine.js");
const P = require("../js/periods.js");

const TODAY = "2026-10-01";
const setup = () => {
  const s = K.emptyState();
  s.accounts.push({ id: "main", name: "メイン口座", balance: 100000, includeInTotal: true });
  const res = P.applyInitialData(s, { mainId: "main", otherId: "", today: TODAY });
  return { s, res };
};

test("初期データ：給料日は10/23（10/25が日曜のため前の平日）", () => {
  const { s, res } = setup();
  assert.equal(K.paydayOfMonth(s.settings, "2026-10"), "2026-10-23");
  assert.equal(res.recurrences, 5);
  assert.equal(res.oneOffs, 9);
  assert.equal(s.accounts.find((a) => a.name === "別口座").includeInTotal, false);
});

test("祝日（10/12・11/3・11/23・1/1・1/11）は休日扱い", () => {
  const { s } = setup();
  ["2026-10-12", "2026-11-03", "2026-11-23", "2027-01-01", "2027-01-11"].forEach((d) => assert.ok(D.isDayOff(d, s.settings.extraHolidays), d));
});

test("別口座の3件は集計に入らず、カレンダー（月の予定）には出る", () => {
  const { s } = setup();
  const { items } = P.monthItems(s, "2026-10");
  const other = items.filter((i) => i.other).map((i) => i.date);
  assert.deepEqual(other, ["2026-10-05", "2026-10-07", "2026-10-15"]);
  const sum = P.summarize(s, "2026-10-01", "2026-10-22");
  assert.equal(sum.repay, 0);
  assert.equal(sum.fixed, 0);
});

test("予算枠 10/1〜10/22：平日15日・休日7日、生活費28,000円、雑費なしで9,797円余る", () => {
  const { s } = setup();
  const b = P.budgetMode(s, s.settings.budget);
  assert.equal(b.weekdays, 15);
  assert.equal(b.holidays, 7);
  assert.equal(b.living, 28000);
  assert.equal(b.diff, 9797);
  assert.equal(b.perDay, Math.floor(37797 / 22));
  // 雑費を含めると、給料期間(9/25〜10/22 の28日)のうち22日分を日割り
  const withMisc = P.budgetMode(s, Object.assign({}, s.settings.budget, { includeMisc: true }));
  assert.equal(withMisc.misc, Math.round((15000 * 22) / 28));
  assert.equal(withMisc.diff, 9797 - withMisc.misc);
});

test("給料期間ごとの集計が指示書の表と一致", () => {
  const { s } = setup();
  const rows = P.periodTable(s, { today: TODAY, count: 3 });
  const pick = (r) => [r.start, r.end, r.weekdays, r.holidays, r.income, r.living, r.misc, r.fixed, r.repay, r.total, r.saving, r.cumulative];
  assert.deepEqual(rows.map(pick), [
    ["2026-10-23", "2026-11-24", 21, 12, 180000, 44700, 15000, 15261, 22256, 97217, 82783, 82783],
    ["2026-11-25", "2026-12-24", 22, 8, 590000, 35400, 15000, 15261, 28510, 94171, 495829, 578612],
    ["2026-12-25", "2027-01-24", 16, 15, 200000, 48700, 15000, 15261, 20910, 99871, 100129, 678741],
  ]);
});

test("電気代は各給料期間に1回ずつ（10/23・11/25・12/25）", () => {
  const { s } = setup();
  const rows = P.periodTable(s, { today: TODAY, count: 3 });
  assert.deepEqual(rows.map((r) => r.items.filter((i) => i.label === "電気代").map((i) => i.date)), [["2026-10-23"], ["2026-11-25"], ["2026-12-25"]]);
});

test("初期データを2回入れても重複しない", () => {
  const { s } = setup();
  const again = P.applyInitialData(s, { mainId: "main", otherId: s.accounts.find((a) => a.name === "別口座").id, today: TODAY });
  assert.equal(again.recurrences, 0);
  assert.equal(again.oneOffs, 0);
  assert.equal(s.accounts.filter((a) => a.name === "別口座").length, 1);
});

test("今の給料期間を含める・給料日の上書き", () => {
  const { s } = setup();
  const rows = P.periodTable(s, { today: TODAY, count: 1, includeCurrent: true });
  assert.equal(rows[0].start, "2026-09-25");
  assert.equal(rows[0].end, "2026-10-22");
  // 11月の給料を 195,000 に上書き
  const rec = s.recurrences.find((r) => r.label === "給料");
  K.overrideOccurrence(s, rec.id, "2026-11-25", { amount: 195000 });
  assert.equal(P.periodTable(s, { today: TODAY, count: 2 })[1].income, 595000);
});

test("リボ返済シミュレーター", () => {
  assert.equal(P.revolving({ balance: "", payment: "" }), null);
  const r = P.revolving({ balance: 50000, payment: 5000, apr: 18, startMonth: "2026-11" });
  // 1回目：50,000 × 18% × 30 ÷ 365 = 739円
  assert.equal(r.rows[0].interest, 739);
  assert.equal(r.rows[0].principal, 4261);
  assert.equal(r.rows[r.rows.length - 1].balance, 0);
  assert.ok(r.totalInterest > 0);
  // 12月に一括返済
  const lump = P.revolving({ balance: 50000, payment: 5000, apr: 18, startMonth: "2026-11", lumpMonth: "2026-12" });
  assert.equal(lump.rows.length, 2);
  assert.equal(lump.rows[1].lump, true);
  assert.ok(lump.totalInterest < r.totalInterest);
  // 利息以下の返済額だと終わらない
  assert.equal(P.revolving({ balance: 1000000, payment: 10000, apr: 18, startMonth: "2026-11" }).neverEnds, true);
});
