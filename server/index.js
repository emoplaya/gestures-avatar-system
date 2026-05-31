import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// На проде (Render) монтируем persistent disk в /var/data — это путь,
// который переживает редеплои. В dev — server/data рядом с кодом.
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "data");

const RECORDINGS_FILE = path.join(DATA_DIR, "recordings.json");
const TEMPLATES_FILE  = path.join(DATA_DIR, "templates.json");
const CLIENT_DIST     = path.join(__dirname, "..", "dist");

// Если DATA_DIR пуст, но в репозитории есть server/data — копируем
// предзаписанные жесты на persistent volume при первом запуске. Так админ
// может закоммитить набор эталонных букв в репо, и они появятся у всех.
if (!fsSync.existsSync(DATA_DIR)) {
  fsSync.mkdirSync(DATA_DIR, { recursive: true });
}
const SEED_DIR = path.join(__dirname, "data");
if (SEED_DIR !== DATA_DIR && fsSync.existsSync(SEED_DIR)) {
  for (const f of ["recordings.json", "templates.json"]) {
    const dst = path.join(DATA_DIR, f);
    const src = path.join(SEED_DIR, f);
    if (!fsSync.existsSync(dst) && fsSync.existsSync(src)) {
      fsSync.copyFileSync(src, dst);
      console.log(`[server] seeded ${f} from repo into ${DATA_DIR}`);
    }
  }
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "100mb" }));

// ===== Аутентификация админа =====
// Пароль задаётся через env ADMIN_PASSWORD. Если не задан — генерируется
// случайный (виден в логах при старте, чтобы локальный dev не падал).
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD
  || (process.env.NODE_ENV === "production"
        ? null
        : "admin123");

if (!ADMIN_PASSWORD) {
  console.warn(
    "[server] ADMIN_PASSWORD не задан в проде. Запись/удаление будут заблокированы для всех.",
  );
} else if (!process.env.ADMIN_PASSWORD) {
  console.log(`[server] dev-режим: ADMIN_PASSWORD = ${ADMIN_PASSWORD}`);
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function requireAdmin(req, res, next) {
  const sent = req.get("X-Admin-Auth") || "";
  if (!ADMIN_PASSWORD || !safeEqual(sent, ADMIN_PASSWORD)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

app.post("/api/auth/login", (req, res) => {
  const { password } = req.body || {};
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({ error: "auth disabled" });
  }
  if (!safeEqual(password || "", ADMIN_PASSWORD)) {
    return res.status(401).json({ error: "invalid password" });
  }
  // Простая схема: токен = сам пароль. Шлётся в X-Admin-Auth.
  // На HTTPS этого достаточно для «soft auth» — защита от случайных правок.
  res.json({ ok: true, token: ADMIN_PASSWORD });
});

app.get("/api/auth/check", (req, res) => {
  const sent = req.get("X-Admin-Auth") || "";
  const ok = ADMIN_PASSWORD && safeEqual(sent, ADMIN_PASSWORD);
  res.json({ ok: Boolean(ok) });
});

async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

const writeQueue = new Map();
async function writeJson(file, data) {
  const prev = writeQueue.get(file) || Promise.resolve();
  const next = prev.then(() => fs.writeFile(file, JSON.stringify(data)));
  writeQueue.set(file, next.catch(() => {}));
  return next;
}

const newId = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ===== Recordings =====
// GET — публичный (любой может читать/проигрывать).
// POST/PATCH/DELETE — только админ.
app.get("/api/recordings", async (_req, res) => {
  res.json(await readJson(RECORDINGS_FILE, []));
});

app.post("/api/recordings", requireAdmin, async (req, res) => {
  const recordings = await readJson(RECORDINGS_FILE, []);
  const body = req.body || {};
  const recording = {
    id: body.id || newId(),
    name: (body.name && String(body.name).trim()) || `Запись ${recordings.length + 1}`,
    frames: Array.isArray(body.frames) ? body.frames : [],
    duration: typeof body.duration === "number" ? body.duration : 0,
    createdAt: body.createdAt || new Date().toISOString(),
    source: body.source || "camera",
  };
  recordings.push(recording);
  await writeJson(RECORDINGS_FILE, recordings);
  res.json(recording);
});

app.patch("/api/recordings/:id", requireAdmin, async (req, res) => {
  const recordings = await readJson(RECORDINGS_FILE, []);
  const idx = recordings.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "not found" });
  const patch = req.body || {};
  recordings[idx] = {
    ...recordings[idx],
    ...patch,
    id: recordings[idx].id,
  };
  await writeJson(RECORDINGS_FILE, recordings);
  res.json(recordings[idx]);
});

app.delete("/api/recordings/:id", requireAdmin, async (req, res) => {
  const recordings = await readJson(RECORDINGS_FILE, []);
  const target = recordings.find((r) => r.id === req.params.id);
  const filtered = recordings.filter((r) => r.id !== req.params.id);
  await writeJson(RECORDINGS_FILE, filtered);

  // Каскад: если у удалённой записи была метка (имя), удаляем все шаблоны
  // распознавания с такой же меткой. Это поддерживает инвариант «запись и
  // эталон жеста живут вместе» — пользователь видит один и тот же набор
  // жестов в Анимациях и в Распознавании.
  let cascadedTemplates = 0;
  if (target) {
    const label = norm(target.name);
    // Не каскадим если остаются другие записи с тем же именем (бывают
    // несколько вариантов одного жеста).
    const stillHasRecording = filtered.some((r) => norm(r.name) === label);
    if (label && !stillHasRecording) {
      const templates = await readJson(TEMPLATES_FILE, []);
      const remaining = templates.filter((t) => norm(t.label) !== label);
      cascadedTemplates = templates.length - remaining.length;
      if (cascadedTemplates > 0) {
        await writeJson(TEMPLATES_FILE, remaining);
      }
    }
  }

  res.json({
    ok: true,
    removed: recordings.length - filtered.length,
    cascadedTemplates,
  });
});

function norm(s) {
  return (s || "").trim().toUpperCase();
}

// ===== Templates (DTW для распознавания) =====
app.get("/api/templates", async (_req, res) => {
  res.json(await readJson(TEMPLATES_FILE, []));
});

app.post("/api/templates", requireAdmin, async (req, res) => {
  const templates = await readJson(TEMPLATES_FILE, []);
  const body = req.body || {};
  const template = {
    id: body.id || newId(),
    label: String(body.label || "").trim(),
    features: Array.isArray(body.features) ? body.features : [],
    rawLength: typeof body.rawLength === "number" ? body.rawLength : 0,
    keyframeIndices: Array.isArray(body.keyframeIndices) ? body.keyframeIndices : [],
    createdAt: typeof body.createdAt === "number" ? body.createdAt : Date.now(),
  };
  templates.push(template);
  await writeJson(TEMPLATES_FILE, templates);
  res.json(template);
});

app.delete("/api/templates/:id", requireAdmin, async (req, res) => {
  const templates = await readJson(TEMPLATES_FILE, []);
  const target = templates.find((t) => t.id === req.params.id);
  const filtered = templates.filter((t) => t.id !== req.params.id);
  await writeJson(TEMPLATES_FILE, filtered);

  // Каскад: если после удаления у метки не осталось эталонов — удаляем
  // соответствующие записи (анимации) с этим именем. См. парный обработчик
  // в DELETE /api/recordings/:id.
  let cascadedRecordings = 0;
  if (target) {
    const label = norm(target.label);
    const stillHasTemplate = filtered.some((t) => norm(t.label) === label);
    if (label && !stillHasTemplate) {
      const recordings = await readJson(RECORDINGS_FILE, []);
      const remaining = recordings.filter((r) => norm(r.name) !== label);
      cascadedRecordings = recordings.length - remaining.length;
      if (cascadedRecordings > 0) {
        await writeJson(RECORDINGS_FILE, remaining);
      }
    }
  }

  res.json({ ok: true, cascadedRecordings });
});

app.delete("/api/templates", requireAdmin, async (_req, res) => {
  await writeJson(TEMPLATES_FILE, []);
  res.json({ ok: true });
});

// ===== Healthcheck =====
app.get("/api/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ===== Раздача собранного фронта (для деплоя) =====
if (fsSync.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(CLIENT_DIST, "index.html"));
  });
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[server] API listening on :${PORT}`);
  console.log(`[server] data dir: ${DATA_DIR}`);
});
