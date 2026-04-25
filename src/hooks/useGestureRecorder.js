import { create } from "zustand";

// Версия формата — при смене схемы старые записи инвалидируются
const STORAGE_KEY = "gesture_recordings_v2";

/**
 * Формат записи:
 * {
 *   id, name, duration, createdAt,
 *   frames: [
 *     {
 *       t: ms,
 *       poseLandmarks, poseWorldLandmarks,
 *       leftHandLandmarks, rightHandLandmarks,
 *       faceLandmarks
 *     }
 *   ]
 * }
 */
export const useGestureRecorder = create((set, get) => ({
  // Состояние записи
  isRecording: false,
  recordingFrames: [],
  recordingStartTime: null,

  // Сохранённые записи
  recordings: loadRecordings(),

  // Воспроизведение
  isPlaying: false,
  playingIndex: null,
  playbackFrame: 0,

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

  stopRecording: (name) => {
    const state = get();
    if (!state.isRecording) return null;

    const frames = state.recordingFrames;
    const recording = {
      id: Date.now().toString(36),
      name: (name && name.trim()) || `Запись ${state.recordings.length + 1}`,
      frames,
      duration: frames.length > 0 ? frames[frames.length - 1].t : 0,
      createdAt: new Date().toISOString(),
    };

    const newRecordings = [...state.recordings, recording];
    saveRecordings(newRecordings);

    set({
      isRecording: false,
      recordingFrames: [],
      recordingStartTime: null,
      recordings: newRecordings,
    });

    return recording;
  },

  cancelRecording: () => {
    set({
      isRecording: false,
      recordingFrames: [],
      recordingStartTime: null,
    });
  },

  deleteRecording: (id) => {
    const newRecordings = get().recordings.filter((r) => r.id !== id);
    saveRecordings(newRecordings);
    set({ recordings: newRecordings });
  },

  renameRecording: (id, newName) => {
    const trimmed = (newName || "").trim();
    if (!trimmed) return;
    const newRecordings = get().recordings.map((r) =>
      r.id === id ? { ...r, name: trimmed } : r,
    );
    saveRecordings(newRecordings);
    set({ recordings: newRecordings });
  },

  /**
   * Импорт готовой записи. Используется, когда жест был записан в другом
   * месте приложения (например, в режиме «Обучи» через TemplateMode),
   * и пользователь хочет добавить его в коллекцию записей аватара.
   *
   * frames — массив {poseLandmarks, leftHandLandmarks, rightHandLandmarks,
   * faceLandmarks, t}. Если время t не задано, проставляется из индекса
   * с шагом ~33 мс.
   */
  importRecording: (name, frames) => {
    if (!frames || frames.length === 0) return null;
    const withTimes = frames.map((f, i) => ({
      poseLandmarks: f.poseLandmarks || null,
      poseWorldLandmarks: f.poseWorldLandmarks || null,
      leftHandLandmarks: f.leftHandLandmarks || null,
      rightHandLandmarks: f.rightHandLandmarks || null,
      faceLandmarks: f.faceLandmarks || null,
      t: typeof f.t === "number" ? f.t : i * 33,
    }));
    const recording = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      name: (name && name.trim()) || `Запись ${get().recordings.length + 1}`,
      frames: withTimes,
      duration: withTimes[withTimes.length - 1].t,
      createdAt: new Date().toISOString(),
    };
    const newRecordings = [...get().recordings, recording];
    saveRecordings(newRecordings);
    set({ recordings: newRecordings });
    return recording;
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

function loadRecordings() {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

function saveRecordings(recordings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(recordings));
  } catch (e) {
    // localStorage может быть переполнен (длинные записи = много МБ).
    console.warn("Не удалось сохранить запись:", e);
  }
}
