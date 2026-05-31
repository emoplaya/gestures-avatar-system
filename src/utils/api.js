/**
 * Тонкий клиент для backend (server/index.js).
 *
 * Все жесты — и записи (recordings, кадры landmarks для проигрывания на
 * аватаре), и эталоны (templates, фичи для DTW-распознавания) — хранятся
 * на сервере, а не в localStorage. Это даёт:
 *   - синхронизацию между вкладками/устройствами;
 *   - переживание очистки кеша браузера;
 *   - возможность задеплоить приложение и сохранить набор жестов.
 *
 * GET — публичный. Любой пользователь может читать записи и эталоны.
 * POST/PATCH/DELETE — требует X-Admin-Auth (см. useTeacher.js).
 *   Заголовок и серверный env-пароль исторически называются «admin»;
 *   во фронте роль теперь называется «учитель», но контракт с бэкендом
 *   не меняем, чтобы не ломать прод.
 *
 * В dev Vite проксирует /api → http://localhost:3001 (см. vite.config.js).
 * В проде один и тот же сервер раздаёт /api и dist/, см. server/index.js.
 */

import { useTeacher } from "../hooks/useTeacher";

const BASE = "/api";

async function request(path, options = {}) {
  // Подмешиваем заголовок «учитель» на каждую мутацию. GET-запросы тоже могут
  // его слать — бэкенду всё равно, он его игнорирует.
  const token = useTeacher.getState().token;
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (token) headers["X-Admin-Auth"] = token;

  const res = await fetch(BASE + path, { ...options, headers });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // 401 — токен протух. Сбрасываем стор, чтобы UI знал и перерисовался.
    if (res.status === 401 && useTeacher.getState().isTeacher) {
      useTeacher.getState().logout();
    }
    throw new Error(`API ${res.status} ${path}: ${text}`);
  }
  // DELETE может вернуть пустой ответ
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return null;
  return res.json();
}

export const api = {
  // Recordings
  listRecordings: () => request("/recordings"),
  createRecording: (data) =>
    request("/recordings", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateRecording: (id, patch) =>
    request("/recordings/" + encodeURIComponent(id), {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteRecording: (id) =>
    request("/recordings/" + encodeURIComponent(id), { method: "DELETE" }),

  // Templates
  listTemplates: () => request("/templates"),
  createTemplate: (data) =>
    request("/templates", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  deleteTemplate: (id) =>
    request("/templates/" + encodeURIComponent(id), { method: "DELETE" }),
  clearTemplates: () => request("/templates", { method: "DELETE" }),
};
