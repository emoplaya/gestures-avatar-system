/**
 * Распознавание жестов по сравнению траектории живого видеопотока
 * с сохранёнными записями (useGestureRecorder) через DTW
 * (Dynamic Time Warping).
 *
 * Задача: пользователь показывает на камеру жест, соответствующий одной
 * из сохранённых записей. Нужно найти наиболее похожую запись по форме
 * траектории рук — независимо от скорости выполнения.
 *
 * Подход:
 *   1. Из каждого кадра (MediaPipe results) извлекаем компактный
 *      feature-вектор: нормализованные позиции кистей относительно плеч
 *      + углы ключевых суставов пальцев. 21D вектор.
 *   2. Последовательность кадров = последовательность векторов.
 *   3. Сравниваем live-буфер (последние ~N кадров) с каждой записью
 *      через DTW с ограничением на ширину пути (Sakoe-Chiba band),
 *      чтобы не взрываться по времени.
 *   4. Запись с минимальной нормированной стоимостью пути — кандидат.
 *      Если стоимость ниже порога и лучше следующего кандидата с запасом,
 *      считаем жест распознанным.
 */

// ===== 1. Извлечение признаков =====

function normalizeLandmark(lm, shoulderL, shoulderR) {
  // Масштаб = расстояние между плечами. Центр = середина плеч.
  if (!shoulderL || !shoulderR) return { x: lm.x, y: lm.y, z: lm.z };
  const cx = (shoulderL.x + shoulderR.x) / 2;
  const cy = (shoulderL.y + shoulderR.y) / 2;
  const scale =
    Math.sqrt(
      (shoulderL.x - shoulderR.x) ** 2 + (shoulderL.y - shoulderR.y) ** 2,
    ) + 1e-6;
  return {
    x: (lm.x - cx) / scale,
    y: (lm.y - cy) / scale,
    z: (lm.z || 0) / scale,
  };
}

function handCurl(handLandmarks) {
  // Грубая метрика «согнутости» руки: среднее расстояние кончиков пальцев
  // от запястья. Маленькое = кулак, большое = растопырено.
  if (!handLandmarks || handLandmarks.length < 21) return 0;
  const wrist = handLandmarks[0];
  const tips = [4, 8, 12, 16, 20];
  let sum = 0;
  for (const i of tips) {
    const p = handLandmarks[i];
    sum += Math.sqrt(
      (p.x - wrist.x) ** 2 + (p.y - wrist.y) ** 2 + ((p.z || 0) - (wrist.z || 0)) ** 2,
    );
  }
  return sum / tips.length;
}

function fingerExtensions(handLandmarks) {
  // 5 значений: выпрямлен ли каждый палец. Грубо: отношение расстояния
  // tip↔wrist к mcp↔wrist. >1 = выпрямлен, ~1 = согнут.
  if (!handLandmarks || handLandmarks.length < 21) return [0, 0, 0, 0, 0];
  const wrist = handLandmarks[0];
  const tips = [4, 8, 12, 16, 20];
  const mcps = [2, 5, 9, 13, 17];
  const out = [];
  for (let i = 0; i < 5; i++) {
    const tip = handLandmarks[tips[i]];
    const mcp = handLandmarks[mcps[i]];
    const dTip = Math.sqrt((tip.x - wrist.x) ** 2 + (tip.y - wrist.y) ** 2);
    const dMcp = Math.sqrt((mcp.x - wrist.x) ** 2 + (mcp.y - wrist.y) ** 2) + 1e-6;
    out.push(dTip / dMcp);
  }
  return out;
}

/**
 * Собирает feature-вектор из одного кадра.
 * Размерность: 3 (L кисть x,y,z) + 3 (R кисть) + 1 (curl L) + 1 (curl R)
 *            + 5 (ext L) + 5 (ext R) + 3 (dx,dy между кистями)
 *            = 21
 * Если какой-то руки нет — её часть = нули.
 */
export function frameToFeature(frame) {
  if (!frame) return new Array(21).fill(0);

  const pose = frame.poseLandmarks || [];
  // MediaPipe Pose: 11 = левое плечо, 12 = правое
  const shoulderL = pose[11];
  const shoulderR = pose[12];

  const left = frame.leftHandLandmarks;
  const right = frame.rightHandLandmarks;

  // Позиции запястий нормированные
  const leftWrist = left && left[0] ? normalizeLandmark(left[0], shoulderL, shoulderR) : null;
  const rightWrist = right && right[0] ? normalizeLandmark(right[0], shoulderL, shoulderR) : null;

  const v = [];
  // 3 — левая кисть
  v.push(leftWrist ? leftWrist.x : 0, leftWrist ? leftWrist.y : 0, leftWrist ? leftWrist.z : 0);
  // 3 — правая
  v.push(rightWrist ? rightWrist.x : 0, rightWrist ? rightWrist.y : 0, rightWrist ? rightWrist.z : 0);
  // 1 + 1 — curl
  v.push(handCurl(left), handCurl(right));
  // 5 + 5 — extensions
  v.push(...fingerExtensions(left), ...fingerExtensions(right));
  // 3 — относительное положение кистей
  if (leftWrist && rightWrist) {
    v.push(leftWrist.x - rightWrist.x, leftWrist.y - rightWrist.y, leftWrist.z - rightWrist.z);
  } else {
    v.push(0, 0, 0);
  }
  return v;
}

// ===== 2. DTW =====

function sqDist(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s;
}

/**
 * DTW с диагональной полосой Sakoe-Chiba.
 * Возвращает нормированную стоимость (путь / длина пути).
 */
function dtw(seqA, seqB, bandRatio = 0.2) {
  const n = seqA.length;
  const m = seqB.length;
  if (n === 0 || m === 0) return Infinity;

  const band = Math.max(2, Math.floor(Math.max(n, m) * bandRatio));

  // Используем одномерный массив для эффективности
  const INF = 1e18;
  const prev = new Float64Array(m + 1).fill(INF);
  const curr = new Float64Array(m + 1).fill(INF);
  prev[0] = 0;

  for (let i = 1; i <= n; i++) {
    curr.fill(INF);
    const jStart = Math.max(1, i - band);
    const jEnd = Math.min(m, i + band);
    for (let j = jStart; j <= jEnd; j++) {
      const cost = sqDist(seqA[i - 1], seqB[j - 1]);
      const best = Math.min(prev[j], curr[j - 1], prev[j - 1]);
      curr[j] = cost + best;
    }
    // swap
    for (let k = 0; k <= m; k++) prev[k] = curr[k];
  }

  return Math.sqrt(prev[m] / (n + m));
}

// ===== 3. Публичный API =====

/**
 * Предобработка записи в последовательность features.
 * Запись из useGestureRecorder → массив feature-векторов.
 */
export function recordingToSequence(recording) {
  if (!recording || !recording.frames) return [];
  return recording.frames.map(frameToFeature);
}

/**
 * Сравнивает live-буфер с каждой записью и возвращает отсортированный
 * список кандидатов.
 *
 * @param {Array} liveSeq — последовательность features от live видео
 * @param {Array} recordingsWithSeq — [{ recording, sequence }]
 * @returns [{ recording, cost }, ...] отсортировано по возрастанию cost
 */
export function matchAgainstRecordings(liveSeq, recordingsWithSeq) {
  const results = [];
  for (const { recording, sequence } of recordingsWithSeq) {
    if (sequence.length < 3) continue; // слишком короткая запись
    const cost = dtw(liveSeq, sequence);
    results.push({ recording, cost });
  }
  results.sort((a, b) => a.cost - b.cost);
  return results;
}

/**
 * Эвристика: считаем жест «распознанным», если:
 *   - лучший кандидат имеет cost ниже MAX_COST
 *   - И лучший cost заметно ниже второго (отрыв ≥ MARGIN)
 *
 * Пороги подобраны эмпирически для feature-вектора выше.
 * Подкручивать под конкретный датасет.
 */
export const MATCH_MAX_COST = 0.35;
export const MATCH_MARGIN = 1.15; // второй кандидат должен быть в >=1.15 раза хуже

export function pickWinner(matches) {
  if (matches.length === 0) return null;
  const best = matches[0];
  if (best.cost > MATCH_MAX_COST) return null;
  if (matches.length >= 2) {
    const second = matches[1];
    if (second.cost < best.cost * MATCH_MARGIN) return null; // слишком близко — неуверенно
  }
  return best;
}
