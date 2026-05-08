import { create } from "zustand";
import { api } from "../utils/api";
import { cleanPhantomHand } from "../utils/handCleanup";

/**
 * Формат записи (на бекенде хранится точно так же):
 * {
 *   id, name, duration, createdAt, source,
 *   frames: [
 *     {
 *       t: ms,
 *       poseLandmarks, poseWorldLandmarks,
 *       leftHandLandmarks, rightHandLandmarks,
 *       faceLandmarks
 *     }
 *   ]
 * }
 *
 * Все CRUD-операции уходят на backend (server/index.js). Локально мы держим
 * слепок recordings в стейте — он обновляется после успешного ответа API.
 */
export const useGestureRecorder = create((set, get) => ({
  // ===== Состояние записи (живая, в памяти) =====
  isRecording: false,
  recordingFrames: [],
  recordingStartTime: null,

  // ===== Сохранённые записи =====
  recordings: [],
  recordingsLoaded: false,
  recordingsError: null,

  // ===== Воспроизведение =====
  isPlaying: false,
  playingIndex: null,
  playbackFrame: 0,

  /**
   * Загрузить список записей с сервера. Вызывается при старте приложения.
   */
  fetchRecordings: async () => {
    try {
      const recordings = await api.listRecordings();
      set({
        recordings: Array.isArray(recordings) ? recordings : [],
        recordingsLoaded: true,
        recordingsError: null,
      });
    } catch (e) {
      console.warn("[recorder] Не удалось загрузить записи:", e);
      set({ recordingsLoaded: true, recordingsError: e.message });
    }
  },

  startRecording: () => {
    set({
      isRecording: true,
      recordingFrames: [],
      recordingStartTime: Date.now(),
    });
  },

  /**
   * Добавить кадр из полных MediaPipe results.
   * Сохраняем только те поля, что нужны VRMAvatar.resultsCallback.
   */
  addResultsFrame: (results) => {
    const state = get();
    if (!state.isRecording || !results) return;

    const frame = {
      t: Date.now() - state.recordingStartTime,
      poseLandmarks: cloneLandmarks(results.poseLandmarks),
      poseWorldLandmarks: cloneLandmarks(
        results.poseWorldLandmarks || results.za || results.ea,
      ),
      leftHandLandmarks: cloneLandmarks(results.leftHandLandmarks),
      rightHandLandmarks: cloneLandmarks(results.rightHandLandmarks),
      faceLandmarks: cloneLandmarks(results.faceLandmarks),
    };

    set({
      recordingFrames: [...state.recordingFrames, frame],
    });
  },

  /**
   * Остановить запись и отправить её на сервер.
   * Возвращает promise с готовой записью (как её сохранил сервер).
   */
  stopRecording: async (name) => {
    const state = get();
    if (!state.isRecording) return null;

    const rawFrames = state.recordingFrames;
    // Чистим «фантомную» вторую руку — типичный артефакт MediaPipe
    // на одноручных жестах. См. handCleanup.js.
    const { frames, dominantHand } = cleanPhantomHand(rawFrames);

    const draft = {
      name: (name && name.trim()) || `Запись ${state.recordings.length + 1}`,
      frames,
      duration: frames.length > 0 ? frames[frames.length - 1].t : 0,
      source: "camera",
      dominantHand,
    };

    set({
      isRecording: false,
      recordingFrames: [],
      recordingStartTime: null,
    });

    try {
      const saved = await api.createRecording(draft);
      set({ recordings: [...get().recordings, saved] });
      return saved;
    } catch (e) {
      console.warn("[recorder] Не удалось сохранить запись:", e);
      // Возвращаем draft, чтобы UI хотя бы показал что-то осмысленное.
      return null;
    }
  },

  cancelRecording: () => {
    set({
      isRecording: false,
      recordingFrames: [],
      recordingStartTime: null,
    });
  },

  deleteRecording: async (id) => {
    // Оптимистично убираем из UI, на ошибке вернём.
    const before = get().recordings;
    set({ recordings: before.filter((r) => r.id !== id) });
    try {
      await api.deleteRecording(id);
    } catch (e) {
      console.warn("[recorder] Не удалось удалить запись:", e);
      set({ recordings: before });
    }
  },

  renameRecording: async (id, newName) => {
    const trimmed = (newName || "").trim();
    if (!trimmed) return;
    const before = get().recordings;
    set({
      recordings: before.map((r) => (r.id === id ? { ...r, name: trimmed } : r)),
    });
    try {
      await api.updateRecording(id, { name: trimmed });
    } catch (e) {
      console.warn("[recorder] Не удалось переименовать запись:", e);
      set({ recordings: before });
    }
  },

  /**
   * Импорт готовой записи. Используется, когда жест был записан в другом
   * месте приложения (TemplateMode при сохранении эталона) или получен
   * из загруженного видео.
   *
   * frames — массив {poseLandmarks, leftHandLandmarks, rightHandLandmarks,
   * faceLandmarks, poseWorldLandmarks, t}. Если время t не задано,
   * проставляется из индекса с шагом ~33 мс.
   *
   * source — пометка "camera" / "video" / иное, чтобы UI мог отличить.
   */
  importRecording: async (name, frames, source = "camera") => {
    if (!frames || frames.length === 0) return null;
    const withTimes = frames.map((f, i) => ({
      poseLandmarks: f.poseLandmarks || null,
      poseWorldLandmarks: f.poseWorldLandmarks || null,
      leftHandLandmarks: f.leftHandLandmarks || null,
      rightHandLandmarks: f.rightHandLandmarks || null,
      faceLandmarks: f.faceLandmarks || null,
      t: typeof f.t === "number" ? f.t : i * 33,
    }));
    // Чистим фантомную вторую руку — то же, что и в stopRecording.
    const { frames: cleaned, dominantHand } = cleanPhantomHand(withTimes);
    const draft = {
      name: (name && name.trim()) || `Запись ${get().recordings.length + 1}`,
      frames: cleaned,
      duration: cleaned[cleaned.length - 1].t,
      source,
      dominantHand,
    };
    try {
      const saved = await api.createRecording(draft);
      set({ recordings: [...get().recordings, saved] });
      return saved;
    } catch (e) {
      console.warn("[recorder] Не удалось импортировать запись:", e);
      return null;
    }
  },

  // ===== Плеер =====
  startPlayback: (index) => {
    set({ isPlaying: true, playingIndex: index, playbackFrame: 0 });
  },

  stopPlayback: () => {
    set({ isPlaying: false, playingIndex: null, playbackFrame: 0 });
  },

  /**
   * Продвинуть курсор и вернуть текущий кадр.
   * Возвращает null, если воспроизведение завершено.
   */
  advancePlayback: () => {
    const state = get();
    if (!state.isPlaying || state.playingIndex === null) return null;
    const recording = state.recordings[state.playingIndex];
    if (!recording || recording.frames.length === 0) {
      set({ isPlaying: false, playingIndex: null, playbackFrame: 0 });
      return null;
    }

    const frame = recording.frames[state.playbackFrame];
    const nextFrame = state.playbackFrame + 1;

    if (nextFrame >= recording.frames.length) {
      // Финальный кадр отдаём, но помечаем что плеер остановится
      set({ isPlaying: false, playingIndex: null, playbackFrame: 0 });
    } else {
      set({ playbackFrame: nextFrame });
    }

    return frame;
  },

  getPlaybackDelay: () => {
    const state = get();
    if (!state.isPlaying || state.playingIndex === null) return 0;
    const recording = state.recordings[state.playingIndex];
    if (!recording) return 0;
    const curr = recording.frames[state.playbackFrame];
    const next = recording.frames[state.playbackFrame + 1];
    if (!curr || !next) return 0;
    return Math.max(0, next.t - curr.t);
  },
}));

// Стартовая загрузка списка с сервера. Вызываем сразу при импорте — модуль
// загружается до первого рендера App, так что recordings уже подтянутся к
// моменту, когда AnimationPlayer/TranslateMode запросят их.
useGestureRecorder.getState().fetchRecordings();

// ===== Вспомогательные =====

function cloneLandmarks(arr) {
  if (!arr) return undefined;
  // Landmark — это {x,y,z[,visibility]}. Берём только числа, чтобы JSON был компактным.
  return arr.map((p) => ({
    x: p.x,
    y: p.y,
    z: p.z,
    ...(p.visibility !== undefined ? { visibility: p.visibility } : {}),
  }));
}
