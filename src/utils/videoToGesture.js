import { Holistic } from "@mediapipe/holistic";

/**
 * Прогоняет произвольный видеофайл через MediaPipe Holistic и возвращает
 * массив landmark-кадров — в том же формате, что и кадры от вебкамеры.
 *
 * Идея — клиентская обработка: видео грузится локально (URL.createObjectURL),
 * мы создаём отдельный, временный экземпляр Holistic (чтобы не мешать
 * вебкамере), играем видео фрейм-за-фреймом через requestVideoFrameCallback,
 * собираем результаты. Никакая обработка не уходит на сервер — там лежит
 * только итоговый набор landmarks (как и у обычной записи).
 *
 * Использование:
 *   const frames = await processVideoFile(file, (p) => setProgress(p));
 *   // frames можно отдать в useGestureRecorder.importRecording или
 *   // в TemplateMatcher.addTemplate (взяв из каждого frame нужную руку).
 */
export async function processVideoFile(file, onProgress) {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.crossOrigin = "anonymous";

  // Ждём metadata, иначе video.duration === NaN.
  await new Promise((resolve, reject) => {
    const onError = () => reject(new Error("Не удалось загрузить видео"));
    video.onloadedmetadata = () => resolve();
    video.onerror = onError;
  });

  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  if (duration <= 0) {
    URL.revokeObjectURL(url);
    throw new Error("Видео без длительности или повреждено");
  }

  // 30 FPS — хватает для жестов и совпадает с тем, что выдаёт вебкамера.
  // Длинные видео ограничиваем 30 секундами, чтобы не зависнуть в обработке.
  const FPS = 30;
  const MAX_SECONDS = 30;
  const effectiveDuration = Math.min(duration, MAX_SECONDS);
  const totalFrames = Math.max(1, Math.floor(effectiveDuration * FPS));

  // Свой Holistic — чтобы не делить состояние с активной вебкамерой.
  const holistic = new Holistic({
    locateFile: (f) =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/holistic@0.5.1635989137/${f}`,
  });
  holistic.setOptions({
    modelComplexity: 1,
    smoothLandmarks: true,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
    refineFaceLandmarks: false,
  });

  // Очередь: holistic.onResults присылает результат для последнего отправленного
  // кадра асинхронно. Связываем send → результат через отдельный resolver.
  let pendingResolve = null;
  holistic.onResults((r) => {
    const fn = pendingResolve;
    pendingResolve = null;
    if (fn) fn(r);
  });

  const frames = [];

  try {
    for (let i = 0; i < totalFrames; i++) {
      const t = i / FPS;

      // Перематываем видео на нужный момент.
      // currentTime = t инициирует событие seeked после готовности кадра.
      await new Promise((resolve) => {
        const onSeeked = () => {
          video.removeEventListener("seeked", onSeeked);
          resolve();
        };
        video.addEventListener("seeked", onSeeked);
        // Защищаемся от перехода за конец дорожки.
        const target = Math.min(t, Math.max(0, duration - 1 / FPS));
        if (Math.abs(video.currentTime - target) < 1e-3) {
          // Уже в нужной позиции — seeked не выстрелит, симулируем.
          video.removeEventListener("seeked", onSeeked);
          resolve();
        } else {
          video.currentTime = target;
        }
      });

      // Прогон через Holistic.
      const r = await new Promise((resolve) => {
        pendingResolve = resolve;
        holistic.send({ image: video }).catch((err) => {
          console.warn("[videoToGesture] holistic.send error:", err);
          if (pendingResolve === resolve) {
            pendingResolve = null;
            resolve(null);
          }
        });
      });

      if (r) {
        const worldLm = r.poseWorldLandmarks || r.za || r.ea || null;
        frames.push({
          t: i * (1000 / FPS),
          poseLandmarks: cloneLandmarks(r.poseLandmarks),
          poseWorldLandmarks: cloneLandmarks(worldLm),
          leftHandLandmarks: cloneLandmarks(r.leftHandLandmarks),
          rightHandLandmarks: cloneLandmarks(r.rightHandLandmarks),
          faceLandmarks: cloneLandmarks(r.faceLandmarks),
        });
      }

      onProgress?.((i + 1) / totalFrames);
    }
  } finally {
    try { await holistic.close(); } catch { /* ignore */ }
    URL.revokeObjectURL(url);
  }

  return frames;
}

function cloneLandmarks(arr) {
  if (!arr) return null;
  return arr.map((p) => ({
    x: p.x,
    y: p.y,
    z: p.z,
    ...(p.visibility !== undefined ? { visibility: p.visibility } : {}),
  }));
}
