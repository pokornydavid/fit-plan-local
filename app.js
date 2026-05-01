const STORAGE_KEY = "fit-plan-local-v1";
const DAY_LABELS = [
  ["Po", "Pondeli"],
  ["Ut", "Utery"],
  ["St", "Streda"],
  ["Ct", "Ctvrtek"],
  ["Pa", "Patek"],
  ["So", "Sobota"],
  ["Ne", "Nedele"]
];
const MUSCLES = [
  "Hrudnik",
  "Zada",
  "Nohy",
  "Ramena",
  "Biceps",
  "Triceps",
  "Core",
  "Kardio",
  "Mobilita",
  "Full body"
];

let state = loadState();
let toastTimer = 0;

const app = document.querySelector("#app");
const toast = document.querySelector("#toast");
const importFile = document.querySelector("#importFile");

app.addEventListener("click", handleClick);
app.addEventListener("input", handleInput);
app.addEventListener("change", handleChange);
importFile.addEventListener("change", handleImport);

applyTheme();
render();

function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function loadState() {
  const fallback = createDefaultState();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    return normalizeState(JSON.parse(raw), fallback);
  } catch {
    return fallback;
  }
}

function createDefaultState() {
  const weekStart = toDateInput(getWeekStart(new Date()));
  return {
    theme: "dark",
    selectedDay: getDayIndex(new Date()),
    weekStart,
    weeks: {
      [weekStart]: createSampleWeek()
    },
    library: createDefaultLibrary()
  };
}

function normalizeState(value, fallback = createDefaultState()) {
  const next = {
    theme: value?.theme === "light" ? "light" : "dark",
    selectedDay: Number.isInteger(value?.selectedDay) ? value.selectedDay : fallback.selectedDay,
    weekStart: value?.weekStart || fallback.weekStart,
    weeks: value?.weeks && typeof value.weeks === "object" ? value.weeks : fallback.weeks,
    library: Array.isArray(value?.library) ? value.library : fallback.library
  };

  next.selectedDay = Math.max(0, Math.min(6, next.selectedDay));
  next.library = next.library.map((item) => ({
    id: item.id || uid(),
    name: String(item.name || "Cvik"),
    muscle: MUSCLES.includes(item.muscle) ? item.muscle : "Full body"
  }));

  Object.keys(next.weeks).forEach((key) => {
    next.weeks[key] = normalizeWeek(next.weeks[key]);
  });
  if (!next.weeks[next.weekStart]) next.weeks[next.weekStart] = createBlankWeek();

  return next;
}

function normalizeWeek(week) {
  const blank = createBlankWeek();
  const out = { ...blank };
  for (let day = 0; day < 7; day += 1) {
    const source = week?.[day] || {};
    out[day] = {
      title: String(source.title || ""),
      focus: String(source.focus || ""),
      notes: String(source.notes || ""),
      exercises: Array.isArray(source.exercises)
        ? source.exercises.map(normalizeExercise)
        : []
    };
  }
  return out;
}

function normalizeExercise(exercise) {
  return {
    id: exercise.id || uid(),
    name: String(exercise.name || "Cvik"),
    muscle: MUSCLES.includes(exercise.muscle) ? exercise.muscle : "Full body",
    notes: String(exercise.notes || ""),
    sets: Array.isArray(exercise.sets) && exercise.sets.length
      ? exercise.sets.map(normalizeSet)
      : [createSet()]
  };
}

function normalizeSet(set) {
  return {
    id: set.id || uid(),
    reps: toNumber(set.reps, 8),
    weight: toNumber(set.weight, 0),
    rpe: toNumber(set.rpe, 7),
    done: Boolean(set.done)
  };
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function createDefaultLibrary() {
  return [
    libraryItem("Bench press", "Hrudnik"),
    libraryItem("Incline dumbbell press", "Hrudnik"),
    libraryItem("Lat pulldown", "Zada"),
    libraryItem("Barbell row", "Zada"),
    libraryItem("Squat", "Nohy"),
    libraryItem("Romanian deadlift", "Nohy"),
    libraryItem("Shoulder press", "Ramena"),
    libraryItem("Lateral raise", "Ramena"),
    libraryItem("Cable curl", "Biceps"),
    libraryItem("Triceps pushdown", "Triceps"),
    libraryItem("Plank", "Core")
  ];
}

function libraryItem(name, muscle) {
  return { id: uid(), name, muscle };
}

function createSet(overrides = {}) {
  return {
    id: uid(),
    reps: overrides.reps ?? 8,
    weight: overrides.weight ?? 0,
    rpe: overrides.rpe ?? 7,
    done: overrides.done ?? false
  };
}

function createExercise(name, muscle, sets = [createSet(), createSet(), createSet()], notes = "") {
  return {
    id: uid(),
    name,
    muscle,
    notes,
    sets: sets.map((set) => createSet(set))
  };
}

function createBlankWeek() {
  return Object.fromEntries(
    DAY_LABELS.map((_, index) => [
      index,
      {
        title: "",
        focus: "",
        notes: "",
        exercises: []
      }
    ])
  );
}

function createSampleWeek() {
  const week = createBlankWeek();
  week[0] = {
    title: "Push",
    focus: "Hrudnik, ramena, triceps",
    notes: "",
    exercises: [
      createExercise("Bench press", "Hrudnik", [
        { reps: 8, weight: 60, rpe: 7 },
        { reps: 8, weight: 62.5, rpe: 8 },
        { reps: 6, weight: 65, rpe: 8 }
      ]),
      createExercise("Shoulder press", "Ramena", [
        { reps: 8, weight: 32.5, rpe: 7 },
        { reps: 8, weight: 32.5, rpe: 8 },
        { reps: 10, weight: 30, rpe: 8 }
      ]),
      createExercise("Triceps pushdown", "Triceps", [
        { reps: 12, weight: 25, rpe: 7 },
        { reps: 12, weight: 25, rpe: 8 }
      ])
    ]
  };
  week[1] = {
    title: "Pull",
    focus: "Zada, zadni ramena, biceps",
    notes: "",
    exercises: [
      createExercise("Lat pulldown", "Zada", [
        { reps: 10, weight: 55, rpe: 7 },
        { reps: 10, weight: 55, rpe: 8 },
        { reps: 8, weight: 60, rpe: 8 }
      ]),
      createExercise("Barbell row", "Zada", [
        { reps: 8, weight: 50, rpe: 7 },
        { reps: 8, weight: 50, rpe: 8 },
        { reps: 8, weight: 52.5, rpe: 8 }
      ]),
      createExercise("Cable curl", "Biceps", [
        { reps: 12, weight: 20, rpe: 7 },
        { reps: 12, weight: 20, rpe: 8 }
      ])
    ]
  };
  week[3] = {
    title: "Lower",
    focus: "Nohy, hyzde, core",
    notes: "",
    exercises: [
      createExercise("Squat", "Nohy", [
        { reps: 6, weight: 80, rpe: 7 },
        { reps: 6, weight: 82.5, rpe: 8 },
        { reps: 6, weight: 85, rpe: 8 }
      ]),
      createExercise("Romanian deadlift", "Nohy", [
        { reps: 8, weight: 70, rpe: 7 },
        { reps: 8, weight: 72.5, rpe: 8 },
        { reps: 8, weight: 72.5, rpe: 8 }
      ]),
      createExercise("Plank", "Core", [
        { reps: 45, weight: 0, rpe: 7 },
        { reps: 45, weight: 0, rpe: 7 }
      ])
    ]
  };
  week[5] = {
    title: "Full body",
    focus: "Lehci technika",
    notes: "",
    exercises: [
      createExercise("Incline dumbbell press", "Hrudnik", [
        { reps: 10, weight: 22.5, rpe: 7 },
        { reps: 10, weight: 22.5, rpe: 8 }
      ]),
      createExercise("Lat pulldown", "Zada", [
        { reps: 12, weight: 50, rpe: 7 },
        { reps: 12, weight: 50, rpe: 8 }
      ]),
      createExercise("Lateral raise", "Ramena", [
        { reps: 15, weight: 8, rpe: 8 },
        { reps: 15, weight: 8, rpe: 8 }
      ])
    ]
  };
  return week;
}

function render() {
  applyTheme();
  const week = ensureWeek();
  const selected = week[state.selectedDay];
  const summary = summarizeWeek(week);
  const daySummary = summarizeDay(selected);

  app.innerHTML = `
    <div class="app">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark" aria-hidden="true">FP</div>
          <div>
            <h1>Fit plan</h1>
            <span>Localhost</span>
          </div>
        </div>
        <div class="week-switcher" aria-label="Vyber tydne">
          <button class="icon-btn" data-action="prev-week" title="Predchozi tyden" aria-label="Predchozi tyden">&lt;</button>
          <div class="week-label">
            <strong>${weekRangeLabel(state.weekStart)}</strong>
            <span>${summary.completed}/${summary.totalSets} serii hotovo</span>
          </div>
          <button class="icon-btn" data-action="next-week" title="Dalsi tyden" aria-label="Dalsi tyden">&gt;</button>
          <button class="btn" data-action="today">Dnes</button>
        </div>
        <div class="top-actions">
          <button class="btn theme-toggle" data-action="toggle-theme" aria-pressed="${state.theme === "dark"}" title="Prepnout rezim">
            <span class="theme-dot" aria-hidden="true"></span>
            ${state.theme === "dark" ? "Tmavy" : "Svetly"}
          </button>
          <button class="btn" data-action="copy-prev-week">Kopirovat minuly</button>
          <button class="btn warn" data-action="sample-week">Ukazkovy plan</button>
        </div>
      </header>
      <div class="shell">
        ${renderWeekPanel(week)}
        ${renderDayWorkspace(selected, daySummary)}
        ${renderSidePanel(summary, daySummary)}
      </div>
    </div>
  `;
  save();
}

function renderWeekPanel(week) {
  return `
    <aside class="panel week-panel">
      <div class="panel-head">
        <h2>Tyden</h2>
      </div>
      <div class="day-list">
        ${DAY_LABELS.map((label, index) => renderDayButton(index, label, week[index])).join("")}
      </div>
    </aside>
  `;
}

function renderDayButton(index, label, day) {
  const summary = summarizeDay(day);
  const active = state.selectedDay === index ? " active" : "";
  const done = summary.totalSets > 0 && summary.completed === summary.totalSets;
  const date = addDays(parseDate(state.weekStart), index);
  return `
    <button class="day-item${active}" data-action="select-day" data-day="${index}">
      <span class="day-row">
        <span class="day-meta">${label[0]} ${formatShortDate(date)}</span>
        <span class="pill${done ? " done" : ""}">${summary.completed}/${summary.totalSets}</span>
      </span>
      <span class="day-title">${escapeHtml(day.title || "Volno")}</span>
      <span class="progress" aria-hidden="true"><span style="--value:${summary.progress}%"></span></span>
    </button>
  `;
}

function renderDayWorkspace(day, summary) {
  return `
    <main class="workspace">
      <section class="day-workspace">
        <div class="day-head">
          <label class="field">
            <span>Den</span>
            <input class="input" data-field="day-title" value="${escapeAttr(day.title)}" placeholder="${DAY_LABELS[state.selectedDay][1]}">
          </label>
          <label class="field">
            <span>Zamereni</span>
            <input class="input" data-field="day-focus" value="${escapeAttr(day.focus)}" placeholder="Partie nebo cil">
          </label>
          <button class="btn danger" data-action="clear-day">Vycistit den</button>
        </div>
        <div class="add-strip">
          <select id="quickAdd" class="select" aria-label="Cvik z knihovny">
            ${state.library.map((item) => `<option value="${item.id}">${escapeHtml(item.name)} / ${escapeHtml(item.muscle)}</option>`).join("")}
          </select>
          <button class="icon-btn primary" data-action="add-library-exercise" title="Pridat z knihovny" aria-label="Pridat z knihovny">+</button>
          <input id="customExerciseName" class="input" placeholder="Vlastni cvik">
          <select id="customExerciseMuscle" class="select" aria-label="Partie vlastniho cviku">
            ${renderMuscleOptions("Full body")}
          </select>
          <button class="btn primary" data-action="add-custom-exercise">Pridat</button>
        </div>
        <div class="exercise-list">
          ${day.exercises.length ? day.exercises.map(renderExercise).join("") : renderEmptyDay(summary)}
        </div>
      </section>
    </main>
  `;
}

function renderEmptyDay() {
  return `
    <div class="empty">
      <div>
        <strong>Zatim prazdno</strong>
        <div class="microcopy">Vyber cvik z knihovny nebo pridej vlastni.</div>
      </div>
    </div>
  `;
}

function renderExercise(exercise) {
  return `
    <article class="exercise-card" data-exercise-id="${exercise.id}">
      <div class="exercise-head">
        <label class="field">
          <span>Cvik</span>
          <input class="input" data-field="exercise-name" data-exercise-id="${exercise.id}" value="${escapeAttr(exercise.name)}">
        </label>
        <label class="field">
          <span>Partie</span>
          <select class="select" data-field="exercise-muscle" data-exercise-id="${exercise.id}">
            ${renderMuscleOptions(exercise.muscle)}
          </select>
        </label>
        <button class="icon-btn danger" data-action="remove-exercise" data-exercise-id="${exercise.id}" title="Smazat cvik" aria-label="Smazat cvik">x</button>
      </div>
      <div class="set-table-wrap">
        <table class="set-table">
          <thead>
            <tr>
              <th class="check-cell">Hotovo</th>
              <th>Serie</th>
              <th>Opak.</th>
              <th>Kg</th>
              <th>RPE</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${exercise.sets.map((set, index) => renderSetRow(exercise.id, set, index)).join("")}
          </tbody>
        </table>
      </div>
      <div class="exercise-foot">
        <button class="btn" data-action="add-set" data-exercise-id="${exercise.id}">+ Serie</button>
        <input class="input" data-field="exercise-notes" data-exercise-id="${exercise.id}" value="${escapeAttr(exercise.notes)}" placeholder="Poznamka">
      </div>
    </article>
  `;
}

function renderSetRow(exerciseId, set, index) {
  return `
    <tr class="${set.done ? "done" : ""}">
      <td class="check-cell">
        <input type="checkbox" data-field="set-done" data-exercise-id="${exerciseId}" data-set-id="${set.id}" ${set.done ? "checked" : ""}>
      </td>
      <td class="set-number">${index + 1}</td>
      <td><input class="input" type="number" min="0" step="1" data-field="set-reps" data-exercise-id="${exerciseId}" data-set-id="${set.id}" value="${escapeAttr(set.reps)}"></td>
      <td><input class="input" type="number" min="0" step="0.5" data-field="set-weight" data-exercise-id="${exerciseId}" data-set-id="${set.id}" value="${escapeAttr(set.weight)}"></td>
      <td><input class="input" type="number" min="1" max="10" step="0.5" data-field="set-rpe" data-exercise-id="${exerciseId}" data-set-id="${set.id}" value="${escapeAttr(set.rpe)}"></td>
      <td><button class="icon-btn" data-action="remove-set" data-exercise-id="${exerciseId}" data-set-id="${set.id}" title="Smazat serii" aria-label="Smazat serii">x</button></td>
    </tr>
  `;
}

function renderSidePanel(summary, daySummary) {
  return `
    <aside class="panel side-panel">
      <div class="side-section">
        <h2 class="section-title">Prehled</h2>
        <div class="metrics">
          <div class="metric"><strong>${daySummary.completed}/${daySummary.totalSets}</strong><span>Dnesni serie</span></div>
          <div class="metric"><strong>${formatNumber(daySummary.volume)}</strong><span>Dnesni kg</span></div>
          <div class="metric"><strong>${summary.trainingDays}</strong><span>Treninkove dny</span></div>
          <div class="metric"><strong>${formatNumber(summary.volume)}</strong><span>Tydenni kg</span></div>
        </div>
      </div>
      <div class="side-section">
        <h2 class="section-title">Sablony</h2>
        <div class="template-grid">
          <button class="btn" data-action="template-ppl">PPL</button>
          <button class="btn" data-action="template-fullbody">Full body</button>
        </div>
      </div>
      <div class="side-section">
        <h2 class="section-title">Knihovna</h2>
        <div class="mini-form">
          <input id="libraryName" class="input" placeholder="Cvik">
          <select id="libraryMuscle" class="select" aria-label="Partie cviku">
            ${renderMuscleOptions("Full body")}
          </select>
          <button class="icon-btn primary" data-action="add-library-item" title="Pridat do knihovny" aria-label="Pridat do knihovny">+</button>
        </div>
        <div>
          ${state.library.map(renderLibraryRow).join("")}
        </div>
      </div>
      <div class="side-section">
        <h2 class="section-title">Data</h2>
        <div class="data-actions">
          <button class="btn" data-action="export-data">Export</button>
          <button class="btn" data-action="import-data">Import</button>
        </div>
      </div>
    </aside>
  `;
}

function renderLibraryRow(item) {
  return `
    <div class="library-row">
      <div class="library-name">
        <strong>${escapeHtml(item.name)}</strong>
        <span>${escapeHtml(item.muscle)}</span>
      </div>
      <button class="icon-btn" data-action="quick-add-library" data-library-id="${item.id}" title="Pridat do dne" aria-label="Pridat do dne">+</button>
      <button class="icon-btn" data-action="remove-library-item" data-library-id="${item.id}" title="Smazat z knihovny" aria-label="Smazat z knihovny">x</button>
    </div>
  `;
}

function renderMuscleOptions(selected) {
  return MUSCLES.map((muscle) => (
    `<option value="${escapeAttr(muscle)}" ${muscle === selected ? "selected" : ""}>${escapeHtml(muscle)}</option>`
  )).join("");
}

function handleClick(event) {
  const target = event.target.closest("[data-action]");
  if (!target) return;

  const action = target.dataset.action;
  const week = ensureWeek();
  const day = week[state.selectedDay];

  if (action === "toggle-theme") {
    state.theme = state.theme === "dark" ? "light" : "dark";
    render();
    return;
  }

  if (action === "select-day") {
    state.selectedDay = Number(target.dataset.day);
    render();
    return;
  }

  if (action === "prev-week" || action === "next-week") {
    const shift = action === "prev-week" ? -7 : 7;
    state.weekStart = toDateInput(addDays(parseDate(state.weekStart), shift));
    ensureWeek();
    render();
    return;
  }

  if (action === "today") {
    const today = new Date();
    state.weekStart = toDateInput(getWeekStart(today));
    state.selectedDay = getDayIndex(today);
    ensureWeek();
    render();
    return;
  }

  if (action === "copy-prev-week") {
    const previousStart = toDateInput(addDays(parseDate(state.weekStart), -7));
    if (!state.weeks[previousStart]) {
      showToast("Minuly tyden zatim nema plan.");
      return;
    }
    state.weeks[state.weekStart] = cloneWeek(state.weeks[previousStart], true);
    render();
    showToast("Tyden zkopirovan.");
    return;
  }

  if (action === "sample-week") {
    if (!confirm("Prepsat aktualni tyden ukazkovym planem?")) return;
    state.weeks[state.weekStart] = createSampleWeek();
    render();
    showToast("Ukazkovy plan nahran.");
    return;
  }

  if (action === "clear-day") {
    if (!confirm("Vycistit vybrany den?")) return;
    week[state.selectedDay] = createBlankWeek()[state.selectedDay];
    render();
    return;
  }

  if (action === "add-library-exercise") {
    const id = document.querySelector("#quickAdd")?.value;
    addLibraryExercise(id);
    return;
  }

  if (action === "quick-add-library") {
    addLibraryExercise(target.dataset.libraryId);
    return;
  }

  if (action === "add-custom-exercise") {
    const nameInput = document.querySelector("#customExerciseName");
    const muscleInput = document.querySelector("#customExerciseMuscle");
    const name = nameInput.value.trim();
    if (!name) {
      showToast("Napis nazev cviku.");
      nameInput.focus();
      return;
    }
    day.exercises.push(createExercise(name, muscleInput.value));
    nameInput.value = "";
    render();
    return;
  }

  if (action === "remove-exercise") {
    const id = target.dataset.exerciseId;
    const index = day.exercises.findIndex((exercise) => exercise.id === id);
    if (index >= 0) day.exercises.splice(index, 1);
    render();
    return;
  }

  if (action === "add-set") {
    const exercise = findExercise(target.dataset.exerciseId);
    if (!exercise) return;
    const last = exercise.sets.at(-1) || createSet();
    exercise.sets.push(createSet({
      reps: last.reps,
      weight: last.weight,
      rpe: last.rpe
    }));
    render();
    return;
  }

  if (action === "remove-set") {
    const exercise = findExercise(target.dataset.exerciseId);
    if (!exercise) return;
    exercise.sets = exercise.sets.filter((set) => set.id !== target.dataset.setId);
    if (!exercise.sets.length) exercise.sets.push(createSet());
    render();
    return;
  }

  if (action === "template-ppl") {
    if (!confirm("Prepsat aktualni tyden sablonou PPL?")) return;
    state.weeks[state.weekStart] = createSampleWeek();
    render();
    return;
  }

  if (action === "template-fullbody") {
    if (!confirm("Prepsat aktualni tyden full body sablonou?")) return;
    state.weeks[state.weekStart] = createFullBodyWeek();
    render();
    return;
  }

  if (action === "add-library-item") {
    const nameInput = document.querySelector("#libraryName");
    const muscleInput = document.querySelector("#libraryMuscle");
    const name = nameInput.value.trim();
    if (!name) {
      showToast("Napis nazev cviku.");
      nameInput.focus();
      return;
    }
    state.library.push(libraryItem(name, muscleInput.value));
    render();
    return;
  }

  if (action === "remove-library-item") {
    state.library = state.library.filter((item) => item.id !== target.dataset.libraryId);
    render();
    return;
  }

  if (action === "export-data") {
    exportData();
    return;
  }

  if (action === "import-data") {
    importFile.click();
  }
}

function handleInput(event) {
  const field = event.target.dataset.field;
  if (!field) return;

  const week = ensureWeek();
  const day = week[state.selectedDay];

  if (field === "day-title") {
    day.title = event.target.value;
    save();
    return;
  }

  if (field === "day-focus") {
    day.focus = event.target.value;
    save();
    return;
  }

  const exercise = findExercise(event.target.dataset.exerciseId);
  if (!exercise) return;

  if (field === "exercise-name") {
    exercise.name = event.target.value;
    save();
    return;
  }

  if (field === "exercise-notes") {
    exercise.notes = event.target.value;
    save();
  }
}

function handleChange(event) {
  const field = event.target.dataset.field;
  if (!field) return;

  const exercise = findExercise(event.target.dataset.exerciseId);
  const set = exercise?.sets.find((item) => item.id === event.target.dataset.setId);

  if (field === "exercise-muscle" && exercise) {
    exercise.muscle = event.target.value;
    render();
    return;
  }

  if (!set) return;

  if (field === "set-done") set.done = event.target.checked;
  if (field === "set-reps") set.reps = toNumber(event.target.value, 0);
  if (field === "set-weight") set.weight = toNumber(event.target.value, 0);
  if (field === "set-rpe") set.rpe = toNumber(event.target.value, 0);

  render();
}

function handleImport(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const imported = JSON.parse(String(reader.result));
      state = normalizeState(imported);
      save();
      render();
      showToast("Import hotovy.");
    } catch {
      showToast("Import se nepovedl.");
    } finally {
      importFile.value = "";
    }
  };
  reader.readAsText(file);
}

function addLibraryExercise(id) {
  const item = state.library.find((entry) => entry.id === id);
  if (!item) return;
  ensureWeek()[state.selectedDay].exercises.push(createExercise(item.name, item.muscle));
  render();
}

function findExercise(id) {
  if (!id) return null;
  return ensureWeek()[state.selectedDay].exercises.find((exercise) => exercise.id === id) || null;
}

function ensureWeek() {
  if (!state.weeks[state.weekStart]) state.weeks[state.weekStart] = createBlankWeek();
  return state.weeks[state.weekStart];
}

function cloneWeek(week, resetDone = false) {
  const normalized = normalizeWeek(week);
  return Object.fromEntries(Object.entries(normalized).map(([day, value]) => [
    day,
    {
      ...value,
      exercises: value.exercises.map((exercise) => ({
        ...exercise,
        id: uid(),
        sets: exercise.sets.map((set) => ({
          ...set,
          id: uid(),
          done: resetDone ? false : set.done
        }))
      }))
    }
  ]));
}

function createFullBodyWeek() {
  const week = createBlankWeek();
  [0, 2, 4].forEach((dayIndex, planIndex) => {
    week[dayIndex] = {
      title: `Full body ${planIndex + 1}`,
      focus: "Cele telo",
      notes: "",
      exercises: [
        createExercise(planIndex === 1 ? "Romanian deadlift" : "Squat", "Nohy", [
          { reps: 6, weight: planIndex === 1 ? 70 : 75, rpe: 7 },
          { reps: 6, weight: planIndex === 1 ? 72.5 : 77.5, rpe: 8 },
          { reps: 8, weight: planIndex === 1 ? 65 : 70, rpe: 8 }
        ]),
        createExercise(planIndex === 2 ? "Incline dumbbell press" : "Bench press", "Hrudnik", [
          { reps: 8, weight: planIndex === 2 ? 22.5 : 60, rpe: 7 },
          { reps: 8, weight: planIndex === 2 ? 22.5 : 62.5, rpe: 8 }
        ]),
        createExercise(planIndex === 0 ? "Lat pulldown" : "Barbell row", "Zada", [
          { reps: 10, weight: planIndex === 0 ? 55 : 50, rpe: 7 },
          { reps: 10, weight: planIndex === 0 ? 55 : 52.5, rpe: 8 }
        ]),
        createExercise("Plank", "Core", [
          { reps: 45, weight: 0, rpe: 7 },
          { reps: 45, weight: 0, rpe: 7 }
        ])
      ]
    };
  });
  return week;
}

function summarizeWeek(week) {
  const days = Object.values(week).map(summarizeDay);
  return {
    completed: days.reduce((sum, day) => sum + day.completed, 0),
    totalSets: days.reduce((sum, day) => sum + day.totalSets, 0),
    volume: days.reduce((sum, day) => sum + day.volume, 0),
    trainingDays: days.filter((day) => day.totalSets > 0).length
  };
}

function summarizeDay(day) {
  const sets = day.exercises.flatMap((exercise) => exercise.sets);
  const totalSets = sets.length;
  const completed = sets.filter((set) => set.done).length;
  const volume = sets.reduce((sum, set) => sum + toNumber(set.reps, 0) * toNumber(set.weight, 0), 0);
  return {
    totalSets,
    completed,
    volume,
    progress: totalSets ? Math.round((completed / totalSets) * 100) : 0
  };
}

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `fit-plan-${state.weekStart}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast("Export pripraven.");
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("show");
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.style.colorScheme = state.theme;
}

function getWeekStart(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  copy.setDate(copy.getDate() - getDayIndex(copy));
  return copy;
}

function getDayIndex(date) {
  return (date.getDay() + 6) % 7;
}

function parseDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function toDateInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function weekRangeLabel(weekStart) {
  const start = parseDate(weekStart);
  const end = addDays(start, 6);
  return `${formatShortDate(start)} - ${formatShortDate(end)}`;
}

function formatShortDate(date) {
  return `${date.getDate()}.${date.getMonth() + 1}.`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("cs-CZ", { maximumFractionDigits: 1 }).format(value);
}

function toNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}
