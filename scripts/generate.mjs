// Generates a fictional Bitrix24 task export (hire / dismissal tasks) for a ~400-person sporting goods
// retailer. Planted on purpose, so the demo has something true to find:
//   1. Склад №2 (one manager) loses most newcomers in weeks 3-8;
//   2. store staff hired in summer leave early more often;
//   3. hires from "Авито" leave early more often than referrals;
//   4. a trap: "Интернет-магазин" has 3 hires and 2 early leavers - too few to conclude anything.
// Usage: node scripts/generate.mjs > data/demo.csv
const AS_OF = Date.UTC(2026, 10, 11); // export date
const DAY = 86400000;

let seed = 20261111;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const weighted = (pairs) => {
  let r = rnd() * pairs.reduce((s, [, w]) => s + w, 0);
  for (const [v, w] of pairs) if ((r -= w) < 0) return v;
  return pairs[0][0];
};

const DEPARTMENTS = [
  // name, manager, positions, hires per year, base early-leave probability
  ["Склад №1", "Беляев Олег Викторович", ["Комплектовщик", "Кладовщик", "Водитель погрузчика"], 24, 0.2],
  ["Склад №2", "Мельников Андрей Сергеевич", ["Комплектовщик", "Кладовщик", "Водитель погрузчика"], 16, 0.6],
  ["Магазин «Центр»", "Захарова Ирина Павловна", ["Продавец-консультант", "Кассир", "Старший продавец"], 22, 0.14],
  ["Магазин «Север»", "Голубев Денис Игоревич", ["Продавец-консультант", "Кассир"], 18, 0.15],
  ["Магазин «Юг»", "Киселёва Марина Олеговна", ["Продавец-консультант", "Кассир"], 18, 0.14],
  ["Отдел продаж (опт)", "Фёдоров Артём Николаевич", ["Менеджер по продажам"], 12, 0.15],
  ["Офис", "Соколова Елена Андреевна", ["Бухгалтер", "Логист", "Маркетолог", "Специалист по закупкам"], 8, 0.08],
];
const CHANNELS = [["hh.ru", 45], ["Авито", 25], ["Рекомендация сотрудника", 18], ["Сайт компании", 8], ["Кадровое агентство", 4]];
const LEAVE_REASONS_EARLY = [
  "Не устроил график", "Ожидал другую зарплату", "Тяжёлая физическая работа", "Нашёл другую работу",
  "Не сложились отношения в коллективе", "Не вышел на смену", "Переезд",
];
const LEAVE_REASONS_LATE = ["Нашёл другую работу", "Переезд", "Учёба", "Семейные обстоятельства", "Повышение у другого работодателя"];
const FIRST = { m: ["Алексей", "Дмитрий", "Иван", "Максим", "Никита", "Павел", "Роман", "Сергей", "Тимур", "Егор", "Кирилл", "Артур"],
  f: ["Анна", "Дарья", "Екатерина", "Ксения", "Мария", "Ольга", "Полина", "София", "Юлия", "Вера", "Алина", "Наталья"] };
const LAST = ["Абрамов", "Борисов", "Власов", "Гусев", "Данилов", "Ершов", "Жуков", "Зуев", "Ильин", "Комаров", "Лебедев",
  "Медведев", "Никитин", "Орлов", "Петров", "Романов", "Савин", "Тихонов", "Устинов", "Филиппов", "Хомяков", "Чернов",
  "Шилов", "Щукин", "Яковлев", "Антонов", "Белов", "Воронин", "Григорьев", "Денисов", "Егоров", "Зайцев", "Карпов"];
const MIDDLE = { m: ["Александрович", "Андреевич", "Викторович", "Игоревич", "Олегович", "Сергеевич"],
  f: ["Александровна", "Андреевна", "Викторовна", "Игоревна", "Олеговна", "Сергеевна"] };
const usedNames = new Set();
function name() {
  for (;;) {
    const g = rnd() < 0.5 ? "m" : "f";
    const last = pick(LAST) + (g === "f" ? "а" : "");
    const n = `${last} ${pick(FIRST[g])} ${pick(MIDDLE[g])}`;
    if (!usedNames.has(n)) { usedNames.add(n); return n; }
  }
}

const fmt = (t) => {
  const d = new Date(t);
  return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`;
};

const tasks = [];
let taskId = 48210;
const HR = "Кравцова Светлана Юрьевна";
function addTask(title, created, closed, employee, dep, position, manager, channel, eventDate, reason) {
  tasks.push({ ID: taskId++, Название: title, Статус: closed && closed <= AS_OF ? "Завершена" : "Ждёт выполнения",
    Постановщик: manager, Ответственный: HR, Создана: fmt(created), Закрыта: closed && closed <= AS_OF ? fmt(closed) : "",
    Сотрудник: employee, Подразделение: dep, Должность: position, Руководитель: manager, "Канал найма": channel,
    "Дата события": fmt(eventDate), "Причина увольнения": reason });
}

function hire(dep, manager, position, hired, earlyP, channel) {
  const employee = name();
  addTask(`Приём: ${employee}`, hired - 7 * DAY, hired, employee, dep, position, manager, channel, hired, "");
  let leave = null, reason = "";
  if (rnd() < earlyP) {
    // Склад №2 newcomers leave in weeks 3-8, others anywhere in the first 12 weeks.
    const days = dep === "Склад №2" ? 14 + Math.floor(rnd() * 42) : 3 + Math.floor(rnd() * 84);
    leave = hired + days * DAY;
    reason = pick(LEAVE_REASONS_EARLY);
  } else if (rnd() < 0.3) {
    leave = hired + (95 + Math.floor(rnd() * 500)) * DAY;
    reason = pick(LEAVE_REASONS_LATE);
  }
  if (leave !== null && leave <= AS_OF) {
    addTask(`Увольнение: ${employee}`, leave - 3 * DAY, leave, employee, dep, position, manager, channel, leave, reason);
  }
}

const START = AS_OF - 2 * 365 * DAY;
for (const [dep, manager, positions, perYear, base] of DEPARTMENTS) {
  const total = Math.round(perYear * 2 * (1 + (rnd() - 0.5) * 0.2));
  for (let i = 0; i < total; i++) {
    const hired = START + Math.floor(rnd() * (AS_OF - START) / DAY) * DAY;
    const channel = weighted(CHANNELS);
    const month = new Date(hired).getUTCMonth();
    let p = base;
    if (dep.startsWith("Магазин") && month >= 5 && month <= 7) p += 0.38; // summer rush in stores
    if (channel === "Авито") p += 0.2;
    if (channel === "Рекомендация сотрудника") p -= 0.1;
    hire(dep, manager, pick(positions), hired, Math.min(0.9, Math.max(0.02, p)), channel);
  }
}
// The trap: a tiny department with a scary-looking but meaningless ratio.
const trap = ["Интернет-магазин", "Орлова Татьяна Михайловна", "Контент-менеджер"];
for (const [daysAgo, early] of [[600, true], [420, true], [300, false]]) {
  const employee = name(), hired = AS_OF - daysAgo * DAY;
  addTask(`Приём: ${employee}`, hired - 7 * DAY, hired, employee, trap[0], trap[2], trap[1], "hh.ru", hired, "");
  if (early) {
    const leave = hired + 40 * DAY;
    addTask(`Увольнение: ${employee}`, leave - 3 * DAY, leave, employee, trap[0], trap[2], trap[1], "hh.ru", leave, "Нашёл другую работу");
  }
}

tasks.sort((a, b) => a.ID - b.ID);
const cols = Object.keys(tasks[0]);
const esc = (v) => (/[;"\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
process.stdout.write([cols.join(";"), ...tasks.map((t) => cols.map((c) => esc(t[c])).join(";"))].join("\n") + "\n");
