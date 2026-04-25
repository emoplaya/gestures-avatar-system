/**
 * Keyframe extractor — извлекает «ключевые» кадры из последовательности
 * признаков руки, основываясь на экстремумах Δ(t) — скорости изменения формы.
 *
 * Идея:
 *   - Между соседними кадрами считаем Δ = евклидова дистанция между векторами
 *     признаков. Δ ≈ 0 когда рука зафиксирована; Δ большое когда рука в движении.
 *   - Находим ЛОКАЛЬНЫЕ МИНИМУМЫ Δ(t) — это моменты, когда форма руки
 *     временно стабильна. Это семантически значимые кадры: стартовая поза,
 *     конечная поза, точки фиксации между переходами.
 *   - Также всегда включаем первый и последний кадр последовательности —
 *     границы жеста важны сами по себе.
 *
 * Профит:
 *   - Сжатие: вместо 60 кадров — 5-10 ключевых.
 *   - Шумоподавление: мелкое дрожание не создаёт экстремумов.
 *   - Ускорение DTW: сложность падает с O(60×60) до O(10×10).
 */

function euclidean(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

function movingAverage(arr, window) {
  if (window <= 1) return arr.slice();
  const half = Math.floor(window / 2);
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let s = 0, n = 0;
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (j < 0 || j >= arr.length) continue;
      s += arr[j]; n++;
    }
    out[i] = n ? s / n : 0;
  }
  return out;
}

/**
 * Находит индексы локальных минимумов в сглаженном сигнале Δ.
 * Использует АДАПТИВНЫЙ порог — процент от максимума, чтобы работать с
 * разной скоростью жестикуляции и физиологией.
 *
 * Параметры:
 *   thresholdRatio — доля от max(Δ), ниже которой значение считается
 *     «низким». Только в низких участках ищем минимумы. Default 0.5.
 *   minGap — минимальное число кадров между соседними минимумами
 *     (чтобы дрожание не давало 10 экстремумов подряд). Default 3.
 */
function findLocalMinima(signal, thresholdRatio = 0.5, minGap = 3) {
  if (signal.length < 3) return [];

  let maxV = 0;
  for (const v of signal) if (v > maxV) maxV = v;
  if (maxV <= 1e-9) {
    // Сигнал почти плоский — рука неподвижна. Возвращаем середину как
    // единственный «минимум».
    return [Math.floor(signal.length / 2)];
  }
  const cutoff = maxV * thresholdRatio;

  // Находим интервалы, где signal <= cutoff (зоны «низкой» скорости).
  const lowZones = [];
  let start = -1;
  for (let i = 0; i < signal.length; i++) {
    if (signal[i] <= cutoff) {
      if (start === -1) start = i;
    } else if (start !== -1) {
      lowZones.push([start, i - 1]);
      start = -1;
    }
  }
  if (start !== -1) lowZones.push([start, signal.length - 1]);

  // В каждой зоне — один минимум (индекс с минимальным signal).
  const minima = [];
  for (const [a, b] of lowZones) {
    let idx = a, v = signal[a];
    for (let i = a + 1; i <= b; i++) {
      if (signal[i] < v) { v = signal[i]; idx = i; }
    }
    if (minima.length === 0 || idx - minima[minima.length - 1] >= minGap) {
      minima.push(idx);
    }
  }
  return minima;
}

/**
 * Основная функция: извлекает ключевые кадры из массива векторов признаков.
 *
 * Вход: массив Float32Array (или обычных массивов) одинаковой длины.
 * Выход: {
 *   keyframes:   Array<Float32Array>,  // сами кадры
 *   indices:     number[],             // их позиции в исходной последовательности
 *   delta:       number[],             // сглаженное Δ(t) — для отладки/графика
 * }
 *
 * Параметры:
 *   minCount — минимум кадров в результате. Если экстремумов меньше —
 *     добавляем равномерно распределённые, чтобы не терять данные.
 *   maxCount — максимум (если слишком много экстремумов, оставляем самые
 *     глубокие).
 *   smoothWindow — окно сглаживания Δ(t). Default 3.
 */
export function extractKeyframes(features, opts = {}) {
  const {
    minCount = 4,
    maxCount = 16,
    smoothWindow = 3,
    thresholdRatio = 0.5,
    minGap = 2,
  } = opts;

  if (!features || features.length === 0) {
    return { keyframes: [], indices: [], delta: [] };
  }
  if (features.length === 1) {
    return { keyframes: [features[0]], indices: [0], delta: [0] };
  }

  // Δ(t) — дистанция между соседними кадрами.
  const rawDelta = new Array(features.length).fill(0);
  for (let i = 1; i < features.length; i++) {
    rawDelta[i] = euclidean(features[i], features[i - 1]);
  }
  const delta = movingAverage(rawDelta, smoothWindow);

  // Локальные минимумы Δ = моменты фиксации формы руки.
  let minimaIdx = findLocalMinima(delta, thresholdRatio, minGap);

  // Границы всегда включаем — они семантичны (начало и конец жеста).
  const set = new Set(minimaIdx);
  set.add(0);
  set.add(features.length - 1);

  let indices = Array.from(set).sort((a, b) => a - b);

  // Если ключевых кадров меньше минимума — равномерно добавляем недостающие.
  if (indices.length < minCount) {
    const extra = new Set(indices);
    const step = (features.length - 1) / (minCount - 1);
    for (let i = 0; i < minCount; i++) {
      extra.add(Math.round(i * step));
    }
    indices = Array.from(extra).sort((a, b) => a - b);
  }

  // Если слишком много — оставляем самые глубокие минимумы + границы.
  if (indices.length > maxCount) {
    const forcedEdges = [0, features.length - 1];
    // Сортируем внутренние по значению delta (меньше = глубже минимум).
    const inner = indices
      .filter((i) => i !== 0 && i !== features.length - 1)
      .sort((a, b) => delta[a] - delta[b])
      .slice(0, maxCount - 2);
    indices = [...forcedEdges, ...inner].sort((a, b) => a - b);
  }

  const keyframes = indices.map((i) => features[i]);
  return { keyframes, indices, delta };
}
