/* 画面の描画と操作 */
(function () {
  "use strict";

  const K = window.Kakeibo;
  const I = window.KImport;
  const P = window.KPeriods;
  const KEdits = window.KEdits;
  const D = window.KDates;
  const C = window.KChart;
  const yen = K.yen;
  const STORE_KEY = "kakeibo.v1";
  const UI_KEY = "kakeibo.ui";

  /* ---------- 保存 ---------- */

  const load = () => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return K.normalizeState(raw ? JSON.parse(raw) : null);
    } catch (e) {
      return K.emptyState();
    }
  };

  let state = load();

  const save = () => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      toast("保存できませんでした（ブラウザの保存領域を確認してください）");
    }
  };

  const ui = Object.assign(
    {
      tab: "home",
      sub: null,
      range: "payday",
      customEnd: "",
      scope: "total",
      scenario: "optimistic",
      showTable: false,
      analysisRange: "thisMonth",
      includePlanned: false,
      inputKind: "expense",
    },
    (() => {
      try {
        return JSON.parse(localStorage.getItem(UI_KEY) || "{}");
      } catch (e) {
        return {};
      }
    })(),
    { whatIf: [], selectedDate: null, openCat: null, draft: {} }
  );

  const saveUi = () => {
    try {
      const { tab, sub, range, customEnd, scope, analysisRange, includePlanned, inputKind, showTable } = ui;
      localStorage.setItem(UI_KEY, JSON.stringify({ tab, sub, range, customEnd, scope, analysisRange, includePlanned, inputKind, showTable }));
    } catch (e) {
      /* 保存できなくても動作には影響しない */
    }
  };

  const commit = () => {
    save();
    render();
  };

  // 操作前の状態を覚えておき、トーストの「元に戻す」で丸ごと復元する
  const undoable = (msg, fn) => {
    const before = JSON.stringify(state);
    const result = fn();
    commit();
    toast(typeof msg === "function" ? msg(result) : msg, () => {
      state = K.normalizeState(JSON.parse(before));
      commit();
      toast("元に戻しました");
    });
  };

  /* ---------- 小物 ---------- */

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const today = () => D.today();
  const pad2 = (n) => String(n).padStart(2, "0");
  const nowParts = () => {
    const n = new Date();
    return { date: today(), time: `${pad2(n.getHours())}:${pad2(n.getMinutes())}` };
  };
  const $ = (sel, root = document) => root.querySelector(sel);
  const app = $("#app");

  // undo を渡すと「元に戻す」ボタン付きで少し長めに表示する
  const toast = (msg, undo) => {
    document.querySelectorAll(".toast").forEach((x) => x.remove());
    const t = document.createElement("div");
    t.className = "toast";
    t.setAttribute("role", "status");
    const text = document.createElement("span");
    text.textContent = msg;
    t.appendChild(text);
    if (undo) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "toast-undo";
      b.textContent = "元に戻す";
      b.addEventListener("click", () => {
        t.remove();
        undo();
      });
      t.appendChild(b);
    }
    document.body.appendChild(t);
    setTimeout(() => t.remove(), undo ? 7000 : 2600);
  };

  const signed = (n) => `<span class="num ${n > 0 ? "pos" : "neg"}">${n > 0 ? "+" : ""}${esc(yen(n))}</span>`;
  const accName = (id) => (K.accountById(state, id) || {}).name || "（削除された口座）";
  const cat = (id) => K.categoryById(state, id) || { name: "その他", color: "#999" };
  const catSwatch = (id) => `<span class="swatch" style="background:${esc(cat(id).color)}"></span>`;

  const ICONS = {
    critical: '<svg class="icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M10 1.5 19 18H1z"/><path d="M9.2 7h1.6l-.2 5.5H9.4zM10 13.6a1 1 0 1 1 0 2 1 1 0 0 1 0-2z" fill="var(--surface)"/></svg>',
    warning: '<svg class="icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><circle cx="10" cy="10" r="9"/><path d="M9.2 5h1.6l-.2 6.5H9.4zM10 13a1 1 0 1 1 0 2 1 1 0 0 1 0-2z" fill="var(--surface)"/></svg>',
    info: '<svg class="icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><circle cx="10" cy="10" r="9"/><path d="M9.2 8.5h1.6V15H9.2zM10 5a1 1 0 1 1 0 2 1 1 0 0 1 0-2z" fill="var(--surface)"/></svg>',
    good: '<svg class="icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><circle cx="10" cy="10" r="9"/><path d="m5.8 10.2 2.8 2.8 5.6-5.6" fill="none" stroke="var(--surface)" stroke-width="2"/></svg>',
  };
  ICONS.serious = ICONS.warning;
  const LEVEL_LABEL = { critical: "危険", serious: "要確認", warning: "注意", info: "お知らせ", good: "順調" };

  const alertBox = (level, html) =>
    `<div class="alert ${level}" role="${level === "critical" ? "alert" : "note"}">${ICONS[level]}<div><strong>${LEVEL_LABEL[level]}</strong>${html}</div></div>`;

  const accountOptions = (selected, { includeEmpty = false } = {}) =>
    (includeEmpty ? `<option value="">（なし）</option>` : "") +
    state.accounts.map((a) => `<option value="${esc(a.id)}" ${a.id === selected ? "selected" : ""}>${esc(a.name)}</option>`).join("");

  const categoryOptions = (kind, selected) =>
    state.categories
      .filter((c) => !kind || c.kind === kind)
      .map((c) => `<option value="${esc(c.id)}" ${c.id === selected ? "selected" : ""}>${esc(c.name)}</option>`)
      .join("");

  const needAccounts = () =>
    state.accounts.length
      ? ""
      : `<div class="card empty"><p>まずは口座を登録しましょう。</p><div class="row" style="justify-content:center;gap:8px">
          <button class="primary" data-action="account-new">口座を追加</button>
          <button data-action="sample">サンプルデータで試す</button></div></div>`;

  /* ---------- 期間 ---------- */

  const rangeEnd = (key, t = today()) => {
    switch (key) {
      case "payday": {
        let p = K.nextPayday(state.settings, t);
        if (p === t) p = K.nextPayday(state.settings, D.addDays(t, 1));
        return p;
      }
      case "month": return D.endOfMonth(t);
      case "nextMonth": return D.endOfMonth(t, 1);
      case "year": return `${t.slice(0, 4)}-12-31`;
      case "90": return D.addDays(t, 90);
      case "custom": return ui.customEnd && ui.customEnd > t ? ui.customEnd : D.addDays(t, 30);
      default: return D.addDays(t, 30);
    }
  };
  const RANGES = [
    ["payday", "次の給料日まで"],
    ["month", "今月末"],
    ["nextMonth", "来月末"],
    ["year", "年末まで"],
    ["90", "90日"],
    ["custom", "日付指定"],
  ];

  /* ---------- 画面: ホーム ---------- */

  const viewHome = () => {
    if (!state.accounts.length) {
      return `<section class="card">
        <h3>残高予測家計簿へようこそ</h3>
        <p class="muted small">給料日から次の給料日まで、口座残高がどう動くかを自動で予測します。口座・定期の支払い・日々の生活費を登録すると、残高が一番低くなる日がわかります。</p>
      </section>${needAccounts()}`;
    }
    const t = today();
    const total = K.sumBalances(state, K.totalAccountIds(state));
    const payday = rangeEnd("payday", t);
    const f = K.forecast(state, { today: t, end: payday, scenario: "pessimistic" });
    const al = K.alerts(state, { today: t });
    const inflightHome = K.inFlightTotal(state, "total");
    const excluded = state.accounts.filter((a) => a.includeInTotal === false);

    let html = "";
    html += `<section class="tiles">
      <div class="card tile hero"><div class="label">総資産（合計対象の口座）</div><div class="value num">${esc(yen(total))}</div>
        <div class="sub">${excluded.length ? `合計外: ${excluded.map((a) => `${esc(a.name)} ${esc(yen(a.balance))}`).join("、")}` : `${state.accounts.length}口座`}</div></div>
      <div class="card tile"><div class="label">給料日（${esc(D.dayLabelLong(payday))}）までの最低残高</div><div class="value num">${esc(yen(f.min.balance))}</div>
        <div class="sub">${esc(D.dayLabelLong(f.min.date))}・あと${D.diffDays(t, payday)}日</div></div>
      <div class="card tile"><div class="label">給料日前日の残高見込み</div><div class="value num">${esc(yen((f.days[f.days.length - 2] || f.days[0]).balance))}</div>
        <div class="sub">${inflightHome ? `着金待ち ${esc(yen(inflightHome))} は含めない場合` : `あと${D.diffDays(t, payday) - 1}日`}</div></div>
    </section>`;

    if (K.needsReminder(state, nowParts())) {
      html += `<section>${alertBox("warning", `<div>今日（${esc(D.dayLabelLong(t))}）はまだ記録がありません</div>
        <div class="row wrap" style="gap:8px;margin-top:8px"><button class="small primary" data-tab-go="input">入力する</button><button class="small" data-sub-go="import">画像から取り込む</button><button class="small ghost" data-action="no-spend">今日は使っていない</button></div>`)}</section>`;
    }

    const bk = K.backupStatus(state, t);
    if (bk.due) {
      html += `<section>${alertBox("warning", `<div>${bk.exported ? `最後のバックアップから${bk.days}日たっています` : `まだバックアップしていません（使い始めて${bk.days}日）`}。データはこの端末のブラウザにだけ保存されているので、機種変更やブラウザのデータ削除で消えます</div>
        <div class="row wrap" style="gap:8px;margin-top:8px"><button class="small primary" data-action="export">今すぐ書き出す</button></div>`)}</section>`;
    }

    html += `<section>${al.length ? al.map((a) => alertBox(a.level, `<div>${esc(a.message)}</div>`)).join("") : alertBox("good", "<div>60日先まで、残高が目安を下回る予測はありません</div>")}</section>`;

    html += `<section class="card"><div class="row between"><h3>残高推移（給料日まで）</h3><button class="link small" data-tab-go="forecast">詳しく ›</button></div>
      <div class="chart" id="homeChart"></div></section>`;

    if (state.goals.length) {
      const g = state.goals[0];
      const p = K.goalPlan(state, g, { today: t });
      html += `<section class="card"><div class="row between"><h3>${esc(g.label || "目標")}</h3><span class="row" style="gap:12px"><button class="link small" data-action="earncal" data-id="${esc(g.id)}">📅 稼ぐ目安</button><button class="link small" data-sub-go="goals">目標 ›</button></span></div>
        <div class="row between small"><span class="num">${esc(yen(p.current))} / ${esc(yen(p.target))}</span><span class="num">${Math.round(p.progress * 100)}%</span></div>
        <div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(p.progress * 100)}" aria-label="目標の進捗"><div style="width:${(p.progress * 100).toFixed(1)}%"></div></div>
        <p class="small" style="margin:8px 0 0">${p.onTrack ? `${ICONS.good.replace('class="icon"', 'class="icon" style="width:14px;height:14px;vertical-align:-2px;color:var(--good)"')} 順調` : `要調整：月あと ${esc(yen(p.gapMonthly))} の上積みが必要`}<span class="muted">（必要 ${esc(yen(p.requiredMonthly))}/月・ペース ${esc(yen(p.pace))}/月）</span></p>
      </section>`;
    }

    html += `<section class="card"><h3>これからの予定（7日間）</h3>${upcomingList(t, D.addDays(t, 7))}</section>`;

    const recentConfirmed = state.transactions
      .filter((x) => K.canUnconfirm(x, t) && x.date >= D.addDays(t, -7))
      .sort((a, b) => (a.date > b.date ? -1 : 1))
      .slice(0, 5);
    if (recentConfirmed.length) {
      html += `<section class="card"><h3>最近の支払済・入金済</h3><p class="tiny">間違えて押したときは「予定に戻す」で取り消せます（口座残高も元に戻ります）。</p>
        <ul class="list">${recentConfirmed.map(txItem).join("")}</ul></section>`;
    }

    const overdue = state.transactions.filter((x) => x.status === "planned" && x.date < t);
    if (overdue.length) {
      html += `<section class="card"><h3>確認待ちの予定</h3><p class="tiny">日付を過ぎた予定です。実際に支払った／入金されたら「支払済」「入金済」を押してください。予測では今日の出来事として計上しています。</p>
        <ul class="list">${overdue.map(txItem).join("")}</ul></section>`;
    }
    return html;
  };

  const upcomingList = (from, to) => {
    const ev = K.collectEvents(state, from, to, { today: from, scenario: "optimistic" }).filter((e) => e.source === "recurrence" || e.source === "planned" || e.source === "transfer");
    if (!ev.length) return `<p class="muted small">予定はありません</p>`;
    const seen = new Set();
    return `<ul class="list">${ev
      .map((ev) => {
        let e = ev;
        if (e.source === "transfer") {
          const key = `trf${e.refId}`;
          if (seen.has(key)) return "";
          seen.add(key);
          const tr = state.transfers.find((x) => x.id === e.refId);
          const late = K.IN_FLIGHT.includes(tr.status) && tr.date < from;
          return `<li><span class="date">${esc(D.dayLabelLong(tr.date))}</span><div class="grow"><div class="ellipsis">${esc(e.label)}</div><div class="meta">振替・${esc(K.TRANSFER_STATUS[tr.status])}${late ? ' <span class="badge warn">予定日超過</span>' : ""}</div></div><span class="amt num">${esc(yen(tr.amount))}</span>
            ${K.IN_FLIGHT.includes(tr.status) ? `<span class="actions"><button class="small" data-action="transfer-arrived" data-id="${esc(tr.id)}">着金した</button></span>` : ""}</li>`;
        }
        const recTransfer = e.source === "recurrence" && e.transfer;
        if (recTransfer) {
          const key = `rt${e.refId}${e.original}`;
          if (seen.has(key)) return "";
          seen.add(key);
          const r = state.recurrences.find((x) => x.id === e.refId);
          e = Object.assign({}, e, { accountId: r.accountId, meta: `${accName(r.accountId)} → ${accName(r.toAccountId)}・定期の振替` });
        }
        const actions =
          e.source === "recurrence"
            ? `<button class="small" data-action="occ-done" data-id="${esc(e.refId)}" data-date="${esc(e.original)}" title="残高に反映して完了">済</button>
               <button class="small ghost" data-action="occ-edit" data-id="${esc(e.refId)}" data-date="${esc(e.original)}">変更</button>`
            : `<button class="small" data-action="tx-confirm" data-id="${esc(e.refId)}">${e.amount < 0 ? "支払済" : "入金済"}</button>`;
        return `<li><span class="date">${esc(D.dayLabelLong(e.date))}</span>${catSwatch(e.categoryId)}<div class="grow"><div class="ellipsis">${esc(e.label)}</div><div class="meta">${esc(e.meta || `${accName(e.accountId)}${e.source === "recurrence" ? "・定期" : "・予定"}`)}</div></div>
          <span class="amt">${recTransfer ? `<span class="num">${esc(yen(Math.abs(e.amount)))}</span>` : signed(e.amount)}</span><span class="actions">${actions}</span></li>`;
      })
      .join("")}</ul>`;
  };

  /* ---------- 画面: 残高予測 ---------- */

  const forecastData = () => {
    const t = today();
    const end = rangeEnd(ui.range, t);
    const scope = ui.scope === "total" ? "total" : [ui.scope];
    const base = { today: t, end, scope };
    const inflight = K.hasInFlightInScope(state, scope, end);
    const main = K.forecast(state, Object.assign({}, base, { scenario: ui.scenario, whatIf: ui.whatIf }));
    let compare = null;
    let names = ["残高"];
    if (ui.whatIf.length) {
      compare = K.forecast(state, Object.assign({}, base, { scenario: ui.scenario }));
      names = ["もしも込み", "現在の予定"];
    } else if (inflight) {
      compare = K.forecast(state, Object.assign({}, base, { scenario: ui.scenario === "optimistic" ? "pessimistic" : "optimistic" }));
      names = ui.scenario === "optimistic" ? ["着金あり", "着金なし"] : ["着金なし", "着金あり"];
    }
    return { t, end, main, compare, names, inflight };
  };

  const viewForecast = () => {
    if (!state.accounts.length) return needAccounts();
    const { t, end, main, compare, names, inflight } = forecastData();
    const threshold = Number(state.settings.threshold) || 0;

    let html = `<section class="row wrap" style="gap:8px">
      <div class="scroll-x" role="group" aria-label="期間">${RANGES.map(([k, l]) => `<button class="chip" aria-pressed="${ui.range === k}" data-action="range" data-key="${k}">${l}</button>`).join("")}</div>
    </section>`;
    html += `<section class="grid2 collapse">
      ${ui.range === "custom" ? `<label class="field">終了日<input type="date" data-bind="customEnd" value="${esc(end)}" min="${esc(D.addDays(t, 1))}"></label>` : ""}
      <label class="field">対象<select data-bind="scope"><option value="total">合計（${K.totalAccountIds(state).length}口座）</option>${state.accounts.map((a) => `<option value="${esc(a.id)}" ${ui.scope === a.id ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select></label>
    </section>`;

    // サマリー
    const minCls = main.min.balance < 0 ? "critical" : main.min.balance < threshold ? "warning" : "good";
    html += `<section>${alertBox(minCls, `<div><b class="num">${esc(D.dayLabelLong(main.min.date))}</b>に残高が<b class="num">${esc(yen(main.min.balance))}</b>まで下がります${
      compare && ui.whatIf.length ? `（もしもなし: ${esc(yen(compare.min.balance))}）` : ""
    }</div>`)}</section>`;

    html += `<section class="tiles">
      <div class="card tile"><div class="label">今日</div><div class="value num">${esc(yen(main.startBalance))}</div></div>
      <div class="card tile"><div class="label">${esc(D.dayLabelLong(end))}時点</div><div class="value num">${esc(yen(main.endBalance))}</div>
        <div class="sub">${compare ? `${esc(names[1])}: ${esc(yen(compare.endBalance))}` : `増減 ${esc(yen(main.endBalance - main.startBalance))}`}</div></div>
    </section>`;

    html += `<section class="card">
      ${compare ? `<div class="legend"><span><i style="border-color:var(--s1)"></i>${esc(names[0])}</span><span><i class="dashed" style="border-color:var(--s2)"></i>${esc(names[1])}</span></div>` : ""}
      <div class="chart" id="forecastChart"></div>
      <p class="tiny" style="margin:6px 0 0">グラフをタップするとその日の内訳を表示します。灰色の帯は休日（生活費は休日単価）。</p>
      ${inflight ? `<div class="row wrap" style="margin-top:8px"><span class="small muted">着金待ちの振替:</span>
        <div class="seg" style="flex:1;max-width:280px"><button aria-pressed="${ui.scenario === "optimistic"}" data-action="scenario" data-key="optimistic">着金する前提</button><button aria-pressed="${ui.scenario === "pessimistic"}" data-action="scenario" data-key="pessimistic">着金しない前提</button></div></div>` : ""}
    </section>`;

    html += `<section class="card" id="dayDetail">${dayDetail(main)}</section>`;

    // What-if
    html += `<section class="card"><h3>もしも（What-if）</h3>
      <p class="tiny">仮の支出・収入をグラフに反映します。保存はされません。</p>
      ${ui.whatIf.length ? `<ul class="list">${ui.whatIf.map((w) => `<li><span class="date">${esc(D.dayLabelLong(w.date))}</span><div class="grow"><div class="ellipsis">${esc(w.label || "仮の支出")}</div><div class="meta">${esc(accName(w.accountId))}</div></div><span class="amt">${signed(w.amount)}</span>
        <span class="actions"><button class="small" data-action="whatif-save" data-id="${esc(w.id)}">予定に追加</button><button class="small ghost" data-action="whatif-remove" data-id="${esc(w.id)}" aria-label="削除">×</button></span></li>`).join("")}</ul>` : ""}
      <form class="grid2 collapse" data-form="whatif" style="margin-top:8px">
        <label class="field">金額（支出）<input name="amount" inputmode="numeric" placeholder="30000" required></label>
        <label class="field">日付<input type="date" name="date" value="${esc(t)}" required></label>
        <label class="field">内容<input name="label" placeholder="イヤホン"></label>
        <label class="field">口座<select name="accountId">${accountOptions(ui.scope !== "total" ? ui.scope : state.settings.livingAccountId || (state.accounts[0] || {}).id)}</select></label>
        <label class="check"><input type="checkbox" name="income"> 収入として試す</label>
        <button class="primary" type="submit">グラフに反映</button>
      </form>
    </section>`;

    html += `<section class="card"><div class="row between"><h3>日別の表</h3><button class="small" data-action="toggle-table">${ui.showTable ? "閉じる" : "表で見る"}</button></div>
      ${ui.showTable ? forecastTable(main) : ""}</section>`;
    return html;
  };

  const eventRow = (e) =>
    `<li>${catSwatch(e.categoryId)}<div class="grow"><div class="ellipsis">${esc(e.label)}</div><div class="meta">${esc(accName(e.accountId))}${e.inFlight ? "・着金待ち" : ""}${e.overdue ? "・日付超過の予定" : ""}</div></div><span class="amt">${signed(e.amount)}</span></li>`;

  const dayDetail = (f) => {
    const date = ui.selectedDate && f.days.some((d) => d.date === ui.selectedDate) ? ui.selectedDate : f.min.date;
    const idx = f.days.findIndex((d) => d.date === date);
    const day = f.days[idx];
    const prev = idx > 0 ? f.days[idx - 1].balance : f.startBalance;
    const net = day.events.reduce((s, e) => s + e.amount, 0);
    const hol = D.holidayName(date);
    const actuals = day.actuals || [];
    const actualList = actuals.length
      ? `<p class="tiny" style="margin:8px 0 0">記録済みの実績（今日の残高に反映済み）</p><ul class="list">${actuals.map(actualRow).join("")}</ul>`
      : "";
    return `<div class="row between"><h3>${esc(D.dayLabelLong(date))}${hol ? ` <span class="badge">${esc(hol)}</span>` : day.dayOff ? ` <span class="badge">休日</span>` : ""}${date === f.min.date ? ` <span class="badge accent">最低残高の日</span>` : ""}</h3>
      <span class="num small muted">${idx > 0 ? `${esc(yen(prev))} → ` : ""}<b style="color:var(--text)">${esc(yen(day.balance))}</b></span></div>
      ${day.events.length ? `<ul class="list">${day.events.map(eventRow).join("")}</ul><div class="row between small" style="margin-top:6px"><span class="muted">この日の増減</span>${signed(net)}</div>` : `${actuals.length ? "" : '<p class="muted small">入出金はありません</p>'}`}${actualList}`;
  };

  const actualRow = (x) =>
    `<li>${catSwatch(x.categoryId)}<div class="grow"><div class="ellipsis">${esc(x.label || cat(x.categoryId).name)}</div><div class="meta">${esc(accName(x.accountId))}・実績（反映済み）${x.date > today() ? `・日付は${esc(D.dayLabel(x.date))}` : ""}</div></div><span class="amt">${signed(x.amount)}</span>
      ${K.canUnconfirm(x, today()) ? `<span class="actions"><button class="small" data-action="tx-unconfirm" data-id="${esc(x.id)}">予定に戻す</button></span>` : ""}</li>`;

  const forecastTable = (f) => {
    const rows = f.days
      .filter((d) => d.events.some((e) => e.source !== "living" && e.source !== "misc") || (d.actuals || []).length || d === f.days[0] || d.date === f.min.date || d === f.days[f.days.length - 1])
      .map((d) => {
        // 対象内の口座同士の振替は出金・入金の2行ではなく1行にまとめる
        const seenTransfer = new Set();
        const main = d.events
          .filter((e) => e.source !== "living" && e.source !== "misc")
          .filter((e) => {
            if (!e.transfer) return true;
            const pair = d.events.some((o) => o !== e && o.transfer && o.refId === e.refId && o.original === e.original && Math.sign(o.amount) !== Math.sign(e.amount));
            if (!pair) return true;
            const key = `${e.refId}|${e.original || ""}`;
            if (seenTransfer.has(key)) return false;
            seenTransfer.add(key);
            e.internal = true;
            return true;
          });
        const daily = d.events.filter((e) => e.source === "living" || e.source === "misc").reduce((s, e) => s + e.amount, 0);
        return `<tr><td>${esc(D.dayLabelLong(d.date))}</td><td>${(d.actuals || []).map((x) => `<div class="ev-line"><span>${esc(x.label || cat(x.categoryId).name)} <span class="badge">実績${x.date > d.date ? `・${esc(D.dayLabel(x.date))}付` : ""}</span></span>${signed(x.amount)}</div>`).join("")}${main.map((e) => `<div class="ev-line"><span>${esc(e.label)}${e.internal ? ' <span class="badge">振替</span>' : ""}</span>${e.internal ? `<span class="num">${esc(yen(Math.abs(e.amount)))}</span>` : signed(e.amount)}</div>`).join("") || ((d.actuals || []).length ? "" : "—")}</td><td class="r">${daily ? signed(daily) : "—"}</td><td class="r num"><b>${esc(yen(d.balance))}</b></td></tr>`;
      })
      .join("");
    return `<p class="tiny">入出金がある日のみ表示（生活費・雑費の日割りはまとめて表示）。「実績」は今日すでに記録した分で、今日の残高に反映済みです。過去の実績は「分析」や「入力」の履歴で確認できます。</p><div class="table-wrap"><table class="data"><thead><tr><th>日付</th><th>入出金</th><th class="r">生活費等</th><th class="r">残高</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  };

  /* ---------- 画面: 入力 ---------- */

  const viewInput = () => {
    if (!state.accounts.length) return needAccounts();
    const t = today();
    const kind = ui.inputKind;
    const d = ui.draft;
    let html = `<section><div class="seg" role="group" aria-label="入力の種類">
      <button aria-pressed="${kind === "expense"}" data-action="kind" data-key="expense">支出</button>
      <button aria-pressed="${kind === "income"}" data-action="kind" data-key="income">収入</button>
      <button aria-pressed="${kind === "transfer"}" data-action="kind" data-key="transfer">振替</button></div></section>
      <section><button class="chip" data-sub-go="import" style="width:100%;justify-content:center">📷 画像から取り込む（レシート・残高・請求・給与明細）</button></section>`;

    if (kind === "transfer") {
      html += `<section class="card"><form class="stack" data-form="transfer">
        <label class="field">金額<input class="amount num" name="amount" inputmode="numeric" placeholder="0" required></label>
        <div class="grid2"><label class="field">出金元<select name="fromId" data-check-balance="1">${accountOptions(d.fromId || state.settings.salaryAccountId)}</select><span class="field-error" data-balance-error hidden></span></label>
        <label class="field">入金先<select name="toId">${accountOptions(d.toId || state.settings.livingAccountId || (state.accounts[1] || {}).id)}</select></label></div>
        <div class="grid2"><label class="field">日付（着金予定日）<input type="date" name="date" value="${esc(t)}" required></label>
        <label class="field">状態<select name="status">${Object.entries(K.TRANSFER_STATUS).map(([k, v]) => `<option value="${k}" ${k === "done" ? "selected" : ""}>${v}</option>`).join("")}</select></label></div>
        <label class="field">メモ<input name="label" placeholder="例: FX出金"></label>
        <p class="tiny" style="margin:0">「申請中」「着金待ち」は出金元からすでに引かれ、入金先には着金予定日に入る前提で予測します。</p>
        <button class="primary" type="submit">振替を登録</button></form></section>`;
    } else {
      const templates = state.recurrences.filter((r) => !r.toAccountId && (kind === "expense" ? r.amount < 0 : r.amount > 0));
      html += templates.length
        ? `<section><h2>テンプレート（定期ルールから）</h2><div class="scroll-x">${templates.map((r) => `<button class="chip" data-action="template" data-id="${esc(r.id)}">${esc(r.label)} <span class="tiny num">${esc(yen(Math.abs(r.amount)))}</span></button>`).join("")}</div></section>`
        : "";
      const defaultCat = d.categoryId || (kind === "expense" ? "cat_living" : "cat_salary");
      html += `<section class="card"><form class="stack" data-form="tx">
        <label class="field">金額<input class="amount num" name="amount" inputmode="numeric" placeholder="0" value="${esc(d.amount || "")}" required autofocus></label>
        <div class="field" style="display:grid;gap:6px"><span class="small muted">カテゴリ</span><div class="chips" role="radiogroup">${state.categories
          .filter((c) => c.kind === kind)
          .map((c) => `<label class="chip btn" style="${c.id === defaultCat ? "border-color:var(--accent)" : ""}"><input type="radio" name="categoryId" value="${esc(c.id)}" ${c.id === defaultCat ? "checked" : ""} style="width:auto;accent-color:var(--accent)"> ${esc(c.name)}</label>`)
          .join("")}</div></div>
        <div class="grid2"><label class="field">日付<input type="date" name="date" value="${esc(d.date || t)}" required></label>
        <label class="field">口座<select name="accountId" data-check-balance="${kind === "expense" ? "1" : ""}">${accountOptions(d.accountId || (kind === "income" ? state.settings.salaryAccountId : state.settings.livingAccountId) || state.accounts[0].id)}</select><span class="field-error" data-balance-error hidden></span></label></div>
        <label class="field">内容<input name="label" value="${esc(d.label || "")}" placeholder="${kind === "expense" ? "例: 退去費、旅行代" : "例: FX利益、仕送りの返済"}"></label>
        <label class="check"><input type="checkbox" name="planned"> 予定として登録（未来の日付は自動で予定になります）</label>
        <details><summary>詳細設定</summary><label class="check" style="margin-top:8px"><input type="checkbox" name="reflected"> 口座残高はもう更新済み（残高を変えずに記録だけする）</label></details>
        <button class="primary" type="submit">${kind === "expense" ? "支出" : "収入"}を登録</button></form></section>`;
    }

    const planned = state.transactions.filter((x) => x.status === "planned").sort((a, b) => (a.date < b.date ? -1 : 1));
    const recent = state.transactions.filter((x) => x.status === "actual").sort((a, b) => (a.date > b.date ? -1 : 1)).slice(0, 30);
    html += `<section class="card"><h3>予定の単発取引</h3>${planned.length ? `<ul class="list">${planned.map(txItem).join("")}</ul>` : `<p class="muted small">なし</p>`}</section>`;
    html += `<section class="card"><h3>最近の実績</h3>${recent.length ? `<ul class="list">${recent.map(txItem).join("")}</ul>` : `<p class="muted small">なし</p>`}</section>`;
    return html;
  };

  const txItem = (x) =>
    `<li><span class="date">${esc(D.dayLabelLong(x.date))}</span>${catSwatch(x.categoryId)}<div class="grow"><div class="ellipsis">${esc(x.label || cat(x.categoryId).name)}</div>
      <div class="meta">${esc(accName(x.accountId))}・${esc(cat(x.categoryId).name)}${x.recurrenceId ? "・定期の1回分" : ""}${x.balanceAlreadyReflected ? "・残高反映済み" : ""}</div></div>
      <span class="amt">${signed(x.amount)}</span><span class="actions">
      ${x.status === "planned" ? `<button class="small" data-action="tx-confirm" data-id="${esc(x.id)}">${x.amount < 0 ? "支払済" : "入金済"}</button>` : ""}
      ${K.canUnconfirm(x, today()) ? `<button class="small" data-action="tx-unconfirm" data-id="${esc(x.id)}">予定に戻す</button>` : ""}
      <button class="small ghost" data-action="tx-edit" data-id="${esc(x.id)}">編集</button></span></li>`;

  /* ---------- 画面: 分析 ---------- */

  const analysisRange = (key) => {
    const t = today();
    const ms = `${t.slice(0, 7)}-01`;
    switch (key) {
      case "lastMonth": { const s = D.addMonths(ms, -1); return [s, D.endOfMonth(s)]; }
      case "3months": return [D.addMonths(ms, -2), D.endOfMonth(t)];
      case "payPeriod": {
        // 前回の給料日〜次の給料日前日
        const next = rangeEnd("payday", t);
        const prev = K.nextPayday(state.settings, D.addDays(D.addMonths(next, -1), -3));
        return [prev <= t ? prev : D.addMonths(next, -1), D.addDays(next, -1)];
      }
      case "year": return [`${t.slice(0, 4)}-01-01`, `${t.slice(0, 4)}-12-31`];
      default: return [ms, D.endOfMonth(t)];
    }
  };

  const viewAnalysis = () => {
    const [start, end] = analysisRange(ui.analysisRange);
    const sum = K.categorySummary(state, start, end, { today: today(), includePlanned: ui.includePlanned });
    const days = D.diffDays(start, end) + 1;
    const benchScale = days / (365.2425 / 12);
    const max = Math.max(1, ...sum.groups.map((g) => g.total), ...sum.groups.map((g) => (Number(cat(g.categoryId).benchmark) || 0) * benchScale));

    let html = `<section class="scroll-x" role="group" aria-label="期間">${[
      ["thisMonth", "今月"], ["lastMonth", "先月"], ["payPeriod", "今回の給料期間"], ["3months", "3か月"], ["year", "今年"],
    ].map(([k, l]) => `<button class="chip" aria-pressed="${ui.analysisRange === k}" data-action="arange" data-key="${k}">${l}</button>`).join("")}</section>`;
    html += `<section class="row between wrap"><span class="small muted num">${esc(D.dayLabel(start))}〜${esc(D.dayLabel(end))}（${days}日）</span>
      <label class="check small"><input type="checkbox" data-bind="includePlanned" ${ui.includePlanned ? "checked" : ""}> 今日以降の予定・日割りを含める</label></section>`;

    html += `<section class="card"><div class="row between"><h3>カテゴリ別の支出</h3><b class="num">${esc(yen(sum.total))}</b></div>`;
    if (!sum.groups.length) {
      html += `<p class="muted small">この期間の支出はまだありません。${ui.includePlanned ? "" : "「予定・日割りを含める」をオンにすると予測分も集計します。"}</p>`;
    } else {
      const hasBench = sum.groups.some((g) => Number(cat(g.categoryId).benchmark) > 0);
      if (hasBench || ui.includePlanned) {
        html += `<div class="legend">${ui.includePlanned ? `<span><i style="border-top:8px solid var(--s1);width:12px"></i>実績</span><span><i style="border-top:8px solid color-mix(in srgb,var(--s1) 55%,var(--surface));width:12px"></i>予定・日割り</span>` : ""}${hasBench ? `<span><i style="border:0;border-left:2px solid var(--text);height:12px;width:2px"></i>比較基準（期間換算）</span>` : ""}</div>`;
      }
      html += `<div class="bars">`;
      sum.groups.forEach((g) => {
        const c = cat(g.categoryId);
        const actual = g.items.filter((i) => i.kind === "actual").reduce((s, i) => s + i.amount, 0);
        const bench = (Number(c.benchmark) || 0) * benchScale;
        const open = ui.openCat === g.categoryId;
        const pct = ((g.total / sum.total) * 100).toFixed(0);
        html += `<button class="bar-row" data-action="cat-open" data-id="${esc(g.categoryId)}" aria-expanded="${open}" title="${esc(c.name)} ${esc(yen(g.total))}（${pct}%）${bench ? ` / 基準 ${esc(yen(bench))}` : ""}">
          <span class="name">${catSwatch(g.categoryId)}<span class="ellipsis">${esc(c.name)}</span></span>
          <span class="bar-track"><span class="bar-fill planned" style="width:${((g.total / max) * 100).toFixed(2)}%"></span><span class="bar-fill" style="width:${((actual / max) * 100).toFixed(2)}%;${actual ? "" : "display:none"}"></span>${bench ? `<span class="bar-bench" style="left:${((bench / max) * 100).toFixed(2)}%"></span>` : ""}</span>
          <span class="val num">${esc(yen(g.total))}<span class="tiny" style="display:block;font-weight:400">${pct}%${bench ? `・基準${esc(C.shortYen(Math.round(bench)))}` : ""}</span></span></button>`;
        if (open) {
          html += `<div class="bar-detail"><ul class="list">${g.items
            .map((i) => `<li><span class="date">${esc(D.dayLabel(i.date))}</span><div class="grow ellipsis small">${esc(i.label || c.name)}${i.kind === "planned" ? ' <span class="badge">予定</span>' : ""}</div><span class="amt num small">${esc(yen(i.amount))}</span></li>`)
            .join("")}</ul></div>`;
        }
      });
      html += `</div>`;
    }
    html += `<p class="tiny" style="margin:10px 0 0">バーをタップすると内訳を表示。比較基準は「メニュー › カテゴリ」で月額を設定できます（総務省「家計調査」の単身世帯・年代別の値などを参考に。寮費・実家暮らしで大きく違う住居費などは自分用に補正してください）。</p></section>`;
    return html;
  };

  /* ---------- 画面: メニュー ---------- */

  const MENU = [
    ["accounts", "口座", "残高・振替の状況"],
    ["recurrences", "定期の支払い・収入", "家賃・サブスク・後払い・給料"],
    ["payslips", "給与明細", "残業の時給換算・次回の見込み"],
    ["goals", "目標", "必要な月間貯金額"],
    ["living", "生活費の設定", "平日・休日の単価、雑費枠"],
    ["categories", "カテゴリ", "色・比較基準"],
    ["periods", "給料期間の収支", "期間ごとの費用・貯金見込み・予算枠・リボ"],
    ["import", "画像から取り込む", "レシート・残高・請求・給与明細"],
    ["earncal", "稼ぐ目安カレンダー", "年収目標・貯金目標に平日いくら"],
    ["settings", "設定・データ", "給料日・通知・バックアップ"],
  ];

  const viewMenu = () =>
    `<section class="menu-grid">${MENU.map(([k, t, s]) => `<button data-sub-go="${k}"><b>${t}</b><span>${s}</span></button>`).join("")}</section>`;

  const viewAccounts = () => {
    let html = `<section class="row between"><h2 style="margin:0">口座</h2><button class="primary small" data-action="account-new">＋ 口座を追加</button></section>`;
    if (!state.accounts.length) return html + needAccounts();
    html += `<section class="card"><ul class="list">${state.accounts
      .map((a) => `<li><div class="grow"><div class="ellipsis"><b>${esc(a.name)}</b> ${a.includeInTotal === false ? '<span class="badge">合計に含めない</span>' : ""}</div>
        <div class="meta">${a.id === state.settings.salaryAccountId ? "給与の入金先・" : ""}${K.livingAccounts(state).includes(a.id) ? `生活費の支払元${K.livingAccounts(state).length > 1 ? "①②③④⑤⑥⑦⑧⑨"[K.livingAccounts(state).indexOf(a.id)] || "" : ""}・` : ""}${esc(a.note || "")}</div></div>
        <span class="amt num">${esc(yen(a.balance))}</span><span class="actions"><button class="small" data-action="account-balance" data-id="${esc(a.id)}">残高更新</button><button class="small ghost" data-action="account-edit" data-id="${esc(a.id)}">編集</button></span></li>`)
      .join("")}</ul>
      <div class="row between" style="margin-top:8px"><span class="muted small">合計（対象口座）</span><b class="num">${esc(yen(K.sumBalances(state, K.totalAccountIds(state))))}</b></div></section>`;

    const t = today();
    const active = state.transfers.filter((x) => x.status !== "done").sort((a, b) => (a.date < b.date ? -1 : 1));
    const done = state.transfers.filter((x) => x.status === "done").sort((a, b) => (a.date > b.date ? -1 : 1)).slice(0, 10);
    const trItem = (x) => {
      const overdue = K.IN_FLIGHT.includes(x.status) && x.date < t;
      return `<li><span class="date">${esc(D.dayLabelLong(x.date))}</span><div class="grow"><div class="ellipsis">${esc(accName(x.fromId))} → ${esc(accName(x.toId))}</div>
        <div class="meta">${esc(x.label || "")}${overdue ? ' <span class="badge warn">予定日超過</span>' : ""}</div></div>
        <span class="amt num">${esc(yen(x.amount))}</span>
        <span class="actions"><select data-action="transfer-status" data-id="${esc(x.id)}" aria-label="状態" style="width:auto;padding:4px 8px;font-size:14px">${Object.entries(K.TRANSFER_STATUS).map(([k, v]) => `<option value="${k}" ${k === x.status ? "selected" : ""}>${v}</option>`).join("")}</select>
        <button class="small ghost danger" data-action="transfer-delete" data-id="${esc(x.id)}" aria-label="削除">×</button></span></li>`;
    };
    html += `<section class="card"><div class="row between"><h3>振替・出金の状況</h3><button class="small" data-action="go-transfer">＋ 振替</button></div>
      <p class="tiny">予定 → 申請中 → 着金待ち → 着金済み。状態を変えると口座残高に自動で反映されます。</p>
      ${active.length ? `<ul class="list">${active.map(trItem).join("")}</ul>` : `<p class="muted small">進行中の振替はありません</p>`}
      ${done.length ? `<details style="margin-top:8px"><summary>着金済み（最近10件）</summary><ul class="list">${done.map(trItem).join("")}</ul></details>` : ""}</section>`;
    return html;
  };

  const describeDays = (r) => {
    if (r.onPayday) return `毎月 給料日${r.startDate ? `（${r.startDate.slice(0, 7).replace("-", "/")}〜${r.endDate ? r.endDate.slice(0, 7).replace("-", "/") : ""}）` : ""}`;
    const days = r.days.map((d) => (Number(d) >= 31 ? "末日" : `${d}日`)).join("・");
    const every = Number(r.intervalMonths) > 1 ? `${r.intervalMonths}か月ごと` : "毎月";
    const adj = r.adjust === "prev" ? "（休日は前営業日）" : r.adjust === "next" ? "（休日は翌営業日）" : "";
    return `${every} ${days}${adj}`;
  };

  const viewRecurrences = () => {
    let html = `<section class="row between"><h2 style="margin:0">定期の支払い・収入</h2><button class="primary small" data-action="rec-new">＋ 追加</button></section>`;
    if (!state.accounts.length) return html + needAccounts();
    if (!state.recurrences.length) return html + `<div class="card empty"><p>家賃・寮費、サブスク、後払い（PayPay・d払いなど）、給料を登録すると予測に反映されます。</p></div>`;
    const groups = [
      ["支出", state.recurrences.filter((r) => !r.toAccountId && r.amount < 0)],
      ["収入", state.recurrences.filter((r) => !r.toAccountId && r.amount >= 0)],
      ["口座間の振替", state.recurrences.filter((r) => r.toAccountId)],
    ];
    groups.forEach(([title, list]) => {
      if (!list.length) return;
      const monthly = list.reduce((s, r) => s + (r.amount * r.days.length) / (Number(r.intervalMonths) || 1), 0);
      html += `<section class="card"><div class="row between"><h3>${title}</h3><span class="small muted">月あたり <b class="num" style="color:var(--text)">${esc(yen(Math.abs(monthly)))}</b></span></div><ul class="list">${list
        .map((r) => `<li>${catSwatch(r.categoryId)}<div class="grow"><div class="ellipsis">${esc(r.label)}</div><div class="meta">${esc(describeDays(r))}・${esc(r.toAccountId ? `${accName(r.accountId)} → ${accName(r.toAccountId)}` : accName(r.accountId))}${r.endDate ? `・${esc(r.endDate)}まで` : ""}</div></div>
          <span class="amt">${r.toAccountId ? `<span class="num">${esc(yen(Math.abs(r.amount)))}</span>` : signed(r.amount)}</span><span class="actions"><button class="small ghost" data-action="rec-edit" data-id="${esc(r.id)}">編集</button></span></li>`)
        .join("")}</ul></section>`;
    });
    return html;
  };

  const viewPayslips = () => {
    const slips = K.sortedPayslips(state);
    const rate = K.overtimeRate(slips);
    const hours = ui.draft.otHours ?? "";
    const est = K.estimateNextPay(slips, Number(hours) || 0);
    const payday = rangeEnd("payday");
    let html = `<section class="row between"><h2 style="margin:0">給与明細</h2><button class="primary small" data-action="slip-new">＋ 明細を追加</button></section>`;
    if (!slips.length) return html + `<div class="card empty"><p>支給額合計・控除額合計・残業時間・時間外手当を入れると、残業1時間あたりの手当と次回の手取り見込みを計算します。</p></div>`;

    html += `<section class="tiles">
      <div class="card tile"><div class="label">残業1時間あたり（平均）</div><div class="value num">${rate ? esc(yen(rate.average)) : "—"}</div><div class="sub">${rate ? `直近 ${esc(yen(rate.latest))}・${rate.samples}件から` : "残業時間と時間外手当を入力してください"}</div></div>
      <div class="card tile"><div class="label">直近の差引支給額</div><div class="value num">${esc(yen(slips[slips.length - 1].net))}</div><div class="sub">${esc(slips[slips.length - 1].payDate)}</div></div>
    </section>`;

    html += `<section class="card"><h3>次回の給与見込み</h3>
      <label class="field">次回の残業時間<input type="number" inputmode="decimal" min="0" step="0.5" data-bind="otHours" value="${esc(hours)}" placeholder="例: 20"></label>
      ${est ? `<table class="data" style="margin-top:10px"><tbody>
        <tr><td>基本部分（直近の支給額 − 時間外手当）</td><td class="r num">${esc(yen(est.baseGross))}</td></tr>
        <tr><td>時間外手当（${esc(yen(est.rate))} × ${esc(String(Number(hours) || 0))}時間）</td><td class="r num">${esc(yen(est.overtimePay))}</td></tr>
        <tr><td>支給額合計</td><td class="r num">${esc(yen(est.gross))}</td></tr>
        <tr><td>控除額（控除率 ${(est.deductionRate * 100).toFixed(1)}%）</td><td class="r num">−${esc(yen(est.deductions))}</td></tr>
        <tr><td><b>差引支給額（見込み）</b></td><td class="r num"><b>${esc(yen(est.net))}</b></td></tr></tbody></table>
        <p class="tiny">控除率は直近の明細（${esc(est.basedOn)}）と同じと仮定しています。</p>
        <button class="primary" data-action="slip-plan" data-amount="${est.net}" ${state.settings.salaryAccountId ? "" : "disabled"}>${esc(D.dayLabelLong(payday))}の給与予定として登録</button>
        ${state.settings.salaryAccountId ? "" : `<p class="tiny">「設定」で給与の入金口座を選ぶと登録できます。</p>`}` : ""}
    </section>`;

    html += `<section class="card"><h3>履歴</h3><div class="table-wrap"><table class="data"><thead><tr><th>支給日</th><th class="r">支給額</th><th class="r">控除額</th><th class="r">差引支給額</th><th class="r">残業</th><th class="r">時給換算</th><th></th></tr></thead><tbody>${[...slips]
      .reverse()
      .map((p) => `<tr><td>${esc(p.payDate)}</td><td class="r num">${esc(yen(p.gross))}</td><td class="r num">${esc(yen(p.deductions))}</td><td class="r num"><b>${esc(yen(p.net))}</b></td>
        <td class="r num">${p.overtimeHours ? `${esc(p.overtimeHours)}h` : "—"}</td><td class="r num">${p.overtimeHours && p.overtimePay ? esc(yen(p.overtimePay / p.overtimeHours)) : "—"}</td>
        <td class="r"><button class="small ghost" data-action="slip-edit" data-id="${esc(p.id)}">編集</button></td></tr>`)
      .join("")}</tbody></table></div></section>`;
    return html;
  };

  // 「30歳の誕生日（2030/5/12）までに ¥8,000,000・今26歳・あと3.6年」
  const goalPeriodText = (g, p) => {
    const until = g.targetAge && p.targetAge ? `${p.targetAge}歳の誕生日（${p.targetDate}）まで` : `${p.targetDate}まで`;
    const parts = [`${until}に ${yen(p.target)}`];
    if (p.ageNow !== null && p.ageNow !== undefined) parts.push(`今${p.ageNow}歳`);
    parts.push(p.notStarted ? `${p.startDate}から貯め始めて${p.years.toFixed(1)}年` : `あと${p.years.toFixed(1)}年`);
    return parts.join("・");
  };

  const viewGoals = () => {
    let html = `<section class="row between"><h2 style="margin:0">目標</h2><button class="primary small" data-action="goal-new">＋ 目標を追加</button></section>`;
    if (!state.goals.length) return html + `<div class="card empty"><p>例：「30歳までに800万円」。期日と金額から必要な月間・年間の貯金額を逆算します。</p></div>`;
    const t = today();
    state.goals.forEach((g) => {
      const p = K.goalPlan(state, g, { today: t });
      const level = p.onTrack ? "good" : "warning";
      html += `<section class="card"><div class="row between"><h3>${esc(g.label || "目標")}</h3><button class="small ghost" data-action="goal-edit" data-id="${esc(g.id)}">編集</button></div>
        <p class="small muted" style="margin:0 0 8px">${esc(goalPeriodText(g, p))}</p>
        <div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(p.progress * 100)}" aria-label="進捗"><div style="width:${(p.progress * 100).toFixed(1)}%"></div></div>
        <div class="row between small" style="margin:4px 0 12px"><span class="num">現在 ${esc(yen(p.current))}</span><span class="num">${Math.round(p.progress * 100)}%</span></div>
        <div class="tiles">
          <div class="tile"><div class="label">必要な貯金額</div><div class="value num">${esc(yen(p.requiredMonthly))}<span class="small">/月</span></div><div class="sub num">年 ${esc(yen(p.requiredYearly))}</div></div>
          <div class="tile"><div class="label">今のペース（${p.paceSource === "manual" ? "手入力" : "12か月予測"}）</div><div class="value num">${esc(yen(p.pace))}<span class="small">/月</span></div>
            <div class="sub">${g.includeWindfall ? "臨時収入を含む" : `臨時収入を除外${p.windfallExcluded ? `（${esc(yen(p.windfallExcluded))}）` : ""}`}</div></div>
          <div class="tile"><div class="label">このペースだと期日に</div><div class="value num">${esc(yen(p.projected))}</div></div>
        </div>
        ${alertBox(level, `<div>${p.onTrack ? "順調です" : `要調整：月あと <b class="num">${esc(yen(p.gapMonthly))}</b> 貯金を増やす必要があります`}</div>`)}
        <button style="width:100%;margin-bottom:10px" data-action="earncal" data-id="${esc(g.id)}">📅 平日にいくら稼げば届くか（カレンダー）</button>
        <p class="tiny" style="margin:0">必要額 = （目標金額 − 現在資産）÷ 貯め始める日から期日までの期間。予測ペースは定期収支・生活費・予定から今後12か月の増減を出したもの${K.inFlightTotal(state, "total") ? "（着金待ちは含めない）" : ""}。</p></section>`;
    });
    return html;
  };

  /* ---------- 画面: 稼ぐ目安カレンダー ---------- */

  // カレンダー本体（どちらのモードでも共通）。cell(d) はその日のマスの中身
  const calendarGrid = (cal, cell, ariaTitle) => {
    const [y, m] = cal.month.split("-").map(Number);
    return `<div class="row between" style="margin-bottom:8px">
        <button class="small ghost" data-action="cal-month" data-key="${cal.prevMonth}" ${cal.hasPrev ? "" : "disabled"} aria-label="前の月">‹</button>
        <b>${y}年${m}月</b>
        <button class="small ghost" data-action="cal-month" data-key="${cal.nextMonth}" ${cal.hasNext ? "" : "disabled"} aria-label="次の月">›</button>
      </div>
      <div class="cal" role="grid" aria-label="${esc(`${y}年${m}月の${ariaTitle}`)}">
        ${D.WEEK.map((w) => `<div class="cal-head">${w}</div>`).join("")}
        ${'<div class="cal-cell blank"></div>'.repeat(D.dow(cal.first))}
        ${cal.days.map((d) => {
          const c = cell(d);
          const cls = ["cal-cell", d.dayOff ? "off" : "work", d.past || d.inPeriod === false ? "past" : "", d.today ? "today" : "", c.cls || ""].join(" ");
          const inner = c.html || (d.dayOff && d.holiday ? `<span class="cal-sub ellipsis">${esc(d.holiday)}</span>` : "");
          const label = `${D.dayLabelLong(d.date)}${d.holiday ? ` ${d.holiday}` : ""}${d.dayOff ? " 休み" : ""}${c.label ? ` ${c.label}` : ""}`;
          return `<div class="${cls}" role="gridcell" aria-label="${esc(label)}"><span class="cal-day num">${Number(d.date.slice(8))}</span>${inner}</div>`;
        }).join("")}
      </div>`;
  };

  const short = (n) => Math.round(n).toLocaleString("ja-JP");

  // 年収目標モード：基本給以外に平日いくら稼げば年収目標に届くか
  const viewIncomeCal = (t, month) => {
    const st = state.settings;
    const cal = K.incomeCalendar(state, { today: t, month });
    const [y, m] = month.split("-").map(Number);
    let html = `<section class="card"><form class="stack" data-form="income-target" style="gap:10px">
        <div class="grid2">
          <label class="field">年収の目標（額面）<input name="annualIncomeTarget" inputmode="numeric" value="${esc(st.annualIncomeTarget || "")}" placeholder="400万"></label>
          <label class="field">基本給（月・額面）<input name="baseMonthlyPay" inputmode="numeric" value="${esc(st.baseMonthlyPay || "")}" placeholder="18万"></label>
        </div>
        <div class="grid2">
          <label class="field">ボーナス（年間の合計・額面）<input name="annualBonus" inputmode="numeric" value="${esc(st.annualBonus || "")}" placeholder="例: 60万"></label>
          <button type="submit" style="align-self:end">保存</button>
        </div>
        ${!Number(st.annualBonus) ? `<p class="tiny" style="margin:0;color:var(--critical)">ボーナスの金額を入れると、その分を差し引いて計算します（今は0円で計算中）</p>` : ""}
      </form></section>`;

    const SRC = { payslip: "給与明細", deposit: "入金から推定", "deposit-net": "入金額（手取り）", assumed: "基本給で仮定", future: "これから" };
    if (cal.thisYear) {
      const y0 = cal.ytd.year;
      const assumed = cal.ytd.months.filter((x) => x.source === "assumed").length;
      html += `<section class="card"><h3>${y0}年の年収 ${esc(yen(cal.annual))} まで</h3>
        <div class="tiles" style="margin-top:8px">
          <div class="tile"><div class="label">もらった給料（額面）</div><div class="value num">${esc(yen(cal.ytd.gross + cal.ytd.bonusReceived))}</div><div class="sub">${cal.ytd.bonusReceived ? `うちボーナス ${esc(yen(cal.ytd.bonusReceived))}` : "ボーナスはまだ"}</div></div>
          <div class="tile"><div class="label">これからの基本給</div><div class="value num">${esc(yen(cal.base * cal.remainingPaychecks))}</div><div class="sub">${esc(yen(cal.base))} × ${cal.remainingPaychecks}回</div></div>
          <div class="tile"><div class="label">これからのボーナス</div><div class="value num">${esc(yen(cal.bonusRemaining))}</div></div>
          <div class="tile"><div class="label">残業・手当で稼ぐ分</div><div class="value num">${esc(yen(cal.extraNeeded))}</div><div class="sub">残りの平日 ${cal.remainingWorkdays}日</div></div>
        </div>
        ${cal.onTrack
          ? alertBox("good", `<div>基本給とボーナスだけで ${esc(yen(cal.annual))} に届きます</div>`)
          : alertBox("warning", `<div>年末まで<b>平日1日あたり額面 <span class="num">${esc(yen(cal.perDayGross))}</span></b>${cal.perDayHours !== null ? `（残業 約<b class="num">${cal.perDayHours}</b>時間）` : ""} 基本給に上乗せで稼げば届きます${cal.perDayNet !== null ? `。手取りだと約 <span class="num">${esc(yen(cal.perDayNet))}</span>` : ""}。給料が入るたびに更新されます</div>`)}
        ${assumed ? `<p class="tiny" style="margin:0">給与明細も入金の記録もない月が${assumed}か月あり、基本給で仮定しています。給与明細を登録（画像から取り込みも可）すると正確になります。</p>` : ""}
        <details style="margin-top:8px"><summary>月ごとの支給額</summary>
          <table class="data" style="margin-top:6px"><tbody>${cal.ytd.months.map((x) => `<tr><td>${Number(x.month.slice(5))}月</td><td class="r num">${x.paid ? esc(yen(x.gross)) : "—"}</td><td class="tiny">${SRC[x.source]}</td></tr>`).join("")}</tbody></table>
          <div class="row" style="gap:8px;margin-top:8px"><button class="small" data-sub-go="payslips">給与明細を追加</button><button class="small" data-sub-go="import">画像から取り込む</button></div>
        </details>
      </section>`;
    } else {
      html += `<section class="card">
        <div class="tiles">
          <div class="tile"><div class="label">月の目標（ボーナス除く）</div><div class="value num">${esc(yen(cal.monthlyTarget))}</div><div class="sub num">（${esc(yen(cal.annual))} − ${esc(yen(cal.bonus))}）÷ 12</div></div>
          <div class="tile"><div class="label">基本給</div><div class="value num">${esc(yen(cal.base))}</div></div>
          <div class="tile"><div class="label">残業・手当で稼ぐ分</div><div class="value num">${esc(yen(cal.extraMonthly))}<span class="small">/月</span></div></div>
        </div>
        ${cal.onTrack
          ? alertBox("good", `<div>基本給とボーナスだけで年収目標に届きます</div>`)
          : alertBox("warning", `<div>${y}年${m}月は平日 ${cal.workdays}日。<b>平日1日あたり額面 <span class="num">${esc(yen(cal.perDayGross))}</span></b>${cal.perDayHours !== null ? `（残業 約<b class="num">${cal.perDayHours}</b>時間）` : ""} 基本給に上乗せで稼げば届きます${cal.perDayNet !== null ? `。手取りだと約 <span class="num">${esc(yen(cal.perDayNet))}</span>` : ""}</div>`)}
      </section>`;
    }

    html += `<section class="card">${calendarGrid(cal, (d) => {
      if (!d.target || d.dayOff) return {};
      if (cal.onTrack) return { html: `<span class="cal-sub">✓</span>` };
      return {
        html: `<span class="cal-amt num">${short(cal.perDayGross)}</span>${cal.perDayHours !== null ? `<span class="cal-sub num">${cal.perDayHours}h</span>` : ""}`,
        label: `額面${yen(cal.perDayGross)}${cal.perDayHours !== null ? `・残業約${cal.perDayHours}時間` : ""}`,
      };
    }, "年収目標の稼ぐ目安")}
      <p class="tiny" style="margin:10px 0 0">数字は平日1日あたり基本給に上乗せで稼ぐ額面（円）、h は残業時間の目安。灰色は土日・祝日・会社の休み。</p></section>`;

    html += `<section class="card"><h3>計算のしかた</h3><ul class="small" style="margin:0;padding-left:18px;display:grid;gap:4px">
      ${cal.thisYear
        ? `<li>残業・手当で稼ぐ分 ＝ 年収の目標 − もらった給料 − これからの基本給 − これからのボーナス ＝ <span class="num">${esc(yen(cal.extraNeeded))}</span></li>
      <li>平日1日あたり ＝ 残業・手当で稼ぐ分 ÷ 今日から年末までの平日数（${cal.remainingWorkdays}日）</li>
      <li>もらった給料は、給与明細の支給額 → なければ給与の入金（手取り）を控除率で額面に戻した額 → どちらもなければ基本給、の順で数えます</li>`
        : `<li>月の目標 ＝（年収の目標 − ボーナス）÷ 12 ＝ <span class="num">${esc(yen(cal.monthlyTarget))}</span></li>
      <li>残業・手当で稼ぐ分 ＝ 月の目標 − 基本給 ＝ <span class="num">${esc(yen(cal.extraMonthly))}</span></li>
      <li>平日1日あたり ＝ 残業・手当で稼ぐ分 ÷ その月の平日数（${cal.workdays}日）</li>`}
      <li>残業時間 ＝ 額面 ÷ 残業1時間あたり ${esc(yen(cal.overtimeRate))}${cal.rateSource === "estimate" ? "（基本給 ÷ 月の所定時間 約163時間 × 1.25 で推定。給与明細を登録すると実際の単価を使います）" : "（給与明細から）"}</li>
      ${cal.deductionRate !== null ? `<li>手取り ＝ 額面 ×（1 − 控除率 ${(cal.deductionRate * 100).toFixed(1)}%）</li>` : ""}
      <li>年収は額面（税金・社会保険を引く前）の金額です</li></ul></section>`;
    return html;
  };

  // 貯金目標モード：目標の貯金に届くには平日いくら上乗せで稼げばいいか（手取り）
  const viewSavingsCal = (t, month) => {
    if (!state.goals.length) return `<div class="card empty"><p>貯金の目標がまだありません。</p><button class="primary" data-sub-go="goals">目標を登録する</button></div>`;
    const g = state.goals.find((x) => x.id === ui.calGoalId) || state.goals[0];
    const plan = K.goalPlan(state, g, { today: t });
    const cal = K.earningsCalendar(state, g, { today: t, month, plan });
    const [y, m] = month.split("-").map(Number);
    let html = "";
    if (state.goals.length > 1) {
      html += `<section><label class="field">目標<select data-bind="calGoalId">${state.goals.map((x) => `<option value="${esc(x.id)}" ${x.id === g.id ? "selected" : ""}>${esc(x.label)}</option>`).join("")}</select></label></section>`;
    }
    html += `<section class="card"><h3>${esc(g.label)}</h3>
      <div class="tiles" style="margin-top:8px">
        <div class="tile"><div class="label">必要な貯金</div><div class="value num">${esc(yen(plan.requiredMonthly))}<span class="small">/月</span></div></div>
        <div class="tile"><div class="label">今のペース</div><div class="value num">${esc(yen(plan.pace))}<span class="small">/月</span></div></div>
        <div class="tile"><div class="label">不足</div><div class="value num">${esc(yen(plan.gapMonthly))}<span class="small">/月</span></div></div>
      </div>
      ${plan.onTrack
        ? alertBox("good", `<div>今のペースで届きます。上乗せで稼ぐ必要はありません（参考：必要な貯金は平日1日あたり ${esc(yen(cal.perDaySaving))}）</div>`)
        : alertBox("warning", `<div>${y}年${m}月は平日 ${cal.workdays}日。<b>平日1日あたり手取りで <span class="num">${esc(yen(cal.perDayNet))}</span></b> 多く稼げば届きます${cal.perDayGross !== null ? `（額面 <span class="num">${esc(yen(cal.perDayGross))}</span>${cal.perDayHours !== null ? `・残業 約<b class="num">${cal.perDayHours}</b>時間` : ""}）` : ""}</div>`)}
    </section>`;
    html += `<section class="card">${calendarGrid(cal, (d) => {
      if (!d.target) return {};
      if (plan.onTrack) return { html: `<span class="cal-sub">✓</span>` };
      return {
        html: `<span class="cal-amt num">${short(cal.perDayNet)}</span>${cal.perDayHours !== null ? `<span class="cal-sub num">${cal.perDayHours}h</span>` : ""}`,
        label: `手取り${yen(cal.perDayNet)}${cal.perDayHours !== null ? `・残業約${cal.perDayHours}時間` : ""}`,
      };
    }, "貯金目標の稼ぐ目安")}
      <p class="tiny" style="margin:10px 0 0">数字は平日1日あたり上乗せで必要な手取り（円）${cal.perDayHours !== null ? "、h は残業時間の目安" : ""}。灰色は土日・祝日・会社の休み。</p></section>`;
    html += `<section class="card"><h3>計算のしかた</h3><ul class="small" style="margin:0;padding-left:18px;display:grid;gap:4px">
      <li>不足 ＝ 必要な貯金（月） − 今のペース（月）＝ <span class="num">${esc(yen(plan.gapMonthly))}</span></li>
      <li>平日1日あたり ＝ 不足 ÷ その月の平日数（${cal.workdays}日）</li>
      ${cal.deductionRate !== null ? `<li>額面 ＝ 手取り ÷ （1 − 控除率 ${(cal.deductionRate * 100).toFixed(1)}%）</li>` : `<li>給与明細を登録すると、額面と残業時間も出ます</li>`}
      ${cal.overtimeRate ? `<li>残業時間 ＝ 額面 ÷ 残業1時間あたり ${esc(yen(cal.overtimeRate))}</li>` : ""}
      <li>残業代はふつう翌月の給料で入るので、入金はそのぶん遅れます</li></ul></section>`;
    return html;
  };

  const viewEarnCal = () => {
    const t = today();
    let month = ui.calMonth || t.slice(0, 7);
    if (month < t.slice(0, 7)) month = t.slice(0, 7);
    const mode = ui.calMode === "savings" ? "savings" : "income";
    return `<section><div class="seg" role="group" aria-label="目安の種類">
        <button aria-pressed="${mode === "income"}" data-action="cal-mode" data-key="income">年収目標</button>
        <button aria-pressed="${mode === "savings"}" data-action="cal-mode" data-key="savings">貯金目標</button></div></section>
      ${mode === "income" ? viewIncomeCal(t, month) : viewSavingsCal(t, month)}`;
  };

  /* ---------- 画面: 給料期間の収支 ---------- */

  const PER_TABS = [["summary", "集計"], ["calendar", "カレンダー"], ["items", "予定"], ["budget", "予算枠"], ["revo", "リボ"]];
  const GROUP_SERIES = [["living", "生活費", "s1"], ["misc", "雑費", "s2"], ["fixed", "固定費", "s3"], ["repay", "返済", "s4"]];
  const mmdd = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
  const ymd2 = (d) => `${d.slice(2, 4)}/${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;

  const viewPeriods = () => {
    if (!state.accounts.length) return needAccounts();
    const tab = PER_TABS.some(([k]) => k === ui.perTab) ? ui.perTab : "summary";
    let html = `<section class="scroll-x" role="group" aria-label="表示">${PER_TABS.map(([k, l]) => `<button class="chip" aria-pressed="${tab === k}" data-action="per-tab" data-key="${k}">${l}</button>`).join("")}</section>`;
    html += { summary: perSummary, calendar: perCalendar, items: perItems, budget: perBudget, revo: perRevo }[tab]();
    return html;
  };

  const perRules = () => {
    const st = state.settings;
    return `<p class="tiny" style="margin:6px 0 0">生活費：平日 ${esc(yen(st.weekdayCost))}・休日 ${esc(yen(st.holidayCost))}／雑費：給料期間ごとに ${esc(yen(st.miscMonthly))}／給料日：毎月${esc(st.payday)}日（休日は${st.paydayAdjust === "next" ? "翌" : st.paydayAdjust === "none" ? "そのまま" : "前の"}${st.paydayAdjust === "none" ? "" : "平日"}）
      <button class="link small" data-sub-go="living">生活費・休みを変更</button>・<button class="link small" data-sub-go="settings">給料日を変更</button></p>`;
  };

  const perSummary = () => {
    const count = Number(ui.perCount) || 6;
    const rows = P.periodTable(state, { today: today(), count, includeCurrent: !!ui.perCurrent });
    let html = `<section class="row wrap" style="gap:12px">
      <label class="field" style="width:auto">期間の数<select data-bind="perCount" style="width:auto">${[3, 6, 12].map((n) => `<option value="${n}" ${n === count ? "selected" : ""}>${n}期間</option>`).join("")}</select></label>
      <label class="check small" style="align-self:end"><input type="checkbox" data-bind="perCurrent" ${ui.perCurrent ? "checked" : ""}> 今の給料期間（今日を含む）から</label>
    </section>`;
    const last = rows[rows.length - 1];
    html += `<section class="tiles">
      <div class="card tile"><div class="label">${rows.length}期間の貯金見込み（累計）</div><div class="value num">${esc(yen(last ? last.cumulative : 0))}</div><div class="sub">${rows.length ? `${ymd2(rows[0].start)}〜${ymd2(last.end)}` : ""}</div></div>
      <div class="card tile"><div class="label">1期間あたりの費用（平均）</div><div class="value num">${esc(yen(rows.length ? rows.reduce((a, r) => a + r.total, 0) / rows.length : 0))}</div></div>
    </section>`;
    html += `<section class="card"><h3>給料期間ごとの費用</h3>
      <div class="legend">${GROUP_SERIES.map(([, name, cls]) => `<span><i class="sw ${cls}"></i>${name}</span>`).join("")}<span>棒の下：給料日／貯金見込みの累計</span></div>
      <div class="chart" id="periodChart"></div>${perRules()}</section>`;
    html += `<section class="card"><h3>集計表</h3><div class="table-wrap"><table class="data period-table"><thead><tr>
      <th>期間</th><th class="r">平日</th><th class="r">休日</th><th class="r">収入</th><th class="r">生活費</th><th class="r">雑費</th><th class="r">固定費</th><th class="r">返済</th><th class="r">費用合計</th><th class="r">貯金見込み</th><th class="r">累計</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td style="white-space:nowrap">${mmdd(r.start)}〜${mmdd(r.end)}</td><td class="r num">${r.weekdays}</td><td class="r num">${r.holidays}</td><td class="r num">${short(r.income)}</td><td class="r num">${short(r.living)}</td><td class="r num">${short(r.misc)}</td><td class="r num">${short(r.fixed)}</td><td class="r num">${short(r.repay)}</td><td class="r num"><b>${short(r.total)}</b></td><td class="r num"><b>${short(r.saving)}</b></td><td class="r num">${short(r.cumulative)}</td></tr>`).join("")}
      </tbody></table></div><p class="tiny" style="margin:6px 0 0">単位：円。期間＝給料日〜次の給料日の前日。別口座の予定は集計に含めません。</p></section>`;
    html += rows.map((r) => `<details class="card" style="margin-bottom:8px"><summary><b>${mmdd(r.start)}〜${mmdd(r.end)}</b>　貯金見込み <b class="num">${esc(yen(r.saving))}</b></summary>
      <ul class="list" style="margin-top:6px">${r.items.map((i) => perItemRow(i)).join("") || '<li class="small muted">予定はありません</li>'}
      <li class="small"><span class="date"></span><div class="grow">生活費（平日${r.weekdays}日×${short(state.settings.weekdayCost)}＋休日${r.holidays}日×${short(state.settings.holidayCost)}）</div><span class="amt num">−${esc(yen(r.living))}</span></li>
      <li class="small"><span class="date"></span><div class="grow">雑費</div><span class="amt num">−${esc(yen(r.misc))}</span></li></ul></details>`).join("");
    return html;
  };

  const perItemRow = (i, { actions = false } = {}) => {
    const src = i.source === "recurrence" ? state.recurrences.find((r) => r.id === i.refId) : state.transactions.find((t) => t.id === i.refId);
    const badge = `<span class="badge">${P.GROUP_LABEL[i.group]}</span>${i.other ? ' <span class="badge">別口座・集計外</span>' : ""}${src && src.tentative ? ` <span class="badge warn">仮：${esc(src.tentative)}</span>` : ""}`;
    const act = !actions ? "" : i.source === "recurrence"
      ? `<span class="actions"><button class="small ghost" data-action="occ-edit" data-id="${esc(i.refId)}" data-date="${esc(i.original)}">変更</button></span>`
      : `<span class="actions"><button class="small ghost" data-action="tx-edit" data-id="${esc(i.refId)}">編集</button></span>`;
    return `<li style="${i.other ? "opacity:.75" : ""}"><span class="date">${esc(D.dayLabelLong(i.date))}</span><div class="grow"><div class="ellipsis">${esc(i.label)}</div><div class="meta">${badge}</div></div><span class="amt">${signed(i.amount)}</span>${act}</li>`;
  };

  const perCalendar = () => {
    const t = today();
    const ym = ui.perMonth || t.slice(0, 7);
    const { items, payday } = P.monthItems(state, ym);
    const first = `${ym}-01`;
    const last = D.endOfMonth(first);
    const days = [];
    for (let d = first; d <= last; d = D.addDays(d, 1)) {
      days.push({ date: d, dayOff: D.isDayOff(d, state.settings.extraHolidays || []), holiday: D.holidayName(d), past: d < t, today: d === t });
    }
    const cal = { month: ym, first, days, prevMonth: D.addMonths(first, -1).slice(0, 7), nextMonth: D.addMonths(first, 1).slice(0, 7), hasPrev: true, hasNext: true };
    let html = `<section class="card">${calendarGrid(cal, (d) => {
      const its = items.filter((i) => i.date === d.date);
      const marks = [
        its.some((i) => !i.other && i.amount > 0) ? '<span class="mark in" title="収入">＋</span>' : "",
        its.some((i) => !i.other && i.amount < 0) ? '<span class="mark out" title="支払い">−</span>' : "",
        its.some((i) => i.other) ? '<span class="mark other" title="別口座">別</span>' : "",
      ].join("");
      const isPay = d.date === payday;
      const label = [isPay ? "給料日・ここから新しい給料期間" : "", ...its.map((i) => `${i.label}${yen(i.amount)}${i.other ? "（別口座）" : ""}`)].filter(Boolean).join("、");
      return { html: `${isPay ? '<span class="cal-pay">給料日</span>' : ""}${marks ? `<span class="cal-marks">${marks}</span>` : ""}`, label, cls: isPay ? "payday" : "" };
    }, "給料期間の予定")}
      <div class="legend" style="margin-top:10px"><span><span class="mark in">＋</span>収入</span><span><span class="mark out">−</span>支払い</span><span><span class="mark other">別</span>別口座（集計外）</span><span><span style="display:inline-block;width:3px;height:12px;background:var(--accent)"></span>給料日（給料期間の区切り）</span></div></section>`;
    const p = P.periodAt(state.settings, first);
    html += `<section class="card"><h3>${Number(ym.slice(5))}月の予定</h3>
      <p class="tiny" style="margin:0 0 6px">給料期間：${ymd2(p.start)}〜${ymd2(p.end)}${payday <= last ? ` ／ ${mmdd(payday)}から次の期間` : ""}</p>
      <ul class="list">${items.map((i) => perItemRow(i, { actions: true })).join("") || '<li class="small muted">予定はありません</li>'}</ul></section>`;
    return html;
  };

  const perItems = () => {
    const t = today();
    const recs = state.recurrences.filter((r) => !r.toAccountId);
    const groupName = (r) => (r.amount > 0 ? "収入" : P.GROUP_LABEL[(K.categoryById(state, r.categoryId) || {}).group || "fixed"]);
    const otherName = (id) => {
      const a = K.accountById(state, id);
      return a ? `${a.name}${a.includeInTotal === false ? "（別口座・集計外）" : ""}` : "";
    };
    const oneOffs = state.transactions.filter((x) => x.status === "planned" && !x.recurrenceId).sort((a, b) => (a.date < b.date ? -1 : 1));
    let html = `<section class="row wrap" style="gap:8px"><button class="primary" data-action="plan-new">＋ 予定を追加</button><button data-action="plan-initial">初期データを追加</button><button class="danger" data-action="fresh-start">まっさらにして初期データを入れる</button></section>`;
    html += `<section class="card"><h3>毎月の予定</h3><ul class="list">${recs.map((r) => `<li><div class="grow"><div class="ellipsis">${esc(r.label)} <span class="badge">${esc(groupName(r))}</span></div>
      <div class="meta">${r.tentative ? `<span class="badge warn">仮：${esc(r.tentative)}</span> ` : ""}${esc(describeDays(r))}${!r.onPayday && r.startDate ? `・${esc(r.startDate.slice(0, 7).replace("-", "/"))}〜${esc(r.endDate ? r.endDate.slice(0, 7).replace("-", "/") : "")}` : ""}・${esc(otherName(r.accountId))}</div></div>
      <span class="amt">${signed(r.amount)}</span><span class="actions"><button class="small ghost" data-action="rec-edit" data-id="${esc(r.id)}">編集</button></span></li>`).join("") || '<li class="small muted">なし</li>'}</ul>
      <p class="tiny" style="margin:6px 0 0">給料など月ごとに金額が違うものは「カレンダー」の予定一覧の「変更」でその月だけ上書きできます。</p></section>`;
    html += `<section class="card"><h3>単発の予定</h3><ul class="list">${oneOffs.map((x) => `<li${x.date < t ? ' style="opacity:.7"' : ""}><span class="date">${esc(ymd2(x.date))}</span><div class="grow"><div class="ellipsis">${esc(x.label)} <span class="badge">${esc(x.amount > 0 ? "収入" : P.GROUP_LABEL[(K.categoryById(state, x.categoryId) || {}).group || "fixed"])}</span></div><div class="meta">${x.tentative ? `<span class="badge warn">仮：${esc(x.tentative)}</span> ` : ""}${esc(otherName(x.accountId))}</div></div>
      <span class="amt">${signed(x.amount)}</span><span class="actions"><button class="small ghost" data-action="tx-edit" data-id="${esc(x.id)}">編集</button></span></li>`).join("") || '<li class="small muted">なし</li>'}</ul></section>`;
    return html;
  };

  const perBudget = () => {
    const b = state.settings.budget || {};
    const r = P.budgetMode(state, b);
    let html = `<section class="card"><h3>予算枠（給料日前など）</h3><form class="stack" data-form="budget" style="gap:10px">
      <div class="grid2"><label class="field">開始日<input type="date" name="start" value="${esc(b.start || today())}"></label>
      <label class="field">終了日<input type="date" name="end" value="${esc(b.end || D.addDays(K.nextPayday(state.settings, today()), -1))}"></label></div>
      <label class="field">使える額（例：後払いの残り枠）<input name="amount" inputmode="numeric" value="${esc(b.amount || "")}" placeholder="例: 27797+10000"></label>
      <label class="check"><input type="checkbox" name="includeMisc" ${b.includeMisc ? "checked" : ""}> 雑費も見込みに含める（給料期間の途中からは日割り）</label>
      <button class="primary" type="submit">計算する</button></form></section>`;
    if (r && r.amount) {
      const level = r.diff >= 0 ? "good" : "critical";
      html += `<section class="tiles">
        <div class="card tile"><div class="label">1日あたり使える額</div><div class="value num">${esc(yen(r.perDay))}</div><div class="sub">${esc(yen(r.amount))} ÷ ${r.days}日</div></div>
        <div class="card tile"><div class="label">見込み支出</div><div class="value num">${esc(yen(r.expected))}</div><div class="sub">生活費 ${esc(yen(r.living))}${r.includeMisc ? `＋雑費 ${esc(yen(r.misc))}` : "（雑費なし）"}</div></div>
        <div class="card tile"><div class="label">${r.diff >= 0 ? "余る" : "足りない"}</div><div class="value num">${esc(yen(Math.abs(r.diff)))}</div></div>
      </section>
      <section>${alertBox(level, `<div>${mmdd(r.start)}〜${mmdd(r.end)}（平日${r.weekdays}日・休日${r.holidays}日）：生活費ルールだと ${esc(yen(r.expected))}。使える額 ${esc(yen(r.amount))} に対して <b class="num">${esc(yen(Math.abs(r.diff)))}</b> ${r.diff >= 0 ? "余ります" : "足りません"}</div>`)}</section>`;
    }
    return html;
  };

  const perRevo = () => {
    const v = ui.revo || { apr: 18, startMonth: D.addMonths(today(), 1).slice(0, 7) };
    const r = P.revolving(v);
    let html = `<section class="card"><h3>リボ返済シミュレーター</h3><div class="stack" style="display:grid;gap:10px" id="revoForm">
      <div class="grid2"><label class="field">残高<input inputmode="numeric" data-revo="balance" value="${esc(v.balance || "")}" placeholder="例: 50000"></label>
      <label class="field">月々の返済額<input inputmode="numeric" data-revo="payment" value="${esc(v.payment || "")}" placeholder="例: 5000"></label></div>
      <div class="grid2"><label class="field">年利（%）<input type="number" step="0.1" data-revo="apr" value="${esc(v.apr ?? 18)}"></label>
      <label class="field">最初の返済月<input type="month" data-revo="startMonth" value="${esc(v.startMonth || "")}"></label></div>
      <label class="field">一括返済する月（任意）<input type="month" data-revo="lumpMonth" value="${esc(v.lumpMonth || "")}"></label>
      <p class="tiny" style="margin:0">利息は「残高 × 年利 × その月の日数 ÷ 365」（円未満切り捨て）で計算する目安です。実際の請求額はカード会社の明細で確認してください。</p></div></section>`;
    if (!r) return html + `<p class="small muted">残高と月々の返済額を入れると計算します。</p>`;
    if (r.neverEnds && !r.rows.length) return html + alertBox("critical", `<div>月々の返済額 ${esc(yen(r.payment))} が利息以下なので、残高が減りません</div>`);
    html += `<section class="tiles">
      <div class="card tile"><div class="label">利息の合計</div><div class="value num">${esc(yen(r.totalInterest))}</div></div>
      <div class="card tile"><div class="label">返済回数</div><div class="value num">${r.rows.length}回</div><div class="sub">${r.rows.length ? `${r.rows[r.rows.length - 1].month.replace("-", "/")}に完済` : ""}</div></div>
      <div class="card tile"><div class="label">支払総額</div><div class="value num">${esc(yen(r.totalPaid || 0))}</div></div></section>`;
    if (r.neverEnds) html += alertBox("critical", "<div>このままでは完済までに50年以上かかります。返済額を増やしてください</div>");
    html += `<section class="card"><h3>返済スケジュール</h3><div class="table-wrap"><table class="data"><thead><tr><th>月</th><th class="r">支払額</th><th class="r">利息</th><th class="r">元金</th><th class="r">残高</th></tr></thead><tbody>
      ${r.rows.map((x) => `<tr><td>${x.month.replace("-", "/")}${x.lump ? ' <span class="badge">一括</span>' : ""}</td><td class="r num">${short(x.payment)}</td><td class="r num">${short(x.interest)}</td><td class="r num">${short(x.principal)}</td><td class="r num">${short(x.balance)}</td></tr>`).join("")}
      </tbody></table></div></section>`;
    return html;
  };

  // 予定の追加（指示書 2-1：名前・金額・日付の種類・開始/終了月・区分・支払い元）
  const planSheet = () => {
    sheetActions = {};
    const accs = state.accounts;
    openSheet("予定を追加", `<div style="display:grid;gap:14px">
      <label class="field">名前<input name="label" required placeholder="例: 電気代、楽天モバイル、d払い"></label>
      <div class="grid2"><label class="field">金額<input name="amount" inputmode="numeric" required></label>
      <label class="field">区分<select name="group"><option value="fixed">固定費</option><option value="repay">返済</option><option value="income-salary">収入（給料）</option><option value="income-bonus">収入（ボーナス）</option><option value="income-other">収入（その他）</option></select></label></div>
      <label class="field">日付<select name="when" id="planWhen"><option value="once">単発（年月日）</option><option value="monthly">毎月 X日</option><option value="payday">毎月 給料日と同じ日（給料のあとに払うもの）</option></select></label>
      <div class="grid2"><label class="field" data-when="once">年月日<input type="date" name="date" value="${esc(today())}"></label>
      <label class="field" data-when="monthly">毎月の日（末日は31）<input type="number" name="day" min="1" max="31" value="27"></label></div>
      <div class="grid2" data-when="repeat"><label class="field">開始月<input type="month" name="startMonth" value="${esc(today().slice(0, 7))}"></label>
      <label class="field">終了月（空欄＝終了なし）<input type="month" name="endMonth"></label></div>
      <label class="field">支払い元<select name="accountId">${accs.map((a) => `<option value="${esc(a.id)}" ${a.id === (state.settings.salaryAccountId || accs[0].id) ? "selected" : ""}>${esc(a.name)}${a.includeInTotal === false ? "（別口座・集計外）" : ""}</option>`).join("")}</select></label>
      <p class="tiny" style="margin:0">別口座（合計に含めない口座）を選ぶと、カレンダーには出ますが集計には入りません。別口座がなければ「メニュー › 口座」で「合計に含める」をオフにした口座を作ってください。</p>
      ${foot(false)}</div>`, (fd) => {
      const amt = Math.abs(money(fd.get("amount")));
      if (!amt) return toast("金額を入れてください"), false;
      const g = fd.get("group");
      const income = g.startsWith("income");
      const categoryId = { fixed: "cat_fixed", repay: "cat_repay", "income-salary": "cat_salary", "income-bonus": "cat_bonus", "income-other": K.WINDFALL }[g];
      const amount = income ? amt : -amt;
      const when = fd.get("when");
      if (when === "once") {
        const date = fd.get("date");
        if (!date) return toast("日付を入れてください"), false;
        K.addTransaction(state, { accountId: fd.get("accountId"), date, amount, categoryId, label: fd.get("label"), status: date > today() ? "planned" : "actual" });
      } else {
        const sm = fd.get("startMonth");
        const em = fd.get("endMonth");
        state.recurrences.push({
          id: K.uid("rec"), label: fd.get("label"), amount, onPayday: when === "payday",
          days: [when === "payday" ? Number(state.settings.payday) || 25 : Math.min(31, Math.max(1, Number(fd.get("day")) || 1))],
          intervalMonths: 1, adjust: "none", accountId: fd.get("accountId"), categoryId,
          startDate: sm ? `${sm}-01` : "", endDate: em ? D.endOfMonth(`${em}-01`) : "", doneDates: [],
        });
      }
      commit();
      toast("予定を追加しました");
    });
    const sync = () => {
      const w = $("#planWhen") && $("#planWhen").value;
      document.querySelectorAll("#sheetBody [data-when]").forEach((el) => {
        const k = el.dataset.when;
        el.hidden = !(k === w || (k === "repeat" && w !== "once"));
      });
    };
    sheetOnInput = sync;
    sync();
  };

  /* ---------- 修正ファイル（予定・収入の追加・変更・削除をJSONで一括適用） ---------- */

  const EDITS_BACKUP_KEY = "kakeibo.beforeEdits";
  const hasEditsBackup = () => {
    try {
      return !!localStorage.getItem(EDITS_BACKUP_KEY);
    } catch (e) {
      return false;
    }
  };

  const editsPreviewHtml = (res) => {
    const c = res.count;
    const icon = { ok: "", skip: "スキップ", fail: "適用しない" };
    return `<div class="small" style="margin-bottom:6px">${c.account ? `口座の追加 ${c.account}・` : ""}追加 ${c.add}・変更 ${c.change}・削除 ${c.delete}${c.skip ? `・スキップ ${c.skip}` : ""}${c.fail ? `・<b style="color:var(--critical)">適用しない ${c.fail}</b>` : ""}</div>
      <ul class="list">${res.items.map((it) => `<li style="display:block">
        <div class="row" style="gap:8px;align-items:flex-start"><span class="badge ${it.status === "fail" ? "" : "accent"}" style="flex:none">${esc(it.status === "ok" ? { add: "追加", change: "変更", delete: "削除", "add-account": "口座の追加" }[it.action] : icon[it.status])}</span>
        <div class="grow small" style="word-break:break-all;${it.status === "fail" ? "color:var(--critical)" : ""}">${esc(it.text.replace(/^(追加|変更|削除|口座の追加): /, ""))}</div></div>
        ${it.notes.map((n) => `<div class="tiny" style="margin:2px 0 0 0;color:var(--critical)">⚠ ${esc(n)}</div>`).join("")}</li>`).join("")}</ul>`;
  };

  const editsSheet = () => {
    let edits = null;
    sheetActions = {
      preview: () => {
        const box = $("#editsPreview");
        const text = $("#editsText").value.trim();
        edits = null;
        $("#editsApply").hidden = true;
        if (!text) {
          box.innerHTML = '<p class="tiny" style="color:var(--critical)">修正ファイルのJSONを貼り付けるか、ファイルを選んでください</p>';
          return false;
        }
        try {
          edits = KEdits.parseEdits(text);
        } catch (e) {
          box.innerHTML = `<p class="tiny" style="color:var(--critical)">${esc(e.message)}</p>`;
          return false;
        }
        const res = KEdits.preview(state, edits, { today: today() });
        box.innerHTML = editsPreviewHtml(res) + (res.applicable ? '<p class="tiny">内容を確認して「適用する」を押すと反映されます。適用前のデータは自動でバックアップされます。</p>' : '<p class="tiny">適用できる行がありません。</p>');
        $("#editsApply").hidden = !res.applicable;
        return false;
      },
      apply: () => {
        if (!edits) return false;
        try {
          localStorage.setItem(EDITS_BACKUP_KEY, JSON.stringify({ savedOn: today(), state }));
        } catch (e) {
          if (!confirm("適用前のバックアップを保存できませんでした（「元に戻す」は直後の数秒だけ使えます）。続けますか？")) return false;
        }
        let res;
        undoable((r) => `修正を適用しました（${r.count.account ? `口座${r.count.account}・` : ""}追加${r.count.add}・変更${r.count.change}・削除${r.count.delete}${r.count.skip + r.count.fail ? `・対象外${r.count.skip + r.count.fail}` : ""}）`, () => {
          res = KEdits.apply(state, edits, { today: today() });
          return res;
        });
      },
    };
    openSheet("修正ファイルを読み込む", `<div style="display:grid;gap:12px">
      <p class="small" style="margin:0">予定・収入の追加・変更・削除と口座の追加を、JSONの修正ファイルでまとめて反映します。いきなり適用はせず、先に差分を表示します。今のデータを置き換える「JSONを読み込む」とは別の機能です。</p>
      <label class="btn" style="display:inline-flex;align-items:center;justify-self:start">ファイルを選ぶ<input type="file" accept="application/json,.json,text/plain" data-action="edits-file" hidden></label>
      <label class="field">または、ここに貼り付け<textarea id="editsText" rows="7" placeholder='{"edits": [ {"action": "add", ...} ]}' style="font-family:monospace;font-size:12px"></textarea></label>
      <button type="submit" data-sheet-action="preview">差分を確認</button>
      <div id="editsPreview"></div>
      <div class="sheet-foot"><button type="submit" class="primary" id="editsApply" data-sheet-action="apply" hidden>適用する</button></div></div>`, () => false);
  };

  // 初期データはコードに入れず、JSONファイルを選んで読み込む（読み込み済みならそのまま実行）
  const withInitial = (run) => {
    if (P.hasInitial()) return run();
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.addEventListener("change", () => {
      if (!input.files[0]) return;
      input.files[0].text().then((text) => {
        try {
          P.loadInitial(JSON.parse(text));
        } catch (err) {
          toast(err instanceof SyntaxError ? "JSONを読み込めませんでした" : err.message);
          return;
        }
        run();
      });
    });
    toast("初期データのJSONファイルを選んでください");
    input.click();
  };

  const initialSheet = () => {
    sheetActions = {};
    const others = state.accounts.filter((a) => a.includeInTotal === false);
    openSheet("初期データを追加", `<div style="display:grid;gap:14px">
      <p class="small" style="margin:0">読み込んだ初期データの予定・収入と、生活費・雑費・給料日・休みの日・予算枠の設定を入れます。今のデータは消えません。同じ名前と金額の定期の予定や、同じ日・同じ金額の予定はとばします。</p>
      <label class="field">メイン口座<select name="mainId">${state.accounts.filter((a) => a.includeInTotal !== false).map((a) => `<option value="${esc(a.id)}" ${a.id === state.settings.salaryAccountId ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select></label>
      <label class="field">別口座（集計から除外する支払い）<select name="otherId">${others.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join("")}<option value="">新しく「別口座」を作る</option></select></label>
      <p class="tiny" style="margin:0;color:var(--critical)">生活費・雑費・給料日の設定は上書きされます。</p>
      <div class="sheet-foot"><button type="submit" class="primary">追加する</button></div></div>`, (fd) => {
      let res;
      try {
        undoable(() => `予定${res.recurrences + res.oneOffs}件と設定を追加しました${res.skipped.length ? `（重複${res.skipped.length}件はとばしました）` : ""}`, () => {
          res = P.applyInitialData(state, { mainId: fd.get("mainId"), otherId: fd.get("otherId"), today: today() });
          ui.perTab = "summary";
          return res;
        });
      } catch (e) {
        toast(e.message);
        return false;
      }
    });
  };

  const viewCover = () => {
    const sel = K.coverAccounts(state);
    const ordered = [...sel.map((id) => K.accountById(state, id)), ...state.accounts.filter((a) => !sel.includes(a.id))];
    return `<section class="card"><h3>残高が足りないとき立て替える口座</h3>
      <p class="tiny" style="margin:0 0 6px">支出で口座の残高が足りなくなる（マイナスになる）見込みのとき、不足分を上から順に、ここで選んだ口座から払う見込みで予測します。生活費以外の支出・定期の支払いも対象です（口座間の振替は除く）。</p>
      <ul class="list">${ordered.map((a) => {
        const k = sel.indexOf(a.id);
        return `<li><div class="row" style="gap:10px">
          <input type="checkbox" data-cover-toggle="${esc(a.id)}" ${k >= 0 ? "checked" : ""} aria-label="${esc(a.name)}で不足分を立て替える">
          ${k >= 0 ? `<span class="badge accent">${"①②③④⑤⑥⑦⑧⑨"[k] || k + 1}</span>` : ""}
          <div class="grow"><div style="word-break:break-all">${esc(a.name)}</div><div class="meta num">残高 ${esc(yen(a.balance))}${a.includeInTotal === false ? "・合計外" : ""}</div></div>
          ${k >= 0 && sel.length > 1 ? `<span class="actions"><button class="small ghost" data-action="cover-up" data-id="${esc(a.id)}" ${k === 0 ? "disabled" : ""} aria-label="上へ">↑</button><button class="small ghost" data-action="cover-down" data-id="${esc(a.id)}" ${k === sel.length - 1 ? "disabled" : ""} aria-label="下へ">↓</button></span>` : ""}</div></li>`;
      }).join("")}</ul></section>`;
  };

  const viewLiving = () => {
    const s = state.settings;
    const t = today();
    const end = D.endOfMonth(t);
    let wd = 0;
    let off = 0;
    for (let d = t; d <= end; d = D.addDays(d, 1)) D.isDayOff(d, s.extraHolidays) ? off++ : wd++;
    const est = wd * (Number(s.weekdayCost) || 0) + off * (Number(s.holidayCost) || 0);
    const sel = K.livingAccounts(state);
    const ordered = [...sel.map((id) => K.accountById(state, id)), ...state.accounts.filter((a) => !sel.includes(a.id))];
    const allEmpty = sel.length && sel.every((id) => (K.accountById(state, id).balance || 0) <= 0);
    return `<section class="card"><h3>生活費を払う口座</h3>
      <p class="tiny" style="margin:0 0 6px">複数選べます。上から順に、1回分（1日の生活費）を払える最初の口座から払う見込みで予測します。払えない額しか残っていない口座はギリギリまで使わず、次の口座へ移ります。</p>
      ${allEmpty ? alertBox("critical", "<div>選んだ口座はどれも残高がありません。生活費を払えない見込みです</div>") : ""}
      <ul class="list">${ordered.map((a) => {
        const k = sel.indexOf(a.id);
        const err = k >= 0 ? K.balanceError(state, a.id, 0) : null;
        return `<li style="display:block"><div class="row" style="gap:10px">
          <input type="checkbox" data-living-toggle="${esc(a.id)}" ${k >= 0 ? "checked" : ""} aria-label="${esc(a.name)}を生活費の支払いに使う">
          ${k >= 0 ? `<span class="badge accent">${"①②③④⑤⑥⑦⑧⑨"[k] || k + 1}</span>` : ""}
          <div class="grow"><div style="word-break:break-all">${esc(a.name)}</div><div class="meta num">残高 ${esc(yen(a.balance))}${a.includeInTotal === false ? "・合計外" : ""}</div></div>
          ${k >= 0 && sel.length > 1 ? `<span class="actions"><button class="small ghost" data-action="living-up" data-id="${esc(a.id)}" ${k === 0 ? "disabled" : ""} aria-label="上へ">↑</button><button class="small ghost" data-action="living-down" data-id="${esc(a.id)}" ${k === sel.length - 1 ? "disabled" : ""} aria-label="下へ">↓</button></span>` : ""}</div>
          ${err ? `<div class="field-error">${esc(err)}${sel.length > 1 && k < sel.length - 1 ? "。次の口座から払う見込みにします" : ""} <button class="link small" data-action="account-balance" data-id="${esc(a.id)}">残高を更新</button></div>` : ""}</li>`;
      }).join("")}</ul></section>
      ${viewCover()}
      <section class="card"><form class="stack" data-form="living">
      <div class="grid2"><label class="field">平日 1日あたり<input name="weekdayCost" inputmode="numeric" value="${esc(s.weekdayCost)}"></label>
      <label class="field">休日 1日あたり<input name="holidayCost" inputmode="numeric" value="${esc(s.holidayCost)}"></label></div>
      <label class="field">月の雑費枠（日用品・衣類など。日割りで計上）<input name="miscMonthly" inputmode="numeric" value="${esc(s.miscMonthly)}"></label>
      <label class="check"><input type="checkbox" name="includeTodayLiving" ${s.includeTodayLiving ? "checked" : ""}> 今日の分も予測に含める</label>
      <label class="field">会社の休み・連休（休日単価にする日。YYYY-MM-DD を改行かカンマ区切り）<textarea name="extraHolidays" rows="3" placeholder="2026-12-29&#10;2026-12-30">${esc((s.extraHolidays || []).join("\n"))}</textarea></label>
      <button class="primary" type="submit">保存</button></form>
      <p class="tiny">休日＝土日・祝日（振替休日・国民の休日を含む）＋上の日付。今月の残り: 平日${wd}日・休日${off}日 → 生活費 約${esc(yen(est))}</p></section>`;
  };

  const viewCategories = () =>
    `<section class="row between"><h2 style="margin:0">カテゴリ</h2><button class="primary small" data-action="cat-new">＋ 追加</button></section>
    ${["expense", "income"].map((kind) => `<section class="card"><h3>${kind === "expense" ? "支出" : "収入"}</h3><ul class="list">${state.categories
      .filter((c) => c.kind === kind)
      .map((c) => `<li>${catSwatch(c.id)}<div class="grow">${esc(c.name)}${c.id === K.WINDFALL ? ' <span class="badge">目標計算・確定申告チェックの対象</span>' : ""}<div class="meta">${Number(c.benchmark) ? `比較基準 ${esc(yen(c.benchmark))}/月` : ""}</div></div>
        <button class="small ghost" data-action="cat-edit" data-id="${esc(c.id)}">編集</button></li>`)
      .join("")}</ul></section>`).join("")}`;

  /* ---------- 画面: 画像から取り込む ---------- */

  const IMPORT_TYPE_LABEL = { expense: "支出", income: "収入", balance: "残高", bill: "請求", payslip: "給与明細" };

  const importRowHtml = (r, i) => {
    const f = (field) => `data-imp="${field}" data-i="${i}"`;
    const warn = r.warnings.length ? `<ul class="tiny" style="margin:6px 0 0;padding-left:18px;color:var(--critical)">${r.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : "";
    let body = "";
    if (r.type === "payslip") {
      const net = (r.gross || 0) - (r.deductions || 0);
      body = `<div class="small num">支給 ${esc(yen(r.gross))} − 控除 ${esc(yen(r.deductions))} ＝ <b>手取り ${esc(yen(net))}</b>${r.overtimeHours ? `・残業 ${esc(r.overtimeHours)}h / ${esc(yen(r.overtimePay))}` : ""}</div>
        <div class="grid2" style="margin-top:8px"><label class="field">支給日<input type="date" value="${esc(r.date)}" ${f("date")}></label><span></span></div>
        <label class="check small" style="margin-top:6px"><input type="checkbox" ${r.recordNet !== false ? "checked" : ""} ${f("recordNet")} ${state.settings.salaryAccountId ? "" : "disabled"}> 手取りを給与口座に入金として記録（同じ頃の給与の記録があれば二重にしません）</label>`;
    } else {
      const catKind = r.type === "income" ? "income" : "expense";
      body = `<div class="grid2">
          <label class="field">日付<input type="date" value="${esc(r.date)}" ${f("date")}></label>
          <label class="field">${r.type === "balance" ? "残高" : "金額"}<input inputmode="numeric" value="${esc(r.amount)}" ${f("amount")}></label>
        </div>
        <div class="grid2" style="margin-top:8px">
          <label class="field">口座<select ${f("accountId")}>${r.type === "balance" && !r.accountId ? '<option value="">（選んでください）</option>' : ""}${accountOptions(r.accountId)}</select></label>
          ${r.type === "balance" ? `<span class="tiny" style="align-self:end">今の残高 ${esc(yen((K.accountById(state, r.accountId) || {}).balance || 0))} → 差額は「残高調整」で記録</span>`
            : r.type === "bill" && r.match && r.useMatch !== false ? "<span></span>"
            : `<label class="field">カテゴリ<select ${f("categoryId")}>${categoryOptions(catKind, r.categoryId)}</select></label>`}
        </div>
        ${r.type === "bill" && r.match ? `<label class="check small" style="margin-top:6px"><input type="checkbox" ${r.useMatch !== false ? "checked" : ""} ${f("useMatch")}> 定期ルール「${esc(r.match.label)}」の${esc(D.dayLabel(r.match.original))}分の金額として登録</label>` : ""}
        ${r.type === "bill" && !r.match ? `<p class="tiny" style="margin:6px 0 0">一致する定期ルールがないので、単発の${r.date > today() ? "予定" : "支出"}として登録します</p>` : ""}`;
    }
    const title = r.type === "payslip" ? "給与明細" : r.type === "balance" ? "残高の更新" : r.label || IMPORT_TYPE_LABEL[r.type];
    return `<li style="display:block;opacity:${r.include ? 1 : 0.6}">
      <div class="row" style="gap:10px"><input type="checkbox" ${r.include ? "checked" : ""} ${f("include")} aria-label="取り込む">
        <span class="badge ${r.type === "expense" || r.type === "bill" ? "" : "accent"}">${IMPORT_TYPE_LABEL[r.type]}</span>
        <b class="grow ellipsis">${esc(title)}</b>${r.type === "payslip" ? "" : `<span class="num">${esc(yen(r.amount))}</span>`}</div>
      <div style="margin-top:8px">${body}</div>${warn}</li>`;
  };

  const viewImport = () => {
    if (!state.accounts.length) return needAccounts();
    const prompt = I.buildPrompt(state, { today: today() });
    const rows = ui.importRows || [];
    const n = rows.filter((r) => r.include).length;
    return `<section class="card"><h3>1. Claude に画像と依頼文を送る</h3>
        <p class="small muted" style="margin:0 0 10px">Claude のアプリで、レシート・残高・請求・給与明細の画像（何枚でも）を添付し、下の依頼文を貼り付けて送信します。今の Claude の契約のままで使えます（追加料金なし）。</p>
        <button class="primary" data-action="imp-copy">依頼文をコピー</button>
        <details style="margin-top:10px"><summary>依頼文を見る</summary><textarea readonly rows="10" id="impPrompt" style="margin-top:8px;font-size:13px">${esc(prompt)}</textarea></details></section>
      <section class="card"><h3>2. Claude の返事を貼り付ける</h3>
        <textarea rows="6" id="impText" placeholder="支出,2026-09-30,1280,セブンイレブン,Olive,生活費&#10;残高,2026-09-30,182345,,広島銀行,">${esc(ui.importText || "")}</textarea>
        <div class="row" style="margin-top:10px;gap:8px"><button class="primary" data-action="imp-parse">読み込む</button>${ui.importText ? '<button class="ghost" data-action="imp-clear">クリア</button>' : ""}</div></section>
      ${rows.length || (ui.importSkipped || []).length ? `<section class="card"><div class="row between"><h3>3. 確認して登録</h3><span class="small muted">${rows.length}件中 ${n}件を取り込む</span></div>
        <p class="tiny" style="margin:0 0 6px">内容を確認し、違うところは直してください。チェックを外した行は取り込みません。</p>
        ${rows.length ? `<ul class="list">${rows.map(importRowHtml).join("")}</ul>` : ""}
        ${(ui.importSkipped || []).length ? `<details style="margin-top:8px"><summary>読み取れなかった行（${ui.importSkipped.length}）</summary><pre class="tiny" style="white-space:pre-wrap">${esc(ui.importSkipped.join("\n"))}</pre></details>` : ""}
        ${rows.length ? `<button class="primary" data-action="imp-apply" style="margin-top:12px;width:100%" ${n ? "" : "disabled"}>${n}件を登録する</button>` : ""}</section>` : ""}`;
  };

  const viewSettings = () => {
    const s = state.settings;
    const notifySupported = "Notification" in window;
    return `<section class="card"><form class="stack" data-form="settings">
      <div class="grid2"><label class="field">給料日<input name="payday" type="number" min="1" max="31" value="${esc(s.payday)}"></label>
      <label class="field">給料日が休日のとき<select name="paydayAdjust"><option value="prev" ${s.paydayAdjust === "prev" ? "selected" : ""}>前営業日</option><option value="next" ${s.paydayAdjust === "next" ? "selected" : ""}>翌営業日</option><option value="none" ${s.paydayAdjust === "none" ? "selected" : ""}>そのまま</option></select></label></div>
      <label class="field">給与の入金口座<select name="salaryAccountId">${accountOptions(s.salaryAccountId, { includeEmpty: true })}</select></label>
      <label class="field">残高アラートの目安（これを下回る予測で警告）<input name="threshold" inputmode="numeric" value="${esc(s.threshold)}"></label>
      <label class="field">確定申告チェックの目安（臨時収入の年間合計）<input name="taxThreshold" inputmode="numeric" value="${esc(s.taxThreshold)}"></label>
      <label class="check"><input type="checkbox" name="notify" ${s.notify ? "checked" : ""} ${notifySupported ? "" : "disabled"}> アプリを開いたときに警告を通知する${notifySupported ? "" : "（このブラウザは非対応）"}</label>
      <button class="primary" type="submit">保存</button></form></section>
      <section class="card"><h3>記録のリマインダー</h3>
        <form class="stack" data-form="reminder" style="gap:10px">
          <div class="grid2"><label class="field">通知する時刻<input type="time" name="reminderTime" value="${esc(s.reminderTime || "")}"></label>
          <button type="submit" style="align-self:end">保存</button></div>
        </form>
        <p class="tiny" style="margin:8px 0 0">指定の時刻を過ぎて今日の記録がないと、ホームに知らせが出ます（アプリを開いたまま時刻になったときも）。アプリを閉じているときの通知は、iPhone のリマインダーアプリで「毎日・この時刻」の繰り返しを登録してください。空欄で保存するとオフになります。</p></section>
      <section class="card"><h3>データ</h3><p class="tiny">データはこの端末のブラウザ内にだけ保存されます。機種変更やブラウザのデータ削除に備えて、ときどき書き出してください。</p>
      <div class="row wrap"><button data-action="export">JSONを書き出す</button><label class="btn" style="display:inline-flex;align-items:center">JSONを読み込む<input type="file" accept="application/json,.json" data-action="import" hidden></label>
      <button data-action="edits-open">修正ファイルを読み込む</button>${hasEditsBackup() ? '<button data-action="edits-restore">修正ファイル適用前に戻す</button>' : ""}
      <button data-action="sample">サンプルデータを読み込む</button><button class="danger" data-action="fresh-start">まっさらにして初期データを入れる</button><button class="danger" data-action="reset">すべて削除</button></div></section>
      <section class="card"><h3>アプリのバージョン</h3><div class="row between wrap"><span class="small muted num">${esc(document.documentElement.dataset.version || "-")}</span><button data-action="check-update">更新を確認</button></div>
      <p class="tiny">表示が古いままのときは「更新を確認」を押してください。入力したデータは消えません。</p></section>`;
  };

  const SUB = {
    accounts: ["口座", viewAccounts],
    recurrences: ["定期の支払い・収入", viewRecurrences],
    payslips: ["給与明細", viewPayslips],
    goals: ["目標", viewGoals],
    living: ["生活費の設定", viewLiving],
    categories: ["カテゴリ", viewCategories],
    settings: ["設定・データ", viewSettings],
    import: ["画像から取り込む", viewImport],
    earncal: ["稼ぐ目安カレンダー", viewEarnCal],
    periods: ["給料期間の収支", viewPeriods],
  };
  const TABS = { home: ["ホーム", viewHome], forecast: ["残高予測", viewForecast], input: ["入力", viewInput], analysis: ["カテゴリ分析", viewAnalysis], menu: ["メニュー", viewMenu] };

  const moveCover = (id, dir) => {
    const list = K.coverAccounts(state);
    const i = list.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    K.setCoverAccounts(state, list);
    commit();
  };

  const moveLiving = (id, dir) => {
    const list = K.livingAccounts(state);
    const i = list.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    K.setLivingAccounts(state, list);
    commit();
  };

  /* ---------- 残高のエラー表示 ---------- */

  const showBalanceError = (form, name, msg) => {
    const sel = form.querySelector(`[name="${name}"]`);
    const box = sel && sel.parentElement.querySelector("[data-balance-error]");
    if (box) {
      box.textContent = msg;
      box.hidden = false;
      sel.setAttribute("aria-invalid", "true");
      sel.focus();
    }
    toast(msg);
  };

  // 口座を選んだ時点で、残高がなければエラーを出す
  const checkSelectedBalance = (sel) => {
    const box = sel.parentElement.querySelector("[data-balance-error]");
    if (!box) return;
    const err = sel.dataset.checkBalance ? K.balanceError(state, sel.value, 0) : null;
    box.textContent = err ? `${err}。この口座からは払えません` : "";
    box.hidden = !err;
    if (err) sel.setAttribute("aria-invalid", "true");
    else sel.removeAttribute("aria-invalid");
  };

  /* ---------- 未記入の通知バー ---------- */

  const setupBar = () => {
    if (!state.accounts.length || ui.setupHidden) return "";
    const list = P.setupChecklist(state, { today: today() });
    if (!list.length) return "";
    const req = list.filter((x) => x.level === "required").length;
    return `<section class="setup-bar ${req ? "required" : ""}" role="status">
      ${ICONS[req ? "warning" : "info"]}<div class="grow"><b>未記入が${list.length}件あります</b>${req ? `<span class="small">（必須 ${req}件）</span>` : ""}
      <div class="tiny">${esc(list.slice(0, 2).map((x) => x.text.replace(/（.*$/, "")).join("・"))}${list.length > 2 ? " など" : ""}</div></div>
      <button class="small primary" data-action="setup-open">確認する</button>
      ${req ? "" : '<button class="small ghost" data-action="setup-hide" aria-label="今は閉じる">×</button>'}</section>`;
  };

  const LEVEL_TEXT = { required: "必須", check: "確認", optional: "任意" };
  const setupSheet = () => {
    const list = P.setupChecklist(state, { today: today() });
    sheetActions = {};
    if (!list.length) return toast("未記入はありません");
    openSheet("未記入の項目", `<div style="display:grid;gap:12px">
      <ul class="list">${list.map((x) => `<li style="display:block">
        <div class="row" style="gap:8px"><span class="badge ${x.level === "required" ? "warn" : x.level === "check" ? "accent" : ""}">${LEVEL_TEXT[x.level]}</span><b class="grow">${esc(x.text.replace(/（.*$/, ""))}</b></div>
        ${x.items ? `<ul class="tiny" style="margin:6px 0;padding-left:18px">${x.items.map((i) => `<li>${esc(i.label)}${i.date ? `（${esc(D.dayLabel(i.date))}）` : ""}：${esc(i.note)} <button type="button" class="link small" data-action="setup-tent-edit" data-kind="${i.kind}" data-id="${esc(i.id)}">直す</button>・<button type="button" class="link small" data-action="setup-tent-ok" data-kind="${i.kind}" data-id="${esc(i.id)}">このままでOK</button></li>`).join("")}</ul>` : ""}
        <div class="row" style="gap:8px;margin-top:6px">${x.target.type === "tentative" ? "" : `<button type="button" class="small primary" data-action="setup-go" data-key="${esc(x.key)}">入力する</button>`}
        ${x.level === "optional" ? `<button type="button" class="small ghost" data-action="setup-dismiss" data-key="${esc(x.key)}">使わない</button>` : ""}</div></li>`).join("")}</ul>
      <p class="tiny" style="margin:0">必須は入力するまで毎回表示します。任意は「使わない」で消せます。仮・概算は金額や日付が決まったら「直す」、そのままで良ければ「このままでOK」。</p></div>`, () => {});
  };

  /* ---------- 描画 ---------- */

  const render = () => {
    const sub = ui.tab === "menu" && ui.sub && SUB[ui.sub];
    const [title, view] = sub || TABS[ui.tab] || TABS.home;
    $("#pageTitle").textContent = title;
    $("#backBtn").hidden = !sub;
    document.querySelectorAll("nav.tabs button").forEach((b) => {
      if (b.dataset.tab === ui.tab) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    app.innerHTML = setupBar() + view();
    app.querySelectorAll("select[data-check-balance]").forEach(checkSelectedBalance);
    enhanceCalc(app);
    drawCharts();
    saveUi();
  };

  const drawCharts = () => {
    const pc = $("#periodChart");
    if (pc) {
      const rows = P.periodTable(state, { today: today(), count: Number(ui.perCount) || 6, includeCurrent: !!ui.perCurrent });
      C.stackedBars(pc, {
        labels: rows.map((r) => `${Number(r.start.slice(5, 7))}/${Number(r.start.slice(8))}`),
        sublabels: rows.map((r) => `〜${Number(r.end.slice(5, 7))}/${Number(r.end.slice(8))}`),
        series: GROUP_SERIES.map(([g, name, cls]) => ({ name, cls, values: rows.map((r) => r[g]) })),
        footer: { name: "累計", values: rows.map((r) => r.cumulative) },
        ariaLabel: "給料期間ごとの費用の内訳",
      });
    }
    const home = $("#homeChart");
    if (home && state.accounts.length) {
      const t = today();
      const f = K.forecast(state, { today: t, end: rangeEnd("payday", t), scenario: "pessimistic" });
      C.lineChart(home, {
        dates: f.days.map((d) => d.date),
        series: [{ name: "残高", values: f.days.map((d) => d.balance), cls: "s1" }],
        threshold: Number(state.settings.threshold) || 0,
        dayOff: f.days.map((d) => d.dayOff),
        compact: true,
        ariaLabel: `給料日までの残高推移。最低 ${yen(f.min.balance)}（${D.dayLabel(f.min.date)}）`,
        onSelect: (i) => {
          ui.tab = "forecast";
          ui.range = "payday";
          ui.selectedDate = f.days[i].date;
          render();
        },
      });
    }
    const fc = $("#forecastChart");
    if (fc) {
      const { main, compare, names } = forecastData();
      const series = [{ name: names[0], values: main.days.map((d) => d.balance), cls: "s1" }];
      if (compare) series.push({ name: names[1], values: compare.days.map((d) => d.balance), cls: "s2" });
      const selIdx = main.days.findIndex((d) => d.date === ui.selectedDate);
      C.lineChart(fc, {
        dates: main.days.map((d) => d.date),
        series,
        threshold: Number(state.settings.threshold) || 0,
        dayOff: main.days.map((d) => d.dayOff),
        selected: selIdx >= 0 ? selIdx : null,
        ariaLabel: `残高推移。最低 ${yen(main.min.balance)}（${D.dayLabel(main.min.date)}）。左右キーで日付を移動`,
        onSelect: (i) => {
          ui.selectedDate = main.days[i].date;
          $("#dayDetail").innerHTML = dayDetail(main);
        },
      });
    }
  };

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawCharts, 150);
  });

  /* ---------- シート（編集ダイアログ） ---------- */

  const sheet = $("#sheet");
  let sheetSubmit = null;
  let sheetOnInput = null;
  $("#sheetBody").addEventListener("input", () => sheetOnInput && sheetOnInput());
  $("#sheetBody").addEventListener("change", () => sheetOnInput && sheetOnInput());

  const openSheet = (title, body, onSubmit) => {
    $("#sheetTitle").textContent = title;
    $("#sheetBody").innerHTML = body;
    enhanceCalc($("#sheetBody"));
    sheetSubmit = onSubmit;
    sheetOnInput = null;
    if (typeof sheet.showModal === "function") sheet.showModal();
    else sheet.setAttribute("open", "");
    const first = $("#sheetBody input:not([type=checkbox]):not([type=hidden]), #sheetBody select");
    if (first) first.focus();
  };
  const closeSheet = () => {
    if (typeof sheet.close === "function") sheet.close();
    else sheet.removeAttribute("open");
    sheetSubmit = null;
  };
  $("#sheetClose").addEventListener("click", closeSheet);
  // 閉じたシートの中身は残さない（Esc で閉じた場合も）
  sheet.addEventListener("close", () => {
    // 閉じた直後に別のシートを開いた場合は消さない（close イベントは後から届く）
    if (sheet.open) return;
    $("#sheetBody").innerHTML = "";
    sheetSubmit = null;
    sheetOnInput = null;
  });
  $("#sheetForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const submitter = e.submitter;
    if (submitter && submitter.dataset.sheetAction) {
      const fn = sheetActions[submitter.dataset.sheetAction];
      if (fn && fn() !== false) closeSheet();
      return;
    }
    if (sheetSubmit && sheetSubmit(new FormData(e.target)) !== false) closeSheet();
  });
  let sheetActions = {};

  // 金額欄は「=1+2」「2万+3000」のような計算式も受け付ける
  const money = (v) => K.evalAmount(v);

  /* ---------- 金額欄の計算 ---------- */

  const CALC_KEYS = [["+", "＋"], ["-", "−"], ["*", "×"], ["/", "÷"], ["(", "("], [")", ")"]];

  const enhanceCalc = (root) => {
    root.querySelectorAll('input[inputmode="numeric"]:not([data-calc])').forEach((input) => {
      input.dataset.calc = "1";
      input.setAttribute("autocomplete", "off");
      const hint = document.createElement("div");
      hint.className = "calc-hint num";
      hint.setAttribute("aria-live", "polite");
      const tools = document.createElement("div");
      tools.className = "calc-tools";
      tools.setAttribute("role", "group");
      tools.setAttribute("aria-label", "計算キー");
      CALC_KEYS.forEach(([op, label]) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "small";
        b.dataset.calcOp = op;
        b.textContent = label;
        b.setAttribute("aria-label", `${label} を入力`);
        tools.appendChild(b);
      });
      const eq = document.createElement("button");
      eq.type = "button";
      eq.className = "small primary";
      eq.dataset.calcOp = "=";
      eq.textContent = "＝";
      eq.setAttribute("aria-label", "計算する");
      tools.appendChild(eq);
      input.after(hint, tools);
    });
  };

  const updateCalcHint = (input) => {
    const hint = input.parentElement.querySelector(".calc-hint");
    if (!hint) return;
    if (!K.isFormula(input.value)) {
      hint.textContent = "";
      return;
    }
    const v = K.evalAmount(input.value);
    hint.textContent = Number.isNaN(v) ? "式を確認してください" : `= ${yen(v)}`;
    hint.classList.toggle("bad", Number.isNaN(v));
  };

  // 計算式を結果の数字に置き換える（欄から離れたとき・＝キー）
  const applyCalc = (input) => {
    if (!K.isFormula(input.value)) return;
    const v = K.evalAmount(input.value);
    if (Number.isNaN(v)) return;
    const hint = input.parentElement.querySelector(".calc-hint");
    const expr = input.value.trim().replace(/^[=＝]/, "");
    input.value = String(v);
    if (hint) {
      hint.textContent = `${expr} = ${yen(v)}`;
      hint.classList.remove("bad");
    }
  };

  document.addEventListener("input", (e) => {
    if (e.target.dataset && e.target.dataset.calc) updateCalcHint(e.target);
  });
  document.addEventListener("focusout", (e) => {
    if (e.target.dataset && e.target.dataset.calc) applyCalc(e.target);
  });
  // 計算キーを押しても入力欄からフォーカスを外さない（スマホのキーボードを閉じない）
  document.addEventListener("pointerdown", (e) => {
    if (e.target.closest("[data-calc-op]")) e.preventDefault();
  });
  document.addEventListener("click", (e) => {
    const key = e.target.closest("[data-calc-op]");
    if (!key) return;
    const input = key.parentElement.parentElement.querySelector("input[data-calc]");
    if (!input) return;
    if (key.dataset.calcOp === "=") {
      applyCalc(input);
    } else {
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      input.value = input.value.slice(0, start) + key.dataset.calcOp + input.value.slice(end);
      input.setSelectionRange(start + 1, start + 1);
      updateCalcHint(input);
    }
    input.focus();
  }, true);

  const foot = (del) =>
    `<div class="sheet-foot">${del ? `<button type="submit" class="danger ghost" data-sheet-action="delete" formnovalidate style="margin-right:auto">削除</button>` : ""}<button type="submit" class="primary">保存</button></div>`;

  const accountSheet = (a) => {
    sheetActions = { delete: () => {
      if (!confirm(`「${a.name}」を削除しますか？この口座に紐付いた定期ルール・予定は残ります。`)) return false;
      state.accounts = state.accounts.filter((x) => x.id !== a.id);
      commit();
    } };
    openSheet(a ? "口座を編集" : "口座を追加", `<div class="stack" style="display:grid;gap:14px">
      <label class="field">名前<input name="name" value="${esc(a ? a.name : "")}" placeholder="例: 広島銀行、Olive、FX口座、PayPay残高" required></label>
      ${a ? "" : `<label class="field">現在の残高<input name="balance" inputmode="numeric" required placeholder="0"></label>`}
      <label class="check"><input type="checkbox" name="includeInTotal" ${!a || a.includeInTotal !== false ? "checked" : ""}> 総資産・残高予測の合計に含める</label>
      <p class="tiny" style="margin:0">PayPay残高など「銀行残高に影響しない支払い」は、別口座として登録して合計から外し、その支払いをこの口座に紐付けます。</p>
      <label class="field">メモ<input name="note" value="${esc(a ? a.note || "" : "")}"></label>${foot(!!a)}</div>`, (fd) => {
      const name = fd.get("name").trim();
      if (!name) return false;
      if (a) {
        Object.assign(a, { name, includeInTotal: fd.get("includeInTotal") === "on", note: fd.get("note") });
      } else {
        const balance = money(fd.get("balance"));
        if (Number.isNaN(balance)) return toast("残高を数字で入力してください"), false;
        const acc = { id: K.uid("acc"), name, balance, balanceSet: true, includeInTotal: fd.get("includeInTotal") === "on", note: fd.get("note") };
        state.accounts.push(acc);
        if (!state.settings.salaryAccountId) state.settings.salaryAccountId = acc.id;
        else if (!K.livingAccounts(state).length && acc.includeInTotal) K.setLivingAccounts(state, [acc.id]);
      }
      commit();
    });
  };

  const balanceSheet = (a) => {
    sheetActions = {};
    openSheet(`${a.name} の残高を更新`, `<div style="display:grid;gap:14px">
      <p class="small muted" style="margin:0">銀行アプリなどで確認した今の残高を入力してください。差額は「残高調整」として記録されます。</p>
      <label class="field">現在の残高<input class="amount num" name="balance" inputmode="numeric" value="${esc(a.balance)}" required></label>
      <label class="check"><input type="checkbox" name="log" checked> 差額を実績として記録する</label>${foot(false)}</div>`, (fd) => {
      const b = money(fd.get("balance"));
      if (Number.isNaN(b)) return toast("数字で入力してください"), false;
      const diff = b - Math.round(a.balance || 0);
      if (diff && fd.get("log") === "on") {
        K.addTransaction(state, { accountId: a.id, date: today(), amount: diff, categoryId: diff < 0 ? "cat_other" : "cat_other", label: "残高調整", status: "actual", balanceAlreadyReflected: true, adjustment: true });
      }
      a.balance = b;
      a.balanceSet = true;
      commit();
      toast(`残高を${yen(b)}に更新しました`);
    });
  };

  const txSheet = (x) => {
    const kind = x.amount < 0 ? "expense" : "income";
    sheetActions = { delete: () => {
      K.removeTransaction(state, x.id);
      commit();
    } };
    openSheet("取引を編集", `<div style="display:grid;gap:14px">
      <div class="grid2"><label class="field">種類<select name="kind"><option value="expense" ${kind === "expense" ? "selected" : ""}>支出</option><option value="income" ${kind === "income" ? "selected" : ""}>収入</option></select></label>
      <label class="field">金額<input name="amount" inputmode="numeric" value="${Math.abs(x.amount)}" required></label></div>
      <div class="grid2"><label class="field">日付<input type="date" name="date" value="${esc(x.date)}" required></label>
      <label class="field">状態<select name="status"><option value="actual" ${x.status === "actual" ? "selected" : ""}>実績</option><option value="planned" ${x.status === "planned" ? "selected" : ""}>予定</option></select></label></div>
      <label class="field">口座<select name="accountId">${accountOptions(x.accountId)}</select></label>
      <label class="field">カテゴリ<select name="categoryId">${categoryOptions(null, x.categoryId)}</select></label>
      <label class="field">内容<input name="label" value="${esc(x.label)}"></label>
      ${x.balanceAlreadyReflected ? `<p class="tiny" style="margin:0">この取引は「残高反映済み」として記録されているため、編集・削除しても口座残高は変わりません。</p>` : `<p class="tiny" style="margin:0">実績の編集・削除は口座残高にも反映されます。</p>`}
      ${foot(true)}</div>`, (fd) => {
      const amt = money(fd.get("amount"));
      if (Number.isNaN(amt)) return toast("金額を数字で入力してください"), false;
      K.updateTransaction(state, x.id, {
        amount: fd.get("kind") === "expense" ? -Math.abs(amt) : Math.abs(amt),
        date: fd.get("date"),
        status: fd.get("status"),
        accountId: fd.get("accountId"),
        categoryId: fd.get("categoryId"),
        label: fd.get("label"),
      });
      delete x.tentative; // 編集したら「仮・概算」は確認済み
      commit();
    });
  };

  const recSheet = (r) => {
    const kind = r && r.toAccountId ? "transfer" : r && r.amount > 0 ? "income" : "expense";
    sheetActions = { delete: () => {
      if (!confirm(`「${r.label}」を削除しますか？`)) return false;
      state.recurrences = state.recurrences.filter((x) => x.id !== r.id);
      commit();
    } };
    const daysText = r ? r.days.map((d) => (Number(d) >= 31 ? "末" : d)).join(", ") : "";
    openSheet(r ? "定期ルールを編集" : "定期ルールを追加", `<div style="display:grid;gap:14px">
      <label class="field">名前<input name="label" value="${esc(r ? r.label : "")}" placeholder="例: 寮費、YouTube Premium、PayPay後払い、給料" required></label>
      <div class="grid2"><label class="field">種類<select name="kind"><option value="expense" ${kind === "expense" ? "selected" : ""}>支出</option><option value="income" ${kind === "income" ? "selected" : ""}>収入</option><option value="transfer" ${kind === "transfer" ? "selected" : ""}>口座間の振替</option></select></label>
      <label class="field">金額（1回あたり）<input name="amount" inputmode="numeric" value="${r ? Math.abs(r.amount) : ""}" required></label></div>
      <label class="check"><input type="checkbox" name="onPayday" ${r && r.onPayday ? "checked" : ""}> 毎月の給料日と同じ日（電気代など給料のあとに払うもの。下の「日」は使いません）</label>
      <div class="grid2"><label class="field">日（複数はカンマ区切り、末日は「末」）<input name="days" value="${esc(daysText)}" placeholder="例: 27 または 5, 20"></label>
      <label class="field">周期<select name="intervalMonths">${[1, 2, 3, 6, 12].map((m) => `<option value="${m}" ${Number(r ? r.intervalMonths || 1 : 1) === m ? "selected" : ""}>${m === 1 ? "毎月" : `${m}か月ごと`}</option>`).join("")}</select></label></div>
      <label class="field">休日の場合<select name="adjust"><option value="none" ${r && r.adjust === "none" ? "selected" : ""}>そのまま</option><option value="next" ${!r || r.adjust === "next" ? "selected" : ""}>翌営業日（引き落としに多い）</option><option value="prev" ${r && r.adjust === "prev" ? "selected" : ""}>前営業日（給料に多い）</option></select></label>
      <div class="grid2"><label class="field">口座（振替は出金元）<select name="accountId">${accountOptions(r ? r.accountId : state.settings.salaryAccountId)}</select></label>
      <label class="field">カテゴリ（振替は不要）<select name="categoryId">${categoryOptions(null, r ? r.categoryId : "cat_bnpl")}</select></label></div>
      <label class="field">振替の入金先（種類が「口座間の振替」のとき）<select name="toAccountId">${accountOptions(r ? r.toAccountId : state.settings.livingAccountId, { includeEmpty: true })}</select></label>
      <div class="grid2"><label class="field">開始日（隔月の起点）<input type="date" name="startDate" value="${esc(r ? r.startDate || "" : today())}"></label>
      <label class="field">終了日（任意）<input type="date" name="endDate" value="${esc(r ? r.endDate || "" : "")}"></label></div>
      <p class="tiny" style="margin:0">後払いのように毎回金額が違うものは、ホームの「これからの予定」の「変更」でその回だけ金額を上書きできます。</p>
      ${foot(!!r)}</div>`, (fd) => {
      const amt = money(fd.get("amount"));
      const days = String(fd.get("days"))
        .split(/[,、，\s]+/)
        .filter(Boolean)
        .map((d) => (/^末/.test(d) ? 31 : Number(d.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)))))
        .filter((d) => d >= 1 && d <= 31);
      const onPayday = fd.get("onPayday") === "on";
      if (Number.isNaN(amt) || (!days.length && !onPayday)) return toast("金額と日付を確認してください"), false;
      const isTransfer = fd.get("kind") === "transfer";
      if (isTransfer && (!fd.get("toAccountId") || fd.get("toAccountId") === fd.get("accountId"))) return toast("振替の入金先を出金元と別の口座にしてください"), false;
      const data = {
        label: fd.get("label"),
        toAccountId: isTransfer ? fd.get("toAccountId") : "",
        amount: fd.get("kind") === "income" ? Math.abs(amt) : -Math.abs(amt),
        days: days.length ? [...new Set(days)].sort((a, b) => a - b) : [Number(state.settings.payday) || 25],
        onPayday,
        intervalMonths: Number(fd.get("intervalMonths")) || 1,
        adjust: fd.get("adjust"),
        accountId: fd.get("accountId"),
        categoryId: fd.get("categoryId"),
        startDate: fd.get("startDate") || "",
        endDate: fd.get("endDate") || "",
      };
      if (r) {
        Object.assign(r, data);
        delete r.tentative;
      } else state.recurrences.push(Object.assign({ id: K.uid("rec"), doneDates: [] }, data));
      commit();
    });
  };

  const occurrenceSheet = (r, original) => {
    const existing = (r.toAccountId ? state.transfers : state.transactions).find((t) => t.recurrenceId === r.id && t.occurrenceDate === original);
    sheetActions = {
      skip: () => {
        if (existing) (r.toAccountId ? K.removeTransfer : K.removeTransaction)(state, existing.id);
        K.skipOccurrence(state, r.id, original);
        commit();
        toast("今回分をスキップしました");
      },
      reflected: () => {
        undoable("済にしました（残高は変更なし）", () => K.completeOccurrence(state, r.id, original, { reflect: false }));
      },
    };
    openSheet(`${r.label}（${D.dayLabel(original)}分）`, `<div style="display:grid;gap:14px">
      <label class="field">今回の金額<input class="amount num" name="amount" inputmode="numeric" value="${Math.abs(existing ? existing.amount : r.amount)}" required></label>
      <label class="field">日付<input type="date" name="date" value="${esc(existing ? existing.date : D.adjustBusinessDay(original, r.adjust))}" required></label>
      <p class="tiny" style="margin:0">この回だけの変更です。定期ルールそのものは変わりません。</p>
      <div class="sheet-foot" style="flex-wrap:wrap"><button type="submit" class="ghost" data-sheet-action="skip" formnovalidate>今回はなし</button>
      <button type="submit" class="ghost" data-sheet-action="reflected" formnovalidate title="銀行残高を手入力で更新済みの場合">済（残高は更新済み）</button>
      <button type="submit" class="primary">この金額で予定する</button></div></div>`, (fd) => {
      const amt = money(fd.get("amount"));
      if (Number.isNaN(amt)) return false;
      K.overrideOccurrence(state, r.id, original, { amount: r.amount < 0 ? -Math.abs(amt) : Math.abs(amt), date: fd.get("date") });
      commit();
    });
  };

  const slipSheet = (p) => {
    sheetActions = { delete: () => {
      state.payslips = state.payslips.filter((x) => x.id !== p.id);
      commit();
    } };
    openSheet(p ? "給与明細を編集" : "給与明細を追加", `<div style="display:grid;gap:14px">
      <label class="field">支給日<input type="date" name="payDate" value="${esc(p ? p.payDate : K.nextPayday(state.settings, `${today().slice(0, 7)}-01`))}" required></label>
      <div class="grid2"><label class="field">支給額合計<input name="gross" inputmode="numeric" value="${esc(p ? p.gross : "")}" required></label>
      <label class="field">控除額合計<input name="deductions" inputmode="numeric" value="${esc(p ? p.deductions : "")}" required></label></div>
      <p class="tiny" style="margin:0">差引支給額 = 支給額合計 − 控除額合計（自動計算）</p>
      <div class="grid2"><label class="field">残業時間<input name="overtimeHours" type="number" step="0.25" min="0" inputmode="decimal" value="${esc(p ? p.overtimeHours || "" : "")}"></label>
      <label class="field">時間外手当<input name="overtimePay" inputmode="numeric" value="${esc(p ? p.overtimePay || "" : "")}"></label></div>
      <label class="field">メモ<input name="memo" value="${esc(p ? p.memo || "" : "")}"></label>
      ${p ? "" : `<label class="check"><input type="checkbox" name="record" ${state.settings.salaryAccountId ? "checked" : ""}> 差引支給額を給与の入金口座に実績として記録する</label>`}
      ${foot(!!p)}</div>`, (fd) => {
      const gross = money(fd.get("gross"));
      const deductions = money(fd.get("deductions"));
      if (Number.isNaN(gross) || Number.isNaN(deductions)) return toast("金額を数字で入力してください"), false;
      const data = {
        payDate: fd.get("payDate"),
        gross,
        deductions,
        net: gross - deductions,
        overtimeHours: Number(fd.get("overtimeHours")) || 0,
        overtimePay: money(fd.get("overtimePay")) || 0,
        memo: fd.get("memo"),
      };
      if (p) Object.assign(p, data);
      else {
        state.payslips.push(Object.assign({ id: K.uid("slip"), createdOn: today() }, data));
        if (fd.get("record") === "on" && state.settings.salaryAccountId) {
          // 同じ日の給与の定期ルール・予定があれば置き換える
          const salaryRec = state.recurrences.find((r) => r.categoryId === "cat_salary" && r.accountId === state.settings.salaryAccountId && r.amount > 0);
          const occ = salaryRec && K.expandRecurrence(salaryRec, D.addDays(data.payDate, -5), D.addDays(data.payDate, 5), state.settings)[0];
          const planned = state.transactions.find((t) => t.status === "planned" && t.categoryId === "cat_salary" && Math.abs(D.diffDays(t.date, data.payDate)) <= 5);
          if (planned) K.updateTransaction(state, planned.id, { status: "actual", amount: data.net, date: data.payDate });
          else if (occ) K.overrideOccurrence(state, salaryRec.id, occ.original, { status: "actual", amount: data.net, date: data.payDate });
          else K.addTransaction(state, { accountId: state.settings.salaryAccountId, date: data.payDate, amount: data.net, categoryId: "cat_salary", label: "給与", status: "actual" });
        }
      }
      commit();
    });
  };

  const goalSheet = (g) => {
    sheetActions = { delete: () => {
      state.goals = state.goals.filter((x) => x.id !== g.id);
      commit();
    } };
    const ids = g ? g.accountIds || [] : [];
    const birthday = state.settings.birthday || "";
    const byDateOnly = g && !g.targetAge && g.targetDate;
    openSheet(g ? "目標を編集" : "目標を追加", `<div style="display:grid;gap:14px">
      <div class="grid2"><label class="field">目標金額<input name="targetAmount" inputmode="numeric" value="${esc(g ? g.targetAmount : "")}" placeholder="例: 800万" required></label>
      <label class="field">目標名（空欄なら自動）<input name="label" value="${esc(g ? g.label : "")}" placeholder="30歳までに800万円"></label></div>
      <div class="grid2 collapse"><label class="field">誕生日<input type="date" name="birthday" value="${esc(birthday)}"></label>
      <label class="field">何歳まで<input type="number" name="targetAge" min="1" max="120" value="${esc(g && g.targetAge ? g.targetAge : byDateOnly ? "" : 30)}" placeholder="30"></label></div>
      <label class="field">いつから貯め始める<input type="date" name="startDate" value="${esc(g && g.startDate ? g.startDate : today())}"></label>
      <details ${byDateOnly ? "open" : ""}><summary>年齢ではなく日付で期日を指定する</summary>
        <label class="field" style="margin-top:8px">期日（「何歳まで」を空欄にしたときに使います）<input type="date" name="targetDate" value="${esc(g && g.targetDate ? g.targetDate : "")}"></label></details>
      <div class="card" style="padding:12px;background:var(--surface-2)" id="goalPreview" aria-live="polite"></div>
      <label class="check"><input type="checkbox" name="includeWindfall" ${g && g.includeWindfall ? "checked" : ""}> 臨時収入（FXの利益など）もペースに含める</label>
      <fieldset style="border:1px solid var(--border);border-radius:10px;padding:10px 12px"><legend class="small muted">対象の口座（未選択なら合計対象の口座すべて）</legend>
      ${state.accounts.map((a) => `<label class="check"><input type="checkbox" name="acc" value="${esc(a.id)}" ${ids.includes(a.id) ? "checked" : ""}> ${esc(a.name)}</label>`).join("")}</fieldset>
      <label class="field">月の貯金ペースを手入力（空欄なら予測から自動）<input name="manual" inputmode="numeric" value="${esc(g && g.manualMonthlyPace !== null && g.manualMonthlyPace !== undefined ? g.manualMonthlyPace : "")}"></label>
      ${foot(!!g)}</div>`, (fd) => {
      const data = readGoalForm(fd);
      if (Number.isNaN(data.targetAmount) || data.targetAmount <= 0) return toast("目標金額を入力してください"), false;
      if (data.targetAge && !data.birthday) return toast("「何歳まで」を使うときは誕生日を入れてください"), false;
      if (!data.targetDate) return toast("「何歳まで」か期日を入れてください"), false;
      if (data.targetDate <= today()) return toast("期日が過ぎています。年齢か期日を確認してください"), false;
      if (data.birthday) state.settings.birthday = data.birthday;
      delete data.birthday;
      if (g) Object.assign(g, data);
      else state.goals.push(Object.assign({ id: K.uid("goal") }, data));
      commit();
    });
    sheetOnInput = () => updateGoalPreview();
    updateGoalPreview();
  };

  const readGoalForm = (fd) => {
    const targetAmount = money(fd.get("targetAmount"));
    const birthday = fd.get("birthday") || "";
    const targetAge = Number(fd.get("targetAge")) || null;
    const goal = {
      targetAmount,
      targetAge,
      startDate: fd.get("startDate") || "",
      includeWindfall: fd.get("includeWindfall") === "on",
      accountIds: fd.getAll("acc"),
      birthday,
    };
    goal.targetDate = K.goalTargetDate(goal, {}) || fd.get("targetDate") || "";
    const manualRaw = String(fd.get("manual") || "").trim();
    goal.manualMonthlyPace = manualRaw === "" ? null : money(manualRaw);
    const man = targetAmount >= 10000 && targetAmount % 10000 === 0 ? `${(targetAmount / 10000).toLocaleString("ja-JP")}万円` : yen(targetAmount);
    goal.label = String(fd.get("label") || "").trim() || (targetAge ? `${targetAge}歳までに${man}` : `${goal.targetDate}までに${man}`);
    return goal;
  };

  // 入力中に「○歳の誕生日＝いつ」「月いくら必要か」を表示する
  const updateGoalPreview = () => {
    const box = $("#goalPreview");
    if (!box) return;
    const g = readGoalForm(new FormData($("#sheetForm")));
    if (g.targetAge && !g.birthday) {
      box.innerHTML = `<p class="small" style="margin:0">誕生日を入れると期日を計算します</p>`;
      return;
    }
    if (!g.targetDate) {
      box.innerHTML = `<p class="small" style="margin:0">「何歳まで」か期日を入れてください</p>`;
      return;
    }
    if (g.targetDate <= today()) {
      box.innerHTML = `<p class="small" style="margin:0;color:var(--critical)">期日（${esc(g.targetDate)}）が過ぎています</p>`;
      return;
    }
    const p = K.goalPlan(Object.assign({}, state, { settings: Object.assign({}, state.settings, { birthday: g.birthday }) }), g, { today: today() });
    const amountOk = !Number.isNaN(g.targetAmount) && g.targetAmount > 0;
    box.innerHTML = `<div class="small" style="display:grid;gap:4px">
      <div><b>${esc(goalPeriodText(g, p))}</b></div>
      ${amountOk ? `<div>必要な貯金額 <b class="num">${esc(yen(p.requiredMonthly))}/月</b>（年 <span class="num">${esc(yen(p.requiredYearly))}</span>）</div>
      <div class="muted">現在の資産 ${esc(yen(p.current))} ・ あと ${esc(yen(p.remaining))}</div>` : `<div class="muted">目標金額を入れると必要額を計算します</div>`}</div>`;
  };

  const catSheet = (c) => {
    const builtin = c && c.id.startsWith("cat_");
    sheetActions = { delete: () => {
      if (builtin) return toast("標準のカテゴリは削除できません"), false;
      state.categories = state.categories.filter((x) => x.id !== c.id);
      commit();
    } };
    openSheet(c ? "カテゴリを編集" : "カテゴリを追加", `<div style="display:grid;gap:14px">
      <label class="field">名前<input name="name" value="${esc(c ? c.name : "")}" required></label>
      <div class="grid2"><label class="field">種類<select name="kind" ${builtin ? "disabled" : ""}><option value="expense" ${!c || c.kind === "expense" ? "selected" : ""}>支出</option><option value="income" ${c && c.kind === "income" ? "selected" : ""}>収入</option></select></label>
      <label class="field">色<input type="color" name="color" value="${esc(c ? c.color : "#2a78d6")}" style="height:42px;padding:4px"></label></div>
      ${!c || c.kind === "expense" ? `<label class="field">給料期間の集計での区分（支出のみ）<select name="group">${[["fixed", "固定費"], ["repay", "返済"], ["living", "生活費（ルール計算に含めるので集計しない）"], ["misc", "雑費（同上）"]].map(([k, v]) => `<option value="${k}" ${(c ? c.group || "fixed" : "fixed") === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>` : ""}
      <label class="field">比較基準（月額・任意）<input name="benchmark" inputmode="numeric" value="${esc(c && c.benchmark ? c.benchmark : "")}" placeholder="例: 家計調査の同年代・単身世帯の値"></label>
      ${foot(!!c && !builtin)}</div>`, (fd) => {
      const bench = String(fd.get("benchmark") || "").trim();
      const data = { name: fd.get("name"), color: fd.get("color"), benchmark: bench ? money(bench) : null };
      if (!builtin) data.kind = fd.get("kind");
      if (fd.get("group")) data.group = fd.get("group");
      if (c) Object.assign(c, data);
      else state.categories.push(Object.assign({ id: K.uid("c") }, data));
      commit();
    });
  };

  /* ---------- サンプルデータ ---------- */

  const sampleState = () => {
    const s = K.emptyState();
    const t = today();
    const acc = (name, balance, includeInTotal = true, note = "") => {
      const a = { id: K.uid("acc"), name, balance, includeInTotal, note };
      s.accounts.push(a);
      return a.id;
    };
    const bank = acc("給料口座（銀行）", 182000, true, "給与の入金・引き落とし");
    const life = acc("生活費口座", 24000, true, "デビットで日々の買い物");
    const fx = acc("FX口座", 130000, true);
    const pp = acc("PayPay残高", 3200, false, "PayPay残高払いはここから");
    Object.assign(s.settings, {
      salaryAccountId: bank, livingAccountId: life, weekdayCost: 1000, holidayCost: 2500, miscMonthly: 8000,
      threshold: 20000, payday: 25, paydayAdjust: "prev",
    });
    const rec = (label, amount, days, accountId, categoryId, adjust = "next") =>
      s.recurrences.push({ id: K.uid("rec"), label, amount, days, accountId, categoryId, adjust, intervalMonths: 1, startDate: "2026-01-01", endDate: "", doneDates: [] });
    rec("給料", 205000, [25], bank, "cat_salary", "prev");
    rec("寮費", -18000, [27], bank, "cat_housing");
    rec("スマホ代", -3300, [26], bank, "cat_telecom");
    rec("YouTube Premium", -1280, [10], bank, "cat_subsc", "none");
    rec("PayPayあと払い", -9000, [27], bank, "cat_bnpl");
    rec("d払い", -6000, [10], bank, "cat_bnpl");
    rec("キャシャカリ", -5000, [5, 20], bank, "cat_bnpl");
    rec("生活費口座へ振替", -40000, [26], bank, "cat_other", "next");
    s.recurrences[s.recurrences.length - 1].toAccountId = life;
    rec("PayPayチャージ分の支払い", -1500, [15], pp, "cat_subsc", "none");
    const tx = (daysFromToday, amount, label, categoryId, accountId, status) =>
      K.addTransaction(s, { accountId, date: D.addDays(t, daysFromToday), amount, label, categoryId, status });
    tx(-12, -3200, "日用品", "cat_misc", life, "actual");
    tx(-9, -1800, "外食", "cat_living", life, "actual");
    tx(-6, -4500, "衣類", "cat_misc", life, "actual");
    tx(-3, 18000, "FXリベート", K.WINDFALL, fx, "actual");
    tx(-2, -2980, "Claude課金", "cat_subsc", bank, "actual");
    tx(20, -38000, "退去費", "cat_extra", bank, "planned");
    tx(45, -25000, "旅行代", "cat_extra", bank, "planned");
    K.addTransfer(s, { fromId: fx, toId: bank, amount: 50000, date: D.addDays(t, 3), status: "pending", label: "FX出金" });
    s.settings.birthday = `${Number(t.slice(0, 4)) - 26}-03-31`;
    s.goals.push({ id: K.uid("goal"), label: "30歳までに800万円", targetAmount: 8000000, targetAge: 30, startDate: t, targetDate: `${Number(t.slice(0, 4)) + 4}-03-31`, includeWindfall: false, accountIds: [], manualMonthlyPace: null });
    const firstOf = (n) => `${D.addMonths(t, n).slice(0, 7)}-01`;
    const lastPay = K.nextPayday(s.settings, firstOf(-1));
    const prevPay = K.nextPayday(s.settings, firstOf(-2));
    s.payslips.push({ id: K.uid("slip"), payDate: prevPay, gross: 262000, deductions: 55000, net: 207000, overtimeHours: 18, overtimePay: 36900, memo: "" });
    s.payslips.push({ id: K.uid("slip"), payDate: lastPay, gross: 271000, deductions: 57000, net: 214000, overtimeHours: 22, overtimePay: 45100, memo: "" });
    s.categories.find((c) => c.id === "cat_telecom").benchmark = 5000;
    s.categories.find((c) => c.id === "cat_misc").benchmark = 10000;
    return s;
  };

  /* ---------- イベント ---------- */

  const actions = {
    range: (b) => { ui.range = b.dataset.key; ui.selectedDate = null; render(); },
    scenario: (b) => { ui.scenario = b.dataset.key; render(); },
    "toggle-table": () => { ui.showTable = !ui.showTable; render(); },
    kind: (b) => { ui.inputKind = b.dataset.key; ui.draft = {}; render(); },
    arange: (b) => { ui.analysisRange = b.dataset.key; ui.openCat = null; render(); },
    "cat-open": (b) => { ui.openCat = ui.openCat === b.dataset.id ? null : b.dataset.id; render(); },
    template: (b) => {
      const r = state.recurrences.find((x) => x.id === b.dataset.id);
      ui.draft = { amount: Math.abs(r.amount), categoryId: r.categoryId, accountId: r.accountId, label: r.label };
      render();
    },
    "go-transfer": () => { ui.tab = "input"; ui.sub = null; ui.inputKind = "transfer"; render(); },
    "account-new": () => accountSheet(null),
    "account-edit": (b) => accountSheet(K.accountById(state, b.dataset.id)),
    "account-balance": (b) => balanceSheet(K.accountById(state, b.dataset.id)),
    "transfer-delete": (b) => {
      if (!confirm("この振替を削除しますか？口座残高への反映も取り消されます。")) return;
      K.removeTransfer(state, b.dataset.id);
      commit();
    },
    "transfer-arrived": (b) => {
      const tr = state.transfers.find((x) => x.id === b.dataset.id);
      if (!tr) return;
      const to = K.accountById(state, tr.toId);
      sheetActions = {
        reflected: () => undoable("着金済みにしました（残高は変更なし）", () => K.completeTransfer(state, tr.id, { reflect: false })),
      };
      openSheet(`${to ? to.name : "入金先"}に${yen(tr.amount)}が着金`, `<div style="display:grid;gap:14px">
        <p class="small" style="margin:0">着金済みにすると、着金待ちの表示と「着金しない前提」の比較が消えます。</p>
        <p class="small muted" style="margin:0">今の${esc(to ? to.name : "入金先")}の残高：<b class="num" style="color:var(--text)">${esc(yen(to ? to.balance : 0))}</b></p>
        <div class="sheet-foot" style="flex-wrap:wrap">
          <button type="submit" class="ghost" data-sheet-action="reflected" formnovalidate>残高はもう更新した</button>
          <button type="submit" class="primary">残高に${esc(yen(tr.amount))}を足す</button></div></div>`, () => {
        undoable(`着金済みにして${to ? to.name : ""}に${yen(tr.amount)}を足しました`, () => K.completeTransfer(state, tr.id));
      });
    },
    "tx-edit": (b) => txSheet(state.transactions.find((x) => x.id === b.dataset.id)),
    "tx-confirm": (b) => {
      const x = state.transactions.find((t) => t.id === b.dataset.id);
      if (!x) return;
      const t = today();
      const word = x.amount < 0 ? "支払い" : "入金";
      if (x.date > t && !confirm(`${D.dayLabelLong(x.date)}の予定ですが、もう${word}済みですか？\n\n「OK」で今日の日付の実績として残高に反映します。\n金額が決まっただけなら「キャンセル」して「編集」で金額を直してください（予定のまま残ります）。`)) return;
      undoable(`${word}済みにして残高に反映しました`, () => K.confirmTransaction(state, x.id, { today: t }));
    },
    "tx-unconfirm": (b) => {
      const x = state.transactions.find((t) => t.id === b.dataset.id);
      if (!x) return;
      undoable(`「${x.label || cat(x.categoryId).name}」を予定に戻しました`, () => K.unconfirmTransaction(state, x.id, today()));
    },
    "occ-done": (b) => undoable("残高に反映しました", () => K.completeOccurrence(state, b.dataset.id, b.dataset.date)),
    "occ-edit": (b) => occurrenceSheet(state.recurrences.find((x) => x.id === b.dataset.id), b.dataset.date),
    "rec-new": () => recSheet(null),
    "rec-edit": (b) => recSheet(state.recurrences.find((x) => x.id === b.dataset.id)),
    "slip-new": () => slipSheet(null),
    "slip-edit": (b) => slipSheet(state.payslips.find((x) => x.id === b.dataset.id)),
    "slip-plan": (b) => {
      const amount = Number(b.dataset.amount);
      const payday = rangeEnd("payday");
      const salaryRec = state.recurrences.find((r) => r.categoryId === "cat_salary" && r.accountId === state.settings.salaryAccountId && r.amount > 0);
      const occ = salaryRec && K.expandRecurrence(salaryRec, D.addDays(payday, -5), D.addDays(payday, 5), state.settings).find((o) => !salaryRec.doneDates.includes(o.original));
      if (occ) K.overrideOccurrence(state, salaryRec.id, occ.original, { amount, date: payday });
      else K.addTransaction(state, { accountId: state.settings.salaryAccountId, date: payday, amount, categoryId: "cat_salary", label: "給与（見込み）", status: "planned" });
      commit();
      toast(`${D.dayLabel(payday)}の給与を${yen(amount)}で予定しました`);
    },
    "imp-copy": async () => {
      const text = I.buildPrompt(state, { today: today() });
      try {
        await navigator.clipboard.writeText(text);
        toast("依頼文をコピーしました。Claude に画像と一緒に貼り付けてください");
      } catch (e) {
        // クリップボードが使えない環境では、全文を選択して手動でコピーしてもらう
        const box = $("#impPrompt");
        box.closest("details").open = true;
        box.focus();
        box.select();
        toast("選択された文をコピーしてください");
      }
    },
    "imp-parse": () => {
      ui.importText = $("#impText").value;
      const { rows, skipped } = I.parseImport(ui.importText, state, { today: today() });
      ui.importRows = rows;
      ui.importSkipped = skipped;
      render();
      if (!rows.length) toast("取り込める行が見つかりませんでした。形式を確認してください");
    },
    "imp-clear": () => {
      ui.importText = "";
      ui.importRows = [];
      ui.importSkipped = [];
      render();
    },
    "imp-apply": () => {
      const rows = ui.importRows || [];
      const bad = rows.find((r) => r.include && (r.type === "balance" ? !r.accountId : r.type !== "payslip" && (!r.amount || !r.accountId)));
      if (bad) return toast("口座か金額が空の行があります");
      undoable(
        (done) => `${Object.entries(done).filter(([, v]) => v).map(([k, v]) => `${IMPORT_TYPE_LABEL[k]}${v}件`).join("・")}を取り込みました`,
        () => {
          const done = I.applyImport(state, rows, { today: today() });
          ui.importRows = [];
          ui.importSkipped = [];
          ui.importText = "";
          return done;
        }
      );
    },
    "no-spend": () => undoable("今日は「使っていない」にしました", () => K.markNoSpend(state, today())),
    "cal-mode": (b) => {
      ui.calMode = b.dataset.key;
      render();
    },
    earncal: (b) => {
      ui.tab = "menu";
      ui.sub = "earncal";
      ui.calMode = b.dataset.mode || (b.dataset.id ? "savings" : "income");
      ui.calGoalId = b.dataset.id || ui.calGoalId;
      ui.calMonth = today().slice(0, 7);
      render();
      window.scrollTo(0, 0);
    },
    "cal-month": (b) => {
      if (ui.sub === "periods") ui.perMonth = b.dataset.key;
      else ui.calMonth = b.dataset.key;
      render();
    },
    "per-tab": (b) => {
      ui.perTab = b.dataset.key;
      render();
    },
    "plan-new": () => planSheet(),
    "plan-initial": () => withInitial(initialSheet),
    "setup-open": () => setupSheet(),
    "setup-hide": () => {
      ui.setupHidden = true;
      render();
    },
    "setup-go": (b) => {
      const item = P.setupChecklist(state, { today: today() }).find((x) => x.key === b.dataset.key);
      if (!item) return;
      closeSheet();
      const tg = item.target;
      if (tg.type === "balance") return balanceSheet(K.accountById(state, tg.id));
      ui.tab = "menu";
      if (tg.type === "earncal") {
        ui.sub = "earncal";
        ui.calMode = "income";
      } else ui.sub = tg.type;
      render();
      window.scrollTo(0, 0);
    },
    "setup-dismiss": (b) => {
      state.settings.dismissedSetup = [...new Set([...(state.settings.dismissedSetup || []), b.dataset.key])];
      commit();
      setupSheet();
    },
    "setup-tent-ok": (b) => {
      const obj = (b.dataset.kind === "rec" ? state.recurrences : state.transactions).find((x) => x.id === b.dataset.id);
      if (obj) delete obj.tentative;
      commit();
      if (P.setupChecklist(state, { today: today() }).length) setupSheet();
      else closeSheet();
    },
    "setup-tent-edit": (b) => {
      closeSheet();
      if (b.dataset.kind === "rec") recSheet(state.recurrences.find((x) => x.id === b.dataset.id));
      else txSheet(state.transactions.find((x) => x.id === b.dataset.id));
    },
    "fresh-start": () => withInitial(() => {
      if (!confirm("今のデータをすべて消して、読み込んだ初期データだけの状態にします。\n\n念のため先に「設定・データ › JSONを書き出す」でバックアップしておくのがおすすめです。\n\n続けますか？")) return;
      const before = JSON.stringify(state);
      const { state: fresh } = P.freshStart({ today: today() });
      state = fresh;
      ui.tab = "home";
      ui.sub = null;
      ui.setupHidden = false;
      commit();
      window.scrollTo(0, 0);
      toast("まっさらにして初期データを入れました", () => {
        state = K.normalizeState(JSON.parse(before));
        commit();
        toast("元に戻しました");
      });
    }),
    "edits-open": () => editsSheet(),
    "edits-restore": () => {
      let saved;
      try {
        saved = JSON.parse(localStorage.getItem(EDITS_BACKUP_KEY));
      } catch (e) {
        saved = null;
      }
      if (!saved || !saved.state) return toast("バックアップがありません");
      if (!confirm(`修正ファイルを適用する前（${saved.savedOn}）のデータに戻します。それ以降に入力したデータは消えます。よろしいですか？`)) return;
      const before = JSON.stringify(state);
      state = K.normalizeState(saved.state);
      commit();
      toast("適用前のデータに戻しました", () => {
        state = K.normalizeState(JSON.parse(before));
        commit();
      });
    },
    "cover-up": (b) => moveCover(b.dataset.id, -1),
    "cover-down": (b) => moveCover(b.dataset.id, 1),
    "living-up": (b) => moveLiving(b.dataset.id, -1),
    "living-down": (b) => moveLiving(b.dataset.id, 1),
    "goal-new": () => goalSheet(null),
    "goal-edit": (b) => goalSheet(state.goals.find((x) => x.id === b.dataset.id)),
    "cat-new": () => catSheet(null),
    "cat-edit": (b) => catSheet(K.categoryById(state, b.dataset.id)),
    "whatif-remove": (b) => { ui.whatIf = ui.whatIf.filter((w) => w.id !== b.dataset.id); render(); },
    "whatif-save": (b) => {
      const w = ui.whatIf.find((x) => x.id === b.dataset.id);
      K.addTransaction(state, { accountId: w.accountId, date: w.date, amount: w.amount, label: w.label, categoryId: w.amount < 0 ? "cat_extra" : K.WINDFALL, status: w.date > today() ? "planned" : "actual" });
      ui.whatIf = ui.whatIf.filter((x) => x.id !== w.id);
      commit();
      toast("予定として保存しました");
    },
    export: () => {
      state.settings.lastExportOn = today();
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `kakeibo-${today()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      commit();
    },
    sample: () => {
      if (state.accounts.length && !confirm("今のデータをサンプルデータで置き換えますか？")) return;
      state = sampleState();
      ui.tab = "home";
      ui.sub = null;
      commit();
      toast("サンプルデータを読み込みました");
    },
    reset: () => {
      if (!confirm("すべてのデータを削除します。よろしいですか？")) return;
      state = K.emptyState();
      commit();
    },
  };

  document.addEventListener("click", (e) => {
    const tab = e.target.closest("[data-tab]");
    if (tab) {
      ui.tab = tab.dataset.tab;
      ui.sub = null;
      ui.draft = {};
      render();
      window.scrollTo(0, 0);
      return;
    }
    const go = e.target.closest("[data-tab-go]");
    if (go) {
      ui.tab = go.dataset.tabGo;
      ui.sub = null;
      render();
      window.scrollTo(0, 0);
      return;
    }
    const sub = e.target.closest("[data-sub-go]");
    if (sub) {
      ui.tab = "menu";
      ui.sub = sub.dataset.subGo;
      render();
      window.scrollTo(0, 0);
      return;
    }
    const b = e.target.closest("button[data-action]");
    if (b && actions[b.dataset.action]) actions[b.dataset.action](b);
  });

  $("#backBtn").addEventListener("click", () => {
    ui.sub = null;
    render();
  });

  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.action === "transfer-status") {
      undoable(`状態を「${K.TRANSFER_STATUS[t.value]}」にしました`, () => K.setTransferStatus(state, t.dataset.id, t.value));
      return;
    }
    if (t.dataset.action === "edits-file" && t.files[0]) {
      t.files[0].text().then((text) => {
        const box = $("#editsText");
        if (!box) return;
        box.value = text;
        const go = document.querySelector('#sheetBody [data-sheet-action="preview"]');
        if (go) go.click();
      });
      return;
    }
    if (t.dataset.action === "import" && t.files[0]) {
      t.files[0].text().then((text) => {
        try {
          const data = K.normalizeState(JSON.parse(text));
          if (!confirm("読み込んだデータで今のデータを置き換えますか？")) return;
          state = data;
          commit();
          toast("読み込みました");
        } catch (err) {
          toast("JSONを読み込めませんでした");
        }
      });
      return;
    }
    if (t.dataset.coverToggle) {
      const cur = K.coverAccounts(state);
      const id = t.dataset.coverToggle;
      K.setCoverAccounts(state, t.checked ? [...cur, id] : cur.filter((x) => x !== id));
      commit();
      toast("保存しました");
      return;
    }
    if (t.dataset.livingToggle) {
      const cur = K.livingAccounts(state);
      const id = t.dataset.livingToggle;
      K.setLivingAccounts(state, t.checked ? [...cur, id] : cur.filter((x) => x !== id));
      commit();
      const err = t.checked ? K.balanceError(state, id, 0) : null;
      toast(err ? `${err}。選んでも、残高が入るまでは次の口座から払う見込みにします` : "保存しました");
      return;
    }
    if (t.dataset.checkBalance !== undefined && t.tagName === "SELECT") {
      checkSelectedBalance(t);
      return;
    }
    if (t.dataset.revo !== undefined) {
      ui.revo = Object.assign({ apr: 18, startMonth: D.addMonths(today(), 1).slice(0, 7) }, ui.revo || {});
      const k = t.dataset.revo;
      ui.revo[k] = k === "balance" || k === "payment" ? Math.abs(money(t.value)) || "" : t.value;
      render();
      return;
    }
    if (t.dataset.imp !== undefined && ui.importRows) {
      const r = ui.importRows[Number(t.dataset.i)];
      if (!r) return;
      const field = t.dataset.imp;
      if (t.type === "checkbox") r[field] = t.checked;
      else if (field === "amount") r.amount = Math.abs(money(t.value)) || 0;
      else r[field] = t.value;
      if (field === "accountId" && r.type === "balance" && t.value && !r.warnings.length) r.include = true;
      render();
      return;
    }
    const bind = t.dataset.bind;
    if (!bind) {
      if (t.name === "categoryId" && t.type === "radio") {
        t.closest(".chips").querySelectorAll("label").forEach((l) => (l.style.borderColor = l.contains(t) ? "var(--accent)" : ""));
      }
      return;
    }
    if (bind === "includePlanned") ui.includePlanned = t.checked;
    else if (bind === "perCurrent") ui.perCurrent = t.checked;
    else if (bind === "otHours") ui.draft.otHours = t.value;
    else ui[bind] = t.value;
    if (bind === "scope") ui.selectedDate = null;
    render();
  });

  document.addEventListener("submit", (e) => {
    const form = e.target;
    const kind = form.dataset.form;
    if (!kind) return;
    e.preventDefault();
    const fd = new FormData(form);
    const t = today();
    if (kind === "tx") {
      const amt = money(fd.get("amount"));
      if (Number.isNaN(amt) || amt <= 0) return toast("金額を入力してください");
      const date = fd.get("date");
      const planned = fd.get("planned") === "on" || date > t;
      // 今日までの支出（残高から引くもの）は、口座の残高が足りなければ登録しない
      if (ui.inputKind === "expense" && !planned && fd.get("reflected") !== "on") {
        const err = K.balanceError(state, fd.get("accountId"), amt);
        if (err) return showBalanceError(form, "accountId", `${err}。別の口座を選ぶか、残高を更新してください`);
      }
      K.addTransaction(state, {
        accountId: fd.get("accountId"),
        date,
        amount: ui.inputKind === "expense" ? -amt : amt,
        categoryId: fd.get("categoryId") || "cat_other",
        label: fd.get("label"),
        status: planned ? "planned" : "actual",
        balanceAlreadyReflected: !planned && fd.get("reflected") === "on",
      });
      ui.draft = {};
      commit();
      toast(planned ? "予定を登録しました" : "登録して残高に反映しました");
    } else if (kind === "transfer") {
      const amt = money(fd.get("amount"));
      if (Number.isNaN(amt) || amt <= 0) return toast("金額を入力してください");
      if (fd.get("fromId") === fd.get("toId")) return toast("出金元と入金先が同じです");
      if (fd.get("status") !== "scheduled") {
        const err = K.balanceError(state, fd.get("fromId"), amt);
        if (err) return showBalanceError(form, "fromId", `${err}。出金元を変えるか、残高を更新してください`);
      }
      K.addTransfer(state, { fromId: fd.get("fromId"), toId: fd.get("toId"), amount: amt, date: fd.get("date"), status: fd.get("status"), label: fd.get("label") });
      commit();
      toast("振替を登録しました");
    } else if (kind === "whatif") {
      const amt = money(fd.get("amount"));
      if (Number.isNaN(amt) || amt <= 0) return toast("金額を入力してください");
      ui.whatIf.push({ id: K.uid("wi"), date: fd.get("date"), amount: fd.get("income") === "on" ? amt : -amt, label: fd.get("label"), accountId: fd.get("accountId") });
      render();
    } else if (kind === "living") {
      Object.assign(state.settings, {
        weekdayCost: money(fd.get("weekdayCost")) || 0,
        holidayCost: money(fd.get("holidayCost")) || 0,
        miscMonthly: money(fd.get("miscMonthly")) || 0,
        includeTodayLiving: fd.get("includeTodayLiving") === "on",
        extraHolidays: String(fd.get("extraHolidays") || "").split(/[\s,、]+/).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
      });
      commit();
      toast("保存しました");
    } else if (kind === "budget") {
      const amount = money(fd.get("amount"));
      state.settings.budget = { start: fd.get("start"), end: fd.get("end"), amount: Number.isNaN(amount) ? 0 : amount, includeMisc: fd.get("includeMisc") === "on" };
      if (state.settings.budget.end < state.settings.budget.start) return toast("終了日を開始日より後にしてください");
      commit();
    } else if (kind === "income-target") {
      const read = (k) => {
        const v = money(fd.get(k));
        return Number.isNaN(v) ? 0 : Math.max(0, v);
      };
      Object.assign(state.settings, {
        annualIncomeTarget: read("annualIncomeTarget"),
        baseMonthlyPay: read("baseMonthlyPay"),
        annualBonus: read("annualBonus"),
      });
      commit();
      toast("保存しました");
    } else if (kind === "reminder") {
      state.settings.reminderTime = fd.get("reminderTime") || "";
      commit();
      scheduleReminder();
      toast(state.settings.reminderTime ? `${state.settings.reminderTime}に確認します` : "リマインダーをオフにしました");
    } else if (kind === "settings") {
      const notify = fd.get("notify") === "on";
      Object.assign(state.settings, {
        payday: Math.min(31, Math.max(1, Number(fd.get("payday")) || 25)),
        paydayAdjust: fd.get("paydayAdjust"),
        salaryAccountId: fd.get("salaryAccountId"),
        threshold: money(fd.get("threshold")) || 0,
        taxThreshold: money(fd.get("taxThreshold")) || 200000,
        notify,
      });
      if (notify && "Notification" in window && Notification.permission === "default") Notification.requestPermission();
      commit();
      toast("保存しました");
    }
  });

  /* ---------- 通知（開いたときに1日1回） ---------- */

  const notifyOnOpen = () => {
    if (!state.settings.notify || !("Notification" in window) || Notification.permission !== "granted") return;
    const key = "kakeibo.notified";
    let last = "";
    try { last = localStorage.getItem(key) || ""; } catch (e) { /* noop */ }
    if (last === today()) return;
    const list = K.alerts(state).filter((a) => a.level !== "info");
    if (!list.length) return;
    try {
      new Notification("家計簿の警告", { body: list.map((a) => a.message).join("\n") });
      localStorage.setItem(key, today());
    } catch (e) { /* 一部ブラウザはページからの通知に非対応 */ }
  };

  /* ---------- 新しいバージョンの確認 ---------- */

  // Safari（とくにホーム画面に追加したもの）は古いファイルを使い続けることがあるので、
  // 開いたときにキャッシュを通さず index.html を取りに行き、バージョンが違えば更新を促す
  const APP_VERSION = document.documentElement.dataset.version || "";

  const reloadToVersion = (v) => {
    const url = new URL(location.href);
    url.searchParams.set("v", v || String(Date.now()));
    location.replace(url.toString());
  };

  const checkForUpdate = async ({ manual = false } = {}) => {
    if (location.protocol === "file:") {
      if (manual) toast("ファイルを直接開いている場合は、新しいファイルをダウンロードし直してください");
      return;
    }
    try {
      const res = await fetch(`index.html?check=${Date.now()}`, { cache: "no-store" });
      const html = await res.text();
      const m = /data-version="([^"]+)"/.exec(html);
      const latest = m ? m[1] : "";
      if (latest && latest !== APP_VERSION) showUpdateBar(latest);
      else if (manual) toast(`最新版です（${APP_VERSION}）`);
    } catch (e) {
      if (manual) toast("確認できませんでした（オフラインの可能性があります）");
    }
  };

  const showUpdateBar = (latest) => {
    if ($(".update-bar")) return;
    const bar = document.createElement("div");
    bar.className = "update-bar";
    bar.setAttribute("role", "status");
    const text = document.createElement("span");
    text.textContent = "新しいバージョンがあります";
    const b = document.createElement("button");
    b.type = "button";
    b.className = "small primary";
    b.textContent = "更新する";
    b.addEventListener("click", () => reloadToVersion(latest));
    bar.append(text, b);
    document.body.prepend(bar);
  };

  actions["check-update"] = () => checkForUpdate({ manual: true });

  /* ---------- 開いている間のリマインダー ---------- */

  // アプリを開いたまま指定時刻になったら、今日の記録がなければ知らせる（閉じているときは iPhone のリマインダーに任せる）
  let reminderTimer = null;
  const scheduleReminder = () => {
    clearTimeout(reminderTimer);
    const at = state.settings.reminderTime;
    if (!at) return;
    const [h, m] = at.split(":").map(Number);
    const target = new Date();
    target.setHours(h, m, 0, 0);
    const ms = target - new Date();
    if (ms <= 0) return;
    reminderTimer = setTimeout(() => {
      if (!K.needsReminder(state, nowParts())) return;
      render();
      if ("Notification" in window && Notification.permission === "granted") {
        try {
          new Notification("家計簿を記入", { body: "今日はまだ記録がありません" });
        } catch (e) { /* ページからの通知に非対応のブラウザ */ }
      } else {
        toast("今日はまだ記録がありません");
      }
    }, Math.min(ms, 2147483647));
  };

  if (state.accounts.length && !state.settings.backupSince && !state.settings.lastExportOn) {
    state.settings.backupSince = today();
    save();
  }
  render();
  notifyOnOpen();
  checkForUpdate();
  scheduleReminder();
  // しばらく開きっぱなしのとき・アプリに戻ってきたときも確認する
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      checkForUpdate();
      scheduleReminder();
      if (ui.tab === "home") render();
    }
  });
})();
