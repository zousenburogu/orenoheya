/* 日付ユーティリティと日本の祝日判定。日付は 'YYYY-MM-DD' 文字列で扱う（タイムゾーン事故を避けるため UTC で計算）。 */
(function (root) {
  "use strict";

  const pad = (n) => String(n).padStart(2, "0");

  const parse = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  };

  const fmt = (dt) => `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;

  const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

  const addDays = (s, n) => {
    const dt = parse(s);
    dt.setUTCDate(dt.getUTCDate() + n);
    return fmt(dt);
  };

  const diffDays = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);

  const dow = (s) => parse(s).getUTCDay();

  const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

  const today = () => {
    const now = new Date();
    return ymd(now.getFullYear(), now.getMonth() + 1, now.getDate());
  };

  const endOfMonth = (s, offset = 0) => {
    const dt = parse(s);
    const y = dt.getUTCFullYear();
    const m = dt.getUTCMonth() + 1 + offset;
    const last = new Date(Date.UTC(y, m, 0));
    return fmt(last);
  };

  const addMonths = (s, n) => {
    const dt = parse(s);
    const y = dt.getUTCFullYear();
    const m = dt.getUTCMonth() + n;
    const target = new Date(Date.UTC(y, m, 1));
    const dim = daysInMonth(target.getUTCFullYear(), target.getUTCMonth() + 1);
    target.setUTCDate(Math.min(dt.getUTCDate(), dim));
    return fmt(target);
  };

  // n 番目の weekday (0=日) の日付
  const nthWeekday = (y, m, n, weekday) => {
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
    return ymd(y, m, day);
  };

  const holidayCache = new Map();

  // 国民の祝日（2020年以降のルール。春分・秋分は 1980–2099 年の近似式）
  const holidaysOfYear = (y) => {
    if (holidayCache.has(y)) return holidayCache.get(y);
    const h = new Map();
    const add = (m, d, name) => h.set(ymd(y, m, d), name);
    const addS = (s, name) => h.set(s, name);

    add(1, 1, "元日");
    addS(nthWeekday(y, 1, 2, 1), "成人の日");
    add(2, 11, "建国記念の日");
    if (y >= 2020) add(2, 23, "天皇誕生日");
    const t = y - 1980;
    add(3, Math.floor(20.8431 + 0.242194 * t - Math.floor(t / 4)), "春分の日");
    add(4, 29, "昭和の日");
    add(5, 3, "憲法記念日");
    add(5, 4, "みどりの日");
    add(5, 5, "こどもの日");
    if (y === 2020) {
      add(7, 23, "海の日");
      add(7, 24, "スポーツの日");
      add(8, 10, "山の日");
    } else if (y === 2021) {
      add(7, 22, "海の日");
      add(7, 23, "スポーツの日");
      add(8, 8, "山の日");
    } else {
      addS(nthWeekday(y, 7, 3, 1), "海の日");
      add(8, 11, "山の日");
      addS(nthWeekday(y, 10, 2, 1), y >= 2020 ? "スポーツの日" : "体育の日");
    }
    addS(nthWeekday(y, 9, 3, 1), "敬老の日");
    add(9, Math.floor(23.2488 + 0.242194 * t - Math.floor(t / 4)), "秋分の日");
    add(11, 3, "文化の日");
    add(11, 23, "勤労感謝の日");

    // 国民の休日：祝日に挟まれた平日
    const base = [...h.keys()].sort();
    base.forEach((d) => {
      const next2 = addDays(d, 2);
      const mid = addDays(d, 1);
      if (h.has(next2) && !h.has(mid) && dow(mid) !== 0) h.set(mid, "国民の休日");
    });

    // 振替休日：日曜の祝日の後の最初の平日
    [...h.keys()].sort().forEach((d) => {
      if (dow(d) !== 0) return;
      let s = addDays(d, 1);
      while (h.has(s)) s = addDays(s, 1);
      h.set(s, "振替休日");
    });

    holidayCache.set(y, h);
    return h;
  };

  const holidayName = (s) => holidaysOfYear(Number(s.slice(0, 4))).get(s) || null;

  const isWeekend = (s) => {
    const w = dow(s);
    return w === 0 || w === 6;
  };

  // 生活費の「休日」判定（土日・祝日・ユーザー指定の休み）
  const isDayOff = (s, extraHolidays = []) =>
    isWeekend(s) || !!holidayName(s) || extraHolidays.includes(s);

  // 銀行休業日（土日・祝日・12/31〜1/3）
  const isBankHoliday = (s) => {
    const md = s.slice(5);
    return isWeekend(s) || !!holidayName(s) || md === "12-31" || md === "01-01" || md === "01-02" || md === "01-03";
  };

  const adjustBusinessDay = (s, mode) => {
    if (mode !== "prev" && mode !== "next") return s;
    const step = mode === "prev" ? -1 : 1;
    let d = s;
    while (isBankHoliday(d)) d = addDays(d, step);
    return d;
  };

  const dayLabel = (s) => {
    const dt = parse(s);
    return `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`;
  };

  const WEEK = ["日", "月", "火", "水", "木", "金", "土"];
  const dayLabelLong = (s) => `${dayLabel(s)}(${WEEK[dow(s)]})`;

  const api = {
    parse, fmt, ymd, addDays, diffDays, dow, daysInMonth, today, endOfMonth, addMonths,
    holidaysOfYear, holidayName, isWeekend, isDayOff, isBankHoliday, adjustBusinessDay,
    dayLabel, dayLabelLong, WEEK,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.KDates = api;
})(typeof window !== "undefined" ? window : globalThis);
