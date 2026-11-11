import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyze, bhAdjust, buildPeople, decodeBytes, fisherExact, parseCSV } from "../src/analysis.js";

const near = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("fisherExact matches scipy.stats.fisher_exact (two-sided)", () => {
  // Reference values computed with scipy.stats.fisher_exact([[a, b], [c, d]]).pvalue
  near(fisherExact(8, 2, 1, 5), 0.034965034965035, 1e-12);
  near(fisherExact(3, 1, 1, 3), 0.485714285714286, 1e-12);
  near(fisherExact(21, 9, 51, 134), 1.295611967488982e-5, 1e-12);
  near(fisherExact(0, 10, 10, 0), 1.082508822446903e-5, 1e-12);
  near(fisherExact(5, 5, 5, 5), 1.0, 1e-12);
});

test("bhAdjust matches the Benjamini-Hochberg procedure", () => {
  const q = bhAdjust([0.01, 0.04, 0.03, 0.2]);
  [0.04, 0.0533333, 0.0533333, 0.2].forEach((v, i) => near(q[i], v));
});

test("parseCSV handles quotes, semicolons and CRLF", () => {
  const rows = parseCSV('A;B\r\n"x;y";"say ""hi"""\r\n');
  assert.deepEqual(rows, [{ A: "x;y", B: 'say "hi"' }]);
});

test("decodeBytes reads windows-1251 exports", () => {
  const cp1251 = new Uint8Array([0xcf, 0xf0, 0xe8, 0xb8, 0xec]); // "Приём"
  assert.equal(decodeBytes(cp1251), "Приём");
});

const demo = analyze(buildPeople(parseCSV(readFileSync(new URL("../data/demo.csv", import.meta.url), "utf8"))));

test("demo: about one in three newcomers leaves within 90 days", () => {
  assert.ok(demo.earlyRate > 0.28 && demo.earlyRate < 0.4, `earlyRate ${demo.earlyRate}`);
});

test("demo: finds the planted warehouse and channel hotspots", () => {
  const values = demo.findings.filter((f) => !f.explainedBy).flatMap((f) => [f, ...f.aliases].map((s) => s.value));
  assert.ok(values.includes("Склад №2"));
  assert.ok(values.includes("Мельников Андрей Сергеевич"), "manager merged with his warehouse");
  assert.ok(values.includes("Авито"));
});

test("demo: the 2-of-3 trap is reported as too little data, never as a finding", () => {
  assert.ok(!demo.findings.some((f) => f.value === "Интернет-магазин"));
  const trap = demo.smallAlarming.filter((t) => [t, ...t.aliases].some((s) => s.value === "Интернет-магазин"));
  assert.equal(trap.length, 1, "department, manager and position of the same 3 people are one line");
  assert.equal(trap[0].k, 2);
  assert.equal(trap[0].n, 3);
  assert.equal(trap[0].aliases.length, 2);
});

test("demo: people of a warehouse whose manager is the hotspot are routed to HR", () => {
  const w2 = demo.thisWeek.filter((p) => p.department === "Склад №2");
  assert.ok(w2.length > 0);
  for (const p of w2) assert.match(p.talker, /^HR/);
});

test("demo: this-week list only holds people still employed and under 90 days", () => {
  for (const p of demo.thisWeek) {
    assert.equal(p.left, null);
    assert.ok(p.week >= 1 && p.week <= 13);
  }
});

test("an echo finding is marked as explained by the stronger one", () => {
  // Synthetic: a bad warehouse where every packer works; packers elsewhere are fine.
  const rows = [];
  let n = 0;
  const add = (dep, manager, position, early) => {
    const name = `Человек ${n++}`;
    rows.push({ Название: `Приём: ${name}`, Создана: "01.01.2025", Сотрудник: name, Подразделение: dep, Должность: position,
      Руководитель: manager, "Канал найма": "hh.ru", "Дата события": "01.01.2025", "Причина увольнения": "" });
    if (early) rows.push({ Название: `Увольнение: ${name}`, Создана: "01.02.2025", Сотрудник: name, Подразделение: dep,
      Должность: position, Руководитель: manager, "Канал найма": "hh.ru", "Дата события": "01.02.2025", "Причина увольнения": "x" });
  };
  for (let i = 0; i < 30; i++) add("Склад Б", "Б", i < 20 ? "Комплектовщик" : "Кладовщик", i < 24);
  for (let i = 0; i < 60; i++) add("Склад А", "А", i < 6 ? "Комплектовщик" : "Кладовщик", i >= 6 && i < 16);
  rows.push({ Название: "Приём: Последний", Создана: "01.01.2026", Сотрудник: "Последний", Подразделение: "Склад А",
    Должность: "Кладовщик", Руководитель: "А", "Канал найма": "hh.ru", "Дата события": "01.01.2026", "Причина увольнения": "" });
  const r = analyze(buildPeople(rows));
  const packer = r.findings.find((f) => f.value === "Комплектовщик");
  assert.ok(packer, "packers look bad on their own");
  assert.deepEqual(packer.explainedBy, ["Склад Б"]);
});

test("demo: segments with the same people are one hypothesis before the BH correction", () => {
  const sets = new Set(demo.tests.map((t) => t.memberIds.join()));
  assert.equal(sets.size, demo.tests.length, "no two tested segments share the exact same people");
  // Counting clones three times made "Отдел продаж (опт)" look significantly better; it must not.
  assert.ok(!demo.better.some((t) => [t, ...t.aliases].some((s) => s.value === "Отдел продаж (опт)")));
});

test("demo: this-week cards only hold people still inside their segment's typical leaving weeks", () => {
  for (const p of demo.thisWeek) {
    for (const f of p.hits) assert.ok(p.week <= f.riskUntilWeek, `${p.name} week ${p.week} > ${f.riskUntilWeek}`);
    for (const f of p.passed) assert.ok(p.week > f.riskUntilWeek);
  }
  assert.ok(demo.thisWeek.some((p) => p.passed.length), "someone in a hotspot has already passed its risk window");
});
