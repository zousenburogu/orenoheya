/* 残高推移の折れ線グラフ（SVG 手書き、依存なし） */
(function (root) {
  "use strict";

  const D = root.KDates;
  const NS = "http://www.w3.org/2000/svg";

  const shortYen = (v) => {
    const a = Math.abs(v);
    const sign = v < 0 ? "-" : "";
    if (a >= 10000) {
      const man = a / 10000;
      return `${sign}${man >= 100 ? Math.round(man) : Number(man.toFixed(1))}万`;
    }
    return `${sign}${a.toLocaleString("ja-JP")}`;
  };

  const niceTicks = (lo, hi, count) => {
    if (lo === hi) {
      lo -= 1000;
      hi += 1000;
    }
    const raw = (hi - lo) / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
    const start = Math.floor(lo / step) * step;
    const end = Math.ceil(hi / step) * step;
    const ticks = [];
    for (let v = start; v <= end + step / 2; v += step) ticks.push(Math.round(v));
    return ticks;
  };

  const el = (tag, attrs = {}, text) => {
    const n = document.createElementNS(NS, tag);
    Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v));
    if (text !== undefined) n.textContent = text;
    return n;
  };

  /**
   * cfg = {
   *   dates: [...], series: [{ name, values, cls: 's1'|'s2' }], threshold, compact,
   *   dayOff: [bool], selected: index|null, onSelect(index), ariaLabel
   * }
   */
  const lineChart = (container, cfg) => {
    container.innerHTML = "";
    const n = cfg.dates.length;
    if (!n) return;
    const W = Math.max(280, container.clientWidth || 320);
    const H = cfg.compact ? 150 : 260;
    const m = { l: cfg.compact ? 44 : 52, r: 14, t: 18, b: 26 };
    const pw = W - m.l - m.r;
    const ph = H - m.t - m.b;

    const all = cfg.series.flatMap((s) => s.values);
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    if (cfg.threshold !== undefined && cfg.threshold !== null) {
      lo = Math.min(lo, cfg.threshold);
      hi = Math.max(hi, cfg.threshold);
    }
    lo = Math.min(lo, 0);
    const ticks = niceTicks(lo, hi, cfg.compact ? 3 : 4);
    const yMin = ticks[0];
    const yMax = ticks[ticks.length - 1];
    const step = n > 1 ? pw / (n - 1) : 0;
    const x = (i) => m.l + (n > 1 ? i * step : pw / 2);
    const y = (v) => m.t + ph - ((v - yMin) / (yMax - yMin || 1)) * ph;

    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", tabindex: "0", "aria-label": cfg.ariaLabel || "残高推移グラフ" });

    // 休日の背景帯（生活費単価の違いが見えるように）
    if (cfg.dayOff && n > 1 && n <= 120) {
      const g = el("g");
      cfg.dayOff.forEach((off, i) => {
        if (!off) return;
        g.appendChild(el("rect", { class: "dayoff", x: x(i) - step / 2, y: m.t, width: step, height: ph }));
      });
      svg.appendChild(g);
    }

    // グリッドと Y 軸
    const axis = el("g", { class: "axis" });
    ticks.forEach((t) => {
      svg.appendChild(el("line", { class: t === 0 ? "zero" : "gridline", x1: m.l, x2: W - m.r, y1: y(t), y2: y(t) }));
      axis.appendChild(el("text", { x: m.l - 6, y: y(t) + 4, "text-anchor": "end" }, shortYen(t)));
    });

    // X 軸ラベル
    const labelCount = Math.min(n, cfg.compact ? 4 : Math.max(3, Math.floor(pw / 70)));
    const idxs = new Set();
    for (let k = 0; k < labelCount; k++) idxs.add(Math.round((k * (n - 1)) / Math.max(1, labelCount - 1)));
    idxs.forEach((i) => {
      const anchor = i === 0 ? "start" : i === n - 1 ? "end" : "middle";
      axis.appendChild(el("text", { x: x(i), y: H - 6, "text-anchor": anchor }, D.dayLabel(cfg.dates[i])));
    });
    svg.appendChild(axis);

    // 閾値ライン
    if (cfg.threshold) {
      svg.appendChild(el("line", { class: "threshold", x1: m.l, x2: W - m.r, y1: y(cfg.threshold), y2: y(cfg.threshold) }));
      svg.appendChild(el("text", { class: "threshold-label", x: W - m.r, y: y(cfg.threshold) - 4, "text-anchor": "end" }, `目安 ${shortYen(cfg.threshold)}`));
    }

    // 系列（残高は日単位で変わるのでステップ線）
    const stepPath = (vals) => {
      let d = `M${x(0)},${y(vals[0])}`;
      for (let i = 1; i < vals.length; i++) d += `H${x(i)}V${y(vals[i])}`;
      return d;
    };
    [...cfg.series].reverse().forEach((s) => {
      svg.appendChild(el("path", { class: `line ${s.cls}`, d: stepPath(s.values) }));
    });

    // 選択中の日
    const sel = el("line", { class: "selected", y1: m.t, y2: m.t + ph, visibility: "hidden" });
    svg.appendChild(sel);
    const showSelected = (i) => {
      if (i === null || i === undefined || i < 0 || i >= n) {
        sel.setAttribute("visibility", "hidden");
        return;
      }
      sel.setAttribute("x1", x(i));
      sel.setAttribute("x2", x(i));
      sel.setAttribute("visibility", "visible");
    };
    showSelected(cfg.selected);

    // 最低残高の点と直接ラベル
    const main = cfg.series[0].values;
    let minI = 0;
    main.forEach((v, i) => {
      if (v < main[minI]) minI = i;
    });
    const mx = x(minI);
    const my = y(main[minI]);
    const text = `最低 ${shortYen(main[minI])}（${D.dayLabel(cfg.dates[minI])}）`;
    const anchor = mx > W * 0.7 ? "end" : mx < W * 0.3 ? "start" : "middle";
    const ly = my + 20 > m.t + ph ? my - 10 : my + 20;
    const label = el("text", { class: "minlabel", x: mx, y: ly, "text-anchor": anchor }, text);
    svg.appendChild(label);
    svg.appendChild(el("circle", { class: "minpt", cx: mx, cy: my, r: 4.5 }));

    // クロスヘア＋ツールチップ
    const cross = el("line", { class: "cross", y1: m.t, y2: m.t + ph, visibility: "hidden" });
    svg.appendChild(cross);
    const dots = cfg.series.map((s) => {
      const c = el("circle", { r: 4, fill: `var(--${s.cls})`, stroke: "var(--surface)", "stroke-width": 2, visibility: "hidden" });
      svg.appendChild(c);
      return c;
    });
    const hit = el("rect", { class: "hit", x: m.l - step / 2, y: 0, width: pw + step, height: H });
    svg.appendChild(hit);
    container.appendChild(svg);

    const tip = document.createElement("div");
    tip.className = "tooltip";
    tip.hidden = true;
    container.appendChild(tip);

    const idxAt = (evt) => {
      const rect = svg.getBoundingClientRect();
      const px = ((evt.clientX - rect.left) / rect.width) * W;
      return Math.max(0, Math.min(n - 1, Math.round(n > 1 ? (px - m.l) / step : 0)));
    };

    const show = (i) => {
      cross.setAttribute("x1", x(i));
      cross.setAttribute("x2", x(i));
      cross.setAttribute("visibility", "visible");
      cfg.series.forEach((s, k) => {
        dots[k].setAttribute("cx", x(i));
        dots[k].setAttribute("cy", y(s.values[i]));
        dots[k].setAttribute("visibility", "visible");
      });
      tip.textContent = "";
      const date = document.createElement("div");
      date.className = "t-date";
      const hol = D.holidayName(cfg.dates[i]);
      date.textContent = D.dayLabelLong(cfg.dates[i]) + (hol ? ` ${hol}` : "");
      tip.appendChild(date);
      cfg.series.forEach((s) => {
        const row = document.createElement("div");
        row.className = "t-row";
        const key = document.createElement("span");
        key.className = "t-key";
        key.style.borderColor = `var(--${s.cls})`;
        const val = document.createElement("b");
        val.className = "num";
        val.textContent = root.Kakeibo.yen(s.values[i]);
        row.append(key, val);
        if (cfg.series.length > 1) {
          const name = document.createElement("span");
          name.className = "t-name";
          name.textContent = s.name;
          row.appendChild(name);
        }
        tip.appendChild(row);
      });
      tip.hidden = false;
      const cw = container.clientWidth;
      const scale = cw / W;
      const tx = x(i) * scale;
      const tw = tip.offsetWidth;
      tip.style.left = `${Math.max(0, Math.min(cw - tw, tx + 12 > cw - tw ? tx - tw - 12 : tx + 12))}px`;
      tip.style.top = `${m.t}px`;
    };
    const hide = () => {
      cross.setAttribute("visibility", "hidden");
      dots.forEach((d) => d.setAttribute("visibility", "hidden"));
      tip.hidden = true;
    };

    let current = cfg.selected ?? null;
    hit.addEventListener("pointermove", (e) => show(idxAt(e)));
    hit.addEventListener("pointerleave", hide);
    hit.addEventListener("click", (e) => {
      current = idxAt(e);
      showSelected(current);
      if (cfg.onSelect) cfg.onSelect(current);
    });
    svg.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      current = current === null ? minI : Math.max(0, Math.min(n - 1, current + (e.key === "ArrowRight" ? 1 : -1)));
      show(current);
      showSelected(current);
      if (cfg.onSelect) cfg.onSelect(current);
    });
    svg.addEventListener("blur", hide);
  };

  /**
   * 積み上げ縦棒グラフ。cfg = { labels, sublabels, series: [{ name, cls, values }], footer: { name, values }, ariaLabel }
   * 区分ごとの塗りの間に 2px の隙間、上端だけ角丸。棒にカーソル（タップ）で内訳のツールチップ
   */
  const stackedBars = (container, cfg) => {
    container.innerHTML = "";
    const n = cfg.labels.length;
    if (!n) return;
    const W = Math.max(280, container.clientWidth || 320);
    const H = 240;
    const m = { l: 44, r: 8, t: 12, b: cfg.footer ? 54 : 36 };
    const pw = W - m.l - m.r;
    const ph = H - m.t - m.b;
    const totals = cfg.labels.map((_, i) => cfg.series.reduce((a, s) => a + (s.values[i] || 0), 0));
    const ticks = niceTicks(0, Math.max(1, ...totals), 4);
    const yMax = ticks[ticks.length - 1];
    const y = (v) => m.t + ph - (v / yMax) * ph;
    const slot = pw / n;
    const bw = Math.min(56, slot * 0.6);
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": cfg.ariaLabel || "積み上げ棒グラフ" });
    const axis = el("g", { class: "axis" });
    ticks.forEach((t) => {
      svg.appendChild(el("line", { class: t === 0 ? "zero" : "gridline", x1: m.l, x2: W - m.r, y1: y(t), y2: y(t) }));
      axis.appendChild(el("text", { x: m.l - 6, y: y(t) + 4, "text-anchor": "end" }, shortYen(t)));
    });
    cfg.labels.forEach((label, i) => {
      const cx = m.l + slot * i + slot / 2;
      axis.appendChild(el("text", { x: cx, y: m.t + ph + 16, "text-anchor": "middle" }, label));
      if (cfg.footer) {
        axis.appendChild(el("text", { x: cx, y: m.t + ph + 34, "text-anchor": "middle", class: "footer-label" }, shortYen(cfg.footer.values[i])));
      }
    });
    svg.appendChild(axis);
    const tip = document.createElement("div");
    tip.className = "tooltip";
    tip.hidden = true;
    const bars = [];
    cfg.labels.forEach((label, i) => {
      const cx = m.l + slot * i + slot / 2;
      const g = el("g", { class: "bar-group", tabindex: "0", role: "img", "aria-label": `${label} ${cfg.series.map((s) => `${s.name}${root.Kakeibo.yen(s.values[i] || 0)}`).join("、")}` });
      let acc = 0;
      const visible = cfg.series.map((s, k) => ({ s, k, v: s.values[i] || 0 })).filter((x) => x.v > 0);
      visible.forEach((x, j) => {
        const top = y(acc + x.v);
        const bottom = y(acc);
        const gap = j > 0 ? 2 : 0; // 塗りの間に 2px の隙間
        const h = Math.max(0, bottom - top - gap);
        const isTop = j === visible.length - 1;
        const r = isTop ? Math.min(4, h) : 0;
        const x0 = cx - bw / 2;
        // 上端だけ角丸の四角形
        const d = `M${x0},${top + h}V${top + r}${r ? `Q${x0},${top} ${x0 + r},${top}` : ""}H${x0 + bw - r}${r ? `Q${x0 + bw},${top} ${x0 + bw},${top + r}` : ""}V${top + h}Z`;
        g.appendChild(el("path", { d, class: `bar-seg ${x.s.cls}` }));
        acc += x.v;
      });
      g.appendChild(el("rect", { x: m.l + slot * i, y: m.t, width: slot, height: ph, fill: "transparent" }));
      const show = () => {
        tip.textContent = "";
        const head = document.createElement("div");
        head.className = "t-date";
        head.textContent = `${label}${cfg.sublabels ? ` ${cfg.sublabels[i]}` : ""}`;
        tip.appendChild(head);
        [...cfg.series].reverse().forEach((s) => {
          const row = document.createElement("div");
          row.className = "t-row";
          const key = document.createElement("span");
          key.className = `t-swatch ${s.cls}`;
          const val = document.createElement("b");
          val.className = "num";
          val.textContent = root.Kakeibo.yen(s.values[i] || 0);
          const name = document.createElement("span");
          name.className = "t-name";
          name.textContent = s.name;
          row.append(key, val, name);
          tip.appendChild(row);
        });
        const tot = document.createElement("div");
        tot.className = "t-row";
        tot.style.marginTop = "4px";
        const tv = document.createElement("b");
        tv.className = "num";
        tv.textContent = root.Kakeibo.yen(totals[i]);
        const tn = document.createElement("span");
        tn.className = "t-name";
        tn.textContent = "費用合計";
        tot.append(tv, tn);
        tip.appendChild(tot);
        tip.hidden = false;
        const scale = container.clientWidth / W;
        const left = (cx + bw / 2 + 8) * scale;
        tip.style.left = `${Math.max(0, Math.min(container.clientWidth - tip.offsetWidth, left + tip.offsetWidth > container.clientWidth ? (cx - bw / 2 - 8) * scale - tip.offsetWidth : left))}px`;
        tip.style.top = `${m.t}px`;
        bars.forEach((b) => b.classList.toggle("dim", b !== g));
      };
      const hide = () => {
        tip.hidden = true;
        bars.forEach((b) => b.classList.remove("dim"));
      };
      g.addEventListener("pointerenter", show);
      g.addEventListener("pointerleave", hide);
      g.addEventListener("focus", show);
      g.addEventListener("blur", hide);
      g.addEventListener("click", show);
      bars.push(g);
      svg.appendChild(g);
    });
    container.appendChild(svg);
    container.appendChild(tip);
  };

  root.KChart = { lineChart, stackedBars, shortYen };
})(window);
