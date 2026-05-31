import { Holistic } from "@mediapipe/holistic";

/**
 * Прогоняет видеофайл через MediaPipe Holistic и возвращает массив кадров
 * с landmarks — в том же формате, что и кадры от вебкамеры.
 *
 * Реализация подбирает параметры так, чтобы признаки максимально совпадали
 * с тем, что выдаёт CameraWidget вживую: те же пороги детекции, без
 * сглаживания между несоседними кадрами (мы перематываем видео, и
 * межкадровое сглаживание Holistic портит координаты).
 */
export async function processVideoFile(file, onProgress) {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.crossOrigin = "anonymous";

  await new Promise((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error("Не удалось загрузить видео"));
  });

  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  if (duration <= 0) {
    URL.revokeObjectURL(url);
    throw new Error("Видео без длительности или повреждено");
  }

  const FPS = 30;
  const MAX_SECONDS = 30;
  const effectiveDuration = Math.min(duration, MAX_SECONDS);
  const totalFrames = Math.max(1, Math.floor(effectiveDuration * FPS));

  // Параметры синхронизированы с CameraWidget. smoothLandmarks выключен —
  // при перемотке Holistic пытается сгладить с прошлым кадром, которого
  // фактически нет (мы прыгаем по таймлайну), и портит координаты.
  const holistic = new Holistic({
    locateFile: (f) =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/holistic@0.5.1635989137/${f}`,
  });
  holistic.setOptions({
    modelComplexity: 1,
    smoothLandmarks: false,
    minDetectionConfidence: 0.7,
    minTrackingConfidence: 0.7,
    refineFaceLandmarks: false,
  });

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

      // Перематываем на нужный момент и ждём, пока кадр действительно
      // отрисуется. seeked может выстрелить до полной декодировки —
      // дожидаемся одного rAF, чтобы Holistic получил готовый кадр.
      await seekVideo(video, t, duration, FPS);
      await new Promise((r) => requestAnimationFrame(r));

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

  // Постобработка: сглаживаем landmarks рук по скользящему окну.
  // smoothLandmarks у Holistic выключен (см. setOptions выше — это сделано
  // намеренно из-за перемоток), поэтому покадровые landmarks из видео
  // получаются заметно шумнее, чем live-поток с вебкамеры (где Holistic
  // сглаживает сам). А шаблон, полученный из шумных данных, потом
  // сравнивается с гладкими live-кадрами — асимметрия портит DTW-матчинг.
  // Внутреннее сглаживание уравнивает оба пути.
  return smoothHandLandmarks(frames, 3);
}

function smoothHandLandmarks(frames, windowSize) {
  if (!frames || frames.length < 2 || windowSize < 2) return frames;
  const half = Math.floor(windowSize / 2);
  const smooth = (arrAt, idx) => {
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (let j = Math.max(0, idx - half); j <= Math.min(frames.length - 1, idx + half); j++) {
      const a = arrAt(j);
      if (!a) continue;
      sx += a.x; sy += a.y; sz += a.z; n++;
    }
    if (n === 0) return null;
    return { x: sx / n, y: sy / n, z: sz / n };
  };
  const smoothHand = (key, idx) => {
    const here = frames[idx][key];
    if (!here) return null;
    // Сглаживаем точка-к-точке, чтобы геометрия кисти не «расползалась».
    return here.map((_, p) => smooth((j) => frames[j][key]?.[p], idx));
  };
  return frames.map((f, i) => ({
    ...f,
    rightHandLandmarks: smoothHand("rightHandLandmarks", i),
    leftHandLandmarks:  smoothHand("leftHandLandmarks", i),
  }));
}

function seekVideo(video, t, duration, fps) {
  return new Promise((resolve) => {
    const target = Math.min(t, Math.max(0, duration - 1 / fps));
    if (Math.abs(video.currentTime - target) < 1e-3) {
      resolve();
      return;
    }
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      resolve();
    };
    video.addEventListener("seeked", onSeeked);
    video.currentTime = target;
  });
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

/**
 * Обрезает массив кадров до окна реального движения: убирает "статичные"
 * кадры в начале и конце записи, где рука уже видна, но ещё (или уже) не
 * жестикулирует. Без обрезки эти кадры становятся ключевыми (Δ ≈ 0), и
 * эталон перестаёт отличать жест от фона.
 *
 * featuresOf(frame) — функция, извлекающая признаки из одного кадра.
 *   Должна вернуть Float32Array (как extractFeatures) либо null.
 *
 * Параметры:
 *   motionRatio — порог в долях от пикового движения. Кадры с Δ ниже этого
 *     порога считаются статичными.
 *   padFrames — сколько "статичных" кадров оставить вокруг активной зоны
 *     как контекст (старт и конец жеста).
 */
export function trimToMotionWindow(frames, featuresOf, opts = {}) {
  const { motionRatio = 0.15, padFrames = 2 } = opts;
  if (!frames || frames.length < 4) return frames;

  const feats = frames.map(featuresOf);
  const deltas = new Array(frames.length).fill(0);
  let peak = 0;
  for (let i = 1; i < frames.length; i++) {
    const a = feats[i];
    const b = feats[i - 1];
    if (!a || !b) continue;
    let s = 0;
    for (let k = 0; k < a.length; k++) {
      const d = a[k] - b[k];
      s += d * d;
    }
    deltas[i] = Math.sqrt(s);
    if (deltas[i] > peak) peak = deltas[i];
  }
  if (peak <= 1e-6) return frames;

  const threshold = peak * motionRatio;
  let first = -1;
  let last = -1;
  for (let i = 0; i < frames.length; i++) {
    if (deltas[i] >= threshold) {
      if (first === -1) first = i;
      last = i;
    }
  }
  if (first === -1) return frames;

  const lo = Math.max(0, first - padFrames);
  const hi = Math.min(frames.length - 1, last + padFrames);
  return frames.slice(lo, hi + 1);
}
