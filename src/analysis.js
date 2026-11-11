// Early-leaver analysis for a Bitrix24 task export. Pure functions: runs in the browser and in node tests.

export const EARLY_DAYS = 90;
const DAY = 86400000;
const MIN_N = 10; // smaller segments are reported as "мало данных", never as a finding
const FDR = 0.1; // Benjamini-Hochberg false discovery rate across all segment tests

export const DIMENSIONS = [
  ["department", "Подразделение"],
  ["manager", "Руководитель"],
  ["position", "Должность"],
  ["channel", "Канал найма"],
  ["season", "Сезон найма"],
];

const COLUMNS = {
  title: "Название",
  employee: "Сотрудник",
  department: "Подразделение",
  position: "Должность",
  manager: "Руководитель",
  channel: "Канал найма",
  eventDate: "Дата события",
  reason: "Причина увольнения",
};

// ---------- CSV ----------

export function decodeBytes(bytes) {
  // Bitrix24 exports CSV in windows-1251; fall back to it when UTF-8 decoding produces garbage.
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  if (!utf8.includes("�")) return utf8.replace(/^﻿/, "");
  return new TextDecoder("windows-1251").decode(bytes);
}

export function parseCSV(text) {
  const sep = (text.split("\n")[0].match(/;/g) || []).length >= (text.split("\n")[0].match(/,/g) || []).length ? ";" : ",";
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((v) => v.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== "")) rows.push(row);
  const header = rows.shift().map((h) => h.trim());
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}

export function parseDate(s) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(s || "");
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) : null;
}

export function formatDate(t) {
  const d = new Date(t);
  return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`;
}

function season(t) {
  const m = new Date(t).getUTCMonth();
  return ["Зима", "Зима", "Весна", "Весна", "Весна", "Лето", "Лето", "Лето", "Осень", "Осень", "Осень", "Зима"][m];
}

// ---------- tasks -> people ----------

export function buildPeople(tasks) {
  const missing = Object.values(COLUMNS).filter((c) => !(c in (tasks[0] || {})));
  if (missing.length) throw new Error(`В файле нет колонок: ${missing.join(", ")}`);
  const hires = [], dismissals = [];
  let asOf = 0;
  for (const t of tasks) {
    const date = parseDate(t[COLUMNS.eventDate]);
    if (date === null) continue;
    asOf = Math.max(asOf, date, parseDate(t["Создана"]) || 0);
    const title = t[COLUMNS.title].toLowerCase();
    if (title.startsWith("приём") || title.startsWith("прием")) hires.push({ t, date });
    else if (title.startsWith("увольнение")) dismissals.push({ t, date });
  }
  hires.sort((a, b) => a.date - b.date);
  const used = new Set();
  const people = hires.map(({ t, date }, id) => {
    // A dismissal belongs to the same full name, on or after the hire date; first match wins (rehires stay separate).
    const d = dismissals.find((x) => !used.has(x) && x.t[COLUMNS.employee] === t[COLUMNS.employee] && x.date >= date);
    if (d) used.add(d);
    return {
      id,
      name: t[COLUMNS.employee],
      department: t[COLUMNS.department],
      position: t[COLUMNS.position],
      manager: t[COLUMNS.manager],
      channel: t[COLUMNS.channel] || "не указан",
      hired: date,
      season: season(date),
      left: d ? d.date : null,
      reason: d ? d.t[COLUMNS.reason] : "",
    };
  });
  return { people, asOf, unmatchedDismissals: dismissals.length - used.size };
}

// ---------- statistics ----------

const logFact = [0];
function lf(n) {
  for (let i = logFact.length; i <= n; i++) logFact[i] = logFact[i - 1] + Math.log(i);
  return logFact[n];
}

// Two-sided Fisher exact test for the 2x2 table [[a, b], [c, d]].
export function fisherExact(a, b, c, d) {
  const r1 = a + b, r2 = c + d, c1 = a + c, n = r1 + r2;
  const p = (x) => Math.exp(lf(r1) + lf(r2) + lf(c1) + lf(n - c1) - lf(n) - lf(x) - lf(r1 - x) - lf(c1 - x) - lf(r2 - c1 + x));
  const pObs = p(a);
  let total = 0;
  for (let x = Math.max(0, c1 - r2); x <= Math.min(r1, c1); x++) {
    const px = p(x);
    if (px <= pObs * (1 + 1e-7)) total += px;
  }
  return Math.min(1, total);
}

// Benjamini-Hochberg adjusted p-values (q-values), same order as input.
export function bhAdjust(ps) {
  const order = ps.map((p, i) => [p, i]).sort((x, y) => x[0] - y[0]);
  const q = new Array(ps.length);
  let min = 1;
  for (let r = order.length - 1; r >= 0; r--) {
    min = Math.min(min, (order[r][0] * order.length) / (r + 1));
    q[order[r][1]] = min;
  }
  return q;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

// Nearest-rank quantile; whole weeks, so no interpolation.
const quantile = (xs, f) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil(f * s.length) - 1)] : null;
};

// ---------- analysis ----------

// Segments with identical members (e.g. a department and its only manager) are one finding, not several.
function mergeSame(tests) {
  const out = [];
  for (const t of tests) {
    const same = out.find((f) => f.memberIds.join() === t.memberIds.join());
    if (same) same.aliases.push(t);
    else out.push({ ...t, aliases: [] });
  }
  return out;
}

export function analyze({ people, asOf }) {
  const tenure = (p) => Math.floor(((p.left ?? asOf) - p.hired) / DAY);
  // Only people hired at least 90 days ago have a known outcome.
  const cohort = people.filter((p) => asOf - p.hired >= EARLY_DAYS * DAY);
  const isEarly = (p) => p.left !== null && p.left - p.hired < EARLY_DAYS * DAY;
  const earlyTotal = cohort.filter(isEarly).length;

  const tests = [];
  for (const [key, label] of DIMENSIONS) {
    const values = [...new Set(cohort.map((p) => p[key]))];
    for (const value of values) {
      const members = cohort.filter((p) => p[key] === value);
      const k = members.filter(isEarly).length, n = members.length;
      const restK = earlyTotal - k, restN = cohort.length - n;
      if (restN === 0) continue;
      tests.push({
        key, label, value, n, k,
        rate: k / n,
        restRate: restK / restN,
        p: fisherExact(k, n - k, restK, restN - restK),
        memberIds: members.map((m) => m.id),
        leaveWeeks: members.filter(isEarly).map((m) => Math.floor(tenure(m) / 7) + 1),
      });
    }
  }
  // Segments with the same people (a department, its only manager, its only position) are one hypothesis:
  // merge them before the correction, otherwise clones inflate each other's significance.
  const units = mergeSame(tests);
  const q = bhAdjust(units.map((t) => t.p));
  units.forEach((t, i) => {
    t.q = q[i];
    const worse = t.rate > t.restRate;
    t.status = t.n < MIN_N ? "мало данных" : t.q < FDR ? (worse ? "хуже" : "лучше") : "норма";
    t.medianLeaveWeek = median(t.leaveWeeks);
    // Week by which 3 of 4 early leavers of this segment were gone: after it the typical danger has passed.
    t.riskUntilWeek = quantile(t.leaveWeeks, 0.75);
  });

  const findings = units.filter((t) => t.status === "хуже").sort((a, b) => b.rate - a.rate);
  // A weaker finding may only echo a stronger one (e.g. "Комплектовщик" because most of them work at a bad
  // warehouse). Retest it without the people of stronger findings; if the effect is gone, say what explains it.
  const seen = new Set();
  for (const f of findings) {
    const rest = cohort.filter((p) => !seen.has(p.id));
    const own = rest.filter((p) => f.memberIds.includes(p.id));
    const others = rest.filter((p) => !f.memberIds.includes(p.id));
    const k = own.filter(isEarly).length, ok = others.filter(isEarly).length;
    f.residual = { n: own.length, k, p: own.length && others.length ? fisherExact(k, own.length - k, ok, others.length - ok) : 1 };
    f.explainedBy = seen.size && f.residual.p >= 0.05
      ? findings.filter((g) => g !== f && g.explainedBy === null && g.memberIds.some((id) => f.memberIds.includes(id))).map((g) => g.value)
      : null;
    if (f.explainedBy && !f.explainedBy.length) f.explainedBy = null;
    if (!f.explainedBy) f.memberIds.forEach((id) => seen.add(id));
  }
  const smallAlarming = units.filter((t) => t.status === "мало данных" && t.k >= 2 && t.rate > t.restRate);
  const better = units.filter((t) => t.status === "лучше").sort((a, b) => a.rate - b.rate);

  // Newcomers still employed and inside the 90-day window. "hits" are findings whose typical leaving weeks
  // are still ahead of this person (talk this week); "passed" are findings whose danger window is behind them.
  const current = people.filter((p) => p.left === null && asOf - p.hired < EARLY_DAYS * DAY);
  const thisWeek = current.map((p) => {
    const week = Math.floor(tenure(p) / 7) + 1;
    const inFinding = findings.filter((f) => !f.explainedBy && [f, ...f.aliases].some((s) => p[s.key] === s.value));
    const hits = inFinding.filter((f) => week <= f.riskUntilWeek);
    const passed = inFinding.filter((f) => week > f.riskUntilWeek);
    const managerIsFinding = hits.some((f) => [f, ...f.aliases].some((s) => s.key === "manager"));
    return {
      ...p, week, hits, passed,
      talker: managerIsFinding ? "HR (руководитель сам в зоне риска)" : `Руководитель: ${p.manager}`,
    };
  }).sort((a, b) => b.hits.length - a.hits.length || a.week - b.week);

  return {
    asOf,
    cohortSize: cohort.length,
    earlyTotal,
    earlyRate: cohort.length ? earlyTotal / cohort.length : 0,
    medianLeaveWeek: median(cohort.filter(isEarly).map((m) => Math.floor(tenure(m) / 7) + 1)),
    tests: units,
    findings,
    smallAlarming,
    better,
    thisWeek,
  };
}
