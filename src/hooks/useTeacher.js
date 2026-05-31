import { create } from "zustand";

/**
 * Стор сессии «Учитель».
 *
 * Идея простая: на бэкенде один пароль (env ADMIN_PASSWORD — имя
 * сохранено для обратной совместимости с прод-окружением). Если фронт
 * шлёт правильный пароль в заголовке X-Admin-Auth — мутации проходят,
 * иначе — 401. Здесь мы:
 *   - храним токен (= пароль) в localStorage, чтобы он переживал перезагрузку;
 *   - валидируем его при старте через /api/auth/check;
 *   - подписчики (api.js, ControlPanel и т.д.) читают getState().token.
 *
 * Это «мягкая» защита от случайных правок — на HTTPS этого достаточно,
 * чтобы случайный пользователь не смог редактировать записи.
 */

const TOKEN_KEY = "vrm4.teacherToken";
const LEGACY_TOKEN_KEY = "vrm4.adminToken";

export const useTeacher = create((set, get) => ({
  isTeacher: false,
  token: null,
  checked: false, // прошла ли стартовая валидация
  error: null,

  /**
   * Стартовая проверка: если в localStorage лежит токен, спрашиваем у бэкенда,
   * валиден ли он. Если нет — чистим.
   */
  init: async () => {
    if (get().checked) return;
    let saved = localStorage.getItem(TOKEN_KEY);
    if (!saved) {
      // Поддерживаем старый ключ — чтобы уже залогиненные не вылетели.
      const legacy = localStorage.getItem(LEGACY_TOKEN_KEY);
      if (legacy) {
        saved = legacy;
        localStorage.setItem(TOKEN_KEY, legacy);
        localStorage.removeItem(LEGACY_TOKEN_KEY);
      }
    }
    if (!saved) {
      set({ checked: true });
      return;
    }
    try {
      const res = await fetch("/api/auth/check", {
        headers: { "X-Admin-Auth": saved },
      });
      const data = await res.json();
      if (data?.ok) {
        set({ isTeacher: true, token: saved, checked: true });
      } else {
        localStorage.removeItem(TOKEN_KEY);
        set({ isTeacher: false, token: null, checked: true });
      }
    } catch (e) {
      // Сеть упала — не выбрасываем токен, просто пометим как непроверенный
      // и попробуем при следующем вызове.
      console.warn("[teacher] не удалось проверить токен:", e);
      set({ isTeacher: false, token: saved, checked: true });
    }
  },

  login: async (password) => {
    set({ error: null });
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const msg = res.status === 401 ? "Неверный пароль" : `Ошибка ${res.status}`;
        set({ error: msg });
        return false;
      }
      const data = await res.json();
      const token = data?.token;
      if (!token) {
        set({ error: "Бэкенд не вернул токен" });
        return false;
      }
      localStorage.setItem(TOKEN_KEY, token);
      set({ isTeacher: true, token, error: null, checked: true });
      return true;
    } catch (e) {
      set({ error: e.message || "Ошибка сети" });
      return false;
    }
  },

  logout: () => {
    localStorage.removeItem(TOKEN_KEY);
    set({ isTeacher: false, token: null, error: null });
  },
}));

// Стартуем валидацию сразу при импорте модуля — до первого рендера App.
useTeacher.getState().init();
