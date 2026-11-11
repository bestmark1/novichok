import { analyze, buildPeople, decodeBytes, formatDate, parseCSV, EARLY_DAYS } from "./analysis.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const pct = (x) => `${Math.round(x * 100)}%`;
// p-values in Russian notation: "p < 0,001" or "p = 0,034".
const pv = (name, v) => (v < 0.001 ? `${name} < 0,001` : `${name} = ${v.toFixed(3).replace(".", ",")}`);
const DAY = 86400000;
const QUESTIONS = [
  "Что за эти недели оказалось не так, как обещали на собеседовании?",
  "К кому ты идёшь, когда что-то непонятно, и помогают ли тебе?",
  "Что одно изменить, чтобы тебе было проще работать?",
];

function segmentTitle(f) {
  return [f, ...f.aliases].map((s) => `${s.label.toLowerCase()} «${esc(s.value)}»`).join(" · ");
}

function peopleTable(people, asOf) {
  const rows = people.map((p) => {
    const end = p.left ?? asOf;
    const weeks = Math.floor((end - p.hired) / DAY / 7) + 1;
    const early = p.left !== null && p.left - p.hired < EARLY_DAYS * DAY;
    return `<tr class="${early ? "early" : ""}"><td>${esc(p.name)}</td><td>${esc(p.position)}</td><td>${esc(p.channel)}</td>
      <td>${formatDate(p.hired)}</td><td>${p.left ? formatDate(p.left) : "работает"}</td><td>${weeks}</td><td>${esc(p.reason)}</td></tr>`;
  }).join("");
  return `<table><thead><tr><th>Сотрудник</th><th>Должность</th><th>Канал</th><th>Принят</th><th>Ушёл</th><th>Недель</th><th>Причина</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function render({ people, asOf, unmatchedDismissals }, label) {
  const r = analyze({ people, asOf });
  const byId = new Map(people.map((p) => [p.id, p]));
  const testsCount = r.tests.length;
  $("source").textContent = `${label} · данные на ${formatDate(asOf)} · ${people.length} приёмов`
    + (unmatchedDismissals ? ` · ${unmatchedDismissals} увольнений без задачи о приёме не учтены` : "");

  const findings = r.findings.map((f) => {
    const weeks = f.medianLeaveWeek ? `Обычно уходят на ${f.medianLeaveWeek}-й неделе.` : "";
    const echo = f.explainedBy
      ? `<p class="echo">Скорее всего, это отражение очага «${esc(f.explainedBy.join("», «"))}»: без его людей разница пропадает (${f.residual.k} из ${f.residual.n}, ${esc(pv("p", f.residual.p))}).</p>`
      : "";
    return `<article class="finding ${f.explainedBy ? "explained" : ""}">
      <h3>${segmentTitle(f)}</h3>
      <p class="big"><b>${pct(f.rate)}</b> новичков не дорабатывают до 90 дней (${f.k} из ${f.n}). В остальной компании (без этого среза) — ${pct(f.restRate)}.</p>
      <p>${weeks} Если бы на деле разницы не было, такой или больший разрыв получался бы случайно с вероятностью ${esc(pv("p", f.p))};
        с поправкой на ${testsCount} проверенных срезов ${esc(pv("q", f.q))}.</p>
      ${echo}
      <details><summary>Люди в этом срезе (${f.n})</summary>${peopleTable(f.memberIds.map((id) => byId.get(id)), asOf)}</details>
    </article>`;
  }).join("") || `<p class="empty">Ни один срез не отличается от среднего по компании сильнее, чем могло бы быть случайно.</p>`;

  const small = r.smallAlarming.map((t) =>
    `<li><b>${segmentTitle(t)}</b>: ${t.k} из ${t.n} ушли до 90 дней. Выглядит тревожно, но людей слишком мало для вывода — вернитесь, когда наберётся хотя бы 10 новичков.</li>`).join("");
  const better = r.better.map((t) =>
    `<li><b>${segmentTitle(t)}</b>: до 90 дней не дорабатывают ${pct(t.rate)} (${t.k} из ${t.n}) против ${pct(t.restRate)}. Стоит узнать, что там делают иначе.</li>`).join("");

  const done = JSON.parse(localStorage.getItem("novichok-talked") || "{}");
  const atRisk = r.thisWeek.filter((p) => p.hits.length);
  const calm = r.thisWeek.filter((p) => !p.hits.length);
  const cards = atRisk.map((p) => {
    const key = `${p.name}|${p.hired}`;
    const why = p.hits.map((f) => `${segmentTitle(f)}: до 90 дней не дорабатывают ${pct(f.rate)},`
      + ` трое из четырёх ушедших уходят до ${f.riskUntilWeek}-й недели`).join("; ");
    return `<article class="person ${done[key] ? "talked" : ""}">
      <h3>${esc(p.name)} <span>${esc(p.position)}, ${esc(p.department)} · ${p.week}-я неделя</span></h3>
      <p class="why">Почему в списке: ${why}.</p>
      <p><b>Кто говорит:</b> ${esc(p.talker)}</p>
      <ol>${QUESTIONS.map((q) => `<li>${q}</li>`).join("")}</ol>
      <label><input type="checkbox" data-key="${esc(key)}" ${done[key] ? "checked" : ""}> Поговорили${done[key] ? ` (${esc(done[key])})` : ""}</label>
    </article>`;
  }).join("") || `<p class="empty">Среди новичков на испытательном окне нет тех, кто попадает в очаги.</p>`;
  const calmList = calm.map((p) => `<li>${esc(p.name)} — ${esc(p.position)}, ${esc(p.department)}, ${p.week}-я неделя`
    + (p.passed.length ? ` · уже миновал(а) обычный срок ухода в срезе ${p.passed.map(segmentTitle).join(", ")}` : "") + `</li>`).join("");

  $("app").innerHTML = `
    <section class="kpis">
      <div><b>${r.cohortSize}</b><span>новичков, принятых больше 90 дней назад (их исход уже известен)</span></div>
      <div><b>${pct(r.earlyRate)}</b><span>из них не доработали до 90 дней (${r.earlyTotal} человек)</span></div>
      <div><b>${r.medianLeaveWeek ?? "—"}-я</b><span>неделя, на которой обычно уходят</span></div>
    </section>

    <section>
      <h2>На этой неделе: с кем поговорить</h2>
      <p class="hint">Работают меньше 90 дней, попадают в срез, где новички уходят значимо чаще, и ещё не прошли недели, на которые там приходится большинство уходов. Отметка «поговорили» хранится только в этом браузере.</p>
      <div class="people">${cards}</div>
      ${calm.length ? `<details><summary>Остальные новички младше 90 дней (${calm.length})</summary><ul>${calmList}</ul></details>` : ""}
    </section>

    <section>
      <h2>Где теряем новичков</h2>
      <p class="hint">Каждый срез (подразделение, руководитель, должность, канал найма, сезон) сравнивается с остальной компанией точным тестом Фишера. Показаны только те, где разница не объясняется случайностью даже с поправкой на число проверок.</p>
      ${findings}
    </section>

    ${small ? `<section><h2>Выглядит плохо, но данных мало</h2><ul class="small">${small}</ul></section>` : ""}
    ${better ? `<section><h2>Где новички держатся лучше</h2><ul class="small">${better}</ul></section>` : ""}

    <section class="method">
      <h2>Как это считается и чего здесь нет</h2>
      <ul>
        <li>Новичок — человек из задачи «Приём: ФИО». Ушёл — есть задача «Увольнение: ФИО» с той же ФИО не раньше даты приёма.</li>
        <li>Ранний уход — увольнение меньше чем через ${EARLY_DAYS} дней. Люди, принятые меньше ${EARLY_DAYS} дней назад, в статистику не входят: их исход ещё неизвестен.</li>
        <li>Срез с меньше чем 10 новичками никогда не объявляется находкой. Если находка исчезает без людей более сильного очага, она так и помечена.</li>
        <li>Срезы проверяются по одному признаку. Сочетания (например, «магазины, принятые летом») не ищутся.</li>
        <li>Срезы с одними и теми же людьми (подразделение и его единственный руководитель) считаются одной гипотезой и склеиваются до поправки на число проверок.</li>
        <li>Свежие уходы (последние 90 дней) в доли пока не входят — тревога в только что нанятой группе станет видна с задержкой.</li>
        <li>Это корреляции, а не причины: инструмент показывает, где смотреть, а не почему люди уходят.</li>
      </ul>
    </section>`;

  for (const box of document.querySelectorAll("input[data-key]")) {
    box.addEventListener("change", () => {
      const d = JSON.parse(localStorage.getItem("novichok-talked") || "{}");
      if (box.checked) d[box.dataset.key] = new Date().toLocaleDateString("ru-RU");
      else delete d[box.dataset.key];
      localStorage.setItem("novichok-talked", JSON.stringify(d));
      render({ people, asOf, unmatchedDismissals }, label);
    });
  }
}

function load(text, label) {
  $("error").hidden = true;
  try {
    render(buildPeople(parseCSV(text)), label);
  } catch (e) {
    $("error").textContent = `Не получилось прочитать файл: ${e.message}`;
    $("error").hidden = false;
  }
}

async function loadDemo() {
  try {
    const res = await fetch("data/demo.csv");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    load(await res.text(), "Демо-данные (вымышленная компания)");
  } catch (e) {
    $("source").textContent = "Демо-данные не загрузились";
    $("error").textContent = `Не удалось загрузить демо-данные (${e.message}). Страницу нужно открыть через веб-сервер (см. README), а не двойным кликом по файлу; свою выгрузку можно загрузить кнопкой выше.`;
    $("error").hidden = false;
  }
}

$("demo").addEventListener("click", loadDemo);
$("file").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (f) load(decodeBytes(new Uint8Array(await f.arrayBuffer())), `Файл «${f.name}»`);
});
loadDemo();
