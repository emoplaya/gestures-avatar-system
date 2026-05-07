import express from "express";
import cors from "cors";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const DATA_DIR        = path.join(__dirname, "data");
const RECORDINGS_FILE = path.join(DATA_DIR, "recordings.json");
const TEMPLATES_FILE  = path.join(DATA_DIR, "templates.json");
const CLIENT_DIST     = path.join(__dirname, "..", "dist");

if (!fsSync.existsSync(DATA_DIR)) fsSync.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: "100mb" }));

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
app.get("/api/recordings", async (_req, res) => {
  res.json(await readJson(RECORDINGS_FILE, []));
});

app.post("/api/recordings", async (req, res) => {
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

app.patch("/api/recordings/:id", async (req, res) => {
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

app.delete("/api/recordings/:id", async (req, res) => {
  const recordings = await readJson(RECORDINGS_FILE, []);
  const filtered = recordings.filter((r) => r.id !== req.params.id);
  await writeJson(RECORDINGS_FILE, filtered);
  res.json({ ok: true, removed: recordings.length - filtered.length });
});

// ===== Templates (DTW для распознавания) =====
app.get("/api/templates", async (_req, res) => {
  res.json(await readJson(TEMPLATES_FILE, []));
});

app.post("/api/templates", async (req, res) => {
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

app.delete("/api/templates/:id", async (req, res) => {
  const templates = await readJson(TEMPLATES_FILE, []);
  const filtered = templates.filter((t) => t.id !== req.params.id);
  await writeJson(TEMPLATES_FILE, filtered);
  res.json({ ok: true });
});

app.delete("/api/templates", async (_req, res) => {
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
