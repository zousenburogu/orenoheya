const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../js/dates.js");
const K = require("../js/engine.js");
const P = require("../js/periods.js");
P.loadInitial(require("./fixtures/initial-data.json"));

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
  assert.equal(res.oneOffs, 10);
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

test("予算枠 10/1〜10/22：平日15日・休日7日、生活費36,000円、雑費なしで6,000円足りない", () => {
  const { s } = setup();
  const b = P.budgetMode(s, s.settings.budget);
  assert.equal(b.weekdays, 15);
  assert.equal(b.holidays, 7);
  assert.equal(b.living, 36000);
  assert.equal(b.diff, -6000);
  assert.equal(b.perDay, Math.floor(30000 / 22));
  // 雑費を含めると、給料期間(9/25〜10/22 の28日)のうち22日分を日割り
  const withMisc = P.budgetMode(s, Object.assign({}, s.settings.budget, { includeMisc: true }));
  assert.equal(withMisc.misc, Math.round((10000 * 22) / 28));
  assert.equal(withMisc.diff, -6000 - withMisc.misc);
});

test("給料期間ごとの集計が初期データどおり", () => {
  const { s } = setup();
  const rows = P.periodTable(s, { today: TODAY, count: 3 });
  const pick = (r) => [r.start, r.end, r.weekdays, r.holidays, r.income, r.living, r.misc, r.fixed, r.repay, r.total, r.saving, r.cumulative];
  assert.deepEqual(rows.map(pick), [
    ["2026-10-23", "2026-11-24", 21, 12, 200000, 57000, 10000, 14000, 15000, 96000, 104000, 104000],
    ["2026-11-25", "2026-12-24", 22, 8, 510000, 46000, 10000, 14000, 19000, 89000, 421000, 525000],
    ["2026-12-25", "2027-01-24", 16, 15, 220000, 61000, 10000, 14000, 15000, 100000, 120000, 645000],
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
  // 11月の給料を 215,000 に上書き
  const rec = s.recurrences.find((r) => r.label === "給料");
  K.overrideOccurrence(s, rec.id, "2026-11-25", { amount: 215000 });
  assert.equal(P.periodTable(s, { today: TODAY, count: 2 })[1].income, 515000);
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

test("まっさらにして初期データ：未記入（残高）と仮・概算をチェックリストに出す", () => {
  const { state: s, added } = P.freshStart({ today: TODAY });
  assert.equal(s.accounts.length, 2);
  assert.equal(added.recurrences, 5);
  assert.equal(added.oneOffs, 10);
  assert.equal(s.transactions.filter((t) => t.status === "actual").length, 0);
  // 集計は初期データどおり
  const rows = P.periodTable(s, { today: TODAY, count: 3 });
  assert.deepEqual(rows.map((r) => r.cumulative), [104000, 525000, 645000]);
  const list = P.setupChecklist(s, { today: TODAY });
  assert.deepEqual(list.filter((x) => x.level === "required").map((x) => x.text), ["「メイン口座」の今の残高", "「別口座」の今の残高"]);
  const tent = list.find((x) => x.key === "tentative");
  assert.equal(tent.items.length, 5); // 電気代・後払い×3・ボーナス
  assert.deepEqual(list.filter((x) => x.level === "optional").map((x) => x.key), ["annualBonus", "goal", "payslip"]);
  // 残高を入れる・概算を直す・任意を「使わない」にすると消える
  s.accounts.forEach((a) => (a.balanceSet = true));
  s.transactions.forEach((t) => delete t.tentative);
  s.recurrences.forEach((r) => delete r.tentative);
  s.settings.dismissedSetup = ["annualBonus", "goal", "payslip"];
  assert.deepEqual(P.setupChecklist(s, { today: TODAY }), []);
});

test("10/5 の入金（メイン口座・確定）", () => {
  const { s } = setup();
  const t = s.transactions.find((x) => x.date === "2026-10-05" && x.amount > 0);
  assert.equal(t.amount, 20000);
  assert.equal(t.accountId, "main");
  assert.equal(t.status, "planned");
  assert.equal(t.tentative, undefined);
  // 今の給料期間（9/25〜10/22）の収入に入り、10/23 からの表は指示書どおり
  assert.equal(P.periodTable(s, { today: TODAY, count: 1, includeCurrent: true })[0].income, 20000);
  assert.equal(P.periodTable(s, { today: TODAY, count: 3 })[2].cumulative, 645000);
  // 残高予測にも 10/5 に +27,853 で入る
  const f = K.forecast(s, { today: TODAY, end: "2026-10-06", scope: ["main"] });
  assert.ok(f.days.find((d) => d.date === "2026-10-05").events.some((e) => e.amount === 20000));
});

test("初期データのJSON：形式が正しくないと読み込めない", () => {
  assert.throws(() => P.loadInitial(null));
  assert.throws(() => P.loadInitial({ recurrences: [], oneOffs: [] }));
  assert.throws(() => P.loadInitial({ oneOffs: [{ label: "x", amount: "あ", date: "2026-10-01" }] }));
  assert.throws(() => P.loadInitial({ oneOffs: [{ label: "x", amount: 100, date: "10/1" }] }));
  // 設定は決まった項目だけ取り込む
  const got = P.loadInitial({ settings: { weekdayCost: 500, evil: 1 }, oneOffs: [{ label: "x", amount: 100, date: "2026-10-01" }] });
  assert.deepEqual(got.settings, { weekdayCost: 500 });
  P.loadInitial(require("./fixtures/initial-data.json"));
});
