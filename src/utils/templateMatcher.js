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

/**
 * Превращает сырые landmarks (21 точка) в нормализованный вектор признаков.
 *
 * Почему не брать сырые x/y/z? Потому что:
 *   - Рука может быть ближе/дальше от камеры (нужен scale invariance).
 *   - Рука может быть в любой точке кадра (нужен translation invariance).
 *   - Нас интересует ФОРМА руки и ЕЁ изменение, а не абсолютное положение.
 *
 * Признаки:
 *   - 20 относительных координат точек относительно запястья, в единицах
 *     "ширина ладони" (расстояние wrist → middle_MCP).
 *   - Итого 40 чисел (x, y) на кадр. Z не используем — он шумный у MediaPipe.
 *
 * Это даёт инвариантность к положению и масштабу руки в кадре.
 */
export function extractFeatures(lm) {
  if (!lm || lm.length < 21) return null;

  const wrist = lm[0];
  const middleMcp = lm[9];

  // Ширина ладони как метрика масштаба.
  const palmWidth = Math.hypot(
    middleMcp.x - wrist.x,
    middleMcp.y - wrist.y,
  );
  if (palmWidth < 1e-5) return null;

  const features = new Float32Array(40); // 20 точек × 2 (x, y)
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
 */
function dtw(seqA, seqB, bandSize = 15) {
  const n = seqA.length;
  const m = seqB.length;
  if (n === 0 || m === 0) return Infinity;

  const INF = 1e9;
  // Работаем на двух строках таблицы — память O(M), не O(N×M).
  let prev = new Float32Array(m + 1).fill(INF);
  let curr = new Float32Array(m + 1).fill(INF);
  prev[0] = 0;

  for (let i = 1; i <= n; i++) {
    curr.fill(INF);
    const jMin = Math.max(1, i - bandSize);
    const jMax = Math.min(m, i + bandSize);
    for (let j = jMin; j <= jMax; j++) {
      const cost = featureDistance(seqA[i - 1], seqB[j - 1]);
      curr[j] = cost + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
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

import { extractKeyframes } from "./keyframeExtractor";
import { api } from "./api";

// ====== Основной класс ======

const LIVE_WINDOW_FRAMES = 60;   // скользящее окно для онлайн-матчинга
const DEFAULT_MATCH_THRESHOLD = 0.45;  // ниже = точнее
const COOLDOWN_MS = 1500;        // после матча не матчим 1.5 сек
const CANONICAL_KEYFRAMES_LEN = 12;  // все эталоны и живые окна приводим к этой длине после extractKeyframes

export class TemplateMatcher {
  constructor() {
    // templates: [{id, label, features, rawLength, keyframeIndices, createdAt}]
    this.templates = [];
    this.liveBuffer = [];   // сырые Float32Array — последние кадры для извлечения keyframes
    this.lastMatchAt = 0;
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

    // Извлекаем ключевые кадры по экстремумам Δ(t).
    // Это даёт сжатие ~5-10× и шумоподавление.
    const { keyframes, indices } = extractKeyframes(features);

    // Приводим к канонической длине — для DTW нужны равные по длине
    // последовательности, чтобы дистанции были сопоставимы между эталонами.
    const canonical = resampleSequence(keyframes, CANONICAL_KEYFRAMES_LEN);

    const template = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      label: label.trim(),
      features: canonical,
      rawLength: features.length,
      keyframeIndices: indices,  // для отладки — на каких кадрах сработали экстремумы
      createdAt: Date.now(),
    };
    this.templates.push(template);
    // Async fire-and-forget. Сериализуем Float32Array → массив для JSON.
    api.createTemplate({
      id: template.id,
      label: template.label,
      features: template.features.map(f => Array.from(f)),
      rawLength: template.rawLength,
      keyframeIndices: template.keyframeIndices,
      createdAt: template.createdAt,
    }).catch(e => console.warn("[matcher] Не удалось сохранить эталон:", e));
    return template;
  }

  removeTemplate(id) {
    this.templates = this.templates.filter(t => t.id !== id);
    api.deleteTemplate(id).catch(e =>
      console.warn("[matcher] Не удалось удалить эталон:", e),
    );
  }

  /**
   * Удаляет все эталоны с данной меткой.
   */
  removeByLabel(label) {
    const removed = this.templates.filter(t => t.label === label);
    this.templates = this.templates.filter(t => t.label !== label);
    Promise.all(removed.map(t => api.deleteTemplate(t.id))).catch(e =>
      console.warn("[matcher] Не удалось удалить эталоны по метке:", e),
    );
  }

  clear() {
    this.templates = [];
    api.clearTemplates().catch(e =>
      console.warn("[matcher] Не удалось очистить эталоны:", e),
    );
  }

  /**
   * Загрузить эталоны с backend. Возвращает promise с кол-вом загруженных.
   * Этот метод заменяет старый sync load() — все вызывающие места теперь
   * могут (но не обязаны) ждать его.
   */
  async load() {
    try {
      const data = await api.listTemplates();
      this.templates = (Array.isArray(data) ? data : []).map(t => ({
        ...t,
        features: (t.features || []).map(f => new Float32Array(f)),
      }));
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

    // КЛЮЧЕВОЕ УЛУЧШЕНИЕ: вместо DTW на 60 сырых кадров, извлекаем
    // ключевые кадры (экстремумы Δ) и работаем с ними. Это:
    //   - сжимает данные ~5-6× (с 60 кадров до ~10);
    //   - ускоряет DTW ~30× (O(60×12) → O(10×12));
    //   - подавляет шум (мелкое дрожание не создаёт экстремумов).
    const { keyframes, indices, delta } = extractKeyframes(this.liveBuffer, {
      minCount: 3,
      maxCount: CANONICAL_KEYFRAMES_LEN,
    });
    this.lastLiveKeyframes = { indices, delta };

    if (keyframes.length < 3) return null;

    // Приводим к той же канонической длине, что и эталоны.
    const live = resampleSequence(keyframes, CANONICAL_KEYFRAMES_LEN);

    const scores = [];
    let best = { distance: Infinity, template: null };

    for (const tpl of this.templates) {
      const d = dtw(live, tpl.features);
      scores.push({ label: tpl.label, distance: d });
      if (d < best.distance) {
        best = { distance: d, template: tpl };
      }
    }

    scores.sort((a, b) => a.distance - b.distance);
    this.lastReport = {
      top: scores.slice(0, 3),
      bufferSize: this.liveBuffer.length,
      keyframeCount: keyframes.length,
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
      liveKeyframeCount: this.lastLiveKeyframes?.indices?.length || 0,
      liveKeyframeIndices: this.lastLiveKeyframes?.indices || [],
    };
  }

  getTemplates() {
    return this.templates.map(t => ({
      id: t.id,
      label: t.label,
      createdAt: t.createdAt,
      rawLength: t.rawLength,
      keyframeCount: t.keyframeIndices?.length || t.features.length,
    }));
  }

  /**
   * Для настройки: позволить изменить threshold.
   */
  setThreshold(value) {
    this.threshold = value;
  }
}
