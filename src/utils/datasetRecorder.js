import { create } from "zustand";

/**
 * Хранилище для сбора датасета дактильной азбуки.
 * Каждый "сэмпл" = короткая последовательность кадров MediaPipe landmarks
 * (21 точка × {x,y,z}), помеченная буквой. Для каждого сэмпла записывается
 * также предсказание правилового рекогнайзера (бейзлайн для сравнения).
 */

const SAMPLE_MS = 1500; // длительность одного сэмпла (мс)
const STORAGE_KEY = "dactyl_dataset_v1";

// Мета-информация сеанса: пользователь, устройство, браузер
function getSessionMeta() {
  try {
    let meta = JSON.parse(localStorage.getItem("dactyl_session_meta") || "{}");
    if (!meta.sessionId) {
      meta.sessionId =
        "s_" + Math.random().toString(36).slice(2, 10) + "_" + Date.now();
      localStorage.setItem("dactyl_session_meta", JSON.stringify(meta));
    }
    return meta;
  } catch {
    return { sessionId: "s_" + Date.now() };
  }
}

function loadFromStorage() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveToStorage(samples) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(samples));
  } catch (e) {
    // localStorage quota — жёсткий fail, нужно скачать/очистить
    console.warn("[datasetRecorder] localStorage full", e);
  }
}

export const useDatasetRecorder = create((set, get) => ({
  samples: loadFromStorage(),
  isRecording: false,
  currentLetter: null,
  currentFrames: [], // буфер кадров текущего сэмпла
  startedAt: 0,
  subjectId: (function () {
    try {
      return localStorage.getItem("dactyl_subject_id") || "";
    } catch {
      return "";
    }
  })(),

  setSubjectId: (id) => {
    try {
      localStorage.setItem("dactyl_subject_id", id);
    } catch {}
    set({ subjectId: id });
  },

  startSample: (letter) => {
    if (get().isRecording) return;
    set({
      isRecording: true,
      currentLetter: letter,
      currentFrames: [],
      startedAt: Date.now(),
    });
  },

  // вызывается каждый кадр, пока isRecording=true
  addFrame: (landmarks, ruleLetter) => {
    if (!get().isRecording) return false;
    const elapsed = Date.now() - get().startedAt;
    // сохраняем только то, что нужно: массив 21×{x,y,z}
    const lm = [];
    for (let i = 0; i < landmarks.length; i++) {
      const p = landmarks[i];
      lm.push([+p.x.toFixed(5), +p.y.toFixed(5), +p.z.toFixed(5)]);
    }
    const frames = get().currentFrames;
    frames.push({ t: elapsed, lm, pred: ruleLetter || null });
    if (elapsed >= SAMPLE_MS) {
      get().finalizeSample();
      return true; // сэмпл завершён
    }
    return false;
  },

  finalizeSample: () => {
    const { currentLetter, currentFrames, samples } = get();
    if (!currentLetter || currentFrames.length === 0) {
      set({ isRecording: false, currentFrames: [], currentLetter: null });
      return;
    }
    const meta = getSessionMeta();
    const subject = get().subjectId || "anon";
    // Итоговое предсказание бейзлайна по самому длительно удерживаемому классу
    const counts = {};
    for (const f of currentFrames) {
      if (f.pred) counts[f.pred] = (counts[f.pred] || 0) + 1;
    }
    const rulePred =
      Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    const sample = {
      id: "smp_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
      letter: currentLetter,
      subject,
      session: meta.sessionId,
      recordedAt: new Date().toISOString(),
      framesCount: currentFrames.length,
      duration: currentFrames[currentFrames.length - 1].t,
      rulePred,
      frames: currentFrames,
    };
    const next = [...samples, sample];
    saveToStorage(next);
    set({
      samples: next,
      isRecording: false,
      currentFrames: [],
      currentLetter: null,
    });
  },

  cancelSample: () => {
    set({ isRecording: false, currentFrames: [], currentLetter: null });
  },

  deleteSample: (id) => {
    const next = get().samples.filter((s) => s.id !== id);
    saveToStorage(next);
    set({ samples: next });
  },

  deleteByLetter: (letter) => {
    const next = get().samples.filter((s) => s.letter !== letter);
    saveToStorage(next);
    set({ samples: next });
  },

  clearAll: () => {
    saveToStorage([]);
    set({ samples: [] });
  },

  // Экспорт как JSONL (каждая строка — один сэмпл)
  exportJSONL: () => {
    const { samples } = get();
    const lines = samples.map((s) => JSON.stringify(s));
    const blob = new Blob([lines.join("\n")], { type: "application/jsonl" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    a.download = `dactyl_dataset_${samples.length}_${ts}.jsonl`;
    a.click();
    URL.revokeObjectURL(url);
  },

  // Сводка: сколько сэмплов на каждую букву
  getStats: () => {
    const { samples } = get();
    const byLetter = {};
    for (const s of samples) {
      byLetter[s.letter] = (byLetter[s.letter] || 0) + 1;
    }
    return { total: samples.length, byLetter };
  },
}));

export { SAMPLE_MS };
