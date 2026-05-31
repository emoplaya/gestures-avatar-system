/**
 * Template Matcher для распознавания произвольных жестов (букв, слов, фраз).
 *
 * ПРИНЦИП:
 *   1. Пользователь записывает эталонный жест — "это слово «ПРИВЕТ»".
 *   2. Мы сохраняем последовательность landmarks руки за этот жест.
 *   3. В реальном времени на каждом кадре сравниваем "скользящее окно" текущих
 *      кадров со всеми эталонами через Dynamic Time Warping.
 *   4. Если минимальная DTW-дистанция опускается ниже порога — выдаём метку.
 *
 * ПОЧЕМУ DTW, А НЕ ПРАВИЛА:
 *   - Правила не работают для произвольных жестов (нужны эвристики на каждый).
 *   - DTW толерантен к разной скорости произнесения (кто-то показывает Й за
 *     300 мс, кто-то за 800 мс — эталон всё равно совпадёт).
 *   - Толерантен к "паучьим лапкам" — неполному сгибанию, разной амплитуде,
 *     если мы сравниваем НОРМАЛИЗОВАННЫЕ признаки (см. extractFeatures ниже).
 *   - Масштабируется: добавил ещё эталон — работает и он.
 *
 * СЛОЖНОСТЬ: O(N × M) на сравнение двух последовательностей длины N и M.
 *   Для 30 FPS и 2-секундных жестов ≈ 60×60 = 3600 операций × кол-во эталонов.
 *   На 10 эталонов это ~36к операций в кадр — реально.
 */

// ====== Извлечение признаков ======

// Размерности: 40 «позиционных» (20 точек × xy) + 15 «угловых» (3 угла × 5 пальцев) = 55.
// Старые v1-шаблоны были только 40-мерными; новые v2 — 55-мерные. См. process().
export const FEATURE_DIM_V1 = 40;
export const FEATURE_DIM_V2 = 55;
// v3 — отличается от v2 не размерностью признака (всё ещё 55), а длиной
// последовательности (20 равномерных кадров вместо 12 keyframe-извлечённых).
// Старые v2-шаблоны не сравнимы — их отсекает фильтр по длине в load().
export const FEATURE_VERSION = 3;

// Угловые признаки нормированы на [0,1], а позиционные живут в диапазоне
// ~[-3,+3] (нормированы на ширину ладони). Без перевзвешивания углы в L2
// дают всего ~10-15% от общей дистанции, и схожие по форме жесты (Ь/Ъ,
// открытая ладонь под разными углами и т.п.) почти не различаются.
// Вес 3.5 даёт углам ~равную с позициями силу. Дополнительно полезен для
// видео-эталонов: руки автора видео и пользователя имеют разные пропорции
// (длина пальцев), и позиционный вектор отличается сильнее угловой формы.
const ANGLE_WEIGHT = 3.5;

// Цепочки суставов одного пальца: [parent, mcp, pip, dip, tip].
// Для большого parent — это сама CMC, у остальных — запястье.
const FINGER_CHAINS = [
  [0, 1, 2, 3, 4],     // большой
  [0, 5, 6, 7, 8],     // указательный
  [0, 9, 10, 11, 12],  // средний
  [0, 13, 14, 15, 16], // безымянный
  [0, 17, 18, 19, 20], // мизинец
];

function angleAt(a, b, c) {
  // Угол в точке b между лучами ba и bc, нормирован на [0,1] (делим на π).
  const bax = a.x - b.x, bay = a.y - b.y, baz = a.z - b.z;
  const bcx = c.x - b.x, bcy = c.y - b.y, bcz = c.z - b.z;
  const la = Math.sqrt(bax*bax + bay*bay + baz*baz);
  const lb = Math.sqrt(bcx*bcx + bcy*bcy + bcz*bcz);
  if (la < 1e-6 || lb < 1e-6) return 0.5;
  let cos = (bax*bcx + bay*bcy + baz*bcz) / (la * lb);
  if (cos > 1) cos = 1; else if (cos < -1) cos = -1;
  return Math.acos(cos) / Math.PI;
}

/**
 * 15 углов сгибания (по 3 на каждый из 5 пальцев): MCP, PIP, DIP.
 *
 * Зачем: углы сгиба пальцев — внутреннее свойство позы кисти, почти
 * не зависят от направления камеры. Это даёт устойчивость к смене
 * ракурса, которой нет у чисто позиционных признаков.
 */
function extractAngleFeatures(lm) {
  const out = new Float32Array(15);
  let i = 0;
  for (const [p, mcp, pip, dip, tip] of FINGER_CHAINS) {
    out[i++] = angleAt(lm[p],   lm[mcp], lm[pip]);
    out[i++] = angleAt(lm[mcp], lm[pip], lm[dip]);
    out[i++] = angleAt(lm[pip], lm[dip], lm[tip]);
  }
  return out;
}

/**
 * Превращает сырые landmarks (21 точка) в нормализованный вектор признаков.
 *
 * Почему не брать сырые x/y/z? Потому что:
 *   - Рука может быть ближе/дальше от камеры (нужен scale invariance).
 *   - Рука может быть в любой точке кадра (нужен translation invariance).
 *   - Нас интересует ФОРМА руки и ЕЁ изменение, а не абсолютное положение.
 *
 * Признаки 55-мерные:
 *   - [0..40)  — 20 относительных координат точек относительно запястья,
 *                в единицах «ширина ладони» (расстояние wrist → middle_MCP).
 *                Дают точное описание формы под фиксированным ракурсом.
 *   - [40..55) — 15 углов сгибания пальцев (по 3 на палец), нормированных
 *                на [0,1]. Углы — внутреннее свойство кисти, почти не
 *                меняются при повороте руки относительно камеры → даёт
 *                кроссугловую устойчивость.
 *
 * Если нужны только старые 40-мерные признаки (для совместимости со
 * старыми шаблонами v1), используйте extractFeaturesV1().
 */
export function extractFeatures(lm) {
  if (!lm || lm.length < 21) return null;

  const wrist = lm[0];
  const middleMcp = lm[9];

  const palmWidth = Math.hypot(
    middleMcp.x - wrist.x,
    middleMcp.y - wrist.y,
  );
  if (palmWidth < 1e-5) return null;

  const features = new Float32Array(FEATURE_DIM_V2);
  for (let i = 1; i < 21; i++) {
    features[(i - 1) * 2]     = (lm[i].x - wrist.x) / palmWidth;
    features[(i - 1) * 2 + 1] = (lm[i].y - wrist.y) / palmWidth;
  }
  const angles = extractAngleFeatures(lm);
  for (let i = 0; i < angles.length; i++) {
    features[FEATURE_DIM_V1 + i] = angles[i] * ANGLE_WEIGHT;
  }
  return features;
}

export function extractFeaturesV1(lm) {
  if (!lm || lm.length < 21) return null;
  const wrist = lm[0];
  const middleMcp = lm[9];
  const palmWidth = Math.hypot(
    middleMcp.x - wrist.x,
    middleMcp.y - wrist.y,
  );
  if (palmWidth < 1e-5) return null;
  const features = new Float32Array(FEATURE_DIM_V1);
  for (let i = 1; i < 21; i++) {
    features[(i - 1) * 2]     = (lm[i].x - wrist.x) / palmWidth;
    features[(i - 1) * 2 + 1] = (lm[i].y - wrist.y) / palmWidth;
  }
  return features;
}

/**
 * Евклидова дистанция между двумя векторами признаков.
 */
function featureDistance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

/**
 * Возвращает копию вектора признаков с зеркалированными X-координатами.
 *
 * Зачем: видео-эталон часто снят с противоположного ракурса (или жест в нём
 * показан другой рукой). Чисто позиционные признаки тогда «развёрнуты»
 * относительно того, что видит live-камера, и DTW даёт большую дистанцию
 * даже для правильного жеста. Углы инвариантны к зеркалу, X-координаты
 * меняют знак, Y/Z остаются. После негации X получаем «как если бы жест
 * показали с другой стороны» — берём min из двух дистанций.
 */
function mirrorFeatures(f) {
  const out = new Float32Array(f.length);
  // Позиционный блок: 20 точек × (x,y). Негируем x.
  for (let i = 0; i < FEATURE_DIM_V1; i += 2) {
    out[i]     = -f[i];     // x → -x
    out[i + 1] =  f[i + 1]; // y без изменений
  }
  // Угловой блок: инвариантен к зеркалу, копируем как есть.
  for (let i = FEATURE_DIM_V1; i < f.length; i++) {
    out[i] = f[i];
  }
  return out;
}

/**
 * Обрезает последовательность признаков до окна реальной активности.
 *
 * Зачем: live-буфер всегда 60 кадров (~2 сек), но реальный жест занимает
 * только часть этого окна — остальное это статичная «поза готовности»
 * до и после жеста. extractKeyframes на таких данных не находит экстремумов
 * Δ и падает на равномерный fallback (видно как «индексы [0, 30, 59]» в
 * отладке), сравнивает статичную фоновую копию с шаблоном движения и
 * получает большие дистанции даже для правильного жеста.
 *
 * Та же логика, что и trimToMotionWindow для видео-эталонов — чтобы
 * live-окно и шаблон проходили одну и ту же подготовку.
 */
function trimToActiveWindow(features, ratio = 0.2, pad = 2) {
  if (!features || features.length < 4) return features;
  const deltas = new Float32Array(features.length);
  let peak = 0;
  for (let i = 1; i < features.length; i++) {
    deltas[i] = featureDistance(features[i], features[i - 1]);
    if (deltas[i] > peak) peak = deltas[i];
  }
  if (peak < 1e-3) return features;
  const cutoff = peak * ratio;
  let first = -1, last = -1;
  for (let i = 0; i < features.length; i++) {
    if (deltas[i] >= cutoff) {
      if (first === -1) first = i;
      last = i;
    }
  }
  if (first === -1) return features;
  const lo = Math.max(0, first - pad);
  const hi = Math.min(features.length - 1, last + pad);
  return features.slice(lo, hi + 1);
}

/**
 * Центроид последовательности — поэлементное среднее всех кадров.
 *
 * Зачем: дешёвый (O(длина·dim), считается один раз на эталон) «отпечаток»
 * жеста. Дистанция между центроидами live-окна и эталона коррелирует с
 * настоящей DTW-дистанцией, но считается мгновенно. Используем её НЕ для
 * отсева (это исказило бы распознавание), а только чтобы отсортировать
 * эталоны и первым посчитать самый перспективный — он задаёт жёсткий
 * потолок для early-abandoning DTW на остальных. Результат при этом
 * остаётся точным.
 */
function computeCentroid(seq) {
  if (!seq || seq.length === 0) return null;
  const dim = seq[0].length;
  const c = new Float32Array(dim);
  for (const f of seq) {
    for (let i = 0; i < dim; i++) c[i] += f[i];
  }
  for (let i = 0; i < dim; i++) c[i] /= seq.length;
  return c;
}

// ====== Dynamic Time Warping ======

/**
 * DTW: сравнивает две последовательности признаков.
 * Возвращает усреднённую дистанцию (нормализованную на длину пути, чтобы
 * эталоны разной длины сравнивались честно).
 *
 * Параметр `bandSize` — ограничение Саковое (Sakoe-Chiba band): путь может
 * отклоняться от диагонали не более чем на bandSize кадров. Это:
 *   - Ускоряет вычисление (не O(N×M), а O(N × bandSize)).
 *   - Предотвращает "патологические" выравнивания, где половина эталона
 *     мапится в один кадр.
 *
 * Параметр `ceiling` — нормализованная дистанция, выше которой результат
 * нам уже неинтересен (нашли эталон лучше, либо это заведомо выше порога
 * матча). Стоимости DTW неотрицательны, поэтому если минимум текущей строки
 * уже превысил ceiling·(n+m) — итог гарантированно будет ещё больше, и расчёт
 * можно прервать (early abandoning). Это НЕ меняет итоговый best-матч: мы
 * обрываем только заведомо проигрышные сравнения. По умолчанию Infinity.
 */
function dtw(seqA, seqB, bandSize = 15, ceiling = Infinity) {
  const n = seqA.length;
  const m = seqB.length;
  if (n === 0 || m === 0) return Infinity;

  const INF = 1e9;
  // Порог обрыва в «сырых» единицах (до нормализации на длину пути n+m).
  const ceilingRaw = ceiling === Infinity ? Infinity : ceiling * (n + m);
  // Работаем на двух строках таблицы — память O(M), не O(N×M).
  let prev = new Float32Array(m + 1).fill(INF);
  let curr = new Float32Array(m + 1).fill(INF);
  prev[0] = 0;

  for (let i = 1; i <= n; i++) {
    curr.fill(INF);
    const jMin = Math.max(1, i - bandSize);
    const jMax = Math.min(m, i + bandSize);
    let rowMin = INF;
    for (let j = jMin; j <= jMax; j++) {
      const cost = featureDistance(seqA[i - 1], seqB[j - 1]);
      const v = cost + Math.min(prev[j - 1], prev[j], curr[j - 1]);
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    // Дальнейший путь только добавляет стоимость — если уже за потолком,
    // финальная дистанция точно будет выше. Прерываем.
    if (rowMin > ceilingRaw) return Infinity;
    [prev, curr] = [curr, prev];
  }
  const raw = prev[m];
  // Нормализуем на длину пути (прибл. n + m).
  return raw / (n + m);
}

// ====== Препроцессинг эталонов ======

/**
 * Приводит эталон к канонической длине (по умолчанию 40 кадров).
 * Равномерное прореживание/интерполяция.
 *
 * Это делает DTW детерминированным по стоимости: мы всегда сравниваем
 * ~40×текущее_окно. Плюс убирает эффект, когда пользователь записал
 * эталон в 100 кадров, а живое окно 30 кадров и DTW склоняется к
 * быстрому «прохождению» через эталон.
 */
const CANONICAL_LENGTH = 40;

function resampleSequence(seq, targetLen = CANONICAL_LENGTH) {
  if (seq.length === 0) return [];
  if (seq.length === targetLen) return seq;
  const out = new Array(targetLen);
  for (let i = 0; i < targetLen; i++) {
    const srcIdx = Math.round((i / (targetLen - 1)) * (seq.length - 1));
    out[i] = seq[srcIdx];
  }
  return out;
}

import { api } from "./api";
import { useGestureRecorder } from "../hooks/useGestureRecorder";

// Вызывается после серверной мутации шаблонов: сервер мог каскадно
// удалить парные записи (анимации), поэтому подтягиваем актуальный
// список и оповещаем подписчиков через tick. См. server/index.js.
function notifyTemplatesChanged() {
  try {
    const recorder = useGestureRecorder.getState();
    recorder.fetchRecordings?.();
    recorder.bumpTick?.();
  } catch {
    /* ignore — hook may not be initialised yet */
  }
}

// ====== Основной класс ======

const LIVE_WINDOW_FRAMES = 60;   // скользящее окно для онлайн-матчинга
// Интервал между попытками матчинга. MediaPipe шлёт ~30 кадров/сек, но
// делать тяжёлый pipeline (trim + keyframes + DTW × N шаблонов) каждый кадр
// — это блокирует основной поток и UI начинает подвисать. На 10Hz матчинг
// неощутим для пользователя, но главному потоку дышится свободнее.
const MATCH_INTERVAL_MS = 100;
// Порог 0.8 — компромисс: распознавание чаще срабатывает, но возможны
// ложноположительные на похожих жестах. Если ловит «не тот» жест —
// записывай больше эталонов одной метки или снижай порог обратно.
const DEFAULT_MATCH_THRESHOLD = 0.8;
// Минимальная пиковая Δ кадр-к-кадру в активном окне, чтобы вообще
// рассматривать матч. Статичная рука даёт jitter ~0.05-0.1, реальный
// жест — 0.3+. Порог 0.25 фильтрует «ничего не происходит».
const MIN_MOTION_PEAK = 0.25;
const COOLDOWN_MS = 1500;        // после матча не матчим 1.5 сек
// Каноническая длина последовательности признаков — все эталоны и live-окна
// равномерно ресемплятся к ней. Старый подход через extractKeyframes (12
// «ключевых» кадров по экстремумам Δ) выкинут: для непрерывных жестов
// (типа О, Ю — рисование фигуры в воздухе) экстремумов нет, на выходе
// получалось 3 равномерные точки → потеря всей формы → дистанции 1.5+.
// Равномерный downsampling 20 кадров сохраняет форму при любом паттерне
// движения. DTW сам обрабатывает временные сдвиги.
const CANONICAL_FRAMES_LEN = 20;

export class TemplateMatcher {
  constructor() {
    // templates: [{id, label, features, rawLength, keyframeIndices, createdAt}]
    this.templates = [];
    this.liveBuffer = [];   // сырые Float32Array — последние кадры для извлечения keyframes
    this.lastMatchAt = 0;
    this.lastMatchAttemptAt = 0;  // для throttling — последняя попытка матчинга
    this.lastReport = null;  // для отладки
    // Отладочные поля — что алгоритм «видит» сейчас.
    this.lastLiveKeyframes = null;  // {indices, deltaSignal}
  }

  /**
   * Добавляет эталон. framesRaw — массив {lm, t} кадров записи.
   * Сжимает последовательность до ключевых кадров (extractKeyframes).
   *
   * ВАЖНО: запись в backend происходит асинхронно. Локально template
   * добавляется сразу — UI не ждёт сети. На ошибке сети мы оставляем его
   * в памяти (распознавание работает), но логируем — он не выживет
   * перезагрузку страницы.
   */
  addTemplate(label, framesRaw) {
    if (!framesRaw || framesRaw.length < 4) {
      throw new Error("Эталон должен содержать минимум 4 кадра");
    }
    const features = [];
    for (const f of framesRaw) {
      const ft = extractFeatures(f.lm);
      if (ft) features.push(ft);
    }
    if (features.length < 4) {
      throw new Error("В эталоне слишком мало валидных кадров");
    }

    // Обрезаем до окна реальной активности (выкидываем «висение» в начале
    // и конце записи) и равномерно ресемплим к CANONICAL_FRAMES_LEN.
    // Никаких keyframe-эвристик — DTW сам разберётся с временным сдвигом.
    const trimmed = trimToActiveWindow(features);
    if (trimmed.length < 4) {
      throw new Error("После обрезки осталось слишком мало кадров");
    }
    const canonical = resampleSequence(trimmed, CANONICAL_FRAMES_LEN);

    const template = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      label: label.trim(),
      features: canonical,
      centroid: computeCentroid(canonical),
      featureVersion: FEATURE_VERSION,
      rawLength: features.length,
      trimmedLength: trimmed.length,
      createdAt: Date.now(),
    };
    this.templates.push(template);
    // Async fire-and-forget. Сериализуем Float32Array → массив для JSON.
    api.createTemplate({
      id: template.id,
      label: template.label,
      features: template.features.map(f => Array.from(f)),
      featureVersion: template.featureVersion,
      rawLength: template.rawLength,
      trimmedLength: template.trimmedLength,
      createdAt: template.createdAt,
    }).catch(e => console.warn("[matcher] Не удалось сохранить эталон:", e));
    return template;
  }

  removeTemplate(id) {
    this.templates = this.templates.filter(t => t.id !== id);
    api.deleteTemplate(id)
      .then(notifyTemplatesChanged)
      .catch(e => console.warn("[matcher] Не удалось удалить эталон:", e));
  }

  /**
   * Удаляет все эталоны с данной меткой.
   */
  removeByLabel(label) {
    const removed = this.templates.filter(t => t.label === label);
    this.templates = this.templates.filter(t => t.label !== label);
    Promise.all(removed.map(t => api.deleteTemplate(t.id)))
      .then(notifyTemplatesChanged)
      .catch(e => console.warn("[matcher] Не удалось удалить эталоны по метке:", e));
  }

  clear() {
    this.templates = [];
    api.clearTemplates()
      .then(notifyTemplatesChanged)
      .catch(e => console.warn("[matcher] Не удалось очистить эталоны:", e));
  }

  /**
   * Загрузить эталоны с backend. Возвращает promise с кол-вом загруженных.
   * Этот метод заменяет старый sync load() — все вызывающие места теперь
   * могут (но не обязаны) ждать его.
   */
  async load() {
    try {
      const data = await api.listTemplates();
      const all = (Array.isArray(data) ? data : []).map(t => {
        const features = (t.features || []).map(f => new Float32Array(f));
        const dim = features[0]?.length || 0;
        return {
          ...t,
          features,
          centroid: computeCentroid(features),
          _dim: dim,
          _len: features.length,
        };
      });
      // Принимаем только v3-шаблоны: 55-мерные признаки и длина
      // последовательности CANONICAL_FRAMES_LEN. Старые v1/v2 не сравнимы
      // — у них другая длина (12 keyframe-кадров) и/или размерность (40).
      this.templates = all.filter(t => {
        if (t._dim === FEATURE_DIM_V2 && t._len === CANONICAL_FRAMES_LEN) return true;
        console.warn(`[matcher] пропускаю эталон ${t.id} (dim=${t._dim} len=${t._len}) — не соответствует v3 формату`);
        return false;
      });
      return this.templates.length;
    } catch (e) {
      console.warn("[matcher] Не удалось загрузить эталоны:", e);
      return 0;
    }
  }

  /**
   * В реальном времени: подаём landmarks на каждом кадре.
   * Возвращает {label, distance, confidence} если матч, иначе null.
   */
  process(lm, now) {
    const ft = extractFeatures(lm);
    if (!ft) {
      // Рука пропала — сбрасываем буфер, чтобы не тянуть «дыру» в матчинг.
      this.liveBuffer = [];
      this.lastLiveKeyframes = null;
      return null;
    }

    this.liveBuffer.push(ft);
    if (this.liveBuffer.length > LIVE_WINDOW_FRAMES) {
      this.liveBuffer.shift();
    }

    if (this.liveBuffer.length < 10) return null;
    if (this.templates.length === 0) return null;
    if (now - this.lastMatchAt < COOLDOWN_MS) return null;
    // Throttle тяжёлого pipeline — буфер по-прежнему обновляется каждый
    // кадр, но матчинг происходит не чаще MATCH_INTERVAL_MS.
    if (now - this.lastMatchAttemptAt < MATCH_INTERVAL_MS) return null;
    this.lastMatchAttemptAt = now;

    // Обрезаем live-буфер до окна реальной активности — выкидываем «висение»
    // до и после жеста, иначе сравниваем разбавленный пустотой live с
    // компактным эталоном.
    const active = trimToActiveWindow(this.liveBuffer);
    if (active.length < 4) return null;

    // Motion-gate: если в активной части жеста нет (jitter ~ peak), не
    // пытаемся матчить — статичный live дал бы случайный «ближайший»
    // шаблон с большой дистанцией.
    let activePeak = 0;
    for (let i = 1; i < active.length; i++) {
      const d = featureDistance(active[i], active[i - 1]);
      if (d > activePeak) activePeak = d;
    }
    if (activePeak < MIN_MOTION_PEAK) return null;

    // Равномерный downsampling к канонической длине. Никаких keyframe-
    // эвристик — это надёжнее работает для непрерывных жестов (когда
    // нет чётких пауз для detection экстремумов Δ).
    const live = resampleSequence(active, CANONICAL_FRAMES_LEN);
    // Зеркальная копия — для матчинга с эталонами противоположного ракурса.
    const liveMirror = live.map(mirrorFeatures);

    this.lastLiveKeyframes = {
      indices: [],
      activeLen: active.length,
      activePeak,
    };

    // Центроиды live-окна (и его зеркала) — дешёвый «отпечаток» для
    // сортировки эталонов. Зеркало центроида = центроид зеркала (операция
    // линейна), поэтому усреднять mirror-кадры заново не нужно.
    const liveCentroid = computeCentroid(live);
    const liveMirrorCentroid = liveCentroid ? mirrorFeatures(liveCentroid) : null;

    // Сортируем эталоны по близости центроида: самый перспективный считаем
    // первым, он задаёт жёсткий потолок для early-abandoning DTW остальных.
    const order = this.templates.map((tpl) => {
      let lb = 0;
      if (liveCentroid && tpl.centroid) {
        const dn = featureDistance(liveCentroid, tpl.centroid);
        const dm = featureDistance(liveMirrorCentroid, tpl.centroid);
        lb = Math.min(dn, dm);
      }
      return { tpl, lb };
    });
    order.sort((a, b) => a.lb - b.lb);

    const scores = [];
    let best = { distance: Infinity, template: null };
    // Потолок обрыва: дистанция выше порога матча нам не нужна в принципе,
    // поэтому стартуем с него — заведомо непохожие эталоны обрываются на
    // первых строках DTW. По мере нахождения хороших кандидатов потолок
    // опускается до текущего лучшего → ещё агрессивнее режем расчёты.
    for (const { tpl } of order) {
      const ceiling = Math.min(best.distance, DEFAULT_MATCH_THRESHOLD);
      const dNormal = dtw(live, tpl.features, 15, ceiling);
      // Для зеркала потолок можно ещё опустить — уже знаем dNormal.
      const dMirror = dtw(liveMirror, tpl.features, 15, Math.min(ceiling, dNormal));
      const d = Math.min(dNormal, dMirror);
      // d === Infinity означает «оборвали как заведомо хуже порога/лучшего».
      // Для отладочного отчёта это эквивалент «далеко» — так и показываем.
      scores.push({ label: tpl.label, distance: d });
      if (d < best.distance) {
        best = { distance: d, template: tpl };
      }
    }

    scores.sort((a, b) => a.distance - b.distance);
    this.lastReport = {
      top: scores.slice(0, 3),
      bufferSize: this.liveBuffer.length,
      activeLen: active.length,
      activePeak,
    };

    if (best.distance < DEFAULT_MATCH_THRESHOLD) {
      this.lastMatchAt = now;
      this.liveBuffer = [];
      this.lastLiveKeyframes = null;
      const confidence = Math.max(0, 1 - best.distance / DEFAULT_MATCH_THRESHOLD);
      return {
        label: best.template.label,
        distance: best.distance,
        confidence,
      };
    }
    return null;
  }

  getDebug() {
    return {
      templatesCount: this.templates.length,
      liveBufferSize: this.liveBuffer.length,
      lastReport: this.lastReport,
      onCooldown: Date.now() - this.lastMatchAt < COOLDOWN_MS,
      activeLen: this.lastLiveKeyframes?.activeLen || 0,
      activePeak: this.lastLiveKeyframes?.activePeak || 0,
    };
  }

  getTemplates() {
    return this.templates.map(t => ({
      id: t.id,
      label: t.label,
      createdAt: t.createdAt,
      rawLength: t.rawLength,
      trimmedLength: t.trimmedLength,
      frameCount: t.features.length,
    }));
  }

  /**
   * Для настройки: позволить изменить threshold.
   */
  setThreshold(value) {
    this.threshold = value;
  }
}
