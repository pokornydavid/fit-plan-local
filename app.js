const STORAGE_KEY = "fit-plan-local-v1";
const SUPABASE_MODULE_URL = "https://esm.sh/@supabase/supabase-js@2.45.4";
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
  "Lytka",
  "Ramena",
  "Trapezy",
  "Biceps",
  "Triceps",
  "Predlokti",
  "Bricho",
  "Core",
  "Kardio",
  "Mobilita",
  "Full body"
];

let state = loadState();
let toastTimer = 0;
let cloudSyncTimer = 0;
let nutritionSyncTimer = 0;
let exerciseDrag = null;
let cloud = {
  ready: false,
  configured: false,
  client: null,
  session: null,
  profile: null,
  feed: [],
  leaderboard: [],
  status: "local",
  message: "Supabase neni pripojeny. Appka zatim uklada lokalne.",
  loading: false
};

const app = document.querySelector("#app");
const toast = document.querySelector("#toast");
const importFile = document.querySelector("#importFile");

app.addEventListener("click", handleClick);
app.addEventListener("input", handleInput);
app.addEventListener("change", handleChange);
app.addEventListener("submit", handleSubmit);
app.addEventListener("pointerdown", handlePointerDown);
window.addEventListener("pointermove", handlePointerMove);
window.addEventListener("pointerup", handlePointerUp);
window.addEventListener("pointercancel", cancelExerciseDrag);
importFile.addEventListener("change", handleImport);

boot();

function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function boot() {
  applyTheme();
  registerServiceWorker();
  render();
  await initSupabase();
  if (cloud.session) {
    await loadCloudData();
    saveLocal();
  }
  render();
}

async function initSupabase() {
  try {
    const config = await import("./supabase-config.js");
    if (!config.SUPABASE_URL || !config.SUPABASE_ANON_KEY) {
      cloud.ready = true;
      cloud.configured = false;
      return;
    }

    const { createClient } = await import(SUPABASE_MODULE_URL);
    cloud.client = createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY);
    cloud.configured = true;
    cloud.status = "auth";
    cloud.message = "Supabase je pripraveny.";

    const { data } = await cloud.client.auth.getSession();
    cloud.session = data.session;
    if (cloud.session) await ensureProfile();

    cloud.client.auth.onAuthStateChange(async (_event, session) => {
      cloud.session = session;
      if (session) {
        await ensureProfile();
        await loadCloudData();
        saveLocal();
        showToast("Jsi prihlaseny.");
      } else {
        cloud.profile = null;
        cloud.feed = [];
        cloud.leaderboard = [];
      }
      render();
    });
  } catch (error) {
    cloud.status = "local";
    cloud.message = "Supabase se nepodarilo nacist. Lokalni rezim zustava aktivni.";
    console.warn(error);
  } finally {
    cloud.ready = true;
  }
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
    activeView: "plan",
    selectedDay: getDayIndex(new Date()),
    weekStart,
    weeks: {
      [weekStart]: createSampleWeek()
    },
    nutrition: {
      [weekStart]: createNutritionWeek()
    },
    library: createDefaultLibrary()
  };
}

function normalizeState(value, fallback = createDefaultState()) {
  const next = {
    theme: value?.theme === "light" ? "light" : "dark",
    activeView: ["plan", "nutrition", "feed", "leaderboard", "profile"].includes(value?.activeView) ? value.activeView : "plan",
    selectedDay: Number.isInteger(value?.selectedDay) ? value.selectedDay : fallback.selectedDay,
    weekStart: value?.weekStart || fallback.weekStart,
    weeks: value?.weeks && typeof value.weeks === "object" ? value.weeks : fallback.weeks,
    nutrition: value?.nutrition && typeof value.nutrition === "object" ? value.nutrition : fallback.nutrition,
    library: Array.isArray(value?.library) ? value.library : fallback.library
  };

  next.selectedDay = Math.max(0, Math.min(6, next.selectedDay));
  next.library = next.library.map((item) => ({
    id: item.id || uid(),
    name: String(item.name || "Cvik"),
    muscle: MUSCLES.includes(item.muscle) ? item.muscle : "Full body"
  }));
  appendMissingLibraryItems(next.library, [
    ["Standing calf raise", "Lytka"],
    ["Dumbbell shrug", "Trapezy"],
    ["Wrist curl", "Predlokti"],
    ["Crunch", "Bricho"]
  ]);

  Object.keys(next.weeks).forEach((key) => {
    next.weeks[key] = normalizeWeek(next.weeks[key]);
  });
  if (!next.weeks[next.weekStart]) next.weeks[next.weekStart] = createBlankWeek();

  Object.keys(next.nutrition).forEach((key) => {
    next.nutrition[key] = normalizeNutritionWeek(next.nutrition[key]);
  });
  if (!next.nutrition[next.weekStart]) next.nutrition[next.weekStart] = createNutritionWeek();

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
      visibility: ["private", "friends", "public"].includes(source.visibility) ? source.visibility : "friends",
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
  saveLocal();
  scheduleCloudSync();
  scheduleNutritionSync();
}

function saveLocal() {
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
    libraryItem("Standing calf raise", "Lytka"),
    libraryItem("Shoulder press", "Ramena"),
    libraryItem("Lateral raise", "Ramena"),
    libraryItem("Dumbbell shrug", "Trapezy"),
    libraryItem("Cable curl", "Biceps"),
    libraryItem("Triceps pushdown", "Triceps"),
    libraryItem("Wrist curl", "Predlokti"),
    libraryItem("Crunch", "Bricho"),
    libraryItem("Plank", "Core")
  ];
}

function libraryItem(name, muscle) {
  return { id: uid(), name, muscle };
}

function appendMissingLibraryItems(library, items) {
  const existing = new Set(library.map((item) => item.name.toLowerCase()));
  items.forEach(([name, muscle]) => {
    if (!existing.has(name.toLowerCase())) {
      library.push(libraryItem(name, muscle));
      existing.add(name.toLowerCase());
    }
  });
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
        visibility: "friends",
        exercises: []
      }
    ])
  );
}

function createNutritionWeek() {
  return {
    goals: {
      dailyCalories: 2300,
      weeklyCalories: 16000,
      protein: 180,
      carbs: 250,
      fat: 55
    },
    lastCheatMeal: "",
    days: DAY_LABELS.map(() => ({
      calories: "",
      protein: "",
      carbs: "",
      fat: "",
      weight: "",
      notes: ""
    }))
  };
}

function normalizeNutritionWeek(nutrition) {
  const fallback = createNutritionWeek();
  const sourceGoals = nutrition?.goals || {};
  const days = Array.isArray(nutrition?.days) ? nutrition.days : [];
  return {
    goals: {
      dailyCalories: toNumber(sourceGoals.dailyCalories, fallback.goals.dailyCalories),
      weeklyCalories: toNumber(sourceGoals.weeklyCalories, fallback.goals.weeklyCalories),
      protein: toNumber(sourceGoals.protein, fallback.goals.protein),
      carbs: toNumber(sourceGoals.carbs, fallback.goals.carbs),
      fat: toNumber(sourceGoals.fat, fallback.goals.fat)
    },
    lastCheatMeal: String(nutrition?.lastCheatMeal || ""),
    days: DAY_LABELS.map((_, index) => {
      const day = days[index] || {};
      return {
        calories: normalizeOptionalNumber(day.calories),
        protein: normalizeOptionalNumber(day.protein),
        carbs: normalizeOptionalNumber(day.carbs),
        fat: normalizeOptionalNumber(day.fat),
        weight: normalizeOptionalNumber(day.weight),
        notes: String(day.notes || "")
      };
    })
  };
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
  const nutrition = ensureNutritionWeek();
  const selected = week[state.selectedDay];
  const summary = summarizeWeek(week);
  const daySummary = summarizeDay(selected);
  const nutritionSummary = summarizeNutrition(nutrition);
  const lockedForAuth = cloud.configured && !cloud.session;
  const content = lockedForAuth
    ? renderAuthShell()
    : state.activeView === "profile"
      ? renderProfileShell()
    : state.activeView === "feed"
      ? renderFeedShell()
      : state.activeView === "leaderboard"
        ? renderLeaderboardShell()
        : state.activeView === "nutrition"
          ? renderNutritionShell(nutrition, nutritionSummary)
        : `
          <div class="shell">
            ${renderWeekPanel(week)}
            ${renderDayWorkspace(selected, daySummary)}
            ${renderSidePanel(summary, daySummary, selected)}
          </div>
        `;

  app.innerHTML = `
    <div class="app">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark" aria-hidden="true">FP</div>
          <div>
            <h1>Fit plan</h1>
            <span>${cloud.configured ? "Training & nutrition cloud" : "Local training tracker"}</span>
          </div>
        </div>
        <div class="center-stack">
          <nav class="view-tabs" aria-label="Hlavni navigace">
            ${renderViewButton("plan", "Plan")}
            ${renderViewButton("nutrition", "Nutrition")}
            ${renderViewButton("feed", "Feed")}
            ${renderViewButton("leaderboard", "Leaderboard")}
          </nav>
          <div class="week-switcher" aria-label="Vyber tydne">
            <button class="icon-btn" data-action="prev-week" title="Predchozi tyden" aria-label="Predchozi tyden">&lt;</button>
            <div class="week-label">
              <strong>${weekRangeLabel(state.weekStart)}</strong>
              <span>${state.activeView === "nutrition" ? `${formatNumber(nutritionSummary.totalCalories)}/${formatNumber(nutrition.goals.weeklyCalories)} kcal` : `${summary.completed}/${summary.totalSets} serii hotovo`}</span>
            </div>
            <button class="icon-btn" data-action="next-week" title="Dalsi tyden" aria-label="Dalsi tyden">&gt;</button>
            <button class="btn" data-action="today">Dnes</button>
          </div>
        </div>
        <div class="top-actions">
          ${renderCloudBadge()}
          <button class="btn theme-toggle" data-action="toggle-theme" aria-pressed="${state.theme === "dark"}" title="Prepnout rezim">
            <span class="theme-dot" aria-hidden="true"></span>
            ${state.theme === "dark" ? "Tmavy" : "Svetly"}
          </button>
          ${cloud.session ? `<button class="btn" data-action="sign-out">Odhlasit</button>` : ""}
          ${state.activeView === "plan" && !lockedForAuth ? `
            <button class="btn" data-action="copy-prev-week">Kopirovat minuly</button>
            <button class="btn warn" data-action="sample-week">Ukazkovy plan</button>
          ` : ""}
        </div>
      </header>
      ${content}
    </div>
  `;
}

function renderViewButton(view, label) {
  const active = state.activeView === view ? " active" : "";
  return `<button class="view-tab${active}" data-action="set-view" data-view="${view}">${label}</button>`;
}

function renderCloudBadge() {
  if (cloud.session) {
    return `<button class="cloud-badge online" data-action="set-view" data-view="profile" title="Upravit profil">${escapeHtml(profileName())}</button>`;
  }
  if (cloud.configured) return `<span class="cloud-badge auth">Login ready</span>`;
  return `<span class="cloud-badge local">Local</span>`;
}

function renderAuthShell() {
  return `
    <main class="auth-shell">
      <section class="auth-panel">
        <div>
          <p class="eyebrow">Fit Plan Cloud</p>
          <h2>Train, eat and track progress in one place</h2>
          <p class="auth-copy">Sync workouts, calories, macros and bodyweight across devices. Share selected sessions with friends and build a weekly leaderboard around consistency.</p>
        </div>
        <div class="auth-grid">
          <form class="auth-card" data-auth-form="sign-in">
            <h3>Prihlasit</h3>
            <input class="input" name="email" type="email" autocomplete="email" placeholder="Email" required>
            <input class="input" name="password" type="password" autocomplete="current-password" placeholder="Heslo" required>
            <button class="btn primary" type="submit">Prihlasit</button>
          </form>
          <form class="auth-card" data-auth-form="sign-up">
            <h3>Registrace</h3>
            <input class="input" name="email" type="email" autocomplete="email" placeholder="Email" required>
            <input class="input" name="password" type="password" autocomplete="new-password" minlength="6" placeholder="Heslo min. 6 znaku" required>
            <button class="btn primary" type="submit">Vytvorit ucet</button>
          </form>
        </div>
      </section>
    </main>
  `;
}

function renderProfileShell() {
  return `
    <main class="auth-shell">
      <section class="auth-panel profile-panel">
        <div>
          <p class="eyebrow">Account</p>
          <h2>Profil a prezdivka</h2>
          <p class="auth-copy">Tohle jmeno se ukazuje nahore v appce, ve feedu a v leaderboardu.</p>
        </div>
        <form class="auth-card profile-card" data-profile-form>
          <label class="field">
            <span>Jmeno / prezdivka</span>
            <input class="input" name="display_name" value="${escapeAttr(profileName())}" placeholder="Treba David" maxlength="40" required>
          </label>
          <button class="btn primary" type="submit">Ulozit profil</button>
        </form>
      </section>
    </main>
  `;
}

function renderFeedShell() {
  return `
    <main class="social-shell">
      <section class="social-main">
        <div class="social-head">
          <div>
            <p class="eyebrow">Community feed</p>
            <h2>Co se jelo dneska</h2>
          </div>
          <button class="btn" data-action="refresh-social">Refresh</button>
        </div>
        ${renderCloudSetupNotice()}
        <div class="feed-list">
          ${cloud.feed.length ? cloud.feed.map(renderFeedCard).join("") : renderSocialEmpty("Zatim tu neni zadny public trening.")}
        </div>
      </section>
    </main>
  `;
}

function renderLeaderboardShell() {
  return `
    <main class="social-shell">
      <section class="social-main">
        <div class="social-head">
          <div>
            <p class="eyebrow">Leaderboard</p>
            <h2>Tydenni vykon</h2>
          </div>
          <button class="btn" data-action="refresh-social">Refresh</button>
        </div>
        ${renderCloudSetupNotice()}
        <div class="leaderboard">
          ${cloud.leaderboard.length ? cloud.leaderboard.map(renderLeaderboardRow).join("") : renderSocialEmpty("Leaderboard se naplni z public treningu.")}
        </div>
      </section>
    </main>
  `;
}

function renderNutritionShell(nutrition, summary) {
  return `
    <main class="nutrition-shell">
      <section class="nutrition-main">
        <div class="nutrition-head">
          <div>
            <p class="eyebrow">Nutrition control</p>
            <h2>Weekly calorie system</h2>
            <p class="auth-copy">Plan calories, macros and bodyweight in the same place as training. Built for cutting, bulking and clean weekly check-ins.</p>
          </div>
          <button class="btn" data-action="copy-nutrition-prev-week">Copy last week</button>
        </div>
        <div class="nutrition-metrics">
          <div class="metric hero-metric"><strong>${formatNumber(summary.totalCalories)}</strong><span>Current kcal</span></div>
          <div class="metric"><strong>${formatNumber(summary.remainingCalories)}</strong><span>Remaining weekly kcal</span></div>
          <div class="metric"><strong>${formatNumber(summary.averageCalories)}</strong><span>Daily average</span></div>
          <div class="metric"><strong>${summary.daysLogged}/7</strong><span>Days logged</span></div>
        </div>
        <div class="nutrition-progress">
          <span style="--value:${summary.progress}%"></span>
        </div>
        <div class="nutrition-grid">
          <section class="nutrition-card">
            <div class="section-row">
              <h3>Weekly targets</h3>
              <span class="pill">${summary.progress}%</span>
            </div>
            <div class="goal-grid">
              ${renderNutritionGoal("weeklyCalories", "Weekly kcal", nutrition.goals.weeklyCalories, 100)}
              ${renderNutritionGoal("dailyCalories", "Daily kcal", nutrition.goals.dailyCalories, 50)}
              ${renderNutritionGoal("protein", "Protein g", nutrition.goals.protein, 5)}
              ${renderNutritionGoal("carbs", "Carbs g", nutrition.goals.carbs, 5)}
              ${renderNutritionGoal("fat", "Fat g", nutrition.goals.fat, 5)}
              <label class="field">
                <span>Last cheat meal</span>
                <input class="input" type="date" data-field="nutrition-cheat" value="${escapeAttr(nutrition.lastCheatMeal)}">
              </label>
            </div>
          </section>
          <section class="nutrition-card">
            <div class="section-row">
              <h3>Current macros</h3>
              <span class="pill done">${formatNumber(summary.totalProtein)}P / ${formatNumber(summary.totalCarbs)}C / ${formatNumber(summary.totalFat)}F</span>
            </div>
            <div class="macro-bars">
              ${renderMacroBar("Protein", summary.totalProtein, nutrition.goals.protein * 7)}
              ${renderMacroBar("Carbs", summary.totalCarbs, nutrition.goals.carbs * 7)}
              ${renderMacroBar("Fat", summary.totalFat, nutrition.goals.fat * 7)}
            </div>
          </section>
        </div>
        <section class="nutrition-card">
          <div class="section-row">
            <h3>Daily log</h3>
            <span class="microcopy">Calories, macros, bodyweight and quick notes</span>
          </div>
          <div class="nutrition-table-wrap">
            <table class="nutrition-table">
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Kcal</th>
                  <th>Protein</th>
                  <th>Carbs</th>
                  <th>Fat</th>
                  <th>Weight</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                ${nutrition.days.map((day, index) => renderNutritionDayRow(day, index)).join("")}
              </tbody>
            </table>
          </div>
        </section>
      </section>
    </main>
  `;
}

function renderNutritionGoal(field, label, value, step) {
  return `
    <label class="field">
      <span>${label}</span>
      <input class="input" type="number" min="0" step="${step}" data-field="nutrition-goal" data-goal="${field}" value="${escapeAttr(value)}">
    </label>
  `;
}

function renderMacroBar(label, value, goal) {
  const percent = goal ? Math.min(100, Math.round((value / goal) * 100)) : 0;
  return `
    <div class="macro-row">
      <div>
        <strong>${label}</strong>
        <span>${formatNumber(value)} / ${formatNumber(goal)} g</span>
      </div>
      <div class="progress"><span style="--value:${percent}%"></span></div>
    </div>
  `;
}

function renderNutritionDayRow(day, index) {
  const date = addDays(parseDate(state.weekStart), index);
  return `
    <tr>
      <th>
        <strong>${DAY_LABELS[index][0]}</strong>
        <span>${formatShortDate(date)}</span>
      </th>
      ${renderNutritionInput(index, "calories", day.calories, 10)}
      ${renderNutritionInput(index, "protein", day.protein, 1)}
      ${renderNutritionInput(index, "carbs", day.carbs, 1)}
      ${renderNutritionInput(index, "fat", day.fat, 1)}
      ${renderNutritionInput(index, "weight", day.weight, 0.1)}
      <td><input class="input" data-field="nutrition-day" data-day="${index}" data-nutrition="notes" value="${escapeAttr(day.notes)}" placeholder="Meal note"></td>
    </tr>
  `;
}

function renderNutritionInput(dayIndex, field, value, step) {
  return `
    <td>
      <input class="input" type="number" min="0" step="${step}" data-field="nutrition-day" data-day="${dayIndex}" data-nutrition="${field}" value="${escapeAttr(value)}">
    </td>
  `;
}

function renderCloudSetupNotice() {
  if (cloud.configured) return "";
  return `
    <div class="setup-notice">
      <strong>Cloud jeste neni zapnuty.</strong>
      <span>Dopln Supabase URL a anon key do <code>supabase-config.js</code>, potom spust SQL ze <code>supabase-schema.sql</code>.</span>
    </div>
  `;
}

function renderSocialEmpty(message) {
  return `
    <div class="empty social-empty">
      <div>
        <strong>${escapeHtml(message)}</strong>
        <div class="microcopy">U treningu nastav viditelnost na Public a po ulozeni se objevi tady.</div>
      </div>
    </div>
  `;
}

function renderFeedCard(row) {
  const profile = row.profile || {};
  const dayLabel = DAY_LABELS[row.day_index]?.[1] || "Den";
  const title = row.title || dayLabel;
  return `
    <article class="feed-card">
      <div class="feed-top">
        <div>
          <strong>${escapeHtml(profile.display_name || profile.username || "Sportovec")}</strong>
          <span>${escapeHtml(formatCloudDate(row.updated_at))}</span>
        </div>
        <span class="pill done">${formatNumber(row.volume)} kg</span>
      </div>
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(row.focus || "Trenink")}</p>
      <div class="feed-stats">
        <span>${row.completed_sets}/${row.total_sets} serii</span>
        <span>${escapeHtml(dayLabel)}</span>
        <span>${escapeHtml(row.week_start)}</span>
      </div>
      ${renderFeedExercises(row.payload?.exercises || [])}
    </article>
  `;
}

function renderFeedExercises(exercises) {
  if (!exercises.length) return "";
  return `
    <div class="feed-exercises">
      ${exercises.slice(0, 4).map((exercise) => `
        <span>${escapeHtml(exercise.name)} - ${exercise.sets?.length || 0}x</span>
      `).join("")}
    </div>
  `;
}

function renderLeaderboardRow(row, index) {
  return `
    <div class="leader-row">
      <span class="leader-rank">${index + 1}</span>
      <div>
        <strong>${escapeHtml(row.name)}</strong>
        <span>${row.trainingDays} dny - ${row.completedSets}/${row.totalSets} serii</span>
      </div>
      <strong>${formatNumber(row.volume)} kg</strong>
    </div>
  `;
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
          <label class="field">
            <span>Viditelnost</span>
            <select class="select" data-field="day-visibility">
              ${renderVisibilityOptions(day.visibility || "friends")}
            </select>
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
        <div class="exercise-list" data-exercise-list>
          ${day.exercises.length ? day.exercises.map((exercise, index) => renderExercise(exercise, index)).join("") : renderEmptyDay(summary)}
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

function renderExercise(exercise, index) {
  return `
    <article class="exercise-card" data-exercise-id="${exercise.id}" data-exercise-index="${index}">
      <div class="exercise-head">
        <button class="drag-handle" type="button" data-drag-exercise-id="${exercise.id}" title="Pretahnout cvik" aria-label="Pretahnout cvik">${index + 1}</button>
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

function renderSidePanel(summary, daySummary, day) {
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
        <h2 class="section-title">Partie dnes</h2>
        ${renderMuscleBreakdown(summarizeDayMuscles(day))}
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

function renderMuscleBreakdown(groups) {
  if (!groups.length) {
    return `<div class="muscle-empty microcopy">Pridej cviky a tady uvidis serie podle partie.</div>`;
  }

  return `
    <div class="muscle-breakdown">
      ${groups.map((group) => `
        <div class="muscle-row">
          <div>
            <strong>${escapeHtml(group.muscle)}</strong>
            <span>${group.exerciseCount} ${group.exerciseCount === 1 ? "cvik" : "cviky"}</span>
          </div>
          <span class="pill">${group.completed}/${group.totalSets} serii</span>
        </div>
      `).join("")}
    </div>
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

function renderVisibilityOptions(selected) {
  const items = [
    ["private", "Private"],
    ["friends", "Friends"],
    ["public", "Public"]
  ];
  return items.map(([value, label]) => (
    `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`
  )).join("");
}

async function handleClick(event) {
  const target = event.target.closest("[data-action]");
  if (!target) return;

  const action = target.dataset.action;
  const week = ensureWeek();
  const day = week[state.selectedDay];

  if (action === "set-view") {
    const nextView = target.dataset.view;
    if (!["plan", "nutrition", "feed", "leaderboard", "profile"].includes(nextView)) return;
    state.activeView = nextView;
    saveLocal();
    render();
    if (nextView === "nutrition") await loadCloudNutritionWeek();
    if (nextView === "feed" || nextView === "leaderboard") await loadSocialData();
    if (nextView === "nutrition") saveLocal();
    render();
    return;
  }

  if (action === "sign-out") {
    if (cloud.client) await cloud.client.auth.signOut();
    showToast("Odhlaseno.");
    return;
  }

  if (action === "refresh-social") {
    await loadSocialData();
    render();
    showToast("Data obnovena.");
    return;
  }

  if (action === "toggle-theme") {
    state.theme = state.theme === "dark" ? "light" : "dark";
    saveLocal();
    render();
    return;
  }

  if (action === "select-day") {
    state.selectedDay = Number(target.dataset.day);
    saveLocal();
    render();
    return;
  }

  if (action === "prev-week" || action === "next-week") {
    const shift = action === "prev-week" ? -7 : 7;
    state.weekStart = toDateInput(addDays(parseDate(state.weekStart), shift));
    ensureWeek();
    ensureNutritionWeek();
    saveLocal();
    render();
    await loadCloudWeek();
    await loadCloudNutritionWeek();
    await loadSocialData();
    saveLocal();
    render();
    return;
  }

  if (action === "today") {
    const today = new Date();
    state.weekStart = toDateInput(getWeekStart(today));
    state.selectedDay = getDayIndex(today);
    ensureWeek();
    ensureNutritionWeek();
    saveLocal();
    render();
    await loadCloudWeek();
    await loadCloudNutritionWeek();
    await loadSocialData();
    saveLocal();
    render();
    return;
  }

  if (action === "copy-nutrition-prev-week") {
    const previousStart = toDateInput(addDays(parseDate(state.weekStart), -7));
    if (!state.nutrition[previousStart]) {
      showToast("Minuly tyden zatim nema nutrition data.");
      return;
    }
    state.nutrition[state.weekStart] = cloneNutritionWeek(state.nutrition[previousStart], true);
    save();
    render();
    showToast("Nutrition targets zkopirovany.");
    return;
  }

  if (action === "copy-prev-week") {
    const previousStart = toDateInput(addDays(parseDate(state.weekStart), -7));
    if (!state.weeks[previousStart]) {
      showToast("Minuly tyden zatim nema plan.");
      return;
    }
    state.weeks[state.weekStart] = cloneWeek(state.weeks[previousStart], true);
    save();
    render();
    showToast("Tyden zkopirovan.");
    return;
  }

  if (action === "sample-week") {
    if (!confirm("Prepsat aktualni tyden ukazkovym planem?")) return;
    state.weeks[state.weekStart] = createSampleWeek();
    save();
    render();
    showToast("Ukazkovy plan nahran.");
    return;
  }

  if (action === "clear-day") {
    if (!confirm("Vycistit vybrany den?")) return;
    week[state.selectedDay] = createBlankWeek()[state.selectedDay];
    save();
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
    save();
    render();
    return;
  }

  if (action === "remove-exercise") {
    const id = target.dataset.exerciseId;
    const index = day.exercises.findIndex((exercise) => exercise.id === id);
    if (index >= 0) day.exercises.splice(index, 1);
    save();
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
    save();
    render();
    return;
  }

  if (action === "remove-set") {
    const exercise = findExercise(target.dataset.exerciseId);
    if (!exercise) return;
    exercise.sets = exercise.sets.filter((set) => set.id !== target.dataset.setId);
    if (!exercise.sets.length) exercise.sets.push(createSet());
    save();
    render();
    return;
  }

  if (action === "template-ppl") {
    if (!confirm("Prepsat aktualni tyden sablonou PPL?")) return;
    state.weeks[state.weekStart] = createSampleWeek();
    save();
    render();
    return;
  }

  if (action === "template-fullbody") {
    if (!confirm("Prepsat aktualni tyden full body sablonou?")) return;
    state.weeks[state.weekStart] = createFullBodyWeek();
    save();
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
    saveLocal();
    render();
    return;
  }

  if (action === "remove-library-item") {
    state.library = state.library.filter((item) => item.id !== target.dataset.libraryId);
    saveLocal();
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

async function handleSubmit(event) {
  if (event.target.dataset.profileForm !== undefined) {
    event.preventDefault();
    await saveProfileForm(event.target);
    return;
  }

  const authMode = event.target.dataset.authForm;
  if (!authMode) return;
  event.preventDefault();

  if (!cloud.client) {
    showToast("Supabase neni nakonfigurovany.");
    return;
  }

  const form = new FormData(event.target);
  const email = String(form.get("email") || "").trim();
  const password = String(form.get("password") || "");

  if (authMode === "sign-in") {
    const { error } = await cloud.client.auth.signInWithPassword({ email, password });
    if (error) showToast(error.message);
    return;
  }

  if (authMode === "sign-up") {
    const { error } = await cloud.client.auth.signUp({ email, password });
    if (error) {
      showToast(error.message);
      return;
    }
    showToast("Registrace hotova. Kdyz Supabase vyzaduje potvrzeni, mrkni do emailu.");
  }
}

async function saveProfileForm(formElement) {
  if (!cloud.client || !cloud.session) {
    showToast("Pro profil se nejdriv prihlas.");
    return;
  }

  const form = new FormData(formElement);
  const displayName = String(form.get("display_name") || "").trim();
  if (!displayName) {
    showToast("Napis prezdivku.");
    return;
  }

  const { data, error } = await cloud.client
    .from("profiles")
    .update({
      display_name: displayName,
      updated_at: new Date().toISOString()
    })
    .eq("id", cloud.session.user.id)
    .select("*")
    .single();

  if (error) {
    console.warn(error);
    showCloudError("Profil se nepodarilo ulozit.", error);
    return;
  }

  cloud.profile = data;
  render();
  showToast("Profil ulozen.");
}

function handleInput(event) {
  const field = event.target.dataset.field;
  if (!field) return;

  const week = ensureWeek();
  const day = week[state.selectedDay];

  if (field === "nutrition-day") {
    updateNutritionDay(event.target);
    save();
    return;
  }

  if (field === "nutrition-goal") {
    updateNutritionGoal(event.target);
    save();
    return;
  }

  if (field === "nutrition-cheat") {
    ensureNutritionWeek().lastCheatMeal = event.target.value;
    save();
    return;
  }

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
    return;
  }

  const set = exercise.sets.find((item) => item.id === event.target.dataset.setId);
  if (set && updateSetField(field, set, event.target)) {
    save();
  }
}

function handleChange(event) {
  const field = event.target.dataset.field;
  if (!field) return;

  const week = ensureWeek();
  const day = week[state.selectedDay];

  if (field === "nutrition-day") {
    updateNutritionDay(event.target);
    save();
    return;
  }

  if (field === "nutrition-goal") {
    updateNutritionGoal(event.target);
    save();
    return;
  }

  if (field === "nutrition-cheat") {
    ensureNutritionWeek().lastCheatMeal = event.target.value;
    save();
    return;
  }

  if (field === "day-visibility") {
    day.visibility = event.target.value;
    save();
    render();
    return;
  }

  const exercise = findExercise(event.target.dataset.exerciseId);
  const set = exercise?.sets.find((item) => item.id === event.target.dataset.setId);

  if (field === "exercise-muscle" && exercise) {
    exercise.muscle = event.target.value;
    save();
    render();
    return;
  }

  if (!set) return;

  const shouldRender = field === "set-done";
  if (!updateSetField(field, set, event.target)) return;

  save();
  if (shouldRender) render();
}

function handlePointerDown(event) {
  const handle = event.target.closest("[data-drag-exercise-id]");
  if (!handle || event.button > 0) return;

  const card = handle.closest(".exercise-card");
  const list = handle.closest("[data-exercise-list]");
  if (!card || !list) return;

  const exercises = ensureWeek()[state.selectedDay].exercises;
  const exerciseId = handle.dataset.dragExerciseId;
  const fromIndex = exercises.findIndex((exercise) => exercise.id === exerciseId);
  if (fromIndex < 0) return;

  exerciseDrag = {
    pointerId: event.pointerId,
    exerciseId,
    overId: exerciseId,
    insertAfter: false,
    moved: false
  };

  handle.setPointerCapture?.(event.pointerId);
  card.classList.add("dragging");
  document.body.classList.add("dragging-exercise");
  event.preventDefault();
}

function handlePointerMove(event) {
  if (!exerciseDrag || event.pointerId !== exerciseDrag.pointerId) return;

  const element = document.elementFromPoint(event.clientX, event.clientY);
  const card = element?.closest?.(".exercise-card");
  if (!card || !card.closest("[data-exercise-list]")) {
    event.preventDefault();
    return;
  }

  exerciseDrag.moved = true;
  const rect = card.getBoundingClientRect();
  const insertAfter = event.clientY > rect.top + rect.height / 2;

  document.querySelectorAll(".exercise-card.drop-before, .exercise-card.drop-after").forEach((item) => {
    item.classList.remove("drop-before", "drop-after");
  });

  if (card.dataset.exerciseId !== exerciseDrag.exerciseId) {
    card.classList.add(insertAfter ? "drop-after" : "drop-before");
  }

  exerciseDrag.overId = card.dataset.exerciseId;
  exerciseDrag.insertAfter = insertAfter;
  event.preventDefault();
}

function handlePointerUp(event) {
  if (!exerciseDrag || event.pointerId !== exerciseDrag.pointerId) return;

  const drag = exerciseDrag;
  cancelExerciseDrag();

  if (!drag.moved || !drag.overId || drag.overId === drag.exerciseId) return;
  if (moveExerciseInSelectedDay(drag.exerciseId, drag.overId, drag.insertAfter)) {
    save();
    render();
    showToast("Poradi cviku upraveno.");
  }
}

function cancelExerciseDrag() {
  if (!exerciseDrag) return;
  exerciseDrag = null;
  document.body.classList.remove("dragging-exercise");
  document.querySelectorAll(".exercise-card.dragging, .exercise-card.drop-before, .exercise-card.drop-after").forEach((card) => {
    card.classList.remove("dragging", "drop-before", "drop-after");
  });
}

function moveExerciseInSelectedDay(exerciseId, targetId, insertAfter) {
  const exercises = ensureWeek()[state.selectedDay].exercises;
  const fromIndex = exercises.findIndex((exercise) => exercise.id === exerciseId);
  const targetIndex = exercises.findIndex((exercise) => exercise.id === targetId);
  if (fromIndex < 0 || targetIndex < 0 || fromIndex === targetIndex) return false;

  const [moved] = exercises.splice(fromIndex, 1);
  let insertIndex = exercises.findIndex((exercise) => exercise.id === targetId);
  if (insertIndex < 0) {
    exercises.splice(fromIndex, 0, moved);
    return false;
  }
  if (insertAfter) insertIndex += 1;

  exercises.splice(insertIndex, 0, moved);
  return true;
}

function updateSetField(field, set, target) {
  if (field === "set-done") {
    set.done = target.checked;
    return true;
  }
  if (field === "set-reps") {
    set.reps = toNumber(target.value, 0);
    return true;
  }
  if (field === "set-weight") {
    set.weight = toNumber(target.value, 0);
    return true;
  }
  if (field === "set-rpe") {
    set.rpe = toNumber(target.value, 0);
    return true;
  }
  return false;
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

async function ensureProfile() {
  if (!cloud.client || !cloud.session) return;
  const user = cloud.session.user;
  const fallbackName = user.email ? user.email.split("@")[0] : "sportovec";
  const { data, error } = await cloud.client
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  if (data && !error) {
    cloud.profile = data;
    return;
  }

  const profile = {
    id: user.id,
    username: `${fallbackName}-${user.id.slice(0, 4)}`.toLowerCase(),
    display_name: fallbackName
  };
  const { data: inserted } = await cloud.client
    .from("profiles")
    .insert(profile)
    .select("*")
    .single();
  cloud.profile = inserted || profile;
}

async function loadCloudData() {
  await loadCloudWeek();
  await loadCloudNutritionWeek();
  await loadSocialData();
}

async function loadCloudWeek() {
  if (!cloud.client || !cloud.session) return;
  cloud.loading = true;
  const { data, error } = await cloud.client
    .from("workout_days")
    .select("*")
    .eq("user_id", cloud.session.user.id)
    .eq("week_start", state.weekStart)
    .order("day_index", { ascending: true });

  cloud.loading = false;
  if (error) {
    cloud.message = error.message;
    showToast("Cloud tyden se nepodarilo nacist.");
    return;
  }

  if (!data?.length) return;
  const week = createBlankWeek();
  data.forEach((row) => {
    week[row.day_index] = rowToDay(row);
  });
  state.weeks[state.weekStart] = week;
}

async function loadCloudNutritionWeek() {
  if (!cloud.client || !cloud.session) return;
  const { data, error } = await cloud.client
    .from("nutrition_weeks")
    .select("*")
    .eq("user_id", cloud.session.user.id)
    .eq("week_start", state.weekStart)
    .maybeSingle();

  if (error) {
    console.warn(error);
    return;
  }

  if (!data) return;
  state.nutrition[state.weekStart] = normalizeNutritionWeek(data.payload);
}

async function loadSocialData() {
  if (!cloud.client || !cloud.session) return;
  await Promise.all([loadFeed(), loadLeaderboard()]);
}

async function loadFeed() {
  const { data, error } = await cloud.client
    .from("workout_days")
    .select("id,user_id,week_start,day_index,title,focus,payload,volume,completed_sets,total_sets,updated_at")
    .eq("visibility", "public")
    .order("updated_at", { ascending: false })
    .limit(20);

  if (error) {
    cloud.feed = [];
    return;
  }
  cloud.feed = await attachProfiles(data || []);
}

async function loadLeaderboard() {
  const { data, error } = await cloud.client
    .from("workout_days")
    .select("user_id,week_start,volume,completed_sets,total_sets")
    .eq("visibility", "public")
    .eq("week_start", state.weekStart)
    .limit(200);

  if (error) {
    cloud.leaderboard = [];
    return;
  }

  const rows = await attachProfiles(data || []);
  const grouped = new Map();
  rows.forEach((row) => {
    const current = grouped.get(row.user_id) || {
      userId: row.user_id,
      name: row.profile?.display_name || row.profile?.username || "Sportovec",
      volume: 0,
      completedSets: 0,
      totalSets: 0,
      trainingDays: 0
    };
    current.volume += toNumber(row.volume, 0);
    current.completedSets += toNumber(row.completed_sets, 0);
    current.totalSets += toNumber(row.total_sets, 0);
    current.trainingDays += 1;
    grouped.set(row.user_id, current);
  });

  cloud.leaderboard = [...grouped.values()]
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 20);
}

async function attachProfiles(rows) {
  const ids = [...new Set(rows.map((row) => row.user_id).filter(Boolean))];
  if (!ids.length) return rows;
  const { data } = await cloud.client
    .from("profiles")
    .select("id,username,display_name,avatar_url")
    .in("id", ids);
  const profiles = new Map((data || []).map((profile) => [profile.id, profile]));
  return rows.map((row) => ({
    ...row,
    profile: profiles.get(row.user_id) || null
  }));
}

function scheduleCloudSync() {
  if (!cloud.client || !cloud.session) return;
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(() => {
    saveSelectedDayToCloud().catch((error) => {
      console.warn(error);
      showCloudError("Cloud ulozeni se nepovedlo.", error);
    });
  }, 650);
}

function scheduleNutritionSync() {
  if (!cloud.client || !cloud.session || state.activeView !== "nutrition") return;
  clearTimeout(nutritionSyncTimer);
  nutritionSyncTimer = setTimeout(() => {
    saveNutritionToCloud().catch((error) => {
      console.warn(error);
      showCloudError("Nutrition cloud ulozeni se nepovedlo.", error);
    });
  }, 650);
}

async function saveSelectedDayToCloud() {
  if (!cloud.client || !cloud.session) return;
  const day = ensureWeek()[state.selectedDay];
  const summary = summarizeDay(day);
  const payload = {
    exercises: day.exercises
  };

  const { error } = await cloud.client
    .from("workout_days")
    .upsert({
      user_id: cloud.session.user.id,
      week_start: state.weekStart,
      day_index: state.selectedDay,
      title: day.title || "",
      focus: day.focus || "",
      notes: day.notes || "",
      visibility: day.visibility || "friends",
      payload,
      volume: summary.volume,
      completed_sets: summary.completed,
      total_sets: summary.totalSets,
      updated_at: new Date().toISOString()
    }, { onConflict: "user_id,week_start,day_index" });

  if (error) throw error;
  if (state.activeView !== "plan") await loadSocialData();
}

function rowToDay(row) {
  return normalizeWeek({
    0: {
      title: row.title,
      focus: row.focus,
      notes: row.notes,
      visibility: row.visibility,
      exercises: row.payload?.exercises || []
    }
  })[0];
}

async function saveNutritionToCloud() {
  if (!cloud.client || !cloud.session) return;
  const nutrition = ensureNutritionWeek();
  const summary = summarizeNutrition(nutrition);
  const { error } = await cloud.client
    .from("nutrition_weeks")
    .upsert({
      user_id: cloud.session.user.id,
      week_start: state.weekStart,
      payload: nutrition,
      calories: summary.totalCalories,
      protein: summary.totalProtein,
      carbs: summary.totalCarbs,
      fat: summary.totalFat,
      latest_weight: summary.latestWeight,
      updated_at: new Date().toISOString()
    }, { onConflict: "user_id,week_start" });

  if (error) throw error;
}

function updateNutritionDay(input) {
  const nutrition = ensureNutritionWeek();
  const dayIndex = Number(input.dataset.day);
  const field = input.dataset.nutrition;
  if (!nutrition.days[dayIndex] || !field) return;
  nutrition.days[dayIndex][field] = field === "notes"
    ? input.value
    : normalizeOptionalNumber(input.value);
}

function updateNutritionGoal(input) {
  const nutrition = ensureNutritionWeek();
  const field = input.dataset.goal;
  if (!field) return;
  nutrition.goals[field] = toNumber(input.value, 0);
}

function addLibraryExercise(id) {
  const item = state.library.find((entry) => entry.id === id);
  if (!item) return;
  ensureWeek()[state.selectedDay].exercises.push(createExercise(item.name, item.muscle));
  save();
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

function ensureNutritionWeek() {
  if (!state.nutrition[state.weekStart]) state.nutrition[state.weekStart] = createNutritionWeek();
  return state.nutrition[state.weekStart];
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

function cloneNutritionWeek(nutrition, resetDays = false) {
  const normalized = normalizeNutritionWeek(nutrition);
  return {
    goals: { ...normalized.goals },
    lastCheatMeal: resetDays ? "" : normalized.lastCheatMeal,
    days: resetDays
      ? createNutritionWeek().days
      : normalized.days.map((day) => ({ ...day }))
  };
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

function summarizeDayMuscles(day) {
  const groups = new Map();
  day.exercises.forEach((exercise) => {
    const muscle = MUSCLES.includes(exercise.muscle) ? exercise.muscle : "Full body";
    const current = groups.get(muscle) || {
      muscle,
      exerciseCount: 0,
      completed: 0,
      totalSets: 0
    };
    current.exerciseCount += 1;
    current.completed += exercise.sets.filter((set) => set.done).length;
    current.totalSets += exercise.sets.length;
    groups.set(muscle, current);
  });
  return [...groups.values()].filter((group) => group.totalSets > 0);
}

function summarizeNutrition(nutrition) {
  const days = nutrition.days || [];
  const totalCalories = days.reduce((sum, day) => sum + toNumber(day.calories, 0), 0);
  const totalProtein = days.reduce((sum, day) => sum + toNumber(day.protein, 0), 0);
  const totalCarbs = days.reduce((sum, day) => sum + toNumber(day.carbs, 0), 0);
  const totalFat = days.reduce((sum, day) => sum + toNumber(day.fat, 0), 0);
  const daysLogged = days.filter((day) => toNumber(day.calories, 0) > 0).length;
  const weights = days
    .filter((day) => day.weight !== "" && day.weight !== null && day.weight !== undefined)
    .map((day) => toNumber(day.weight, NaN))
    .filter(Number.isFinite);
  const latestWeight = weights.length ? weights.at(-1) : null;
  const weeklyGoal = toNumber(nutrition.goals?.weeklyCalories, 0);
  const progress = weeklyGoal ? Math.min(100, Math.round((totalCalories / weeklyGoal) * 100)) : 0;

  return {
    totalCalories,
    totalProtein,
    totalCarbs,
    totalFat,
    latestWeight,
    daysLogged,
    averageCalories: daysLogged ? Math.round(totalCalories / daysLogged) : 0,
    remainingCalories: Math.max(0, weeklyGoal - totalCalories),
    progress
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
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function showCloudError(prefix, error) {
  const message = error?.code === "PGRST205"
    ? `${prefix} V Supabase chybi tabulka. Spust SQL patch.`
    : `${prefix} ${error?.message || ""}`.trim();
  showToast(message);
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.style.colorScheme = state.theme;
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

function profileName() {
  return cloud.profile?.display_name || cloud.profile?.username || cloud.session?.user?.email || "Online";
}

function formatCloudDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("cs-CZ", {
    day: "numeric",
    month: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
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

function normalizeOptionalNumber(value) {
  if (value === "" || value === null || value === undefined) return "";
  const number = Number(value);
  return Number.isFinite(number) ? number : "";
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
