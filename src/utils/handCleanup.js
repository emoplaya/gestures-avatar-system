/**
 * Чистка «фантомной» второй руки в одноручных жестах.
 *
 * MediaPipe Holistic иногда дёргается и время от времени отдаёт landmarks
 * для второй руки, даже если она не в кадре или просто висит вдоль тела.
 * При воспроизведении это превращается в дёрганый рывок «второй руки» на
 * аватаре — будто она ловит несуществующий жест.
 *
 * Логика:
 *   1. Считаем долю кадров, где видна каждая рука.
 *   2. Если одна рука доминирует (≥ DOMINANT_THRESHOLD), а вторая
 *      редкая (≤ PHANTOM_THRESHOLD) — обнуляем landmarks второй руки
 *      во ВСЕХ кадрах. Аватар тогда не будет шевелить ею вообще.
 *   3. Иначе — это либо двуручный жест, либо чистый поток (две руки
 *      примерно поровну) — оставляем как есть.
 */

const DOMINANT_THRESHOLD = 0.5;  // ≥ 50% кадров — основная рука
const PHANTOM_THRESHOLD  = 0.35; // ≤ 35% кадров — скорее всего фантом

/**
 * @param {Array<{leftHandLandmarks?, rightHandLandmarks?}>} frames
 * @returns {{frames, dominantHand: "left"|"right"|"both"}}
 */
export function cleanPhantomHand(frames) {
  if (!Array.isArray(frames) || frames.length === 0) {
    return { frames: frames || [], dominantHand: "both" };
  }

  let leftCount = 0;
  let rightCount = 0;
  for (const f of frames) {
    if (f.leftHandLandmarks && f.leftHandLandmarks.length > 0) leftCount++;
    if (f.rightHandLandmarks && f.rightHandLandmarks.length > 0) rightCount++;
  }

  const total = frames.length;
  const leftRatio  = leftCount  / total;
  const rightRatio = rightCount / total;

  let dominantHand = "both";
  if (rightRatio >= DOMINANT_THRESHOLD && leftRatio  <= PHANTOM_THRESHOLD) {
    dominantHand = "right";
  } else if (leftRatio  >= DOMINANT_THRESHOLD && rightRatio <= PHANTOM_THRESHOLD) {
    dominantHand = "left";
  }

  if (dominantHand === "both") {
    return { frames, dominantHand };
  }

  // Стираем «фантомную» руку во всех кадрах. Аватар при null-landmarks
  // просто не двигает кость — то, что нам нужно.
  const phantomField =
    dominantHand === "right" ? "leftHandLandmarks" : "rightHandLandmarks";
  const cleaned = frames.map((f) => ({ ...f, [phantomField]: null }));

  return { frames: cleaned, dominantHand };
}
