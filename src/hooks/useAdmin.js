import { create } from "zustand";

/**
 * Стор админ-сессии.
 *
 * Идея простая: на бэкенде один пароль (env ADMIN_PASSWORD). Если фронт
 * шлёт правильный пароль в заголовке X-Admin-Auth — мутации проходят,
 * иначе — 401. Здесь мы:
 *   - храним токен (= пароль) в localStorage, чтобы он переживал перезагрузку;
 *   - валидируем его при старте через /api/auth/check;
 *   - подписчики (api.js, ControlPanel и т.д.) читают getState().token.
 *
 * Это «мягкая» защита от случайных правок — на HTTPS этого достаточно,
 * чтобы случайный пользователь не смог редактировать записи. От серьёзного
 * атакующего она не защищает (но при self-hosted сервере и одном админе
 * этого и не нужно).
 */

const TOKEN_KEY = "vrm4.adminToken";

export const useAdmin = create((set, get) => ({
  isAdmin: false,
  token: null,
  checked: false, // прошла ли стартовая валидация
  error: null,

  /**
   * Стартовая проверка: если в localStorage лежит токен, спрашиваем у бэкенда,
   * валиден ли он. Если нет — чистим.
   */
  init: async () => {
    if (get().checked) return;
    const saved = localStorage.getItem(TOKEN_KEY);
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
        set({ isAdmin: true, token: saved, checked: true });
      } else {
        localStorage.removeItem(TOKEN_KEY);
        set({ isAdmin: false, token: null, checked: true });
      }
    } catch (e) {
      // Сеть упала — не выбрасываем токен, просто пометим как непроверенный
      // и попробуем при следующем вызове.
      console.warn("[admin] не удалось проверить токен:", e);
      set({ isAdmin: false, token: saved, checked: true });
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
      set({ isAdmin: true, token, error: null, checked: true });
      return true;
    } catch (e) {
      set({ error: e.message || "Ошибка сети" });
      return false;
    }
  },

  logout: () => {
    localStorage.removeItem(TOKEN_KEY);
    set({ isAdmin: false, token: null, error: null });
  },
}));

// Стартуем валидацию сразу при импорте модуля — до первого рендера App.
useAdmin.getState().init();
