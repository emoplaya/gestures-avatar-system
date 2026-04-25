import { create } from "zustand";

export const useVideoRecognition = create((set) => ({
  videoElement: null,
  setVideoElement: (videoElement) => set({ videoElement }),
  resultsCallback: null,
  setResultsCallback: (resultsCallback) => set({ resultsCallback }),
  gestureCallback: null,
  setGestureCallback: (gestureCallback) => set({ gestureCallback }),
  // Флаг: заблокировать передачу ЖИВЫХ кадров от MediaPipe в аватар.
  // Используется в режиме «Перевод → Распознать жест»: там аватар должен
  // стоять в T-позе пока DTW не сматчит жест. После матча воспроизводится
  // запись через прямой вызов avatar-callback (обходя этот флаг).
  liveFeedBlocked: false,
  setLiveFeedBlocked: (liveFeedBlocked) => set({ liveFeedBlocked }),
}));

