const test = require("node:test");
const assert = require("node:assert/strict");
const K = require("../js/engine.js");
const E = require("../js/edits.js");

const TODAY = "2026-10-01";

// 架空のデータ
const setup = () => {
  const s = K.emptyState();
  s.accounts.push({ id: "main", name: "テスト給料口座", balance: 100000, includeInTotal: true, balanceSet: true });
  s.accounts.push({ id: "sub", name: "テスト別口座", balance: 5000, includeInTotal: false, balanceSet: true });
  s.settings.salaryAccountId = "main";
  s.settings.livingAccountIds = ["main"];
  s.recurrences.push({ id: "r_elec", label: "電気代テスト", amount: -8000, days: [25], onPayday: false, intervalMonths: 1, adjust: "none", accountId: "main", categoryId: "cat_fixed", startDate: "2026-10-01", endDate: "", doneDates: [] });
  s.recurrences.push({ id: "r_sub", label: "サブスクX", amount: -500, days: [25], onPayday: false, intervalMonths: 1, adjust: "none", accountId: "main", categoryId: "cat_subsc", startDate: "2026-10-01", endDate: "", doneDates: [] });
  K.addTransaction(s, { accountId: "sub", date: "2026-10-05", amount: -1200, categoryId: "cat_bnpl", label: "後払いテスト", status: "planned" });
  K.addTransaction(s, { accountId: "main", date: "2026-10-05", amount: 3000, categoryId: K.WINDFALL, label: "入金テスト", status: "planned" });
  K.addTransaction(s, { accountId: "main", date: "2026-10-27", amount: -700, categoryId: "cat_bnpl", label: "ペイテスト", status: "planned" });
  return s;
};
const tx = (s, label) => s.transactions.filter((t) => t.label === label);

test("parseEdits：配列でも edits でも読め、壊れたJSONは例外", () => {
  assert.equal(E.parseEdits('{"edits":[{"action":"add"}]}').length, 1);
  assert.equal(E.parseEdits('[{"action":"add"}]').length, 1);
  assert.throws(() => E.parseEdits("{"), /JSON/);
  assert.throws(() => E.parseEdits('{"edits":[]}'), /形式/);
  assert.throws(() => E.parseEdits('{"x":1}'), /形式/);
});

test("add：収入を予定として追加（口座・カテゴリは名前で照合）、同じ日・同じ金額はスキップ", () => {
  const s = setup();
  const edit = { action: "add", type: "income", date: "2026-10-09", amount: 4321, label: "臨時テスト", account: "テスト給料口座", category: "臨時収入" };
  const r = E.apply(s, [edit, edit, { action: "add", type: "expense", date: "2026-10-10", amount: 900, label: "出費テスト", account: "テスト別口座" }], { today: TODAY });
  assert.deepEqual(r.items.map((i) => i.status), ["ok", "skip", "ok"]);
  const t = tx(s, "臨時テスト");
  assert.equal(t.length, 1);
  assert.deepEqual([t[0].accountId, t[0].amount, t[0].status, t[0].categoryId], ["main", 4321, "planned", K.WINDFALL]);
  assert.equal(tx(s, "出費テスト")[0].amount, -900);
  assert.deepEqual(r.count, { add: 2, change: 0, delete: 0, skip: 1, fail: 0 });
  assert.match(r.items[1].text, /重複|同じ日/);
});

test("add：過去の日付は実績で残高に反映、口座の指定がなければ給与口座＋注記、不明な口座はエラー", () => {
  const s = setup();
  const r = E.apply(s, [
    { action: "add", type: "income", date: "2026-09-30", amount: 1000, label: "実績テスト" },
    { action: "add", type: "income", date: "2026-10-12", amount: 1000, label: "口座不明", account: "存在しない口座名XYZ" },
    { action: "add", type: "gift", date: "2026-10-12", amount: 1000, label: "種類不正" },
    { action: "add", type: "income", date: "2026-13-40", amount: 1000, label: "日付不正" },
    { action: "add", type: "income", date: "2026-10-12", amount: 0, label: "金額不正" },
  ], { today: TODAY });
  assert.deepEqual(r.items.map((i) => i.status), ["ok", "fail", "fail", "fail", "fail"]);
  assert.equal(tx(s, "実績テスト")[0].status, "actual");
  assert.equal(tx(s, "実績テスト")[0].accountId, "main");
  assert.equal(s.accounts[0].balance, 101000);
  assert.ok(r.items[0].notes.some((n) => /口座の指定がない/.test(n)));
  assert.equal(s.transactions.length, 4);
});

test("change：予定の日付と金額を変える（符号は元のまま。名前の表記ゆれ・括弧の付け足しも照合）", () => {
  const s = setup();
  const r = E.apply(s, [
    { action: "change", target: "後払いテスト（別口座）", from: { date: "2026-10-05", amount: 1200 }, to: { date: "2026-10-09", amount: 1200 } },
    { action: "change", target: "ペイテスト", from: { date: "2026-10-27", amount: -700 }, to: { date: "2026-10-27", amount: -900 } },
  ], { today: TODAY });
  assert.deepEqual(r.items.map((i) => i.status), ["ok", "ok"]);
  const a = tx(s, "後払いテスト")[0];
  assert.deepEqual([a.date, a.amount], ["2026-10-09", -1200]);
  const b = tx(s, "ペイテスト")[0];
  assert.deepEqual([b.date, b.amount], ["2026-10-27", -900]);
});

test("change：定期ルールの1回分は上書き（その回だけ）。実績の残高も正しく動く", () => {
  const s = setup();
  const r = E.apply(s, [{ action: "change", target: "電気代テスト", from: { date: "2026-10-25", amount: 8000 }, to: { date: "2026-10-09", amount: 6543 } }], { today: TODAY });
  assert.equal(r.items[0].status, "ok");
  const o = s.transactions.find((t) => t.recurrenceId === "r_elec");
  assert.deepEqual([o.date, o.amount, o.status, o.occurrenceDate], ["2026-10-09", -6543, "planned", "2026-10-25"]);
  assert.equal(s.recurrences[0].amount, -8000); // ルール自体は変えない
  // 来月の回には影響しない
  const f = K.forecast(s, { today: TODAY, end: "2026-11-30", scope: ["main"] });
  const elec = f.days.flatMap((d) => d.events).filter((e) => /電気代テスト/.test(e.label)).map((e) => [e.date, e.amount]);
  assert.deepEqual(elec, [["2026-10-09", -6543], ["2026-11-25", -8000]]);
  // 一度変えた回をもう一度変える（取引側で特定される）
  const r2 = E.apply(s, [{ action: "change", target: "電気代テスト", from: { date: "2026-10-09", amount: 6543 }, to: { amount: 7000 } }], { today: TODAY });
  assert.equal(r2.items[0].status, "ok");
  assert.equal(s.transactions.filter((t) => t.recurrenceId === "r_elec").length, 1);
  assert.equal(s.transactions.find((t) => t.recurrenceId === "r_elec").amount, -7000);
});

test("change：見つからない・複数一致・変更なし・指定不足は適用しない", () => {
  const s = setup();
  K.addTransaction(s, { accountId: "main", date: "2026-10-20", amount: -300, categoryId: "cat_other", label: "同名テスト", status: "planned" });
  K.addTransaction(s, { accountId: "sub", date: "2026-10-20", amount: -300, categoryId: "cat_other", label: "同名テスト", status: "planned" });
  const before = JSON.stringify(s.transactions);
  const r = E.apply(s, [
    { action: "change", target: "ないものABC", from: { date: "2026-10-05", amount: 1200 }, to: { amount: 1 } },
    { action: "change", target: "後払いテスト", from: { date: "2026-10-06", amount: 1200 }, to: { amount: 1 } }, // 日付違い
    { action: "change", target: "後払いテスト", from: { date: "2026-10-05", amount: 1201 }, to: { amount: 1 } }, // 金額違い
    { action: "change", target: "同名テスト", from: { date: "2026-10-20", amount: 300 }, to: { amount: 400 } }, // 複数一致
    { action: "change", target: "後払いテスト", from: { date: "2026-10-05", amount: 1200 }, to: { date: "2026-10-05", amount: 1200 } }, // 変更なし
    { action: "change", target: "後払いテスト", from: { date: "2026-10-05", amount: 1200 }, to: {} },
  ], { today: TODAY });
  assert.deepEqual(r.items.map((i) => i.status), ["fail", "fail", "fail", "fail", "skip", "fail"]);
  assert.match(r.items[3].text, /複数/);
  assert.equal(JSON.stringify(s.transactions), before);
  assert.equal(r.applicable, 0);
});

test("delete：予定を削除、定期ルールの1回分はスキップ、見つからなければ警告", () => {
  const s = setup();
  const r = E.apply(s, [
    { action: "delete", target: "入金テスト", date: "2026-10-05", amount: 3000 },
    { action: "delete", target: "サブスクX", date: "2026-10-25", amount: 500 },
    { action: "delete", target: "入金テスト", date: "2026-10-05", amount: 3000 }, // もうない
  ], { today: TODAY });
  assert.deepEqual(r.items.map((i) => i.status), ["ok", "ok", "fail"]);
  assert.equal(tx(s, "入金テスト").length, 0);
  assert.deepEqual(s.recurrences.find((x) => x.id === "r_sub").doneDates, ["2026-10-25"]);
  const f = K.forecast(s, { today: TODAY, end: "2026-10-31", scope: ["main"] });
  assert.ok(!f.days.flatMap((d) => d.events).some((e) => /サブスクX/.test(e.label)));
});

test("delete：実績は残高も戻る。定期の回の変更後に削除してもその回は復活しない", () => {
  const s = setup();
  K.addTransaction(s, { accountId: "main", date: "2026-09-30", amount: -2500, categoryId: "cat_other", label: "実績テスト", status: "actual" });
  assert.equal(s.accounts[0].balance, 97500);
  E.apply(s, [{ action: "delete", target: "実績テスト", date: "2026-09-30", amount: 2500 }], { today: TODAY });
  assert.equal(s.accounts[0].balance, 100000);
  E.apply(s, [
    { action: "change", target: "サブスクX", from: { date: "2026-10-25", amount: 500 }, to: { date: "2026-10-24" } },
    { action: "delete", target: "サブスクX", date: "2026-10-24", amount: 500 },
  ], { today: TODAY });
  const f = K.forecast(s, { today: TODAY, end: "2026-10-31", scope: ["main"] });
  assert.ok(!f.days.flatMap((d) => d.events).some((e) => /サブスクX/.test(e.label)));
});

test("preview：今のデータは変えず、apply と同じ結果になる。上から順に適用される", () => {
  const s = setup();
  const edits = [
    { action: "add", type: "expense", date: "2026-10-15", amount: 1500, label: "新規テスト", account: "テスト給料口座" },
    { action: "change", target: "新規テスト", from: { date: "2026-10-15", amount: 1500 }, to: { date: "2026-10-16" } }, // 直前の追加を変更
    { action: "unknown" },
  ];
  const before = JSON.stringify(s);
  const p = E.preview(s, edits, { today: TODAY });
  assert.equal(JSON.stringify(s), before);
  assert.deepEqual(p.items.map((i) => i.status), ["ok", "ok", "fail"]);
  assert.deepEqual(p.count, { add: 1, change: 1, delete: 0, skip: 0, fail: 1 });
  const a = E.apply(s, edits, { today: TODAY });
  assert.deepEqual(a.items.map((i) => i.text), p.items.map((i) => i.text));
  assert.equal(tx(s, "新規テスト")[0].date, "2026-10-16");
});

test("架空の修正ファイルのひな形どおりに適用できる", () => {
  const s = setup();
  const file = JSON.stringify({ edits: [
    { action: "add", type: "income", date: "2026-10-09", amount: 5555, label: "収入1", account: "テスト給料口座", category: "臨時収入" },
    { action: "change", target: "後払いテスト（別口座）", from: { date: "2026-10-05", amount: 1200 }, to: { date: "2026-10-09", amount: 1200 } },
    { action: "change", target: "電気代テスト", from: { date: "2026-10-25", amount: 8000 }, to: { date: "2026-10-09", amount: 7000 } },
    { action: "change", target: "ペイテスト", from: { date: "2026-10-27", amount: -700 }, to: { date: "2026-10-27", amount: -1000 } },
    { action: "change", target: "サブスクX", from: { date: "2026-10-25", amount: -500 }, to: { date: "2026-10-24", amount: -500 } },
    { action: "delete", target: "入金テスト", date: "2026-10-05", amount: 3000 },
  ] });
  const r = E.apply(s, E.parseEdits(file), { today: TODAY });
  assert.deepEqual(r.count, { add: 1, change: 4, delete: 1, skip: 0, fail: 0 });
});
