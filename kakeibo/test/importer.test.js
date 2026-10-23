const test = require("node:test");
const assert = require("node:assert/strict");
const K = require("../js/engine.js");
const I = require("../js/importer.js");

const setup = () => {
  const s = K.emptyState();
  s.accounts.push({ id: "hiro", name: "広島銀行", balance: 100000, includeInTotal: true });
  s.accounts.push({ id: "olive", name: "Olive", balance: 20000, includeInTotal: true });
  s.accounts.push({ id: "pp", name: "PayPay残高", balance: 3000, includeInTotal: false });
  Object.assign(s.settings, { salaryAccountId: "hiro", livingAccountId: "olive" });
  s.recurrences.push({ id: "ppl", label: "PayPayあと払い", amount: -9000, days: [27], accountId: "hiro", categoryId: "cat_bnpl", adjust: "next", doneDates: [] });
  return s;
};
const T = "2026-09-30";

test("日付の読み取り", () => {
  assert.equal(I.parseDate("2026/9/5", T), "2026-09-05");
  assert.equal(I.parseDate("2026年10月27日", T), "2026-10-27");
  assert.equal(I.parseDate("10/27", T), "2026-10-27");
  assert.equal(I.parseDate("12/28", "2027-01-05"), "2026-12-28");
  assert.equal(I.parseDate("", T), null);
});

test("CSVの分類：コードブロック・見出し・全角・引用符に強い", () => {
  const s = setup();
  const text = [
    "```csv",
    "種類,日付,金額,内容,口座,カテゴリ",
    "支出,2026-09-29,\"1,280\",セブンイレブン,olive,",
    "収入，2026-09-25，214000，給料，広島銀行，給与",
    "残高,2026-09-30,182345,,広島銀行,",
    "請求,2026-10-27,12340,PayPay後払い,,",
    "給与明細,2026-09-25,271000,57000,22,45100",
    "よくわからない行",
    "```",
  ].join("\n");
  const { rows, skipped } = I.parseImport(text, s, { today: T });
  assert.deepEqual(rows.map((r) => r.type), ["expense", "income", "balance", "bill", "payslip"]);
  assert.deepEqual(skipped, ["よくわからない行"]);
  const [exp, inc, bal, bill, slip] = rows;
  assert.equal(exp.amount, 1280);
  assert.equal(exp.accountId, "olive");
  assert.equal(exp.categoryId, "cat_living"); // 「セブン」から推測
  assert.equal(inc.categoryId, "cat_salary");
  assert.equal(bal.accountId, "hiro");
  assert.equal(bill.match.recurrenceId, "ppl"); // 「PayPay後払い」と「PayPayあと払い」の表記ゆれを吸収
  assert.equal(slip.gross, 271000);
  assert.ok(rows.every((r) => r.include));
});

test("取り込み：各種類がそれぞれの場所に入る", () => {
  const s = setup();
  const text = [
    "支出,2026-09-29,1280,セブンイレブン,Olive,生活費",
    "収入,2026-09-28,18000,FXリベート,広島銀行,",
    "残高,2026-09-30,150000,,広島銀行,",
    "請求,2026-10-27,12340,PayPayあと払い,,",
    "給与明細,2026-09-25,271000,57000,22,45100",
  ].join("\n");
  const { rows } = I.parseImport(text, s, { today: T });
  assert.equal(rows[1].categoryId, K.WINDFALL);
  const done = I.applyImport(s, rows, { today: T });
  assert.deepEqual(done, { expense: 1, income: 1, balance: 1, bill: 1, payslip: 1 });
  assert.equal(K.accountById(s, "olive").balance, 18720);
  // 残高は取り込んだ値ちょうどになる（その前の収入 +18000 も上書き）
  assert.equal(K.accountById(s, "hiro").balance, 150000);
  // 請求は定期ルールのその回を上書き
  const f = K.forecast(s, { today: T, end: "2026-10-31", scope: ["hiro"] });
  const ev = f.events.filter((e) => e.label === "PayPayあと払い");
  assert.deepEqual(ev.map((e) => [e.date, e.amount]), [["2026-10-27", -12340]]);
  // 給与明細は明細として登録。すでに9/25前後の給与実績がないので手取りを記録
  assert.equal(s.payslips.length, 1);
  assert.equal(s.payslips[0].net, 214000);
  assert.ok(s.transactions.some((t) => t.categoryId === "cat_salary" && t.amount === 214000));
});

test("重複・読めない行は取り込み対象から外す", () => {
  const s = setup();
  K.addTransaction(s, { accountId: "olive", date: "2026-09-29", amount: -1280, label: "コンビニ", categoryId: "cat_living" });
  const { rows } = I.parseImport("支出,2026-09-29,1280,セブン,Olive,\n支出,9/30,abc,何か,,\n残高,2026-09-30,5000,,不明な口座,", s, { today: T });
  assert.equal(rows[0].include, false);
  assert.match(rows[0].warnings[0], /同じ日・同じ金額/);
  assert.equal(rows[1].include, false);
  assert.equal(rows[2].include, false);
  assert.match(rows[2].warnings[0], /口座「不明な口座」/);
});

test("未来日付の支出は予定、給与の実績が既にあれば手取りは二重記録しない", () => {
  const s = setup();
  K.addTransaction(s, { accountId: "hiro", date: "2026-09-25", amount: 214000, label: "給与", categoryId: "cat_salary" });
  const { rows } = I.parseImport("支出,2026-10-15,38000,退去費,,臨時支出\n給与明細,2026-09-25,271000,57000,,", s, { today: T });
  I.applyImport(s, rows, { today: T });
  assert.equal(s.transactions.find((t) => t.label === "退去費").status, "planned");
  assert.equal(s.transactions.filter((t) => t.categoryId === "cat_salary").length, 1);
  assert.equal(K.accountById(s, "hiro").balance, 314000);
});

test("依頼文に口座・カテゴリ・今日の日付が入る", () => {
  const p = I.buildPrompt(setup(), { today: T });
  assert.match(p, /口座の候補: 広島銀行、Olive、PayPay残高/);
  assert.match(p, /請求のサービス名の候補: PayPayあと払い/);
  assert.match(p, /今日は2026-09-30です/);
});
