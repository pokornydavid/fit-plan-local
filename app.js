const STORAGE_KEY = "fit-plan-local-v1";
const PENDING_SYNC_KEY = "fit-plan-pending-sync-v1";
const USER_STORAGE_PREFIX = `${STORAGE_KEY}:user:`;
const USER_PENDING_SYNC_PREFIX = `${PENDING_SYNC_KEY}:user:`;
const APP_VERSION = "61";
const SUPABASE_CONFIG_URL = `./supabase-config.js?v=${APP_VERSION}`;
const SUPABASE_MODULE_URL = "https://esm.sh/@supabase/supabase-js@2.45.4";
const SUPABASE_FALLBACK_MODULE_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
const CLOUD_INIT_TIMEOUT_MS = 15000;
const CLOUD_REFRESH_INTERVAL_MS = 6000;
const DEFAULT_PHASE_WEEKS = 16;
const NUTRITION_PHASE_WEEK_START = "1970-01-05";
const PHASE_PHOTO_BUCKET = "progress-photos";
const PHASE_PHOTO_LIMIT = 12;
const PHASE_PHOTO_SIGNED_URL_SECONDS = 60 * 60 * 24 * 7;
const COMMUNITY_POST_BUCKET = "community-posts";
const COMMUNITY_POST_SIGNED_URL_SECONDS = 60 * 60 * 24 * 7;
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

let activeStorageKey = STORAGE_KEY;
let activePendingSyncKey = PENDING_SYNC_KEY;
let activeUserId = null;
let state = loadState();
let toastTimer = 0;
let cloudSyncTimer = 0;
let nutritionSyncTimer = 0;
let cloudRefreshTimer = 0;
let cloudRefreshInFlight = false;
let exerciseDrag = null;
let phasePhotoDrag = null;
let pendingSync = loadPendingSync();
let flushingPendingSync = false;
let feedLoadSeq = 0;
let pendingPhasePhotoRowId = null;
let phasePhotoViewer = null;
let phaseCompareViewer = null;
let copyDayDialogOpen = false;
let postComposerImageFile = null;
let postComposerPreviewUrl = "";
let phaseCompare = {
  fromRowId: "",
  toRowId: "",
  slotIndex: 0
};
const openPhasePhotoRows = new Set();
let cloud = {
  ready: false,
  configured: false,
  client: null,
  session: null,
  profile: null,
  feed: [],
  leaderboard: [],
  posts: [],
  authNotice: null,
  pendingEmail: "",
  passwordRecovery: false,
  status: "local",
  message: "Supabase neni pripojeny. Appka zatim uklada lokalne.",
  loading: false
};

const app = document.querySelector("#app");
const toast = document.querySelector("#toast");
const importFile = document.querySelector("#importFile");
const posingFile = document.querySelector("#posingFile");

app.addEventListener("click", handleClick);
app.addEventListener("input", handleInput);
app.addEventListener("change", handleChange);
app.addEventListener("submit", handleSubmit);
app.addEventListener("focusout", handleFocusOut);
app.addEventListener("pointerdown", handlePointerDown);
app.addEventListener("toggle", handleToggle, true);
window.addEventListener("pointermove", handlePointerMove);
window.addEventListener("pointerup", handlePointerUp);
window.addEventListener("pointercancel", handlePointerCancel);
window.addEventListener("pagehide", handlePageHide);
window.addEventListener("focus", () => refreshCloudDataIfIdle({ force: true }));
window.addEventListener("online", () => refreshCloudDataIfIdle({ force: true }));
document.addEventListener("visibilitychange", handleVisibilityChange);
document.addEventListener("keydown", handleKeyDown);
importFile.addEventListener("change", handleImport);
posingFile?.addEventListener("change", handlePhasePhotoImport);

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
    await flushPendingSync();
    await loadCloudData();
    saveLocal();
  }
  startCloudAutoRefresh();
  render();
}

async function initSupabase() {
  try {
    const config = await withTimeout(import(SUPABASE_CONFIG_URL), CLOUD_INIT_TIMEOUT_MS, "Supabase config timeout");
    if (!config.SUPABASE_URL || !config.SUPABASE_ANON_KEY) {
      cloud.ready = true;
      cloud.configured = false;
      return;
    }

    const { createClient } = await importSupabaseClient();
    cloud.client = createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY);
    cloud.configured = true;
    cloud.status = "auth";
    cloud.message = "Supabase je pripraveny.";

    const { data } = await withTimeout(cloud.client.auth.getSession(), CLOUD_INIT_TIMEOUT_MS, "Supabase session timeout");
    cloud.session = data.session;
    if (cloud.session) {
      activateUserStorage(cloud.session.user.id);
      await ensureProfile();
    }

    cloud.client.auth.onAuthStateChange(async (event, session) => {
      cloud.session = session;
      if (event === "PASSWORD_RECOVERY") cloud.passwordRecovery = true;
      if (session) {
        activateUserStorage(session.user.id);
        if (!cloud.passwordRecovery) {
          cloud.authNotice = null;
          cloud.pendingEmail = "";
        }
        await ensureProfile();
        if (!cloud.passwordRecovery) {
          await finishSignedInSession(session, "Jsi prihlaseny.");
        }
      } else {
        finishSignedOutState();
      }
      render();
    });
  } catch (error) {
    cloud.configured = false;
    cloud.client = null;
    cloud.session = null;
    cloud.status = "local";
    cloud.message = "Cloud se nacital moc dlouho. Zkus refresh, appka zatim bezi lokalne.";
    console.warn(error);
  } finally {
    cloud.ready = true;
  }
}

async function importSupabaseClient() {
  try {
    return await withTimeout(import(SUPABASE_MODULE_URL), CLOUD_INIT_TIMEOUT_MS, "Supabase client timeout");
  } catch (error) {
    console.warn(error);
    return withTimeout(import(SUPABASE_FALLBACK_MODULE_URL), CLOUD_INIT_TIMEOUT_MS, "Supabase fallback client timeout");
  }
}

function withTimeout(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), timeoutMs);
    })
  ]);
}

function startCloudAutoRefresh() {
  clearInterval(cloudRefreshTimer);
  cloudRefreshTimer = setInterval(() => {
    refreshCloudDataIfIdle().catch((error) => console.warn(error));
  }, CLOUD_REFRESH_INTERVAL_MS);
}

function isEditingAppField() {
  const element = document.activeElement;
  if (!element || !app.contains(element)) return false;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName);
}

async function refreshCloudDataIfIdle({ force = false } = {}) {
  if (!cloud.client || !cloud.session || !cloud.ready || cloudRefreshInFlight) return;
  if (document.visibilityState === "hidden") return;
  if (!force && isEditingAppField()) return;

  cloudRefreshInFlight = true;
  try {
    await flushPendingSync();
    if (hasAnyPendingSync()) return;
    const beforeRefresh = snapshotVisibleCloudData();
    await loadCloudData();
    const afterRefresh = snapshotVisibleCloudData();
    saveLocal();
    if (beforeRefresh !== afterRefresh) render();
  } catch (error) {
    console.warn(error);
  } finally {
    cloudRefreshInFlight = false;
  }
}

function snapshotVisibleCloudData() {
  const week = state.weeks[state.weekStart] || null;
  const nutrition = state.nutrition[state.weekStart] || null;
  const phase = {
    ...stripPhasePhotosForCloud(state.nutritionPhase),
    rows: state.nutritionPhase.rows.map((row) => ({
      id: row.id,
      weekLabel: row.weekLabel,
      date: row.date,
      calories: row.calories,
      weight: row.weight,
      notes: row.notes,
      photoOrder: normalizePhotoOrder(row.photoOrder),
      photos: orderPhasePhotos(row.photos, row.photoOrder).map((photo) => ({
        key: phasePhotoKey(photo),
        storagePath: photo.storagePath || "",
        addedAt: photo.addedAt || ""
      }))
    }))
  };
  return JSON.stringify({
    activeView: state.activeView,
    weekStart: state.weekStart,
    selectedDay: state.selectedDay,
    week,
    nutrition,
    phase,
    feed: cloud.feed.map((row) => `${row.user_id}:${row.week_start}:${row.day_index}:${row.updated_at}:${row.volume}:${row.completed_sets}:${row.total_sets}`),
    leaderboard: cloud.leaderboard.map((row) => `${row.user_id}:${row.totalVolume}:${row.trainingDays}:${row.completedSets}:${row.totalSets}`),
    posts: cloud.posts.map((post) => `${post.id}:${post.updated_at}:${post.body}:${post.image_storage_path || ""}`)
  });
}

function loadState(storageKey = activeStorageKey, fallback = createDefaultState()) {
  try {
    const raw = localStorage.getItem(storageKey);
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
    nutritionPhase: createNutritionPhase(),
    library: createDefaultLibrary()
  };
}

function createAccountState(theme = "dark") {
  const weekStart = toDateInput(getWeekStart(new Date()));
  return {
    theme,
    activeView: "plan",
    selectedDay: getDayIndex(new Date()),
    weekStart,
    weeks: {
      [weekStart]: createBlankWeek()
    },
    nutrition: {
      [weekStart]: createNutritionWeek()
    },
    nutritionPhase: createNutritionPhase(),
    library: createDefaultLibrary()
  };
}

function normalizeState(value, fallback = createDefaultState()) {
  const next = {
    theme: value?.theme === "light" ? "light" : "dark",
    activeView: ["plan", "nutrition", "feed", "posts", "leaderboard", "profile"].includes(value?.activeView) ? value.activeView : "plan",
    selectedDay: Number.isInteger(value?.selectedDay) ? value.selectedDay : fallback.selectedDay,
    weekStart: value?.weekStart || fallback.weekStart,
    weeks: value?.weeks && typeof value.weeks === "object" ? value.weeks : fallback.weeks,
    nutrition: value?.nutrition && typeof value.nutrition === "object" ? value.nutrition : fallback.nutrition,
    nutritionPhase: normalizeNutritionPhase(value?.nutritionPhase || findStoredNutritionPhase(value?.nutrition) || fallback.nutritionPhase),
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
      visibility: normalizeVisibility(source.visibility),
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
  if (state.activeView === "nutrition") {
    markPendingNutritionSync();
    scheduleNutritionSync();
    return;
  }
  markPendingWorkoutSync();
  scheduleCloudSync();
}

function saveLocal() {
  localStorage.setItem(activeStorageKey, JSON.stringify(state));
}

function createEmptyPendingSync() {
  return {
    workouts: {},
    nutrition: {}
  };
}

function loadPendingSync(storageKey = activePendingSyncKey) {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return createEmptyPendingSync();
    const parsed = JSON.parse(raw);
    return {
      workouts: parsed?.workouts && typeof parsed.workouts === "object" ? parsed.workouts : {},
      nutrition: parsed?.nutrition && typeof parsed.nutrition === "object" ? parsed.nutrition : {}
    };
  } catch {
    return createEmptyPendingSync();
  }
}

function savePendingSync() {
  localStorage.setItem(activePendingSyncKey, JSON.stringify(pendingSync));
}

function userStorageKey(userId) {
  return `${USER_STORAGE_PREFIX}${userId}`;
}

function userPendingSyncKey(userId) {
  return `${USER_PENDING_SYNC_PREFIX}${userId}`;
}

function activateUserStorage(userId) {
  if (!userId || activeUserId === userId) return;
  activeUserId = userId;
  activeStorageKey = userStorageKey(userId);
  activePendingSyncKey = userPendingSyncKey(userId);
  const theme = state?.theme === "light" ? "light" : "dark";
  state = loadState(activeStorageKey, createAccountState(theme));
  pendingSync = loadPendingSync(activePendingSyncKey);
  saveLocal();
}

function activateAnonymousStorage() {
  activeUserId = null;
  activeStorageKey = STORAGE_KEY;
  activePendingSyncKey = PENDING_SYNC_KEY;
  state = loadState(activeStorageKey, createDefaultState());
  pendingSync = loadPendingSync(activePendingSyncKey);
}

function workoutPendingKey(weekStart, dayIndex) {
  return `${weekStart}:${dayIndex}`;
}

function markPendingWorkoutSync(weekStart = state.weekStart, dayIndex = state.selectedDay) {
  pendingSync.workouts[workoutPendingKey(weekStart, dayIndex)] = {
    weekStart,
    dayIndex: Number(dayIndex),
    updatedAt: new Date().toISOString()
  };
  savePendingSync();
}

function markPendingNutritionSync(weekStart = state.weekStart) {
  pendingSync.nutrition[weekStart] = {
    weekStart,
    updatedAt: new Date().toISOString()
  };
  savePendingSync();
}

function clearPendingWorkoutSync(weekStart, dayIndex) {
  delete pendingSync.workouts[workoutPendingKey(weekStart, dayIndex)];
  savePendingSync();
}

function clearPendingWorkoutSyncIfCurrent(weekStart, dayIndex, expectedUpdatedAt) {
  if (!expectedUpdatedAt) {
    clearPendingWorkoutSync(weekStart, dayIndex);
    return;
  }
  const key = workoutPendingKey(weekStart, dayIndex);
  if (pendingSync.workouts[key]?.updatedAt === expectedUpdatedAt) {
    clearPendingWorkoutSync(weekStart, dayIndex);
  }
}

function clearPendingNutritionSync(weekStart) {
  delete pendingSync.nutrition[weekStart];
  savePendingSync();
}

function clearPendingNutritionSyncIfCurrent(weekStart, expectedUpdatedAt) {
  if (!expectedUpdatedAt) {
    clearPendingNutritionSync(weekStart);
    return;
  }
  if (pendingSync.nutrition[weekStart]?.updatedAt === expectedUpdatedAt) {
    clearPendingNutritionSync(weekStart);
  }
}

function hasPendingWorkoutsForWeek(weekStart) {
  return Object.values(pendingSync.workouts).some((item) => item.weekStart === weekStart);
}

function hasPendingNutritionForWeek(weekStart) {
  return Boolean(pendingSync.nutrition[weekStart]);
}

function hasAnyPendingSync() {
  return Boolean(Object.keys(pendingSync.workouts).length || Object.keys(pendingSync.nutrition).length);
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

function createSet(overrides = {}) {
  return {
    id: uid(),
    reps: overrides.reps ?? 8,
    weight: overrides.weight ?? 0,
    rpe: overrides.rpe ?? 7,
    done: overrides.done ?? false
  };
}

function createExercise(name, muscle, sets = null, notes = "") {
  const baseSets = sets || (muscle === "Kardio"
    ? [createSet({ reps: 20, weight: 5, rpe: 0 })]
    : [createSet(), createSet(), createSet()]);
  return {
    id: uid(),
    name,
    muscle,
    notes,
    sets: baseSets.map((set) => createSet(set))
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
        visibility: "public",
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

function createNutritionPhase() {
  return {
    title: "",
    mode: "diet",
    goalWeight: "",
    rows: Array.from({ length: DEFAULT_PHASE_WEEKS }, (_, index) => createNutritionPhaseRow(index + 1))
  };
}

function createNutritionPhaseRow(index) {
  return {
    id: uid(),
    weekLabel: `Tyden ${index}`,
    date: "",
    calories: "",
    weight: "",
    note: "",
    photos: [],
    photoOrder: []
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

function normalizeVisibility(value) {
  return value === "private" ? "private" : "public";
}

function findStoredNutritionPhase(nutrition) {
  if (!nutrition || typeof nutrition !== "object") return null;
  return Object.values(nutrition).find((week) => week?.phase)?.phase || null;
}

function normalizeNutritionPhase(phase) {
  const fallback = createNutritionPhase();
  const rows = Array.isArray(phase?.rows) && phase.rows.length ? phase.rows : fallback.rows;
  const normalizedRows = rows.map((row, index) => {
    const photos = normalizePhasePhotos(row.photos);
    const photoOrder = normalizePhotoOrder(row.photoOrder);
    const orderedPhotos = orderPhasePhotos(photos, photoOrder);
    const orderedKeys = orderedPhotos.map(phasePhotoKey);
    return {
      id: row.id || uid(),
      weekLabel: String(row.weekLabel || `Tyden ${index + 1}`),
      date: String(row.date || ""),
      calories: normalizeOptionalNumber(row.calories),
      weight: normalizeOptionalNumber(row.weight),
      note: String(row.note || ""),
      photos: orderedPhotos,
      photoOrder: orderedPhotos.length
        ? normalizePhotoOrder([...photoOrder.filter((key) => orderedKeys.includes(key)), ...orderedKeys])
        : photoOrder
    };
  });
  while (normalizedRows.length < DEFAULT_PHASE_WEEKS) {
    normalizedRows.push(createNutritionPhaseRow(normalizedRows.length + 1));
  }

  return {
    title: String(phase?.title || ""),
    mode: ["diet", "bulk", "maintain"].includes(phase?.mode) ? phase.mode : "diet",
    goalWeight: normalizeOptionalNumber(phase?.goalWeight),
    rows: normalizedRows
  };
}

function normalizePhasePhotos(photos) {
  if (!Array.isArray(photos)) return [];
  return photos
    .filter((photo) => photo?.dataUrl || photo?.url || photo?.storagePath)
    .slice(0, PHASE_PHOTO_LIMIT)
    .map((photo) => ({
      id: photo.id || uid(),
      name: String(photo.name || "Posing photo"),
      addedAt: photo.addedAt || new Date().toISOString(),
      dataUrl: photo.dataUrl ? String(photo.dataUrl) : "",
      url: photo.url ? String(photo.url) : "",
      storagePath: photo.storagePath ? String(photo.storagePath) : "",
      cloudId: photo.cloudId ? String(photo.cloudId) : "",
      phaseRowId: photo.phaseRowId ? String(photo.phaseRowId) : "",
      weekLabel: photo.weekLabel ? String(photo.weekLabel) : "",
      width: toNumber(photo.width, 0),
      height: toNumber(photo.height, 0)
    }));
}

function normalizePhotoOrder(order) {
  if (!Array.isArray(order)) return [];
  const seen = new Set();
  return order
    .map((item) => String(item || ""))
    .filter((key) => {
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, PHASE_PHOTO_LIMIT);
}

function phasePhotoKey(photo) {
  return String(photo?.cloudId || photo?.storagePath || photo?.id || "");
}

function orderPhasePhotos(photos, order) {
  const normalized = normalizePhasePhotos(photos);
  const orderMap = new Map(normalizePhotoOrder(order).map((key, index) => [key, index]));
  return normalized
    .map((photo, index) => {
      const key = phasePhotoKey(photo);
      return {
        photo,
        index,
        order: orderMap.has(key) ? orderMap.get(key) : Number.MAX_SAFE_INTEGER
      };
    })
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map((item) => item.photo)
    .slice(0, PHASE_PHOTO_LIMIT);
}

function syncPhasePhotoOrder(row, keepCurrentOrder = false) {
  if (!row) return;
  const photos = keepCurrentOrder
    ? normalizePhasePhotos(row.photos)
    : orderPhasePhotos(row.photos, row.photoOrder);
  row.photos = photos;
  row.photoOrder = normalizePhotoOrder(photos.map(phasePhotoKey));
}

function stripPhasePhotosForCloud(phase) {
  const normalized = normalizeNutritionPhase(phase);
  return {
    ...normalized,
    rows: normalized.rows.map(({ photos, ...row }) => row)
  };
}

function mergePhasePhotos(targetPhase, sourcePhase) {
  const sourceRows = normalizeNutritionPhase(sourcePhase).rows;
  const rowsById = new Map(sourceRows.map((row) => [row.id, row]));
  const rowsByLabel = new Map(sourceRows.map((row) => [row.weekLabel, row]));
  return {
    ...targetPhase,
    rows: targetPhase.rows.map((row) => {
      const sourceRow = rowsById.get(row.id) || rowsByLabel.get(row.weekLabel);
      const order = normalizePhotoOrder([...normalizePhotoOrder(row.photoOrder), ...normalizePhotoOrder(sourceRow?.photoOrder)]);
      const sourcePhotos = sourceRow?.photos?.length ? sourceRow.photos : row.photos;
      const photos = orderPhasePhotos(normalizePhasePhotos(sourcePhotos), order);
      const photoKeys = photos.map(phasePhotoKey);
      return {
        ...row,
        photos,
        photoOrder: photos.length
          ? normalizePhotoOrder([...order.filter((key) => photoKeys.includes(key)), ...photoKeys])
          : order
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
  const content = !cloud.ready
    ? renderLoadingShell()
    : lockedForAuth
    ? renderAuthShell()
    : cloud.passwordRecovery
      ? renderPasswordResetShell()
    : state.activeView === "profile"
      ? renderProfileShell()
    : state.activeView === "feed"
      ? renderFeedShell()
      : state.activeView === "posts"
        ? renderPostsShell()
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
          <div class="brand-copy">
            <h1>Fit plan <small>by David</small></h1>
            <span class="brand-subtitle">${cloud.configured ? "Training & nutrition cloud" : "Local training tracker"}</span>
          </div>
        </div>
        <div class="center-stack">
          <nav class="view-tabs" aria-label="Hlavni navigace">
            ${renderViewButton("plan", "Plan")}
            ${renderViewButton("nutrition", "Nutrition")}
            ${renderViewButton("feed", "Feed")}
            ${renderViewButton("leaderboard", "Progress")}
            ${renderViewButton("posts", "Posty")}
          </nav>
          <div class="week-switcher" aria-label="Vyber tydne">
            <button class="icon-btn" data-action="prev-week" title="Predchozi tyden" aria-label="Predchozi tyden">&lt;</button>
            <div class="week-label">
              <strong>${weekRangeLabel(state.weekStart)}</strong>
              <span ${state.activeView === "nutrition" ? `data-nutrition-summary="header"` : ""}>${state.activeView === "nutrition" ? `${formatNumber(nutritionSummary.totalCalories)}/${formatNumber(nutrition.goals.weeklyCalories)} kcal` : `${summary.completed}/${summary.totalSets} serii hotovo`}</span>
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
            <button class="btn" data-action="open-copy-day-dialog">Kopirovat</button>
            <button class="btn warn" data-action="sample-week">Ukazkovy plan</button>
          ` : ""}
        </div>
      </header>
      ${content}
      ${renderCopyDayDialog()}
      ${renderPhasePhotoViewer()}
      ${renderPhaseCompareViewer()}
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
  return `<button class="cloud-badge local" data-action="retry-cloud" title="Zkusit znovu nacist cloud">Local</button>`;
}

function renderCopyDayDialog() {
  if (!copyDayDialogOpen) return "";
  const sourceDate = getSelectedDate();
  const targetDate = addDays(sourceDate, 1);
  const sourceDay = ensureWeek()[state.selectedDay];
  return `
    <div class="copy-dialog" role="dialog" aria-modal="true" aria-label="Kopirovat trening">
      <button class="copy-dialog-backdrop" type="button" data-action="close-copy-day-dialog" aria-label="Zavrit"></button>
      <form class="copy-dialog-panel" data-copy-day-form>
        <div class="copy-dialog-head">
          <div>
            <p class="eyebrow">Kopirovani</p>
            <h2>Kopirovat trening</h2>
            <p class="auth-copy">Vyber zdrojovy den a datum, kam se ma trening zkopirovat. Prepisuje se jen cilovy den.</p>
          </div>
          <button class="icon-btn" type="button" data-action="close-copy-day-dialog" title="Zavrit" aria-label="Zavrit">x</button>
        </div>
        <div class="copy-dialog-summary">
          <strong>${escapeHtml(sourceDay.title || "Vybrany den")}</strong>
          <span>${escapeHtml(DAY_LABELS[state.selectedDay][1])} ${escapeHtml(formatShortDate(sourceDate))} - ${sourceDay.exercises.length} cviku</span>
        </div>
        <div class="copy-dialog-grid">
          <label class="field">
            <span>Zkopirovat z data</span>
            <input class="input" type="date" name="sourceDate" value="${escapeAttr(toDateInput(sourceDate))}" required>
          </label>
          <label class="field">
            <span>Zkopirovat na datum</span>
            <input class="input" type="date" name="targetDate" value="${escapeAttr(toDateInput(targetDate))}" required>
          </label>
        </div>
        <div class="copy-dialog-actions">
          <button class="btn" type="button" data-action="close-copy-day-dialog">Zrusit</button>
          <button class="btn primary" type="submit">Kopirovat trening</button>
        </div>
      </form>
    </div>
  `;
}

function renderLoadingShell() {
  return `
    <main class="auth-shell">
      <section class="auth-panel profile-panel">
        <div>
          <p class="eyebrow">Fit plan by David</p>
          <h2>Nacitam spravny ucet</h2>
          <p class="auth-copy">Chvilku kontroluju prihlaseni a oddeluju data podle uctu.</p>
        </div>
      </section>
    </main>
  `;
}

function renderAuthShell() {
  return `
    <main class="auth-shell">
      <section class="auth-panel">
        <div>
          <p class="eyebrow">Fit plan by David</p>
          <h2>Train, eat and track progress in one place</h2>
          <p class="auth-copy">Sync workouts, calories, macros and bodyweight across devices. Share public sessions, post updates and track weekly progress with your crew.</p>
        </div>
        ${renderAuthNotice()}
        <div class="auth-grid">
          <form class="auth-card" data-auth-form="sign-in">
            <h3>Prihlasit</h3>
            <input class="input" name="email" type="email" autocomplete="email" placeholder="Email" required>
            <input class="input" name="password" type="password" autocomplete="current-password" placeholder="Heslo" required>
            <button class="btn primary" type="submit">Prihlasit</button>
            <button class="text-btn" type="button" data-action="forgot-password">Zapomenute heslo?</button>
          </form>
          <form class="auth-card" data-auth-form="sign-up">
            <h3>Registrace</h3>
            <p class="microcopy">Po registraci ti prijde overovaci e-mail. Otevri ho, potvrd ucet a potom se prihlas.</p>
            <input class="input" name="email" type="email" autocomplete="email" placeholder="Email" required>
            <input class="input" name="password" type="password" autocomplete="new-password" minlength="6" placeholder="Heslo min. 6 znaku" required>
            <button class="btn primary" type="submit">Vytvorit ucet</button>
          </form>
        </div>
      </section>
    </main>
  `;
}

function renderAuthNotice() {
  if (!cloud.authNotice) {
    return `
      <div class="auth-notice">
        <strong>Registrace je pres e-mail.</strong>
        <span>Po vytvoreni uctu prijde potvrzovaci odkaz. Bez potvrzeni se ucet nemusi pustit do appky.</span>
      </div>
    `;
  }

  return `
    <div class="auth-notice ${cloud.authNotice.type || ""}">
      <strong>${escapeHtml(cloud.authNotice.title)}</strong>
      <span>${escapeHtml(cloud.authNotice.text)}</span>
      ${cloud.pendingEmail ? `<button class="btn" data-action="resend-confirmation">Poslat e-mail znovu</button>` : ""}
    </div>
  `;
}

function renderPasswordResetShell() {
  return `
    <main class="auth-shell">
      <section class="auth-panel profile-panel">
        <div>
          <p class="eyebrow">Password reset</p>
          <h2>Nastav nove heslo</h2>
          <p class="auth-copy">Po ulozeni se normalne vratis do appky a muzes se prihlasovat novym heslem.</p>
        </div>
        <form class="auth-card profile-card" data-reset-password-form>
          <label class="field">
            <span>Nove heslo</span>
            <input class="input" name="password" type="password" autocomplete="new-password" minlength="6" placeholder="Min. 6 znaku" required>
          </label>
          <button class="btn primary" type="submit">Ulozit nove heslo</button>
        </form>
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
          <p class="auth-copy">Tohle jmeno se ukazuje nahore v appce, ve feedu, postech a progressu.</p>
        </div>
        <form class="auth-card profile-card" data-profile-form>
          <label class="field">
            <span>Jmeno / prezdivka</span>
            <input class="input" name="display_name" value="${escapeAttr(profileName())}" placeholder="Treba David" maxlength="40" required>
          </label>
          <button class="btn primary" type="submit">Ulozit profil</button>
        </form>
        <div class="auth-card profile-card danger-zone">
          <div>
            <h3>Vymazat data uctu</h3>
            <p class="microcopy">Smaze jen tvoje workouty a nutrition data v cloudu i na tomhle zarizeni. Profil a prihlaseni zustanou.</p>
          </div>
          <button class="btn danger" data-action="reset-account-data">Vymazat moje data</button>
        </div>
      </section>
    </main>
  `;
}

function renderFeedShell() {
  const feedDate = getSelectedDate();
  const isToday = toDateInput(feedDate) === toDateInput(new Date());
  const heading = isToday
    ? "Co se jelo dneska"
    : `Co se jelo ${DAY_LABELS[state.selectedDay][1]} ${formatShortDate(feedDate)}`;
  const feedRows = getSelectedFeedRows();
  return `
    <main class="social-shell">
      <section class="social-main">
        <div class="social-head">
          <div>
            <p class="eyebrow">Community feed</p>
            <h2>${escapeHtml(heading)}</h2>
            <p class="auth-copy">Public treninky jen pro vybrany den. Sipkami muzes koukat zpet i dopredu.</p>
          </div>
          <div class="feed-day-controls" aria-label="Vyber dne feedu">
            <button class="icon-btn" data-action="prev-feed-day" title="Predchozi den" aria-label="Predchozi den">&lt;</button>
            <div class="feed-day-label">
              <strong>${DAY_LABELS[state.selectedDay][1]}</strong>
              <span>${formatShortDate(feedDate)}</span>
            </div>
            <button class="icon-btn" data-action="next-feed-day" title="Dalsi den" aria-label="Dalsi den">&gt;</button>
            <button class="btn" data-action="today">Dnes</button>
            <button class="btn" data-action="refresh-social">Refresh</button>
          </div>
        </div>
        ${renderCloudSetupNotice()}
        <div class="feed-list">
          ${feedRows.length ? feedRows.map(renderFeedCard).join("") : renderSocialEmpty("Pro tenhle den tu zatim neni zadny public trening.")}
        </div>
      </section>
    </main>
  `;
}

function renderPostsShell() {
  const posts = cloud.posts || [];
  return `
    <main class="social-shell">
      <section class="social-main">
        <div class="social-head">
          <div>
            <p class="eyebrow">Posty</p>
            <h2>Komunitni zed</h2>
            <p class="auth-copy">Rychle zpravy a fotky pro vybrany tyden ${escapeHtml(weekRangeLabel(state.weekStart))}.</p>
          </div>
          <button class="btn" data-action="refresh-social">Refresh</button>
        </div>
        ${renderCloudSetupNotice()}
        ${cloud.session ? renderPostComposer() : ""}
        <div class="post-list">
          ${posts.length ? posts.map(renderPostCard).join("") : renderSocialEmpty("Tenhle tyden tu zatim nejsou zadne posty.", "Napis prvni update pro partu, klidne jen text nebo fotku.")}
        </div>
      </section>
    </main>
  `;
}

function renderPostComposer() {
  return `
    <form class="post-composer" data-post-form>
      <label class="field">
        <span>Novy post</span>
        <textarea class="input post-textarea" name="body" rows="3" maxlength="700" placeholder="Co chces poslat parte?"></textarea>
      </label>
      <div class="post-composer-actions">
        <label class="post-file-field">
          <input type="file" name="image" accept="image/*" data-field="post-image">
          <span>+ Fotka</span>
        </label>
        <button class="btn primary" type="submit">Pridat post</button>
      </div>
      <div class="post-preview" data-post-preview ${postComposerPreviewUrl ? "" : "hidden"}>
        ${postComposerPreviewUrl ? renderPostPreviewMarkup() : ""}
      </div>
    </form>
  `;
}

function renderPostPreviewMarkup() {
  return `
    <div class="post-preview-head">
      <strong>Vybrana fotka</strong>
      <button class="icon-btn danger" type="button" data-action="clear-post-image" title="Odebrat fotku" aria-label="Odebrat fotku">x</button>
    </div>
    <img src="${escapeAttr(postComposerPreviewUrl)}" alt="${escapeAttr(postComposerImageFile?.name || "Nahled fotky")}">
  `;
}

function renderPostCard(post) {
  const profile = post.profile || {};
  const name = profile.display_name || profile.username || post.authorName || "Sportovec";
  const isOwn = post.user_id === cloud.session?.user?.id;
  return `
    <article class="post-card">
      <div class="post-head">
        <div>
          <strong>${escapeHtml(name)}</strong>
          <span>${escapeHtml(formatCloudDate(post.created_at))}</span>
        </div>
        ${isOwn ? `<button class="icon-btn danger" data-action="delete-community-post" data-post-id="${escapeAttr(post.id)}" title="Smazat post" aria-label="Smazat post">x</button>` : ""}
      </div>
      ${post.body ? `<p>${escapeHtml(post.body)}</p>` : ""}
      ${post.imageUrl ? `
        <button class="post-image" type="button" data-action="open-community-post-image" data-post-id="${escapeAttr(post.id)}" title="Otevrit fotku" aria-label="Otevrit fotku">
          <img src="${escapeAttr(post.imageUrl)}" alt="${escapeAttr(post.imageName || "Post fotka")}">
        </button>
      ` : ""}
    </article>
  `;
}

function renderLeaderboardShell() {
  return `
    <main class="social-shell">
      <section class="social-main">
        <div class="social-head">
          <div>
            <p class="eyebrow">Progress</p>
            <h2>Tydenni progress</h2>
            <p class="auth-copy">Rozklikni sportovce a uvidis jeho public treninky a makra pro vybrany tyden. Zobrazuji se vsichni registrovani uzivatele.</p>
          </div>
          <button class="btn" data-action="refresh-social">Refresh</button>
        </div>
        ${renderCloudSetupNotice()}
        <div class="leaderboard">
          ${cloud.leaderboard.length ? cloud.leaderboard.map(renderLeaderboardRow).join("") : renderSocialEmpty("Progress se naplni po registraci uzivatelu.", "Jakmile nekdo zapise makra nebo public trening, uvidis ho tady.")}
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
          <div class="nutrition-actions">
            <button class="btn" data-action="copy-nutrition-prev-week">Copy last week</button>
            <button class="btn danger" data-action="reset-nutrition-data">Vycistit nutrition</button>
          </div>
        </div>
        <div class="nutrition-metrics">
          <div class="metric hero-metric"><strong data-nutrition-summary="totalCalories">${formatNumber(summary.totalCalories)}</strong><span>Current kcal</span></div>
          <div class="metric"><strong data-nutrition-summary="remainingCalories">${formatNumber(summary.remainingCalories)}</strong><span>Remaining weekly kcal</span></div>
          <div class="metric"><strong data-nutrition-summary="averageCalories">${formatNumber(summary.averageCalories)}</strong><span>Daily average</span></div>
          <div class="metric"><strong data-nutrition-summary="daysLogged">${summary.daysLogged}/7</strong><span>Days logged</span></div>
        </div>
        <div class="nutrition-progress">
          <span data-nutrition-progress style="--value:${summary.progress}%"></span>
        </div>
        <div class="nutrition-grid">
          <section class="nutrition-card">
            <div class="section-row">
              <h3>Weekly targets</h3>
              <span class="pill" data-nutrition-summary="progress">${summary.progress}%</span>
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
              <span class="pill done" data-nutrition-summary="macroTotals">${formatNumber(summary.totalProtein)}P / ${formatNumber(summary.totalCarbs)}C / ${formatNumber(summary.totalFat)}F</span>
            </div>
            <div class="macro-bars">
              ${renderMacroBar("Protein", "protein", summary.totalProtein, nutrition.goals.protein * 7)}
              ${renderMacroBar("Carbs", "carbs", summary.totalCarbs, nutrition.goals.carbs * 7)}
              ${renderMacroBar("Fat", "fat", summary.totalFat, nutrition.goals.fat * 7)}
            </div>
          </section>
        </div>
        <section class="nutrition-card">
          <div class="section-row">
            <h3>Daily log</h3>
            <span class="microcopy">Calories, macros, bodyweight and quick notes</span>
          </div>
          <div class="nutrition-day-cards">
            ${renderNutritionDayPager(nutrition)}
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
        <section class="nutrition-card phase-card">
          <div class="section-row">
            <div>
              <h3>Diet / bulk progress</h3>
              <span class="microcopy">Weekly bodyweight log for a cut, bulk or maintenance phase</span>
            </div>
            <button class="btn primary" data-action="add-phase-row">+ Week</button>
          </div>
          ${renderNutritionPhase(state.nutritionPhase)}
        </section>
      </section>
    </main>
  `;
}

function renderNutritionDayPager(nutrition) {
  const dayIndex = Math.max(0, Math.min(6, state.selectedDay));
  const day = nutrition.days[dayIndex] || createNutritionWeek().days[dayIndex];
  const date = addDays(parseDate(state.weekStart), dayIndex);
  return `
    <div class="nutrition-day-pager">
      <div class="nutrition-day-switcher">
        <button class="icon-btn" data-action="prev-nutrition-day" title="Predchozi den" aria-label="Predchozi den">&lt;</button>
        <div class="nutrition-day-current">
          <strong>${DAY_LABELS[dayIndex][1]}</strong>
          <span>${formatShortDate(date)}</span>
        </div>
        <button class="icon-btn" data-action="next-nutrition-day" title="Dalsi den" aria-label="Dalsi den">&gt;</button>
      </div>
      <div class="nutrition-day-tabs" aria-label="Vyber dne">
        ${DAY_LABELS.map((label, index) => `
          <button class="nutrition-day-tab${index === dayIndex ? " active" : ""}" data-action="select-nutrition-day" data-day="${index}">
            ${label[0]}
          </button>
        `).join("")}
      </div>
      ${renderNutritionDayCard(day, dayIndex)}
    </div>
  `;
}

function renderNutritionPhase(phase) {
  const summary = summarizeNutritionPhase(phase);
  return `
    <div class="phase-settings">
      <label class="field">
        <span>Nazev faze</span>
        <input class="input" data-field="nutrition-phase" data-phase="title" value="${escapeAttr(phase.title)}" placeholder="Treba Dieta leto">
      </label>
      <label class="field">
        <span>Rezim</span>
        <select class="select" data-field="nutrition-phase" data-phase="mode">
          ${renderPhaseModeOptions(phase.mode)}
        </select>
      </label>
      <label class="field">
        <span>Goal vaha</span>
        <input class="input" type="number" min="0" step="0.1" data-field="nutrition-phase" data-phase="goalWeight" value="${escapeAttr(phase.goalWeight)}" placeholder="74">
      </label>
    </div>
    <div class="phase-summary">
      <div><strong>${summary.latestWeight === null ? "-" : `${formatNumber(summary.latestWeight)} kg`}</strong><span>Aktualni vaha</span></div>
      <div><strong>${summary.change === null ? "-" : `${summary.change > 0 ? "+" : ""}${formatNumber(summary.change)} kg`}</strong><span>Zmena od startu</span></div>
      <div><strong>${summary.goalGap === null ? "-" : `${summary.goalGap > 0 ? "+" : ""}${formatNumber(summary.goalGap)} kg`}</strong><span>Od goalu</span></div>
    </div>
    <div class="phase-list">
      <div class="phase-row phase-row-head">
        <span>Tyden</span>
        <span>Datum</span>
        <span>Kcal</span>
        <span>Vaha</span>
        <span>Poznamka</span>
        <span></span>
      </div>
      ${phase.rows.map((row) => renderNutritionPhaseRow(row)).join("")}
    </div>
    ${renderPhaseCompare(phase)}
  `;
}

function renderPhaseModeOptions(selected) {
  const modes = [
    ["diet", "Dieta"],
    ["bulk", "Objem"],
    ["maintain", "Udrzba"]
  ];
  return modes.map(([value, label]) => (
    `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`
  )).join("");
}

function renderPhaseCompare(phase) {
  const rowsWithPhotos = phaseRowsWithPhotos(phase);
  if (!rowsWithPhotos.length) {
    return `
      <div class="phase-compare empty">
        <div>
          <strong>Compare formy</strong>
          <span class="microcopy">Nahraj fotky do vice tydnu a appka je porovna podle poradi.</span>
        </div>
      </div>
    `;
  }

  const selection = resolvePhaseCompare(rowsWithPhotos);
  const fromPhoto = selection.fromRow?.photos[selection.slotIndex] || null;
  const toPhoto = selection.toRow?.photos[selection.slotIndex] || null;
  const maxSlots = Math.max(selection.fromRow?.photos.length || 0, selection.toRow?.photos.length || 0, 1);
  return `
    <div class="phase-compare">
      <div class="phase-compare-head">
        <div>
          <strong>Compare formy</strong>
          <span class="microcopy">Vyber dva tydny a porovnej stejnou pozici fotky vedle sebe.</span>
        </div>
      </div>
      <div class="phase-compare-controls">
        <label class="field">
          <span>Od</span>
          <select class="select" data-field="phase-compare" data-compare="fromRowId">
            ${renderCompareRowOptions(rowsWithPhotos, selection.fromRow?.id)}
          </select>
        </label>
        <label class="field">
          <span>Do</span>
          <select class="select" data-field="phase-compare" data-compare="toRowId">
            ${renderCompareRowOptions(rowsWithPhotos, selection.toRow?.id)}
          </select>
        </label>
        <label class="field">
          <span>Pozice</span>
          <select class="select" data-field="phase-compare" data-compare="slotIndex">
            ${Array.from({ length: maxSlots }, (_, index) => (
              `<option value="${index}" ${index === selection.slotIndex ? "selected" : ""}>Pozice ${index + 1}</option>`
            )).join("")}
          </select>
        </label>
      </div>
      <div class="phase-compare-slots">
        <button class="icon-btn" type="button" data-action="move-compare-slot" data-direction="-1" title="Predchozi pozice" aria-label="Predchozi pozice">&lt;</button>
        <strong>Pozice ${selection.slotIndex + 1}/${maxSlots}</strong>
        <button class="icon-btn" type="button" data-action="move-compare-slot" data-direction="1" title="Dalsi pozice" aria-label="Dalsi pozice">&gt;</button>
      </div>
      ${renderPhaseCompareSide(selection.fromRow, fromPhoto, selection.toRow, toPhoto)}
      <div class="phase-compare-actions">
        <button class="btn" type="button" data-action="open-phase-compare-viewer" ${!fromPhoto || !toPhoto ? "disabled" : ""}>Otevrit velky compare se zoomem</button>
      </div>
    </div>
  `;
}

function phaseRowsWithPhotos(phase = state.nutritionPhase) {
  return phase.rows
    .map((row) => ({ ...row, photos: orderPhasePhotos(row.photos, row.photoOrder) }))
    .filter((row) => row.photos.length);
}

function resolvePhaseCompare(rowsWithPhotos) {
  const first = rowsWithPhotos[0];
  const last = rowsWithPhotos.at(-1) || first;
  const fromRow = rowsWithPhotos.find((row) => row.id === phaseCompare.fromRowId) || first;
  const toRow = rowsWithPhotos.find((row) => row.id === phaseCompare.toRowId) || (last.id !== fromRow.id ? last : first);
  const maxSlots = Math.max(fromRow?.photos.length || 0, toRow?.photos.length || 0, 1);
  const slotIndex = Math.max(0, Math.min(maxSlots - 1, Number(phaseCompare.slotIndex) || 0));
  phaseCompare = {
    ...phaseCompare,
    fromRowId: fromRow?.id || "",
    toRowId: toRow?.id || "",
    slotIndex
  };
  return { fromRow, toRow, slotIndex };
}

function renderCompareRowOptions(rows, selectedId) {
  return rows.map((row) => (
    `<option value="${escapeAttr(row.id)}" ${row.id === selectedId ? "selected" : ""}>${escapeHtml(compareRowLabel(row))}</option>`
  )).join("");
}

function compareRowLabel(row) {
  return `${row.weekLabel || "Tyden"}${row.date ? ` - ${formatDateForDisplay(row.date)}` : ""} (${row.photos.length})`;
}

function renderPhaseCompareSide(fromRow, fromPhoto, toRow, toPhoto) {
  return `
    <div class="phase-compare-stage side">
      ${renderComparePhotoPanel("Od", fromRow, fromPhoto)}
      ${renderComparePhotoPanel("Do", toRow, toPhoto)}
    </div>
  `;
}

function renderComparePhotoPanel(label, row, photo) {
  return `
    <div class="compare-photo-panel">
      <div class="compare-photo-head">
        <span>${label}</span>
        <strong>${escapeHtml(compareRowLabel(row))}</strong>
      </div>
      ${photo ? `
        <img src="${escapeAttr(phasePhotoSource(photo))}" alt="${escapeAttr(photo.name)}">
      ` : `
        <div class="compare-photo-empty">Tahle pozice tady chybi.</div>
      `}
    </div>
  `;
}

function renderPhaseCompareViewer() {
  if (!phaseCompareViewer) return "";
  const rowsWithPhotos = phaseRowsWithPhotos();
  if (!rowsWithPhotos.length) return "";
  const selection = resolvePhaseCompareViewer(rowsWithPhotos);
  if (!selection.fromRow || !selection.toRow) return "";
  const fromPhoto = selection.fromRow.photos[selection.slotIndex] || null;
  const toPhoto = selection.toRow.photos[selection.slotIndex] || null;
  const zoom = selection.zoom;
  return `
    <div class="compare-viewer" role="dialog" aria-modal="true" aria-label="Velky compare formy">
      <button class="compare-viewer-backdrop" data-action="close-phase-compare-viewer" aria-label="Zavrit compare"></button>
      <div class="compare-viewer-panel" style="--compare-zoom: ${zoom}%;">
        <div class="compare-viewer-head">
          <div>
            <strong>Velky compare formy</strong>
            <span>${escapeHtml(compareRowLabel(selection.fromRow))} vs ${escapeHtml(compareRowLabel(selection.toRow))}</span>
          </div>
          <button class="icon-btn" data-action="close-phase-compare-viewer" title="Zavrit" aria-label="Zavrit">x</button>
        </div>
        <div class="compare-viewer-toolbar">
          <div class="compare-viewer-slot-nav">
            <button class="icon-btn" type="button" data-action="prev-phase-compare-viewer" title="Predchozi pozice" aria-label="Predchozi pozice">&lt;</button>
            <strong>Pozice ${selection.slotIndex + 1}/${selection.maxSlots}</strong>
            <button class="icon-btn" type="button" data-action="next-phase-compare-viewer" title="Dalsi pozice" aria-label="Dalsi pozice">&gt;</button>
          </div>
          <div class="compare-viewer-zoom">
            <button class="icon-btn" type="button" data-action="zoom-phase-compare-viewer" data-direction="-25" title="Oddalit" aria-label="Oddalit">-</button>
            <input type="range" min="75" max="250" step="25" value="${zoom}" data-field="phase-compare-zoom" aria-label="Zoom compare fotek">
            <span>${zoom}%</span>
            <button class="icon-btn" type="button" data-action="zoom-phase-compare-viewer" data-direction="25" title="Priblizit" aria-label="Priblizit">+</button>
            <button class="btn compact" type="button" data-action="reset-phase-compare-zoom">100%</button>
          </div>
        </div>
        <div class="compare-viewer-stage">
          ${renderCompareViewerPhotoPanel("Od", selection.fromRow, fromPhoto)}
          ${renderCompareViewerPhotoPanel("Do", selection.toRow, toPhoto)}
        </div>
      </div>
    </div>
  `;
}

function resolvePhaseCompareViewer(rowsWithPhotos) {
  const first = rowsWithPhotos[0];
  const last = rowsWithPhotos.at(-1) || first;
  const fromRow = rowsWithPhotos.find((row) => row.id === phaseCompareViewer.fromRowId) || first;
  const toRow = rowsWithPhotos.find((row) => row.id === phaseCompareViewer.toRowId) || (last.id !== fromRow.id ? last : first);
  const maxSlots = Math.max(fromRow?.photos.length || 0, toRow?.photos.length || 0, 1);
  const slotIndex = Math.max(0, Math.min(maxSlots - 1, Number(phaseCompareViewer.slotIndex) || 0));
  const zoom = Math.max(75, Math.min(250, Number(phaseCompareViewer.zoom) || 100));
  phaseCompareViewer = {
    fromRowId: fromRow?.id || "",
    toRowId: toRow?.id || "",
    slotIndex,
    zoom
  };
  return { fromRow, toRow, slotIndex, maxSlots, zoom };
}

function renderCompareViewerPhotoPanel(label, row, photo) {
  return `
    <section class="compare-viewer-photo">
      <div class="compare-viewer-photo-head">
        <span>${label}</span>
        <strong>${escapeHtml(compareRowLabel(row))}</strong>
      </div>
      <div class="compare-viewer-photo-frame">
        ${photo ? `
          <img src="${escapeAttr(phasePhotoSource(photo))}" alt="${escapeAttr(photo.name)}">
        ` : `
          <div class="compare-photo-empty">Tahle pozice tady chybi.</div>
        `}
      </div>
    </section>
  `;
}

function renderNutritionPhaseRow(row) {
  const photos = orderPhasePhotos(row.photos, row.photoOrder);
  const isPhotoPanelOpen = openPhasePhotoRows.has(row.id);
  const photoStorageText = cloud.session
    ? "Fotky se ukladaji do Supabase a uvidis je i na dalsim zarizeni."
    : "Bez prihlaseni zustanou fotky jen na tomhle zarizeni.";
  return `
    <div class="phase-entry">
      <div class="phase-row">
        <label class="phase-row-field">
          <span>Tyden</span>
          <input class="input" data-field="nutrition-phase-row" data-row-id="${row.id}" data-phase-row="weekLabel" value="${escapeAttr(row.weekLabel)}" placeholder="Tyden">
        </label>
        <label class="phase-row-field">
          <span>Datum</span>
          <input class="input" type="date" data-field="nutrition-phase-row" data-row-id="${row.id}" data-phase-row="date" value="${escapeAttr(row.date)}">
        </label>
        <label class="phase-row-field">
          <span>Kcal</span>
          <input class="input" type="number" min="0" step="50" data-field="nutrition-phase-row" data-row-id="${row.id}" data-phase-row="calories" value="${escapeAttr(row.calories)}" placeholder="2300">
        </label>
        <label class="phase-row-field">
          <span>Vaha</span>
          <input class="input" type="number" min="0" step="0.1" data-field="nutrition-phase-row" data-row-id="${row.id}" data-phase-row="weight" value="${escapeAttr(row.weight)}" placeholder="85.5">
        </label>
        <label class="phase-row-field">
          <span>Poznamka</span>
          <input class="input" data-field="nutrition-phase-row" data-row-id="${row.id}" data-phase-row="note" value="${escapeAttr(row.note)}" placeholder="Poznamka">
        </label>
        <button class="icon-btn danger" data-action="remove-phase-row" data-row-id="${row.id}" title="Smazat tyden" aria-label="Smazat tyden">x</button>
      </div>
      <details class="phase-photo-panel" data-row-id="${row.id}" ${isPhotoPanelOpen ? "open" : ""}>
        <summary>
          <span>Fotky formy</span>
          <strong>${photos.length ? `${photos.length}x` : "+"}</strong>
        </summary>
        <div class="phase-photo-tools">
          <button class="btn compact" type="button" data-action="add-phase-photo" data-row-id="${row.id}">+ Fotky</button>
          <span class="microcopy">${photoStorageText}</span>
        </div>
        ${photos.length ? `
          <div class="phase-photo-grid">
            ${photos.map((photo, index) => renderPhasePhoto(row.id, photo, index, photos.length)).join("")}
          </div>
        ` : `
          <div class="phase-photo-empty">Rozklikni tyden a pridej fotku pro porovnani formy.</div>
        `}
      </details>
    </div>
  `;
}

function renderPhasePhoto(rowId, photo, index, total) {
  const src = phasePhotoSource(photo);
  return `
    <figure class="phase-photo-card" data-phase-photo-card data-row-id="${rowId}" data-photo-id="${photo.id}">
      <div class="phase-photo-order">
        <button class="photo-drag-handle" type="button" data-drag-phase-photo-id="${photo.id}" data-row-id="${rowId}" title="Pretahnout fotku" aria-label="Pretahnout fotku">
          <span>${index + 1}</span>
        </button>
        <div class="photo-move-controls">
          <button class="icon-btn photo-mini-move" type="button" data-action="move-phase-photo" data-row-id="${rowId}" data-photo-id="${photo.id}" data-direction="-1" title="Posunout fotku zpet" aria-label="Posunout fotku zpet" ${index === 0 ? "disabled" : ""}>&lt;</button>
          <button class="icon-btn photo-mini-move" type="button" data-action="move-phase-photo" data-row-id="${rowId}" data-photo-id="${photo.id}" data-direction="1" title="Posunout fotku dopredu" aria-label="Posunout fotku dopredu" ${index >= total - 1 ? "disabled" : ""}>&gt;</button>
        </div>
      </div>
      <button class="phase-photo-thumb" type="button" data-action="open-phase-photo" data-row-id="${rowId}" data-photo-id="${photo.id}" title="Otevrit fotku" aria-label="Otevrit fotku">
        <img src="${escapeAttr(src)}" alt="${escapeAttr(photo.name)}">
      </button>
      <figcaption>
        <span>${escapeHtml(formatPhotoDate(photo.addedAt))}</span>
        <button class="icon-btn danger" type="button" data-action="remove-phase-photo" data-row-id="${rowId}" data-photo-id="${photo.id}" title="Smazat fotku" aria-label="Smazat fotku">x</button>
      </figcaption>
    </figure>
  `;
}

function phasePhotoSource(photo) {
  return photo?.dataUrl || photo?.url || "";
}

function renderPhasePhotoViewer() {
  if (!phasePhotoViewer) return "";
  const row = findNutritionPhaseRow(phasePhotoViewer.rowId);
  const photos = orderPhasePhotos(row?.photos, row?.photoOrder);
  const index = photos.findIndex((photo) => photo.id === phasePhotoViewer.photoId);
  if (!row || index < 0) return "";
  const photo = photos[index];
  const src = phasePhotoSource(photo);
  return `
    <div class="photo-viewer" role="dialog" aria-modal="true" aria-label="Posing fotka">
      <button class="photo-viewer-backdrop" data-action="close-phase-photo" aria-label="Zavrit galerii"></button>
      <div class="photo-viewer-panel">
        <div class="photo-viewer-head">
          <div>
            <strong>${escapeHtml(row.weekLabel || "Tyden")}</strong>
            <span>${index + 1}/${photos.length} - ${escapeHtml(formatPhotoDate(photo.addedAt))}</span>
          </div>
          <button class="icon-btn" data-action="close-phase-photo" title="Zavrit" aria-label="Zavrit">x</button>
        </div>
        <div class="photo-viewer-stage">
          <button class="icon-btn photo-nav" data-action="prev-phase-photo" title="Predchozi fotka" aria-label="Predchozi fotka" ${photos.length <= 1 ? "disabled" : ""}>&lt;</button>
          <img src="${escapeAttr(src)}" alt="${escapeAttr(photo.name)}">
          <button class="icon-btn photo-nav" data-action="next-phase-photo" title="Dalsi fotka" aria-label="Dalsi fotka" ${photos.length <= 1 ? "disabled" : ""}>&gt;</button>
        </div>
      </div>
    </div>
  `;
}

function renderNutritionDayCard(day, index) {
  const date = addDays(parseDate(state.weekStart), index);
  return `
    <article class="nutrition-day-card">
      <div class="nutrition-day-card-head">
        <div class="nutrition-day-title">
          <strong>${DAY_LABELS[index][1]}</strong>
          <span>${formatShortDate(date)}</span>
        </div>
        ${renderNutritionCardInput(index, "calories", "Kcal", day.calories, 10)}
      </div>
      <div class="nutrition-day-grid">
        ${renderNutritionCardInput(index, "protein", "Protein", day.protein, 1)}
        ${renderNutritionCardInput(index, "carbs", "Carbs", day.carbs, 1)}
        ${renderNutritionCardInput(index, "fat", "Fat", day.fat, 1)}
        ${renderNutritionCardInput(index, "weight", "Vaha", day.weight, 0.1)}
      </div>
      <label class="field">
        <span>Poznamka</span>
        <input class="input" data-field="nutrition-day" data-day="${index}" data-nutrition="notes" value="${escapeAttr(day.notes)}" placeholder="Meal note">
      </label>
    </article>
  `;
}

function renderNutritionCardInput(dayIndex, field, label, value, step) {
  return `
    <label class="field">
      <span>${label}</span>
      <input class="input" type="number" min="0" step="${step}" data-field="nutrition-day" data-day="${dayIndex}" data-nutrition="${field}" value="${escapeAttr(value)}">
    </label>
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

function renderMacroBar(label, key, value, goal) {
  const percent = goal ? Math.min(100, Math.round((value / goal) * 100)) : 0;
  return `
    <div class="macro-row" data-macro-row="${key}">
      <div>
        <strong>${label}</strong>
        <span data-macro-text>${formatNumber(value)} / ${formatNumber(goal)} g</span>
      </div>
      <div class="progress"><span data-macro-progress style="--value:${percent}%"></span></div>
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

function renderSocialEmpty(message, detail = "U treningu nastav viditelnost na Public a po ulozeni se objevi tady.") {
  return `
    <div class="empty social-empty">
      <div>
        <strong>${escapeHtml(message)}</strong>
        <div class="microcopy">${escapeHtml(detail)}</div>
      </div>
    </div>
  `;
}

function renderFeedCard(row) {
  const profile = row.profile || {};
  const dayLabel = DAY_LABELS[row.day_index]?.[1] || "Den";
  const workoutDate = addDays(parseDate(row.week_start), Number(row.day_index) || 0);
  const title = row.title || dayLabel;
  const exercises = row.payload?.exercises || [];
  return `
    <details class="feed-card">
      <summary class="feed-summary">
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
          <span>${escapeHtml(formatShortDate(workoutDate))}</span>
        </div>
        ${renderFeedExercises(exercises)}
        <span class="feed-detail-toggle">Rozkliknout detail</span>
      </summary>
      ${renderFeedWorkoutDetails(exercises)}
    </details>
  `;
}

function renderFeedExercises(exercises) {
  if (!exercises.length) return "";
  return `
    <div class="feed-exercises">
      ${exercises.map((exercise) => `
        <span>${escapeHtml(exercise.name)} - ${exercise.sets?.length || 0}x</span>
      `).join("")}
    </div>
  `;
}

function renderFeedWorkoutDetails(exercises) {
  if (!exercises.length) {
    return `<div class="feed-detail microcopy">Detail cviku u tohohle treningu neni ulozeny.</div>`;
  }

  return `
    <div class="feed-detail">
      ${exercises.map((exercise, index) => renderFeedExerciseDetail(exercise, index)).join("")}
    </div>
  `;
}

function renderFeedExerciseDetail(exercise, index) {
  const sets = Array.isArray(exercise.sets) ? exercise.sets : [];
  const completed = sets.filter((set) => set.done).length;
  const volume = summarizeExerciseVolume(exercise);
  const cardioDuration = summarizeCardioDuration(exercise);
  const isCardio = isCardioExercise(exercise);
  return `
    <div class="feed-exercise-detail">
      <div class="feed-exercise-head">
        <div>
          <span>Cvik ${index + 1}</span>
          <strong>${escapeHtml(exercise.name || "Cvik")}</strong>
          <small>${escapeHtml(exercise.muscle || "Full body")}</small>
        </div>
        <span class="pill">${isCardio ? `${completed}/${sets.length} useku - ${formatNumber(cardioDuration)} min` : `${completed}/${sets.length} serii - ${formatNumber(volume)} kg`}</span>
      </div>
      ${renderFeedSetTable(exercise)}
      ${exercise.notes ? `<p class="feed-note">${escapeHtml(exercise.notes)}</p>` : ""}
    </div>
  `;
}

function renderFeedSetTable(exercise) {
  const sets = Array.isArray(exercise.sets) ? exercise.sets : [];
  const labels = setMetricLabels(exercise);
  if (!sets.length) return `<div class="microcopy">Bez serii.</div>`;
  return `
    <div class="feed-set-wrap">
      <table class="feed-set-table">
        <thead>
          <tr>
            <th>Serie</th>
            <th>Hotovo</th>
            <th>${labels.reps}</th>
            <th>${labels.weight}</th>
            <th>${labels.rpe}</th>
          </tr>
        </thead>
        <tbody>
          ${sets.map((set, index) => `
            <tr class="${set.done ? "done" : ""}">
              <td>${index + 1}</td>
              <td>${set.done ? "Ano" : "-"}</td>
              <td>${formatNumber(toNumber(set.reps, 0))}</td>
              <td>${formatNumber(toNumber(set.weight, 0))}</td>
              <td>${formatNumber(toNumber(set.rpe, 0))}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderLeaderboardRow(row, index) {
  return `
    <details class="leader-card">
      <summary class="leader-row">
        <span class="leader-rank">${index + 1}</span>
        <div class="leader-person">
          <strong>${escapeHtml(row.name)}</strong>
          <span>${formatTrainingDays(row.trainingDays)} - ${row.completedSets}/${row.totalSets} serii</span>
        </div>
        <div class="leader-result">
          <strong>${formatNumber(row.volume)} kg</strong>
          <span>Rozkliknout tyden</span>
        </div>
      </summary>
      <div class="leader-detail">
        ${renderLeaderboardNutrition(row)}
        ${renderLeaderboardWorkouts(row)}
      </div>
    </details>
  `;
}

function formatTrainingDays(count) {
  const value = Number(count) || 0;
  if (value === 1) return "1 den";
  if (value >= 2 && value <= 4) return `${value} dny`;
  return `${value} dni`;
}

function renderLeaderboardNutrition(row) {
  const nutrition = row.nutrition;
  if (!nutrition) {
    return `
      <section class="leader-detail-card">
        <div class="leader-detail-head">
          <div>
            <strong>Nutrition tyden</strong>
            <span>Tenhle tyden bez zapsanych maker.</span>
          </div>
        </div>
        <div class="microcopy">Az si uzivatel zapise jidlo, objevi se tady kcal a makra.</div>
      </section>
    `;
  }

  const week = nutrition.week;
  const summary = nutrition.summary;
  const weeklyGoal = toNumber(week.goals.weeklyCalories, 0);
  const proteinGoal = toNumber(week.goals.protein, 0) * 7;
  const carbsGoal = toNumber(week.goals.carbs, 0) * 7;
  const fatGoal = toNumber(week.goals.fat, 0) * 7;
  return `
    <section class="leader-detail-card">
      <div class="leader-detail-head">
        <div>
          <strong>Nutrition tyden</strong>
          <span>${summary.daysLogged}/7 dni zapsano</span>
        </div>
        <span class="pill done">${formatNumber(summary.totalCalories)} / ${formatNumber(weeklyGoal)} kcal</span>
      </div>
      <div class="leader-macro-grid">
        ${renderLeaderMacroMetric("Protein", summary.totalProtein, proteinGoal, "g")}
        ${renderLeaderMacroMetric("Sachry", summary.totalCarbs, carbsGoal, "g")}
        ${renderLeaderMacroMetric("Tuky", summary.totalFat, fatGoal, "g")}
        ${renderLeaderMacroMetric("Prumer", summary.averageCalories, 0, "kcal/den")}
      </div>
      ${renderLeaderboardNutritionDays(week)}
    </section>
  `;
}

function renderLeaderMacroMetric(label, value, goal, unit) {
  const goalText = goal ? ` / ${formatNumber(goal)}` : "";
  return `
    <div class="leader-macro-card">
      <strong>${formatNumber(value)}${goalText} ${unit}</strong>
      <span>${label}</span>
    </div>
  `;
}

function renderLeaderboardNutritionDays(week) {
  const days = (week.days || [])
    .map((day, index) => ({ day, index }))
    .filter(({ day }) => hasLeaderboardNutritionDay(day));
  if (!days.length) return `<div class="microcopy">Zadne denni makro zaznamy pro tenhle tyden.</div>`;

  return `
    <div class="leader-nutrition-days">
      ${days.map(({ day, index }) => `
        <div class="leader-nutrition-day">
          <strong>${DAY_LABELS[index]?.[0] || "Den"}</strong>
          <span>${formatNumber(toNumber(day.calories, 0))} kcal</span>
          <span>P ${formatNumber(toNumber(day.protein, 0))} / S ${formatNumber(toNumber(day.carbs, 0))} / T ${formatNumber(toNumber(day.fat, 0))}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function hasLeaderboardNutritionDay(day) {
  return ["calories", "protein", "carbs", "fat"].some((key) => {
    const value = day?.[key];
    return value !== "" && value !== null && value !== undefined && toNumber(value, 0) > 0;
  });
}

function renderLeaderboardWorkouts(row) {
  const workouts = row.workouts || [];
  return `
    <section class="leader-detail-card">
      <div class="leader-detail-head">
        <div>
          <strong>Treninky v tydnu</strong>
          <span>${workouts.length ? `${workouts.length} public dni` : "Zadne public treningy"}</span>
        </div>
      </div>
      <div class="leader-workouts">
        ${workouts.length ? workouts.map(renderLeaderboardWorkout).join("") : `<div class="microcopy">Tenhle uzivatel nema v tomhle tydnu zadny public trening.</div>`}
      </div>
    </section>
  `;
}

function renderLeaderboardWorkout(workout) {
  const dayLabel = DAY_LABELS[workout.day_index]?.[1] || "Den";
  const workoutDate = addDays(parseDate(workout.week_start), Number(workout.day_index) || 0);
  const exercises = workout.payload?.exercises || [];
  return `
    <details class="leader-workout">
      <summary>
        <div>
          <strong>${escapeHtml(workout.title || dayLabel)}</strong>
          <span>${escapeHtml(dayLabel)} ${escapeHtml(formatShortDate(workoutDate))} - ${escapeHtml(workout.focus || "Trenink")}</span>
        </div>
        <span class="pill">${workout.completed_sets}/${workout.total_sets} serii - ${formatNumber(workout.volume)} kg</span>
        ${renderFeedExercises(exercises)}
        <span class="feed-detail-toggle">Rozkliknout trening</span>
      </summary>
      ${renderFeedWorkoutDetails(exercises)}
    </details>
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
              ${renderVisibilityOptions(day.visibility || "public")}
            </select>
          </label>
          <button class="btn danger" data-action="clear-day">Vycistit den</button>
        </div>
        ${renderMobileDaySummary(day, summary)}
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
          ${day.exercises.length ? day.exercises.map((exercise, index) => renderExercise(exercise, index, day.exercises.length)).join("") : renderEmptyDay(summary)}
        </div>
      </section>
    </main>
  `;
}

function renderMobileDaySummary(day, summary) {
  const date = addDays(parseDate(state.weekStart), state.selectedDay);
  const title = day.title || "Volno";
  return `
    <div class="mobile-day-summary">
      <div class="mobile-summary-head">
        <div>
          <span>${DAY_LABELS[state.selectedDay][1]} ${formatShortDate(date)}</span>
          <strong>${escapeHtml(title)}</strong>
        </div>
        <span class="pill${summary.totalSets > 0 && summary.completed === summary.totalSets ? " done" : ""}">${summary.completed}/${summary.totalSets} serii</span>
      </div>
      <div class="mobile-summary-grid">
        <div><strong>${formatNumber(summary.volume)}</strong><span>Dnesni kg</span></div>
        <div><strong>${day.exercises.length}</strong><span>Cviky</span></div>
      </div>
      ${renderMuscleChips(summarizeDayMuscles(day))}
    </div>
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

function renderExercise(exercise, index, totalExercises) {
  const labels = setMetricLabels(exercise);
  return `
    <article class="exercise-card" data-exercise-id="${exercise.id}" data-exercise-index="${index}">
      <div class="exercise-head">
        <div class="exercise-order">
          <button class="drag-handle" type="button" data-drag-exercise-id="${exercise.id}" title="Pretahnout cvik" aria-label="Pretahnout cvik">
            <span>Cvik</span>
            <strong>${index + 1}</strong>
          </button>
          <div class="move-controls" aria-label="Posun cviku">
            <button class="icon-btn mini-move" data-action="move-exercise-up" data-exercise-id="${exercise.id}" title="Posunout nahoru" aria-label="Posunout cvik nahoru" ${index === 0 ? "disabled" : ""}>^</button>
            <button class="icon-btn mini-move" data-action="move-exercise-down" data-exercise-id="${exercise.id}" title="Posunout dolu" aria-label="Posunout cvik dolu" ${index >= totalExercises - 1 ? "disabled" : ""}>v</button>
          </div>
        </div>
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
              <th>${labels.reps}</th>
              <th>${labels.weight}</th>
              <th>${labels.rpe}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${exercise.sets.map((set, index) => renderSetRow(exercise, set, index)).join("")}
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

function renderSetRow(exercise, set, index) {
  const exerciseId = exercise.id;
  const labels = setMetricLabels(exercise);
  return `
    <tr class="${set.done ? "done" : ""}">
      <td class="check-cell">
        <input type="checkbox" data-field="set-done" data-exercise-id="${exerciseId}" data-set-id="${set.id}" ${set.done ? "checked" : ""}>
      </td>
      <td class="set-number">${index + 1}</td>
      <td><input class="input" type="number" min="0" step="${labels.repsStep}" data-field="set-reps" data-exercise-id="${exerciseId}" data-set-id="${set.id}" value="${escapeAttr(set.reps)}" aria-label="${escapeAttr(labels.reps)}"></td>
      <td><input class="input" type="number" min="0" step="${labels.weightStep}" data-field="set-weight" data-exercise-id="${exerciseId}" data-set-id="${set.id}" value="${escapeAttr(set.weight)}" aria-label="${escapeAttr(labels.weight)}"></td>
      <td><input class="input" type="number" min="${labels.rpeMin}" max="${labels.rpeMax}" step="${labels.rpeStep}" data-field="set-rpe" data-exercise-id="${exerciseId}" data-set-id="${set.id}" value="${escapeAttr(set.rpe)}" aria-label="${escapeAttr(labels.rpe)}"></td>
      <td><button class="icon-btn" data-action="remove-set" data-exercise-id="${exerciseId}" data-set-id="${set.id}" title="Smazat serii" aria-label="Smazat serii">x</button></td>
    </tr>
  `;
}

function renderSidePanel(summary, daySummary, day) {
  return `
    <aside class="panel side-panel">
      <div class="side-section side-summary-section">
        <h2 class="section-title">Prehled</h2>
        <div class="metrics">
          <div class="metric"><strong>${daySummary.completed}/${daySummary.totalSets}</strong><span>Dnesni serie</span></div>
          <div class="metric"><strong>${formatNumber(daySummary.volume)}</strong><span>Dnesni kg</span></div>
          <div class="metric"><strong>${summary.trainingDays}</strong><span>Treninkove dny</span></div>
          <div class="metric"><strong>${formatNumber(summary.volume)}</strong><span>Tydenni kg</span></div>
        </div>
      </div>
      <div class="side-section side-muscle-section">
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
        <div class="section-row">
          <h2 class="section-title">Knihovna</h2>
          <button class="btn compact" data-action="restore-default-library">Obnovit zaklad</button>
        </div>
        <div class="mini-form">
          <input id="libraryName" class="input" placeholder="Cvik">
          <select id="libraryMuscle" class="select" aria-label="Partie cviku">
            ${renderMuscleOptions("Full body")}
          </select>
          <button class="icon-btn primary" data-action="add-library-item" title="Pridat do knihovny" aria-label="Pridat do knihovny">+</button>
        </div>
        <div>
          ${state.library.length ? state.library.map(renderLibraryRow).join("") : renderEmptyLibrary()}
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

function renderMuscleChips(groups) {
  if (!groups.length) {
    return `<div class="muscle-empty microcopy">Partie se ukazou po pridani cviku.</div>`;
  }

  return `
    <div class="muscle-chips">
      ${groups.map((group) => `
        <span class="muscle-chip">
          <strong>${escapeHtml(group.muscle)}</strong>
          ${group.completed}/${group.totalSets}
        </span>
      `).join("")}
    </div>
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

function renderEmptyLibrary() {
  return `
    <div class="library-empty microcopy">
      Knihovna je prazdna. Pridej vlastni cvik nebo obnov zakladni balicek.
    </div>
  `;
}

function renderMuscleOptions(selected) {
  return MUSCLES.map((muscle) => (
    `<option value="${escapeAttr(muscle)}" ${muscle === selected ? "selected" : ""}>${escapeHtml(muscle)}</option>`
  )).join("");
}

function renderVisibilityOptions(selected) {
  const normalized = normalizeVisibility(selected);
  const items = [
    ["public", "Public"],
    ["private", "Private"],
  ];
  return items.map(([value, label]) => (
    `<option value="${value}" ${value === normalized ? "selected" : ""}>${label}</option>`
  )).join("");
}

function handleToggle(event) {
  const panel = event.target.closest?.(".phase-photo-panel");
  if (!panel) return;
  const rowId = panel.dataset.rowId;
  if (!rowId) return;
  if (panel.open) {
    openPhasePhotoRows.add(rowId);
  } else {
    openPhasePhotoRows.delete(rowId);
  }
}

async function handleClick(event) {
  const target = event.target.closest("[data-action]");
  if (!target) return;

  const action = target.dataset.action;
  const week = ensureWeek();
  const day = week[state.selectedDay];

  if (action === "retry-cloud") {
    cloud.ready = false;
    render();
    await initSupabase();
    if (cloud.session) {
      await flushPendingSync();
      await loadCloudData();
      saveLocal();
    }
    render();
    showToast(cloud.configured ? "Cloud nacteny." : "Cloud se nepodarilo nacist.");
    return;
  }

  if (action === "set-view") {
    const nextView = target.dataset.view;
    if (!["plan", "nutrition", "feed", "posts", "leaderboard", "profile"].includes(nextView)) return;
    if (nextView === "feed" && state.activeView !== "feed") {
      setSelectedDate(new Date());
      ensureWeek();
      ensureNutritionWeek();
      cloud.feed = cloud.feed.filter(isSelectedFeedRow);
    }
    state.activeView = nextView;
    saveLocal();
    render();
    await flushPendingSync();
    if (nextView === "nutrition") await loadCloudNutritionWeek();
    if (nextView === "feed") await loadCloudWeek();
    if (nextView === "feed" || nextView === "posts" || nextView === "leaderboard") await loadSocialData();
    if (nextView === "nutrition") saveLocal();
    render();
    return;
  }

  if (action === "sign-out") {
    await signOutUser();
    return;
  }

  if (action === "reset-account-data") {
    await resetAccountData();
    return;
  }

  if (action === "reset-nutrition-data") {
    await resetNutritionData();
    return;
  }

  if (action === "resend-confirmation") {
    await resendConfirmationEmail();
    return;
  }

  if (action === "forgot-password") {
    const email = document.querySelector('[data-auth-form="sign-in"] input[name="email"]')?.value.trim() || "";
    await sendPasswordResetEmail(email);
    return;
  }

  if (action === "refresh-social") {
    await flushPendingSync();
    await loadSocialData();
    render();
    showToast("Data obnovena.");
    return;
  }

  if (action === "open-copy-day-dialog" || action === "copy-prev-day" || action === "copy-prev-week") {
    copyDayDialogOpen = true;
    render();
    return;
  }

  if (action === "close-copy-day-dialog") {
    copyDayDialogOpen = false;
    render();
    return;
  }

  if (action === "delete-community-post") {
    await deleteCommunityPost(target.dataset.postId);
    return;
  }

  if (action === "clear-post-image") {
    clearPostImageSelection(target.closest("[data-post-form]"));
    return;
  }

  if (action === "open-community-post-image") {
    const post = cloud.posts.find((item) => item.id === target.dataset.postId);
    if (post?.imageUrl) window.open(post.imageUrl, "_blank", "noopener");
    return;
  }

  if (action === "prev-feed-day" || action === "next-feed-day") {
    const shift = action === "prev-feed-day" ? -1 : 1;
    setSelectedDate(addDays(getSelectedDate(), shift));
    ensureWeek();
    ensureNutritionWeek();
    cloud.feed = cloud.feed.filter(isSelectedFeedRow);
    saveLocal();
    render();
    await flushPendingSync();
    await loadCloudWeek();
    await loadFeed();
    saveLocal();
    render();
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

  if (action === "prev-nutrition-day" || action === "next-nutrition-day") {
    const shift = action === "prev-nutrition-day" ? -1 : 1;
    state.selectedDay = (state.selectedDay + shift + 7) % 7;
    saveLocal();
    render();
    return;
  }

  if (action === "select-nutrition-day") {
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
    await flushPendingSync();
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
    cloud.feed = cloud.feed.filter(isSelectedFeedRow);
    saveLocal();
    render();
    await flushPendingSync();
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

  if (action === "add-phase-row") {
    const phase = state.nutritionPhase;
    phase.rows.push(createNutritionPhaseRow(phase.rows.length + 1));
    save();
    render();
    return;
  }

  if (action === "remove-phase-row") {
    const phase = state.nutritionPhase;
    const rowId = target.dataset.rowId;
    if (phase.rows.length <= 1) {
      phase.rows = [createNutritionPhaseRow(1)];
      openPhasePhotoRows.clear();
    } else {
      phase.rows = phase.rows.filter((row) => row.id !== rowId);
      openPhasePhotoRows.delete(rowId);
    }
    save();
    render();
    return;
  }

  if (action === "add-phase-photo") {
    pendingPhasePhotoRowId = target.dataset.rowId;
    if (pendingPhasePhotoRowId) {
      openPhasePhotoRows.add(pendingPhasePhotoRowId);
    }
    if (!posingFile) {
      showToast("Vyber fotky tady neni dostupny.");
      return;
    }
    posingFile.click();
    return;
  }

  if (action === "move-phase-photo") {
    const offset = Number(target.dataset.direction);
    if (movePhasePhotoByOffset(target.dataset.rowId, target.dataset.photoId, offset)) {
      save();
      runPendingSyncNow("Poradi fotek se nepodarilo ulozit do cloudu.");
      render();
      showToast("Poradi fotek upraveno.");
    }
    return;
  }

  if (action === "move-compare-slot") {
    phaseCompare.slotIndex = Math.max(0, toNumber(phaseCompare.slotIndex, 0) + Number(target.dataset.direction || 0));
    render();
    return;
  }

  if (action === "open-phase-compare-viewer") {
    const rowsWithPhotos = phaseRowsWithPhotos();
    if (!rowsWithPhotos.length) {
      showToast("Nejdriv nahraj fotky aspon do jednoho tydne.");
      return;
    }
    const selection = resolvePhaseCompare(rowsWithPhotos);
    phaseCompareViewer = {
      fromRowId: selection.fromRow?.id || "",
      toRowId: selection.toRow?.id || "",
      slotIndex: selection.slotIndex,
      zoom: 100
    };
    render();
    return;
  }

  if (action === "close-phase-compare-viewer") {
    phaseCompareViewer = null;
    render();
    return;
  }

  if (action === "prev-phase-compare-viewer" || action === "next-phase-compare-viewer") {
    movePhaseCompareViewer(action === "prev-phase-compare-viewer" ? -1 : 1);
    render();
    return;
  }

  if (action === "zoom-phase-compare-viewer") {
    zoomPhaseCompareViewer(Number(target.dataset.direction || 0));
    render();
    return;
  }

  if (action === "reset-phase-compare-zoom") {
    if (phaseCompareViewer) phaseCompareViewer.zoom = 100;
    render();
    return;
  }

  if (action === "open-phase-photo") {
    phasePhotoViewer = {
      rowId: target.dataset.rowId,
      photoId: target.dataset.photoId
    };
    render();
    return;
  }

  if (action === "close-phase-photo") {
    phasePhotoViewer = null;
    render();
    return;
  }

  if (action === "prev-phase-photo" || action === "next-phase-photo") {
    movePhasePhotoViewer(action === "prev-phase-photo" ? -1 : 1);
    render();
    return;
  }

  if (action === "remove-phase-photo") {
    const rowId = target.dataset.rowId;
    const photoId = target.dataset.photoId;
    const row = findNutritionPhaseRow(rowId);
    if (!row) return;
    const previousPhotos = normalizePhasePhotos(row.photos);
    const removedIndex = previousPhotos.findIndex((photo) => photo.id === photoId);
    const removedPhoto = previousPhotos[removedIndex];
    row.photos = previousPhotos.filter((photo) => photo.id !== photoId);
    row.photoOrder = normalizePhotoOrder(row.photoOrder).filter((key) => key !== phasePhotoKey(removedPhoto));
    syncPhasePhotoOrder(row);
    openPhasePhotoRows.add(rowId);
    if (phasePhotoViewer?.rowId === rowId && phasePhotoViewer?.photoId === photoId) {
      const nextPhotos = orderPhasePhotos(row.photos, row.photoOrder);
      phasePhotoViewer = nextPhotos.length
        ? {
            rowId,
            photoId: nextPhotos[Math.min(Math.max(removedIndex, 0), nextPhotos.length - 1)].id
          }
        : null;
    }
    save();
    render();
    showToast(removedPhoto?.storagePath ? "Fotka smazana, cistim cloud..." : "Fotka smazana jen lokalne.");
    if (removedPhoto?.storagePath) {
      deleteCloudPhasePhoto(removedPhoto)
        .then(() => showToast("Fotka smazana z cloudu."))
        .catch((error) => {
          console.warn(error);
          showCloudError("Fotka zmizela z appky, ale cloud smazani se nepovedlo.", error);
        });
    }
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

  if (action === "move-exercise-up" || action === "move-exercise-down") {
    const shift = action === "move-exercise-up" ? -1 : 1;
    if (moveExerciseByOffset(target.dataset.exerciseId, shift)) {
      save();
      render();
      showToast("Poradi cviku upraveno.");
    }
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

  if (action === "restore-default-library") {
    const added = restoreDefaultLibraryItems();
    saveLocal();
    render();
    showToast(added ? `Zakladni knihovna obnovena: ${added} cviku pridano.` : "Zakladni knihovna uz je kompletni.");
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
  if (event.target.dataset.copyDayForm !== undefined) {
    event.preventDefault();
    await copyWorkoutByDates(event.target);
    return;
  }

  if (event.target.dataset.resetPasswordForm !== undefined) {
    event.preventDefault();
    await saveNewPassword(event.target);
    return;
  }

  if (event.target.dataset.profileForm !== undefined) {
    event.preventDefault();
    await saveProfileForm(event.target);
    return;
  }

  if (event.target.dataset.postForm !== undefined) {
    event.preventDefault();
    await createCommunityPost(event.target);
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
    try {
      const { data, error } = await withTimeout(
        cloud.client.auth.signInWithPassword({ email, password }),
        15000,
        "Prihlaseni vyprselo, zkus to prosim znovu."
      );
      if (error) {
        cloud.authNotice = {
          type: "error",
          title: "Prihlaseni se nepovedlo",
          text: friendlyAuthError(error)
        };
        cloud.pendingEmail = error.message?.toLowerCase().includes("confirm") ? email : "";
        render();
        showToast(cloud.authNotice.text);
        return;
      }

      const session = data.session || (await cloud.client.auth.getSession()).data.session;
      if (!session) {
        cloud.authNotice = {
          type: "error",
          title: "Prihlaseni se nepovedlo",
          text: "Supabase nevratil aktivni session. Zkus refresh a prihlaseni znovu."
        };
        render();
        showToast(cloud.authNotice.text);
        return;
      }

      await finishSignedInSession(session, "Jsi prihlaseny.");
      state.activeView = "plan";
      saveLocal();
      render();
    } catch (error) {
      cloud.authNotice = {
        type: "error",
        title: "Prihlaseni se nepovedlo",
        text: friendlyAuthError(error)
      };
      cloud.pendingEmail = "";
      render();
      showToast(cloud.authNotice.text);
    }
    return;
  }

  if (authMode === "sign-up") {
    const { data, error } = await cloud.client.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: authRedirectUrl()
      }
    });
    if (error) {
      cloud.authNotice = {
        type: "error",
        title: "Registrace se nepovedla",
        text: friendlyAuthError(error)
      };
      cloud.pendingEmail = email;
      render();
      showToast(cloud.authNotice.text);
      return;
    }

    event.target.reset();
    cloud.pendingEmail = email;
    cloud.authNotice = data.session
      ? {
        type: "success",
        title: "Ucet je vytvoreny",
        text: "Jsi prihlaseny. Kdyby te appka odhlasila, staci se prihlasit stejnym e-mailem a heslem."
      }
      : {
        type: "success",
        title: "Zkontroluj e-mail",
        text: `Na ${email} prisel overovaci odkaz. Otevri ho, potvrd ucet a potom se prihlas. Mrkni i do spamu nebo hromadne posty.`
      };
    render();
    showToast(data.session ? "Ucet vytvoren." : "Overovaci e-mail odeslan.");
  }
}

async function resendConfirmationEmail() {
  if (!cloud.client || !cloud.pendingEmail) return;
  const { error } = await cloud.client.auth.resend({
    type: "signup",
    email: cloud.pendingEmail,
    options: {
      emailRedirectTo: authRedirectUrl()
    }
  });

  if (error) {
    cloud.authNotice = {
      type: "error",
      title: "E-mail se nepodarilo poslat",
      text: friendlyAuthError(error)
    };
    render();
    showToast(cloud.authNotice.text);
    return;
  }

  cloud.authNotice = {
    type: "success",
    title: "E-mail poslan znovu",
    text: `Na ${cloud.pendingEmail} jsme poslali novy overovaci odkaz.`
  };
  render();
  showToast("Overovaci e-mail poslan znovu.");
}

async function signOutUser() {
  const theme = state.theme;
  if (cloud.client) {
    try {
      await withTimeout(cloud.client.auth.signOut({ scope: "local" }), 5000, "Supabase sign out timeout");
    } catch (error) {
      console.warn(error);
    }
  }

  finishSignedOutState(theme);
  render();
  showToast("Odhlaseno.");
}

async function finishSignedInSession(session, toastMessage = "") {
  if (!session) return;
  cloud.session = session;
  activateUserStorage(session.user.id);
  if (!cloud.passwordRecovery) {
    cloud.authNotice = null;
    cloud.pendingEmail = "";
  }
  await ensureProfile();
  if (!cloud.passwordRecovery) {
    await flushPendingSync();
    await loadCloudData();
    saveLocal();
    if (toastMessage) showToast(toastMessage);
  }
}

function finishSignedOutState(theme = state.theme) {
  cloud.session = null;
  cloud.profile = null;
  cloud.feed = [];
  cloud.leaderboard = [];
  cloud.posts = [];
  cloud.authNotice = null;
  cloud.pendingEmail = "";
  cloud.passwordRecovery = false;
  clearPostImageSelection();
  activateAnonymousStorage();
  state.theme = theme;
  saveLocal();
}

async function sendPasswordResetEmail(email) {
  if (!cloud.client) return;
  if (!email) {
    cloud.authNotice = {
      type: "error",
      title: "Dopln e-mail",
      text: "Nejdriv napis e-mail do prihlaseni a potom klikni na zapomenute heslo."
    };
    render();
    document.querySelector('[data-auth-form="sign-in"] input[name="email"]')?.focus();
    return;
  }

  const { error } = await cloud.client.auth.resetPasswordForEmail(email, {
    redirectTo: authRedirectUrl()
  });

  if (error) {
    cloud.authNotice = {
      type: "error",
      title: "Reset hesla se nepodaril",
      text: friendlyAuthError(error)
    };
    render();
    showToast(cloud.authNotice.text);
    return;
  }

  cloud.pendingEmail = "";
  cloud.authNotice = {
    type: "success",
    title: "Reset hesla odeslan",
    text: `Na ${email} prisel odkaz pro nastaveni noveho hesla. Mrkni i do spamu nebo hromadne posty.`
  };
  render();
  showToast("Reset hesla odeslan na e-mail.");
}

async function saveNewPassword(formElement) {
  if (!cloud.client || !cloud.session) {
    showToast("Reset link uz neni aktivni. Posli si reset hesla znovu.");
    cloud.passwordRecovery = false;
    render();
    return;
  }

  const form = new FormData(formElement);
  const password = String(form.get("password") || "");
  if (password.length < 6) {
    showToast("Heslo musi mit aspon 6 znaku.");
    return;
  }

  const { error } = await cloud.client.auth.updateUser({ password });
  if (error) {
    cloud.authNotice = {
      type: "error",
      title: "Heslo se nepodarilo zmenit",
      text: friendlyAuthError(error)
    };
    render();
    showToast(cloud.authNotice.text);
    return;
  }

  cloud.passwordRecovery = false;
  cloud.authNotice = null;
  state.activeView = "plan";
  saveLocal();
  await loadCloudData();
  render();
  showToast("Heslo zmeneno.");
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

async function resetAccountData() {
  if (!cloud.client || !cloud.session) {
    showToast("Nejdriv se prihlas.");
    return;
  }
  if (!confirm("Fakt vymazat tvoje workouty a nutrition data z tohoto uctu?")) return;
  if (!confirm("Posledni kontrola: data se smazi z cloudu i z tohoto zarizeni.")) return;

  const userId = cloud.session.user.id;
  const [workoutResult, nutritionResult, photoResult, postResult] = await Promise.allSettled([
    cloud.client.from("workout_days").delete().eq("user_id", userId),
    cloud.client.from("nutrition_weeks").delete().eq("user_id", userId),
    deleteAllCloudPhasePhotos(),
    deleteAllCommunityPosts()
  ]);

  const error = workoutResult.value?.error || nutritionResult.value?.error || photoResult.reason || postResult.reason;
  if (workoutResult.status === "rejected" || nutritionResult.status === "rejected" || postResult.status === "rejected" || error) {
    const thrownError = workoutResult.reason || nutritionResult.reason || postResult.reason || error;
    console.warn(thrownError);
    showCloudError("Data se nepodarilo vymazat.", thrownError);
    return;
  }

  state = createAccountState(state.theme);
  pendingSync = createEmptyPendingSync();
  cloud.feed = [];
  cloud.leaderboard = [];
  cloud.posts = [];
  saveLocal();
  savePendingSync();
  await loadSocialData();
  render();
  showToast("Ucet je vycisteny.");
}

async function resetNutritionData() {
  if (!confirm("Vycistit nutrition data jen pro aktualni ucet? Treningovy plan zustane.")) return;
  if (!confirm("Posledni kontrola: smaze se nutrition cloud i lokalni nutrition na tomhle uctu.")) return;

  if (cloud.client && cloud.session) {
    const [nutritionResult, photoResult] = await Promise.allSettled([
      cloud.client
        .from("nutrition_weeks")
        .delete()
        .eq("user_id", cloud.session.user.id),
      deleteAllCloudPhasePhotos()
    ]);
    const error = nutritionResult.value?.error || photoResult.reason;
    if (nutritionResult.status === "rejected" || error) {
      const thrownError = nutritionResult.reason || error;
      console.warn(thrownError);
      showCloudError("Nutrition data se nepodarilo vymazat.", thrownError);
      return;
    }
  }

  state.nutrition = {};
  state.nutritionPhase = createNutritionPhase();
  ensureNutritionWeek();
  pendingSync.nutrition = {};
  saveLocal();
  savePendingSync();
  render();
  showToast("Nutrition vycistena.");
}

function handleInput(event) {
  const field = event.target.dataset.field;
  if (!field) return;

  const week = ensureWeek();
  const day = week[state.selectedDay];

  if (field === "nutrition-day") {
    updateNutritionDay(event.target);
    syncNutritionInputs(event.target);
    refreshNutritionSummary();
    save();
    return;
  }

  if (field === "nutrition-goal") {
    updateNutritionGoal(event.target);
    refreshNutritionSummary();
    save();
    return;
  }

  if (field === "nutrition-cheat") {
    ensureNutritionWeek().lastCheatMeal = event.target.value;
    save();
    return;
  }

  if (field === "nutrition-phase") {
    updateNutritionPhase(event.target);
    save();
    return;
  }

  if (field === "nutrition-phase-row") {
    updateNutritionPhaseRow(event.target);
    save();
    return;
  }

  if (field === "phase-compare") {
    updatePhaseCompare(event.target);
    render();
    return;
  }

  if (field === "phase-compare-zoom") {
    setPhaseCompareViewerZoom(event.target.value);
    render();
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

  if (field === "post-image") {
    updatePostImagePreview(event.target);
    return;
  }

  const week = ensureWeek();
  const day = week[state.selectedDay];

  if (field === "nutrition-day") {
    updateNutritionDay(event.target);
    syncNutritionInputs(event.target);
    refreshNutritionSummary();
    save();
    return;
  }

  if (field === "nutrition-goal") {
    updateNutritionGoal(event.target);
    refreshNutritionSummary();
    save();
    return;
  }

  if (field === "nutrition-cheat") {
    ensureNutritionWeek().lastCheatMeal = event.target.value;
    save();
    return;
  }

  if (field === "nutrition-phase") {
    updateNutritionPhase(event.target);
    save();
    render();
    return;
  }

  if (field === "nutrition-phase-row") {
    updateNutritionPhaseRow(event.target);
    save();
    render();
    return;
  }

  if (field === "phase-compare") {
    updatePhaseCompare(event.target);
    render();
    return;
  }

  if (field === "phase-compare-zoom") {
    setPhaseCompareViewerZoom(event.target.value);
    render();
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

function handleFocusOut(event) {
  if (!event.target?.dataset?.field) return;
  saveLocal();
  runPendingSyncNow("Cloud ulozeni se nepovedlo.");
}

function handlePageHide() {
  saveLocal();
  runPendingSyncNow("Neulozene zmeny se nepodarilo dosynchronizovat.");
}

function handleVisibilityChange() {
  if (document.visibilityState === "hidden") {
    saveLocal();
    runPendingSyncNow("Neulozene zmeny se nepodarilo dosynchronizovat.");
    return;
  }
  refreshCloudDataIfIdle({ force: true });
}

function handleKeyDown(event) {
  if (!phasePhotoViewer) return;
  if (event.key === "Escape") {
    phasePhotoViewer = null;
    render();
    return;
  }
  if (event.key === "ArrowLeft") {
    movePhasePhotoViewer(-1);
    render();
    return;
  }
  if (event.key === "ArrowRight") {
    movePhasePhotoViewer(1);
    render();
  }
}

function handlePointerDown(event) {
  const photoHandle = event.target.closest("[data-drag-phase-photo-id]");
  if (photoHandle && event.button <= 0) {
    startPhasePhotoDrag(event, photoHandle);
    return;
  }

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
  if (phasePhotoDrag && event.pointerId === phasePhotoDrag.pointerId) {
    handlePhasePhotoPointerMove(event);
    return;
  }

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
  if (phasePhotoDrag && event.pointerId === phasePhotoDrag.pointerId) {
    finishPhasePhotoDrag(event);
    return;
  }

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

function handlePointerCancel(event) {
  if (!event || !phasePhotoDrag || event.pointerId === phasePhotoDrag.pointerId) {
    cancelPhasePhotoDrag();
  }
  if (!event || !exerciseDrag || event.pointerId === exerciseDrag.pointerId) {
    cancelExerciseDrag();
  }
}

function startPhasePhotoDrag(event, handle) {
  const card = handle.closest("[data-phase-photo-card]");
  const rowId = handle.dataset.rowId;
  const photoId = handle.dataset.dragPhasePhotoId;
  const row = findNutritionPhaseRow(rowId);
  if (!card || !row || !photoId) return;

  phasePhotoDrag = {
    pointerId: event.pointerId,
    rowId,
    photoId,
    overId: photoId,
    insertAfter: false,
    moved: false
  };

  handle.setPointerCapture?.(event.pointerId);
  card.classList.add("photo-dragging");
  document.body.classList.add("dragging-photo");
  event.preventDefault();
}

function handlePhasePhotoPointerMove(event) {
  const element = document.elementFromPoint(event.clientX, event.clientY);
  const card = element?.closest?.("[data-phase-photo-card]");
  if (!card || card.dataset.rowId !== phasePhotoDrag.rowId) {
    event.preventDefault();
    return;
  }

  phasePhotoDrag.moved = true;
  const rect = card.getBoundingClientRect();
  const midX = rect.left + rect.width / 2;
  const midY = rect.top + rect.height / 2;
  const sameRowGesture = Math.abs(event.clientY - midY) < rect.height * 0.35;
  const insertAfter = sameRowGesture
    ? event.clientX > midX
    : event.clientY > midY;

  document.querySelectorAll(".phase-photo-card.photo-drop-before, .phase-photo-card.photo-drop-after").forEach((item) => {
    item.classList.remove("photo-drop-before", "photo-drop-after");
  });

  if (card.dataset.photoId !== phasePhotoDrag.photoId) {
    card.classList.add(insertAfter ? "photo-drop-after" : "photo-drop-before");
  }

  phasePhotoDrag.overId = card.dataset.photoId;
  phasePhotoDrag.insertAfter = insertAfter;
  event.preventDefault();
}

function finishPhasePhotoDrag(event) {
  const drag = phasePhotoDrag;
  cancelPhasePhotoDrag();

  if (!drag.moved || !drag.overId || drag.overId === drag.photoId) return;
  if (movePhasePhotoInRow(drag.rowId, drag.photoId, drag.overId, drag.insertAfter)) {
    save();
    runPendingSyncNow("Poradi fotek se nepodarilo ulozit do cloudu.");
    render();
    showToast("Poradi fotek upraveno.");
  }
  event.preventDefault();
}

function cancelPhasePhotoDrag() {
  if (!phasePhotoDrag) return;
  phasePhotoDrag = null;
  document.body.classList.remove("dragging-photo");
  document.querySelectorAll(".phase-photo-card.photo-dragging, .phase-photo-card.photo-drop-before, .phase-photo-card.photo-drop-after").forEach((card) => {
    card.classList.remove("photo-dragging", "photo-drop-before", "photo-drop-after");
  });
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

function moveExerciseByOffset(exerciseId, offset) {
  const exercises = ensureWeek()[state.selectedDay].exercises;
  const fromIndex = exercises.findIndex((exercise) => exercise.id === exerciseId);
  const toIndex = fromIndex + offset;
  if (fromIndex < 0 || toIndex < 0 || toIndex >= exercises.length) return false;
  const [moved] = exercises.splice(fromIndex, 1);
  exercises.splice(toIndex, 0, moved);
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

async function handlePhasePhotoImport(event) {
  const files = Array.from(event.target.files || []);
  const rowId = pendingPhasePhotoRowId;
  pendingPhasePhotoRowId = null;
  if (posingFile) posingFile.value = "";
  if (!files.length || !rowId) return;
  const imageFiles = files.filter((file) => file.type.startsWith("image/")).slice(-12);
  if (!imageFiles.length) {
    showToast("Vyber prosim obrazek.");
    return;
  }

  const row = findNutritionPhaseRow(rowId);
  if (!row) return;

  try {
    const syncToCloud = Boolean(cloud.client && cloud.session);
    showToast(syncToCloud ? "Pripravuju fotky a nahravam do cloudu..." : "Pripravuju fotky...");
    const preparedPhotos = [];
    const localPhotos = [];
    for (const file of imageFiles) {
      const prepared = await prepareCompressedPhasePhoto(file);
      preparedPhotos.push(prepared);
      localPhotos.push(localPhasePhotoFromPrepared(prepared));
    }
    row.photos = [...orderPhasePhotos(row.photos, row.photoOrder), ...localPhotos].slice(-PHASE_PHOTO_LIMIT);
    syncPhasePhotoOrder(row);
    openPhasePhotoRows.add(rowId);
    saveLocal();
    render();

    if (!syncToCloud) {
      showToast(formatPhotoSaveMessage(localPhotos.length, false));
      return;
    }

    await saveNutritionToCloud();
    const uploadedPhotos = [];
    const uploadedPreviewIds = [];
    try {
      for (let index = 0; index < preparedPhotos.length; index += 1) {
        uploadedPhotos.push(await uploadPreparedCloudPhasePhoto(row, preparedPhotos[index]));
        uploadedPreviewIds.push(localPhotos[index].id);
      }
      replacePhasePhotoPreviews(rowId, uploadedPreviewIds, uploadedPhotos);
      save();
      render();
      showToast(formatPhotoSaveMessage(uploadedPhotos.length, true));
    } catch (error) {
      if (uploadedPhotos.length) {
        replacePhasePhotoPreviews(rowId, uploadedPreviewIds, uploadedPhotos);
        save();
        render();
      }
      console.warn(error);
      showCloudError("Nektere fotky zustaly jen lokalne.", error);
    }
  } catch (error) {
    console.warn(error);
    showCloudError("Fotku se nepodarilo ulozit.", error);
  }
}

function formatPhotoSaveMessage(count, synced) {
  const suffix = synced ? "do cloudu" : "lokalne";
  if (count === 1) return `Fotka ulozena ${suffix}.`;
  if (count > 1 && count < 5) return `${count} fotky ulozeny ${suffix}.`;
  return `${count} fotek ulozeno ${suffix}.`;
}

async function createCompressedPhasePhoto(file) {
  const prepared = await prepareCompressedPhasePhoto(file);
  return localPhasePhotoFromPrepared(prepared);
}

function localPhasePhotoFromPrepared(prepared) {
  return {
    id: prepared.id,
    name: prepared.name,
    addedAt: prepared.addedAt,
    dataUrl: prepared.dataUrl,
    url: "",
    storagePath: "",
    cloudId: "",
    width: prepared.width,
    height: prepared.height
  };
}

async function uploadCloudPhasePhoto(row, file) {
  if (!cloud.client || !cloud.session) throw new Error("Nejdriv se prihlas.");
  const prepared = await prepareCompressedPhasePhoto(file);
  return uploadPreparedCloudPhasePhoto(row, prepared);
}

async function uploadPreparedCloudPhasePhoto(row, prepared) {
  if (!cloud.client || !cloud.session) throw new Error("Nejdriv se prihlas.");
  const objectId = uid();
  const storagePath = `${cloud.session.user.id}/${row.id}/${Date.now()}-${objectId}.jpg`;
  const bucket = cloud.client.storage.from(PHASE_PHOTO_BUCKET);
  const { error: uploadError } = await bucket.upload(storagePath, prepared.blob, {
    cacheControl: "31536000",
    contentType: "image/jpeg",
    upsert: false
  });
  if (uploadError) throw uploadError;

  const { data, error } = await cloud.client
    .from("progress_photos")
    .insert({
      user_id: cloud.session.user.id,
      phase_row_id: row.id,
      week_label: row.weekLabel || "",
      storage_path: storagePath,
      file_name: prepared.name,
      width: prepared.width,
      height: prepared.height,
      file_size: prepared.blob.size,
      content_type: "image/jpeg"
    })
    .select("id,user_id,phase_row_id,week_label,storage_path,file_name,width,height,created_at")
    .single();

  if (error) {
    await bucket.remove([storagePath]);
    throw error;
  }

  const { data: signed, error: signedError } = await bucket.createSignedUrl(storagePath, PHASE_PHOTO_SIGNED_URL_SECONDS);
  if (signedError) throw signedError;
  return cloudPhasePhotoFromRow(data, signed?.signedUrl || "");
}

function replacePhasePhotoPreviews(rowId, previewIds, uploadedPhotos) {
  const row = findNutritionPhaseRow(rowId);
  if (!row) return;
  const previewIdSet = new Set(previewIds);
  const uploadedByPreviewId = new Map(previewIds.map((previewId, index) => [previewId, phasePhotoKey(uploadedPhotos[index])]));
  row.photoOrder = normalizePhotoOrder(row.photoOrder).map((key) => uploadedByPreviewId.get(key) || key);
  row.photos = [
    ...orderPhasePhotos(row.photos, row.photoOrder).filter((photo) => !previewIdSet.has(photo.id)),
    ...uploadedPhotos
  ].slice(-PHASE_PHOTO_LIMIT);
  syncPhasePhotoOrder(row);
  openPhasePhotoRows.add(rowId);
}

async function syncLocalPhasePhotosToCloud() {
  if (!cloud.client || !cloud.session) return 0;
  let uploadedCount = 0;

  for (const row of state.nutritionPhase.rows) {
    const localPhotos = orderPhasePhotos(row.photos, row.photoOrder).filter((photo) => photo.dataUrl && !photo.storagePath);
    if (!localPhotos.length) continue;

    const uploadedPhotos = [];
    const uploadedPreviewIds = [];
    for (const photo of localPhotos) {
      try {
        const prepared = await preparePhasePhotoFromLocal(photo);
        uploadedPhotos.push(await uploadPreparedCloudPhasePhoto(row, prepared));
        uploadedPreviewIds.push(photo.id);
      } catch (error) {
        console.warn(error);
      }
    }

    if (uploadedPhotos.length) {
      replacePhasePhotoPreviews(row.id, uploadedPreviewIds, uploadedPhotos);
      uploadedCount += uploadedPhotos.length;
    }
  }

  if (uploadedCount) {
    save();
    showToast(`${uploadedCount} lokalni fotky doposlany do cloudu.`);
  }
  return uploadedCount;
}

async function preparePhasePhotoFromLocal(photo) {
  const blob = await dataUrlToBlob(photo.dataUrl);
  return {
    id: photo.id || uid(),
    name: photo.name || "Posing photo",
    addedAt: photo.addedAt || new Date().toISOString(),
    dataUrl: photo.dataUrl,
    blob,
    width: toNumber(photo.width, 0),
    height: toNumber(photo.height, 0)
  };
}

async function deleteCloudPhasePhoto(photo) {
  if (!cloud.client || !cloud.session || !photo.storagePath) return;
  let query = cloud.client
    .from("progress_photos")
    .delete()
    .eq("user_id", cloud.session.user.id);
  if (photo.cloudId) {
    query = query.eq("id", photo.cloudId);
  } else {
    query = query.eq("storage_path", photo.storagePath);
  }
  const { error } = await query;
  if (error) throw error;

  const storageResult = await cloud.client
    .storage
    .from(PHASE_PHOTO_BUCKET)
    .remove([photo.storagePath]);
  if (storageResult.error) console.warn(storageResult.error);
}

async function deleteAllCloudPhasePhotos() {
  if (!cloud.client || !cloud.session) return null;
  const userId = cloud.session.user.id;
  const { data, error: listError } = await cloud.client
    .from("progress_photos")
    .select("storage_path")
    .eq("user_id", userId);
  if (listError) {
    if (listError.code === "42P01") return null;
    throw listError;
  }

  const paths = (data || []).map((photo) => photo.storage_path).filter(Boolean);
  if (paths.length) {
    const { error: storageError } = await cloud.client
      .storage
      .from(PHASE_PHOTO_BUCKET)
      .remove(paths);
    if (storageError) throw storageError;
  }

  const { error } = await cloud.client
    .from("progress_photos")
    .delete()
    .eq("user_id", userId);
  if (error) throw error;
  return paths.length;
}

async function prepareCompressedPhasePhoto(file) {
  const dataUrl = await readFileAsDataUrl(file);
  const image = await loadImageFromDataUrl(dataUrl);
  const maxSide = 1200;
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, width, height);
  const compressedDataUrl = canvas.toDataURL("image/jpeg", 0.78);
  const blob = await dataUrlToBlob(compressedDataUrl);
  return {
    id: uid(),
    name: file.name,
    addedAt: new Date().toISOString(),
    dataUrl: compressedDataUrl,
    blob,
    width,
    height
  };
}

async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  return response.blob();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Image read failed"));
    reader.readAsDataURL(file);
  });
}

function loadImageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Image load failed"));
    image.src = dataUrl;
  });
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
  if (!flushingPendingSync && hasPendingWorkoutsForWeek(state.weekStart)) {
    await flushPendingSync();
  }
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

  if (!data?.length) {
    if (!hasPendingWorkoutsForWeek(state.weekStart)) {
      state.weeks[state.weekStart] = createBlankWeek();
    }
    return;
  }
  const week = createBlankWeek();
  data.forEach((row) => {
    week[row.day_index] = rowToDay(row);
  });
  state.weeks[state.weekStart] = week;
  data
    .filter((row) => row.visibility === "friends" || toNumber(row.total_sets, 0) <= 0)
    .forEach((row) => markPendingWorkoutSync(row.week_start, row.day_index));
  await flushPendingSync();
}

async function loadCloudWeekByStart(weekStart) {
  if (!cloud.client || !cloud.session) return null;
  const { data, error } = await cloud.client
    .from("workout_days")
    .select("*")
    .eq("user_id", cloud.session.user.id)
    .eq("week_start", weekStart)
    .order("day_index", { ascending: true });

  if (error) throw error;
  if (!data?.length) return null;
  const week = createBlankWeek();
  data.forEach((row) => {
    week[row.day_index] = rowToDay(row);
  });
  return week;
}

async function loadCloudNutritionWeek() {
  if (!cloud.client || !cloud.session) return;
  if (!flushingPendingSync && hasPendingNutritionForWeek(state.weekStart)) {
    await flushPendingSync();
  }
  const { data, error } = await cloud.client
    .from("nutrition_weeks")
    .select("*")
    .eq("user_id", cloud.session.user.id)
    .eq("week_start", state.weekStart)
    .maybeSingle();

  if (error) {
    console.warn(error);
    showCloudError("Nutrition data se nepodarilo nacist.", error);
    return;
  }

  if (!data) {
    const localNutrition = ensureNutritionWeek();
    if (hasNutritionData(localNutrition)) await saveNutritionToCloud();
    await loadCloudNutritionPhase();
    await loadCloudPhasePhotos();
    await syncLocalPhasePhotosToCloud();
    return;
  }
  state.nutrition[state.weekStart] = normalizeNutritionWeek(data.payload);
  await loadCloudNutritionPhase(data.payload?.phase);
  await loadCloudPhasePhotos();
  await syncLocalPhasePhotosToCloud();
}

async function loadCloudNutritionPhase(fallbackPhase = null) {
  if (!cloud.client || !cloud.session) return;
  const { data, error } = await cloud.client
    .from("nutrition_weeks")
    .select("payload")
    .eq("user_id", cloud.session.user.id)
    .eq("week_start", NUTRITION_PHASE_WEEK_START)
    .maybeSingle();

  if (error) {
    console.warn(error);
    if (fallbackPhase) {
      state.nutritionPhase = mergePhasePhotos(normalizeNutritionPhase(fallbackPhase), state.nutritionPhase);
    }
    return;
  }

  const phase = data?.payload?.phase || fallbackPhase;
  if (phase) {
    state.nutritionPhase = mergePhasePhotos(normalizeNutritionPhase(phase), state.nutritionPhase);
  }
  if (!data && hasNutritionPhaseData(state.nutritionPhase)) {
    await saveNutritionPhaseToCloud();
  }
}

async function loadCloudPhasePhotos() {
  if (!cloud.client || !cloud.session) return;
  const { data, error } = await cloud.client
    .from("progress_photos")
    .select("id,user_id,phase_row_id,week_label,storage_path,file_name,width,height,created_at")
    .eq("user_id", cloud.session.user.id)
    .order("created_at", { ascending: true });

  if (error) {
    if (error.code !== "42P01") console.warn(error);
    return;
  }

  const photos = await Promise.all((data || []).map(async (record) => {
    const { data: signed, error: signedError } = await cloud.client
      .storage
      .from(PHASE_PHOTO_BUCKET)
      .createSignedUrl(record.storage_path, PHASE_PHOTO_SIGNED_URL_SECONDS);
    if (signedError) {
      console.warn(signedError);
      return null;
    }
    return cloudPhasePhotoFromRow(record, signed?.signedUrl || "");
  }));

  attachCloudPhasePhotos(photos.filter(Boolean));
}

function attachCloudPhasePhotos(photos) {
  const byRowId = new Map();
  const byWeekLabel = new Map();
  const byWeekNumber = new Map();
  photos.forEach((photo) => {
    if (photo.phaseRowId) {
      const items = byRowId.get(photo.phaseRowId) || [];
      items.push(photo);
      byRowId.set(photo.phaseRowId, items);
    }
    if (photo.weekLabel) {
      const items = byWeekLabel.get(photo.weekLabel) || [];
      items.push(photo);
      byWeekLabel.set(photo.weekLabel, items);
    }
    const weekNumber = phaseWeekNumber(photo.weekLabel);
    if (weekNumber !== null) {
      const items = byWeekNumber.get(weekNumber) || [];
      items.push(photo);
      byWeekNumber.set(weekNumber, items);
    }
  });

  state.nutritionPhase.rows = state.nutritionPhase.rows.map((row) => {
    const localPhotos = orderPhasePhotos(row.photos, row.photoOrder).filter((photo) => !photo.storagePath);
    const cloudPhotos = [
      ...(byRowId.get(row.id) || []),
      ...(byWeekLabel.get(row.weekLabel) || []),
      ...(byWeekNumber.get(phaseWeekNumber(row.weekLabel)) || [])
    ];
    const mergedPhotos = mergePhasePhotoLists(localPhotos, cloudPhotos, row.photoOrder);
    const mergedKeys = mergedPhotos.map(phasePhotoKey);
    return {
      ...row,
      photos: mergedPhotos,
      photoOrder: mergedPhotos.length
        ? normalizePhotoOrder([...normalizePhotoOrder(row.photoOrder).filter((key) => mergedKeys.includes(key)), ...mergedKeys])
        : normalizePhotoOrder(row.photoOrder)
    };
  });
}

function phaseWeekNumber(label) {
  const normalized = String(label || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const match = normalized.match(/\btyden\s*(\d+)/i);
  return match ? Number(match[1]) : null;
}

function mergePhasePhotoLists(localPhotos, cloudPhotos, order = []) {
  const merged = new Map();
  [...localPhotos, ...cloudPhotos].forEach((photo) => {
    const key = photo.cloudId || photo.storagePath || photo.id;
    merged.set(key, photo);
  });
  const photos = [...merged.values()]
    .sort((a, b) => new Date(a.addedAt) - new Date(b.addedAt))
    .slice(-PHASE_PHOTO_LIMIT);
  return orderPhasePhotos(photos, order);
}

function findExistingCloudPhasePhoto(record) {
  const recordId = record.id || "";
  const storagePath = record.storage_path || "";
  for (const row of state.nutritionPhase.rows) {
    const match = row.photos.find((photo) => (
      (recordId && photo.cloudId === recordId) ||
      (storagePath && photo.storagePath === storagePath)
    ));
    if (match) return match;
  }
  return null;
}

function cloudPhasePhotoFromRow(record, url) {
  const existing = findExistingCloudPhasePhoto(record);
  return {
    id: record.id || uid(),
    cloudId: record.id || "",
    phaseRowId: record.phase_row_id || "",
    weekLabel: record.week_label || "",
    name: record.file_name || "Posing photo",
    addedAt: record.created_at || new Date().toISOString(),
    dataUrl: "",
    url: existing?.url || url,
    storagePath: record.storage_path || "",
    width: toNumber(record.width, 0),
    height: toNumber(record.height, 0)
  };
}

async function loadSocialData() {
  if (!cloud.client || !cloud.session) return;
  await Promise.all([loadFeed(), loadLeaderboard(), loadCommunityPosts()]);
}

async function loadCommunityPosts() {
  if (!cloud.client || !cloud.session) return;
  const weekStartDate = parseDate(state.weekStart);
  const weekEndDate = addDays(weekStartDate, 7);
  const { data, error } = await cloud.client
    .from("community_posts")
    .select("id,user_id,body,image_storage_path,image_name,image_width,image_height,image_size,content_type,created_at,updated_at")
    .gte("created_at", weekStartDate.toISOString())
    .lt("created_at", weekEndDate.toISOString())
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    if (!["42P01", "PGRST205"].includes(error.code)) console.warn(error);
    cloud.posts = [];
    return;
  }

  const rows = await attachProfiles(data || []);
  cloud.posts = await Promise.all(rows.map(async (row) => {
    let signedUrl = "";
    if (row.image_storage_path) {
      const { data: signed, error: signedError } = await cloud.client
        .storage
        .from(COMMUNITY_POST_BUCKET)
        .createSignedUrl(row.image_storage_path, COMMUNITY_POST_SIGNED_URL_SECONDS);
      if (signedError) {
        console.warn(signedError);
      } else {
        signedUrl = signed?.signedUrl || "";
      }
    }
    return communityPostFromRow(row, signedUrl);
  }));
}

function communityPostFromRow(row, imageUrl = "") {
  return {
    ...row,
    body: String(row.body || ""),
    imageUrl,
    imageName: row.image_name || "Post fotka",
    imageWidth: toNumber(row.image_width, 0),
    imageHeight: toNumber(row.image_height, 0)
  };
}

function updatePostImagePreview(input) {
  const file = input.files?.[0] || null;
  if (!file) {
    clearPostImageSelection(input.closest("[data-post-form]"));
    return;
  }
  if (!file.type.startsWith("image/")) {
    clearPostImageSelection(input.closest("[data-post-form]"));
    showToast("Vyber prosim obrazek.");
    return;
  }

  if (postComposerPreviewUrl) URL.revokeObjectURL(postComposerPreviewUrl);
  postComposerImageFile = file;
  postComposerPreviewUrl = URL.createObjectURL(file);
  const preview = input.closest("[data-post-form]")?.querySelector("[data-post-preview]");
  if (preview) {
    preview.hidden = false;
    preview.innerHTML = renderPostPreviewMarkup();
  }
}

function clearPostImageSelection(formElement = document.querySelector("[data-post-form]")) {
  if (postComposerPreviewUrl) URL.revokeObjectURL(postComposerPreviewUrl);
  postComposerImageFile = null;
  postComposerPreviewUrl = "";
  const form = formElement || document.querySelector("[data-post-form]");
  const input = form?.querySelector("[data-field='post-image']");
  if (input) input.value = "";
  const preview = form?.querySelector("[data-post-preview]");
  if (preview) {
    preview.hidden = true;
    preview.innerHTML = "";
  }
}

async function createCommunityPost(formElement) {
  if (!cloud.client || !cloud.session) {
    showToast("Pro posty se nejdriv prihlas.");
    return;
  }

  const form = new FormData(formElement);
  const body = String(form.get("body") || "").trim();
  const image = postComposerImageFile || form.get("image");
  const hasImage = image instanceof File && image.size > 0;
  if (!body && !hasImage) {
    showToast("Napis text nebo pridej fotku.");
    return;
  }

  let uploadedPath = "";
  let prepared = null;
  try {
    if (hasImage) {
      prepared = await prepareCompressedPhasePhoto(image);
      uploadedPath = `${cloud.session.user.id}/${Date.now()}-${prepared.id}.jpg`;
      const { error: uploadError } = await cloud.client
        .storage
        .from(COMMUNITY_POST_BUCKET)
        .upload(uploadedPath, prepared.blob, {
          cacheControl: "31536000",
          contentType: "image/jpeg",
          upsert: false
        });
      if (uploadError) throw uploadError;
    }

    const { data, error } = await cloud.client
      .from("community_posts")
      .insert({
        user_id: cloud.session.user.id,
        body,
        image_storage_path: uploadedPath || null,
        image_name: prepared?.name || "",
        image_width: prepared?.width || 0,
        image_height: prepared?.height || 0,
        image_size: prepared?.blob?.size || 0,
        content_type: prepared ? "image/jpeg" : ""
      })
      .select("id,user_id,body,image_storage_path,image_name,image_width,image_height,image_size,content_type,created_at,updated_at")
      .single();

    if (error) throw error;

    let signedUrl = "";
    if (uploadedPath) {
      const { data: signed, error: signedError } = await cloud.client
        .storage
        .from(COMMUNITY_POST_BUCKET)
        .createSignedUrl(uploadedPath, COMMUNITY_POST_SIGNED_URL_SECONDS);
      if (signedError) console.warn(signedError);
      signedUrl = signed?.signedUrl || "";
    }

    formElement.reset();
    clearPostImageSelection(formElement);
    cloud.posts = [
      communityPostFromRow({ ...data, profile: cloud.profile || null }, signedUrl),
      ...cloud.posts
    ].slice(0, 50);
    render();
    showToast("Post pridan.");
  } catch (error) {
    if (uploadedPath) {
      try {
        await cloud.client.storage.from(COMMUNITY_POST_BUCKET).remove([uploadedPath]);
      } catch {
        // Best effort cleanup when DB insert fails after upload.
      }
    }
    console.warn(error);
    showCloudError("Post se nepodarilo pridat.", error, "supabase-posts-patch.sql");
  }
}

async function deleteCommunityPost(postId) {
  if (!cloud.client || !cloud.session || !postId) return;
  const post = cloud.posts.find((item) => item.id === postId);
  if (!post || post.user_id !== cloud.session.user.id) return;
  if (!confirm("Smazat post?")) return;

  const { error } = await cloud.client
    .from("community_posts")
    .delete()
    .eq("id", postId)
    .eq("user_id", cloud.session.user.id);
  if (error) {
    showCloudError("Post se nepodarilo smazat.", error, "supabase-posts-patch.sql");
    return;
  }

  if (post.image_storage_path) {
    const { error: storageError } = await cloud.client
      .storage
      .from(COMMUNITY_POST_BUCKET)
      .remove([post.image_storage_path]);
    if (storageError) console.warn(storageError);
  }

  cloud.posts = cloud.posts.filter((item) => item.id !== postId);
  render();
  showToast("Post smazan.");
}

async function deleteAllCommunityPosts() {
  if (!cloud.client || !cloud.session) return null;
  const userId = cloud.session.user.id;
  const { data, error: listError } = await cloud.client
    .from("community_posts")
    .select("image_storage_path")
    .eq("user_id", userId);
  if (listError) {
    if (["42P01", "PGRST205"].includes(listError.code)) return null;
    throw listError;
  }

  const paths = (data || []).map((post) => post.image_storage_path).filter(Boolean);
  if (paths.length) {
    const { error: storageError } = await cloud.client
      .storage
      .from(COMMUNITY_POST_BUCKET)
      .remove(paths);
    if (storageError) console.warn(storageError);
  }

  const { error } = await cloud.client
    .from("community_posts")
    .delete()
    .eq("user_id", userId);
  if (error) throw error;
  return paths.length;
}

async function loadFeed() {
  const requestId = ++feedLoadSeq;
  const weekStart = state.weekStart;
  const dayIndex = state.selectedDay;
  cloud.feed = cloud.feed.filter((row) => isFeedRowFor(row, weekStart, dayIndex));
  const { data, error } = await cloud.client
    .from("workout_days")
    .select("id,user_id,week_start,day_index,title,focus,payload,volume,completed_sets,total_sets,updated_at")
    .eq("visibility", "public")
    .eq("week_start", weekStart)
    .eq("day_index", dayIndex)
    .gt("total_sets", 0)
    .order("updated_at", { ascending: false })
    .limit(20);

  if (requestId !== feedLoadSeq || weekStart !== state.weekStart || dayIndex !== state.selectedDay) return;
  if (error) {
    cloud.feed = [];
    return;
  }
  const rows = await attachProfiles((data || []).filter((row) => isFeedRowFor(row, weekStart, dayIndex)));
  if (requestId !== feedLoadSeq || weekStart !== state.weekStart || dayIndex !== state.selectedDay) return;
  cloud.feed = rows;
}

async function loadLeaderboard() {
  const [profiles, workoutResult] = await Promise.all([
    loadLeaderboardProfiles(),
    cloud.client
      .from("workout_days")
      .select("id,user_id,week_start,day_index,title,focus,payload,volume,completed_sets,total_sets,updated_at")
      .eq("visibility", "public")
      .eq("week_start", state.weekStart)
      .gt("total_sets", 0)
      .order("day_index", { ascending: true })
      .limit(200)
  ]);

  if (workoutResult.error && !profiles.length) {
    cloud.leaderboard = [];
    return;
  }

  const rows = await attachProfiles(workoutResult.data || []);
  const grouped = new Map();
  profiles.forEach((profile) => {
    grouped.set(profile.id, createLeaderboardEntry(profile));
  });

  rows.forEach((row) => {
    const current = grouped.get(row.user_id) || createLeaderboardEntry(row.profile, row.user_id);
    current.volume += toNumber(row.volume, 0);
    current.completedSets += toNumber(row.completed_sets, 0);
    current.totalSets += toNumber(row.total_sets, 0);
    current.trainingDays += 1;
    current.workouts.push(row);
    grouped.set(row.user_id, current);
  });

  const nutritionByUser = await loadLeaderboardNutrition([...grouped.keys()]);
  nutritionByUser.forEach((nutrition, userId) => {
    if (!grouped.has(userId)) grouped.set(userId, createLeaderboardEntry(null, userId));
  });
  grouped.forEach((row, userId) => {
    row.workouts = row.workouts.sort((a, b) => Number(a.day_index) - Number(b.day_index));
    row.nutrition = nutritionByUser.get(userId) || null;
  });

  cloud.leaderboard = [...grouped.values()]
    .sort(compareLeaderboardRows)
    .slice(0, 100);
}

async function loadLeaderboardProfiles() {
  const { data, error } = await cloud.client
    .from("profiles")
    .select("id,username,display_name,avatar_url")
    .limit(100);
  if (error) {
    if (cloud.profile?.id) return [cloud.profile];
    return [];
  }
  const profiles = data || [];
  if (cloud.profile?.id && !profiles.some((profile) => profile.id === cloud.profile.id)) {
    profiles.push(cloud.profile);
  }
  return profiles;
}

function createLeaderboardEntry(profile = null, userId = "") {
  return {
    userId: profile?.id || userId,
    name: profile?.display_name || profile?.username || "Sportovec",
    profile,
    volume: 0,
    completedSets: 0,
    totalSets: 0,
    trainingDays: 0,
    workouts: [],
    nutrition: null
  };
}

function compareLeaderboardRows(a, b) {
  const byVolume = b.volume - a.volume;
  if (byVolume) return byVolume;
  const byTrainingDays = b.trainingDays - a.trainingDays;
  if (byTrainingDays) return byTrainingDays;
  const byCalories = (b.nutrition?.summary?.totalCalories || 0) - (a.nutrition?.summary?.totalCalories || 0);
  if (byCalories) return byCalories;
  return a.name.localeCompare(b.name, "cs");
}

async function loadLeaderboardNutrition(userIds) {
  const nutritionByUser = new Map();
  if (!userIds.length) return nutritionByUser;

  const { data: rpcData, error: rpcError } = await cloud.client
    .rpc("leaderboard_nutrition_for_week", { target_week: state.weekStart });
  if (!rpcError && Array.isArray(rpcData)) {
    rpcData
      .filter((row) => userIds.includes(row.user_id))
      .forEach((row) => nutritionByUser.set(row.user_id, normalizeLeaderboardNutritionRecord(row)));
    return nutritionByUser;
  }

  const { data, error } = await cloud.client
    .from("nutrition_weeks")
    .select("user_id,week_start,payload,calories,protein,carbs,fat,updated_at")
    .eq("week_start", state.weekStart)
    .in("user_id", userIds)
    .limit(50);

  if (error) return nutritionByUser;
  (data || []).forEach((row) => {
    nutritionByUser.set(row.user_id, normalizeLeaderboardNutritionRecord(row));
  });
  return nutritionByUser;
}

function normalizeLeaderboardNutritionRecord(record) {
  const week = normalizeNutritionWeek(record.payload || {
    goals: record.goals || {},
    days: record.days || []
  });
  const summary = summarizeNutrition(week);
  return {
    week,
    summary: {
      ...summary,
      totalCalories: metricNumber(record.calories, summary.totalCalories),
      totalProtein: metricNumber(record.protein, summary.totalProtein),
      totalCarbs: metricNumber(record.carbs, summary.totalCarbs),
      totalFat: metricNumber(record.fat, summary.totalFat)
    },
    updatedAt: record.updated_at || ""
  };
}

function metricNumber(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
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
    runPendingSyncNow("Cloud ulozeni se nepovedlo.");
  }, 250);
}

function scheduleNutritionSync() {
  if (!cloud.client || !cloud.session || state.activeView !== "nutrition") return;
  clearTimeout(nutritionSyncTimer);
  nutritionSyncTimer = setTimeout(() => {
    runPendingSyncNow("Nutrition cloud ulozeni se nepovedlo.");
  }, 250);
}

function runPendingSyncNow(errorPrefix) {
  clearTimeout(cloudSyncTimer);
  clearTimeout(nutritionSyncTimer);
  cloudSyncTimer = 0;
  nutritionSyncTimer = 0;
  if (!cloud.client || !cloud.session || !hasAnyPendingSync()) return;
  flushPendingSync().catch((error) => {
    console.warn(error);
    showCloudError(errorPrefix, error);
  });
}

async function flushPendingSync() {
  if (flushingPendingSync || !cloud.client || !cloud.session) return;

  const workoutItems = Object.values(pendingSync.workouts);
  const nutritionItems = Object.values(pendingSync.nutrition);
  if (!workoutItems.length && !nutritionItems.length) return;

  flushingPendingSync = true;
  let hadError = false;
  try {
    for (const item of workoutItems) {
      await saveDayToCloud(item.weekStart, Number(item.dayIndex), item.updatedAt);
    }
    for (const item of nutritionItems) {
      await saveNutritionWeekToCloud(item.weekStart, item.updatedAt);
    }
  } catch (error) {
    hadError = true;
    console.warn(error);
    showCloudError("Neulozene zmeny se nepodarilo dosynchronizovat.", error);
  } finally {
    flushingPendingSync = false;
    if (!hadError && hasAnyPendingSync()) scheduleCloudSync();
  }
}

async function saveSelectedDayToCloud() {
  if (!cloud.client || !cloud.session) return;
  await saveDayToCloud(state.weekStart, state.selectedDay);
  if (state.activeView !== "plan") await loadSocialData();
}

async function saveDayToCloud(weekStart, dayIndex, expectedPendingUpdatedAt = null) {
  if (!cloud.client || !cloud.session) return;
  const day = state.weeks[weekStart]?.[dayIndex];
  if (!day) {
    clearPendingWorkoutSyncIfCurrent(weekStart, dayIndex, expectedPendingUpdatedAt);
    return;
  }
  const summary = summarizeDay(day);
  if (summary.totalSets <= 0) {
    await deleteDayFromCloud(weekStart, dayIndex);
    clearPendingWorkoutSyncIfCurrent(weekStart, dayIndex, expectedPendingUpdatedAt);
    return;
  }

  const payload = {
    exercises: day.exercises
  };

  const { data, error } = await cloud.client
    .from("workout_days")
    .upsert({
      user_id: cloud.session.user.id,
      week_start: weekStart,
      day_index: Number(dayIndex),
      title: day.title || "",
      focus: day.focus || "",
      notes: day.notes || "",
      visibility: normalizeVisibility(day.visibility),
      payload,
      volume: summary.volume,
      completed_sets: summary.completed,
      total_sets: summary.totalSets,
      updated_at: new Date().toISOString()
    }, { onConflict: "user_id,week_start,day_index" })
    .select("id,user_id,week_start,day_index,title,focus,visibility,payload,volume,completed_sets,total_sets,updated_at")
    .single();

  if (error) throw error;
  updateFeedCacheRow(data);
  clearPendingWorkoutSyncIfCurrent(weekStart, dayIndex, expectedPendingUpdatedAt);
}

async function deleteDayFromCloud(weekStart, dayIndex) {
  if (!cloud.client || !cloud.session) return;
  const { error } = await cloud.client
    .from("workout_days")
    .delete()
    .eq("user_id", cloud.session.user.id)
    .eq("week_start", weekStart)
    .eq("day_index", Number(dayIndex));
  if (error) throw error;
  removeFeedCacheRow(cloud.session.user.id, weekStart, dayIndex);
}

function updateFeedCacheRow(row) {
  if (!row?.user_id) return;
  const keyMatches = (item) => (
    item.user_id === row.user_id &&
    item.week_start === row.week_start &&
    Number(item.day_index) === Number(row.day_index)
  );
  const existingIndex = cloud.feed.findIndex(keyMatches);
  if (row.visibility !== "public" || toNumber(row.total_sets, 0) <= 0 || !isSelectedFeedRow(row)) {
    if (existingIndex >= 0) cloud.feed.splice(existingIndex, 1);
    return;
  }

  const nextRow = {
    ...row,
    profile: cloud.profile || cloud.feed[existingIndex]?.profile || null
  };
  if (existingIndex >= 0) {
    cloud.feed[existingIndex] = nextRow;
  } else {
    cloud.feed.unshift(nextRow);
  }
  cloud.feed = cloud.feed
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
    .slice(0, 20);
}

function getSelectedFeedRows() {
  const localRow = createLocalSelectedFeedRow();
  const rows = cloud.feed.filter(isSelectedFeedRow);
  if (!localRow) return rows;
  return [
    localRow,
    ...rows.filter((row) => !sameFeedIdentity(row, localRow))
  ].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
}

function createLocalSelectedFeedRow() {
  if (!cloud.session) return null;
  const day = state.weeks[state.weekStart]?.[state.selectedDay];
  if (!day || normalizeVisibility(day.visibility) !== "public") return null;
  const summary = summarizeDay(day);
  if (summary.totalSets <= 0) return null;
  const existing = cloud.feed.find((row) => (
    row.user_id === cloud.session.user.id &&
    row.week_start === state.weekStart &&
    Number(row.day_index) === state.selectedDay
  ));
  const pendingKey = workoutPendingKey(state.weekStart, state.selectedDay);
  return {
    id: existing?.id || `local-${state.weekStart}-${state.selectedDay}`,
    user_id: cloud.session.user.id,
    week_start: state.weekStart,
    day_index: state.selectedDay,
    title: day.title || "",
    focus: day.focus || "",
    payload: { exercises: day.exercises },
    volume: summary.volume,
    completed_sets: summary.completed,
    total_sets: summary.totalSets,
    updated_at: pendingSync.workouts[pendingKey]?.updatedAt || existing?.updated_at || new Date().toISOString(),
    profile: cloud.profile || existing?.profile || null
  };
}

function sameFeedIdentity(a, b) {
  return a.user_id === b.user_id &&
    a.week_start === b.week_start &&
    Number(a.day_index) === Number(b.day_index);
}

function isSelectedFeedRow(row) {
  return isFeedRowFor(row, state.weekStart, state.selectedDay);
}

function isFeedRowFor(row, weekStart, dayIndex) {
  return row.week_start === weekStart && Number(row.day_index) === Number(dayIndex);
}

function removeFeedCacheRow(userId, weekStart, dayIndex) {
  cloud.feed = cloud.feed.filter((item) => !(
    item.user_id === userId &&
    item.week_start === weekStart &&
    Number(item.day_index) === Number(dayIndex)
  ));
}

function rowToDay(row) {
  return normalizeWeek({
    0: {
      title: row.title,
      focus: row.focus,
      notes: row.notes,
      visibility: normalizeVisibility(row.visibility),
      exercises: row.payload?.exercises || []
    }
  })[0];
}

async function saveNutritionToCloud() {
  await saveNutritionWeekToCloud(state.weekStart);
}

async function saveNutritionWeekToCloud(weekStart, expectedPendingUpdatedAt = null) {
  if (!cloud.client || !cloud.session) return;
  if (weekStart === NUTRITION_PHASE_WEEK_START) {
    await saveNutritionPhaseToCloud();
    clearPendingNutritionSyncIfCurrent(weekStart, expectedPendingUpdatedAt);
    return;
  }
  const nutrition = state.nutrition[weekStart];
  if (!nutrition) {
    clearPendingNutritionSyncIfCurrent(weekStart, expectedPendingUpdatedAt);
    return;
  }
  const summary = summarizeNutrition(nutrition);
  const { error } = await cloud.client
    .from("nutrition_weeks")
    .upsert({
      user_id: cloud.session.user.id,
      week_start: weekStart,
      payload: {
        ...nutrition,
        phase: stripPhasePhotosForCloud(state.nutritionPhase)
      },
      calories: summary.totalCalories,
      protein: summary.totalProtein,
      carbs: summary.totalCarbs,
      fat: summary.totalFat,
      latest_weight: summary.latestWeight,
      updated_at: new Date().toISOString()
    }, { onConflict: "user_id,week_start" });

  if (error) throw error;
  await saveNutritionPhaseToCloud();
  clearPendingNutritionSyncIfCurrent(weekStart, expectedPendingUpdatedAt);
}

async function saveNutritionPhaseToCloud() {
  if (!cloud.client || !cloud.session) return;
  const { error } = await cloud.client
    .from("nutrition_weeks")
    .upsert({
      user_id: cloud.session.user.id,
      week_start: NUTRITION_PHASE_WEEK_START,
      payload: {
        phase: stripPhasePhotosForCloud(state.nutritionPhase)
      },
      calories: 0,
      protein: 0,
      carbs: 0,
      fat: 0,
      latest_weight: null,
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

function restoreDefaultLibraryItems() {
  const existing = new Set(state.library.map((item) => item.name.trim().toLowerCase()).filter(Boolean));
  let added = 0;
  createDefaultLibrary().forEach((item) => {
    const key = item.name.trim().toLowerCase();
    if (existing.has(key)) return;
    state.library.push(item);
    existing.add(key);
    added += 1;
  });
  return added;
}

async function copyWorkoutByDates(formElement) {
  const form = new FormData(formElement);
  const sourceDateValue = String(form.get("sourceDate") || "");
  const targetDateValue = String(form.get("targetDate") || "");
  if (!sourceDateValue || !targetDateValue) {
    showToast("Vyber zdrojovy i cilovy datum.");
    return;
  }

  const sourceDate = parseDate(sourceDateValue);
  const targetDate = parseDate(targetDateValue);
  if (Number.isNaN(sourceDate.getTime()) || Number.isNaN(targetDate.getTime())) {
    showToast("Datum neni platne.");
    return;
  }
  if (sourceDateValue === targetDateValue) {
    showToast("Zdroj a cil nemuzou byt stejny den.");
    return;
  }

  const sourceWeekStart = toDateInput(getWeekStart(sourceDate));
  const targetWeekStart = toDateInput(getWeekStart(targetDate));
  const sourceDayIndex = getDayIndex(sourceDate);
  const targetDayIndex = getDayIndex(targetDate);

  try {
    await loadWeekForCopy(sourceWeekStart);
    await loadWeekForCopy(targetWeekStart);
  } catch (error) {
    console.warn(error);
    showCloudError("Kopirovani se nepodarilo pripravit.", error);
    return;
  }

  const sourceDay = state.weeks[sourceWeekStart]?.[sourceDayIndex];
  if (!sourceDay || !hasDayPlanData(sourceDay)) {
    showToast(`${DAY_LABELS[sourceDayIndex][1]} ${formatShortDate(sourceDate)} nema plan.`);
    return;
  }

  const targetWeek = state.weeks[targetWeekStart] || createBlankWeek();
  const targetDay = targetWeek[targetDayIndex];
  if (hasDayPlanData(targetDay) && !confirm(`Prepsat jen ${DAY_LABELS[targetDayIndex][1]} ${formatShortDate(targetDate)} zkopirovanym treningem? Ostatni dny zustanou.`)) {
    return;
  }

  targetWeek[targetDayIndex] = cloneDay(sourceDay, true);
  state.weeks[targetWeekStart] = targetWeek;
  state.weekStart = targetWeekStart;
  state.selectedDay = targetDayIndex;
  ensureNutritionWeek();
  copyDayDialogOpen = false;
  save();
  runPendingSyncNow("Kopirovany den se nepodarilo ulozit do cloudu.");
  render();
  showToast(`Trening z ${formatShortDate(sourceDate)} zkopirovan na ${formatShortDate(targetDate)}.`);
}

async function loadWeekForCopy(weekStart) {
  if (!cloud.client || !cloud.session) {
    if (!state.weeks[weekStart]) state.weeks[weekStart] = createBlankWeek();
    return;
  }

  const cloudWeek = await loadCloudWeekByStart(weekStart);
  if (!cloudWeek) {
    if (!state.weeks[weekStart]) state.weeks[weekStart] = createBlankWeek();
    return;
  }

  const localWeek = state.weeks[weekStart] || createBlankWeek();
  const mergedWeek = createBlankWeek();
  DAY_LABELS.forEach((_, dayIndex) => {
    const pendingKey = workoutPendingKey(weekStart, dayIndex);
    mergedWeek[dayIndex] = pendingSync.workouts[pendingKey]
      ? localWeek[dayIndex]
      : cloudWeek[dayIndex];
  });
  state.weeks[weekStart] = mergedWeek;
  saveLocal();
}

function syncNutritionInputs(sourceInput) {
  const day = sourceInput.dataset.day;
  const field = sourceInput.dataset.nutrition;
  if (day === undefined || !field) return;

  document
    .querySelectorAll("[data-field='nutrition-day']")
    .forEach((input) => {
      if (input !== sourceInput && input.dataset.day === day && input.dataset.nutrition === field) {
        input.value = sourceInput.value;
      }
    });
}

function refreshNutritionSummary() {
  if (state.activeView !== "nutrition") return;
  const nutrition = ensureNutritionWeek();
  const summary = summarizeNutrition(nutrition);

  setText("[data-nutrition-summary='header']", `${formatNumber(summary.totalCalories)}/${formatNumber(nutrition.goals.weeklyCalories)} kcal`);
  setText("[data-nutrition-summary='totalCalories']", formatNumber(summary.totalCalories));
  setText("[data-nutrition-summary='remainingCalories']", formatNumber(summary.remainingCalories));
  setText("[data-nutrition-summary='averageCalories']", formatNumber(summary.averageCalories));
  setText("[data-nutrition-summary='daysLogged']", `${summary.daysLogged}/7`);
  setText("[data-nutrition-summary='progress']", `${summary.progress}%`);
  setText("[data-nutrition-summary='macroTotals']", `${formatNumber(summary.totalProtein)}P / ${formatNumber(summary.totalCarbs)}C / ${formatNumber(summary.totalFat)}F`);

  document.querySelectorAll("[data-nutrition-progress]").forEach((bar) => {
    bar.style.setProperty("--value", `${summary.progress}%`);
  });

  refreshMacroSummary("protein", summary.totalProtein, nutrition.goals.protein * 7);
  refreshMacroSummary("carbs", summary.totalCarbs, nutrition.goals.carbs * 7);
  refreshMacroSummary("fat", summary.totalFat, nutrition.goals.fat * 7);
}

function refreshMacroSummary(key, value, goal) {
  const percent = goal ? Math.min(100, Math.round((value / goal) * 100)) : 0;
  document.querySelectorAll(`[data-macro-row="${key}"]`).forEach((row) => {
    const label = row.querySelector("[data-macro-text]");
    const bar = row.querySelector("[data-macro-progress]");
    if (label) label.textContent = `${formatNumber(value)} / ${formatNumber(goal)} g`;
    if (bar) bar.style.setProperty("--value", `${percent}%`);
  });
}

function setText(selector, text) {
  document.querySelectorAll(selector).forEach((element) => {
    element.textContent = text;
  });
}

function updateNutritionPhase(input) {
  const phase = state.nutritionPhase;
  const field = input.dataset.phase;
  if (!field) return;
  if (field === "goalWeight") {
    phase.goalWeight = normalizeOptionalNumber(input.value);
    return;
  }
  if (field === "mode") {
    phase.mode = ["diet", "bulk", "maintain"].includes(input.value) ? input.value : "diet";
    return;
  }
  phase[field] = input.value;
}

function updateNutritionPhaseRow(input) {
  const row = findNutritionPhaseRow(input.dataset.rowId);
  const field = input.dataset.phaseRow;
  if (!row || !field) return;
  row[field] = ["calories", "weight"].includes(field)
    ? normalizeOptionalNumber(input.value)
    : input.value;
}

function updatePhaseCompare(input) {
  const field = input.dataset.compare;
  if (!field) return;
  if (field === "slotIndex") {
    phaseCompare.slotIndex = Math.max(0, Number(input.value) || 0);
    return;
  }
  if (field === "fromRowId" || field === "toRowId") {
    phaseCompare[field] = input.value;
  }
}

function movePhaseCompareViewer(offset) {
  if (!phaseCompareViewer) return;
  const rowsWithPhotos = phaseRowsWithPhotos();
  if (!rowsWithPhotos.length) return;
  const selection = resolvePhaseCompareViewer(rowsWithPhotos);
  const nextIndex = (selection.slotIndex + offset + selection.maxSlots) % selection.maxSlots;
  phaseCompareViewer.slotIndex = nextIndex;
  phaseCompare.slotIndex = nextIndex;
}

function zoomPhaseCompareViewer(offset) {
  if (!phaseCompareViewer) return;
  setPhaseCompareViewerZoom((Number(phaseCompareViewer.zoom) || 100) + offset);
}

function setPhaseCompareViewerZoom(value) {
  if (!phaseCompareViewer) return;
  phaseCompareViewer.zoom = Math.max(75, Math.min(250, Number(value) || 100));
}

function findNutritionPhaseRow(rowId) {
  if (!rowId) return null;
  return state.nutritionPhase.rows.find((item) => item.id === rowId) || null;
}

function movePhasePhotoViewer(offset) {
  if (!phasePhotoViewer) return;
  const row = findNutritionPhaseRow(phasePhotoViewer.rowId);
  const photos = orderPhasePhotos(row?.photos, row?.photoOrder);
  if (photos.length <= 1) return;
  const index = photos.findIndex((photo) => photo.id === phasePhotoViewer.photoId);
  const nextIndex = (Math.max(0, index) + offset + photos.length) % photos.length;
  phasePhotoViewer = {
    rowId: phasePhotoViewer.rowId,
    photoId: photos[nextIndex].id
  };
}

function movePhasePhotoByOffset(rowId, photoId, offset) {
  const row = findNutritionPhaseRow(rowId);
  const photos = orderPhasePhotos(row?.photos, row?.photoOrder);
  const fromIndex = photos.findIndex((photo) => photo.id === photoId);
  const toIndex = fromIndex + offset;
  if (!row || fromIndex < 0 || toIndex < 0 || toIndex >= photos.length) return false;
  const [moved] = photos.splice(fromIndex, 1);
  photos.splice(toIndex, 0, moved);
  row.photos = photos;
  syncPhasePhotoOrder(row, true);
  openPhasePhotoRows.add(rowId);
  return true;
}

function movePhasePhotoInRow(rowId, photoId, targetId, insertAfter) {
  const row = findNutritionPhaseRow(rowId);
  const photos = orderPhasePhotos(row?.photos, row?.photoOrder);
  const fromIndex = photos.findIndex((photo) => photo.id === photoId);
  const targetIndex = photos.findIndex((photo) => photo.id === targetId);
  if (!row || fromIndex < 0 || targetIndex < 0 || fromIndex === targetIndex) return false;

  const [moved] = photos.splice(fromIndex, 1);
  let insertIndex = photos.findIndex((photo) => photo.id === targetId);
  if (insertIndex < 0) {
    photos.splice(fromIndex, 0, moved);
    return false;
  }
  if (insertAfter) insertIndex += 1;
  photos.splice(insertIndex, 0, moved);
  row.photos = photos;
  syncPhasePhotoOrder(row, true);
  openPhasePhotoRows.add(rowId);
  return true;
}

function addLibraryExercise(id) {
  const item = state.library.find((entry) => entry.id === id);
  if (!item) {
    showToast("Knihovna je prazdna. Pridej vlastni cvik nebo obnov zaklad.");
    return;
  }
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
    cloneDay(value, resetDone)
  ]));
}

function cloneDay(day, resetDone = false) {
  const normalized = normalizeWeek({ 0: day })[0];
  return {
    ...normalized,
    exercises: normalized.exercises.map((exercise) => ({
      ...exercise,
      id: uid(),
      sets: exercise.sets.map((set) => ({
        ...set,
        id: uid(),
        done: resetDone ? false : set.done
      }))
    }))
  };
}

function hasDayPlanData(day) {
  if (!day) return false;
  return Boolean(
    String(day.title || "").trim() ||
    String(day.focus || "").trim() ||
    String(day.notes || "").trim() ||
    day.exercises?.length
  );
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

function isCardioExercise(exercise) {
  return exercise?.muscle === "Kardio";
}

function setMetricLabels(exercise) {
  if (isCardioExercise(exercise)) {
    return {
      reps: "Doba min",
      weight: "Rychlost",
      rpe: "Sklon",
      repsStep: "1",
      weightStep: "0.1",
      rpeMin: "0",
      rpeMax: "30",
      rpeStep: "0.5"
    };
  }
  return {
    reps: "Opak.",
    weight: "Kg",
    rpe: "RPE",
    repsStep: "1",
    weightStep: "0.5",
    rpeMin: "1",
    rpeMax: "10",
    rpeStep: "0.5"
  };
}

function summarizeExerciseVolume(exercise) {
  if (isCardioExercise(exercise)) return 0;
  return (exercise.sets || []).reduce((sum, set) => sum + toNumber(set.reps, 0) * toNumber(set.weight, 0), 0);
}

function summarizeCardioDuration(exercise) {
  if (!isCardioExercise(exercise)) return 0;
  return (exercise.sets || []).reduce((sum, set) => sum + toNumber(set.reps, 0), 0);
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
  const volume = day.exercises.reduce((sum, exercise) => sum + summarizeExerciseVolume(exercise), 0);
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

function summarizeNutritionPhase(phase) {
  const weights = (phase.rows || [])
    .map((row) => normalizeOptionalNumber(row.weight))
    .filter((value) => value !== "")
    .map((value) => toNumber(value, NaN))
    .filter(Number.isFinite);
  const startWeight = weights.length ? weights[0] : null;
  const latestWeight = weights.length ? weights.at(-1) : null;
  const goalWeight = phase.goalWeight === "" ? null : toNumber(phase.goalWeight, NaN);
  const change = startWeight !== null && latestWeight !== null
    ? latestWeight - startWeight
    : null;
  const goalGap = Number.isFinite(goalWeight) && latestWeight !== null
    ? latestWeight - goalWeight
    : null;

  return {
    latestWeight,
    change,
    goalGap
  };
}

function hasNutritionData(nutrition) {
  const defaults = createNutritionWeek();
  const goals = nutrition.goals || {};
  const goalsChanged = Object.keys(defaults.goals)
    .some((key) => toNumber(goals[key], 0) !== defaults.goals[key]);
  const hasDayData = (nutrition.days || []).some((day) => (
    ["calories", "protein", "carbs", "fat", "weight"].some((key) => {
      const value = day[key];
      return value !== "" && value !== null && value !== undefined;
    }) || String(day.notes || "").trim()
  ));
  const hasPhaseData = hasNutritionPhaseData(state.nutritionPhase);

  return goalsChanged || hasDayData || hasPhaseData || Boolean(nutrition.lastCheatMeal);
}

function hasNutritionPhaseData(phaseValue) {
  const phase = normalizeNutritionPhase(phaseValue);
  return Boolean(phase.title || phase.goalWeight) || phase.mode !== "diet" || phase.rows.some((row, index) => (
    row.weekLabel !== `Tyden ${index + 1}` ||
    row.date !== "" ||
    row.calories !== "" ||
    row.weight !== "" ||
    row.note.trim()
  ));
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

function showCloudError(prefix, error, patchFile = "supabase-progress-photos.sql") {
  const rawMessage = String(error?.message || "");
  const lowerMessage = rawMessage.toLowerCase();
  const needsSqlPatch = ["PGRST205", "42P01"].includes(error?.code) ||
    lowerMessage.includes("bucket not found") ||
    lowerMessage.includes("row-level security") ||
    lowerMessage.includes("violates row-level security");
  const message = needsSqlPatch
    ? `${prefix} V Supabase chybi patch. Spust ${patchFile}.`
    : `${prefix} ${rawMessage}`.trim();
  showToast(message);
}

function friendlyAuthError(error) {
  const message = String(error?.message || "").toLowerCase();
  if (message.includes("rate limit") || message.includes("too many") || message.includes("email rate")) {
    return "Supabase ted nepusti dalsi potvrzovaci e-mail, protoze je prekroceny e-mail limit projektu. Zkus to za hodinu, nebo musi majitel appky zapnout vlastni SMTP pro registrace.";
  }
  if (message.includes("email not confirmed") || message.includes("not confirmed")) {
    return "Ucet jeste neni overeny. Otevri potvrzovaci e-mail, klikni na odkaz a potom se prihlas znovu.";
  }
  if (message.includes("invalid login") || message.includes("invalid credentials")) {
    return "E-mail nebo heslo nesedi. Muze to byt spatne heslo, neovereny ucet, nebo jiny e-mail. Zkus zkontrolovat potvrzovaci e-mail, pripadne pouzij zapomenute heslo.";
  }
  if (message.includes("already registered") || message.includes("already been registered")) {
    return "Tenhle e-mail uz ucet ma. Zkus se prihlasit, nebo si nech poslat novy overovaci e-mail.";
  }
  if (message.includes("password")) {
    return "Heslo musi mit aspon 6 znaku.";
  }
  return error?.message || "Akce se nepovedla. Zkus to prosim znovu.";
}

function authRedirectUrl() {
  return `${window.location.origin}${window.location.pathname}`;
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.style.colorScheme = state.theme;
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  let refreshed = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshed) return;
    refreshed = true;
    window.location.reload();
  });

  navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" })
    .then((registration) => registration.update())
    .catch(() => {});
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

function formatPhotoDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("cs-CZ", {
    day: "numeric",
    month: "numeric",
    year: "numeric"
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

function getSelectedDate() {
  return addDays(parseDate(state.weekStart), state.selectedDay);
}

function setSelectedDate(date) {
  const weekStart = getWeekStart(date);
  state.weekStart = toDateInput(weekStart);
  state.selectedDay = getDayIndex(date);
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

function formatDateForDisplay(value) {
  if (!value) return "";
  const date = parseDate(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.getDate()}.${date.getMonth() + 1}.${date.getFullYear()}`;
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
