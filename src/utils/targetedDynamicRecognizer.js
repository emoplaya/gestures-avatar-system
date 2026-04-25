/**
 * ТАРГЕТИРОВАННЫЙ распознаватель динамических букв русского дактиля.
 *
 * Принципиально отличается от общей стейт-машины тем, что:
 *   1. Пользователь заранее выбирает, какую букву он хочет показать.
 *   2. Распознаватель сравнивает то, что видит, со шаблоном ИМЕННО этой буквы.
 *   3. Нет проблемы «промежуточное распознавание выдаёт мусор» — у нас нет
 *      никакого «промежуточного», есть только «сработал шаблон Й / не сработал».
 *
 * Архитектура:
 *   - На каждом кадре пишем в кольцевой буфер снимок руки (landmarks + время).
 *   - Храним последние ~1500 мс (≈45 кадров на 30 fps).
 *   - Для каждой целевой буквы есть функция detectЙ(buffer), detectЦ(buffer) и т.д.
 *   - Детектор возвращает confidence ∈ [0, 1] и набор метрик для отладки.
 *   - Если confidence превысил порог — букву подтверждаем.
 */

const BUFFER_MS = 1500;

// ====== Геометрические помощники ======

function dist2D(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function dist3D(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function angleBetween(a, b, c) {
  // Угол в точке B между лучами BA и BC, в радианах.
  const bax = a.x - b.x, bay = a.y - b.y;
  const bcx = c.x - b.x, bcy = c.y - b.y;
  const d = bax * bcx + bay * bcy;
  const la = Math.hypot(bax, bay);
  const lc = Math.hypot(bcx, bcy);
  const cos = Math.max(-1, Math.min(1, d / (la * lc + 1e-9)));
  return Math.acos(cos);
}

// Проверки формы руки — согласованы с существующим gestureRecognizer.js,
// но более «допускающие», потому что мы имеем дело с динамикой
// (форма чуть сбивается во время движения).

function isFingerExtended(lm, mcp, pip, tip, threshold = 2.0) {
  // Палец «прямой» если угол MCP→PIP→TIP близок к π.
  return angleBetween(lm[mcp], lm[pip], lm[tip]) > threshold;
}

function isFingerCurled(lm, tipIdx, mcpIdx, threshold = 0.95) {
  const wrist = lm[0];
  return dist3D(wrist, lm[tipIdx]) < dist3D(wrist, lm[mcpIdx]) * threshold;
}

/**
 * Мягкая проверка «поза как И»: мизинец выпрямлен, указательный/средний/
 * безымянный согнуты. Большой палец — пофиг (на картинке в И он сверху
 * прижат к согнутым пальцам).
 */
function isPoseI(lm) {
  if (!lm || lm.length < 21) return false;
  const pinkyStraight = isFingerExtended(lm, 17, 18, 20, 1.9);
  const indexCurled = isFingerCurled(lm, 8, 5);
  const middleCurled = isFingerCurled(lm, 12, 9);
  const ringCurled = isFingerCurled(lm, 16, 13);
  return pinkyStraight && indexCurled && middleCurled && ringCurled;
}

/**
 * «Поза как У»: указательный и средний выпрямлены вместе, остальные согнуты.
 */
function isPoseU(lm) {
  if (!lm || lm.length < 21) return false;
  const indexStraight = isFingerExtended(lm, 5, 6, 8, 1.9);
  const middleStraight = isFingerExtended(lm, 9, 10, 12, 1.9);
  const ringCurled = isFingerCurled(lm, 16, 13);
  const pinkyCurled = isFingerCurled(lm, 20, 17);
  // Вместе (не широкая V):
  const together = dist2D(lm[8], lm[12]) < dist2D(lm[5], lm[9]) * 1.4;
  return indexStraight && middleStraight && ringCurled && pinkyCurled && together;
}

/**
 * «Поза как Ш»: указательный, средний, безымянный выпрямлены. Мизинец согнут.
 */
function isPoseSh(lm) {
  if (!lm || lm.length < 21) return false;
  const i = isFingerExtended(lm, 5, 6, 8, 1.9);
  const m = isFingerExtended(lm, 9, 10, 12, 1.9);
  const r = isFingerExtended(lm, 13, 14, 16, 1.9);
  const p = isFingerCurled(lm, 20, 17);
  return i && m && r && p;
}

/**
 * «Поза как Б»: все 4 пальца (без большого) выпрямлены и вместе.
 */
function isPoseB(lm) {
  if (!lm || lm.length < 21) return false;
  const i = isFingerExtended(lm, 5, 6, 8, 1.9);
  const m = isFingerExtended(lm, 9, 10, 12, 1.9);
  const r = isFingerExtended(lm, 13, 14, 16, 1.9);
  const p = isFingerExtended(lm, 17, 18, 20, 1.9);
  return i && m && r && p;
}

// ====== Анализ траектории запястья ======

/**
 * Считает параметры траектории запястья (точка 0) за указанное окно кадров.
 * Возвращает направления, амплитуды, и — что важно для Й — признак «движение
 * по дуге» (есть ли точка в пути, отклонённая ортогонально от прямой старт-конец).
 */
function analyzeWrist(frames) {
  if (frames.length < 3) return null;
  const pts = frames.map(f => ({ x: f.lm[0].x, y: f.lm[0].y, z: f.lm[0].z }));
  const s = pts[0], e = pts[pts.length - 1];
  const dx = e.x - s.x, dy = e.y - s.y, dz = e.z - s.z;

  // Максимальные отклонения от стартовой позиции.
  let maxDown = 0, maxUp = 0, maxLeft = 0, maxRight = 0;
  for (const p of pts) {
    const ddy = p.y - s.y, ddx = p.x - s.x;
    if (ddy > maxDown) maxDown = ddy;
    if (-ddy > maxUp) maxUp = -ddy;
    if (ddx > maxRight) maxRight = ddx;
    if (-ddx > maxLeft) maxLeft = -ddx;
  }

  // Общая длина пути.
  let pathLen = 0;
  for (let i = 1; i < pts.length; i++) pathLen += dist2D(pts[i], pts[i - 1]);
  const displacement = Math.hypot(dx, dy);
  // curvature ≈ 1 − прямота. 0 = идеально прямая линия, 1 = петля (вернулись в старт).
  const curvature = 1 - displacement / (pathLen + 1e-9);

  // Количество разворотов скорости по каждой оси отдельно.
  let turnsY = 0, turnsX = 0;
  let lastSx = 0, lastSy = 0;
  for (let i = 1; i < pts.length; i++) {
    const vx = pts[i].x - pts[i - 1].x, vy = pts[i].y - pts[i - 1].y;
    const sx = vx > 0.002 ? 1 : vx < -0.002 ? -1 : 0;
    const sy = vy > 0.002 ? 1 : vy < -0.002 ? -1 : 0;
    if (sx !== 0 && lastSx !== 0 && sx !== lastSx) turnsX++;
    if (sy !== 0 && lastSy !== 0 && sy !== lastSy) turnsY++;
    if (sx !== 0) lastSx = sx;
    if (sy !== 0) lastSy = sy;
  }

  return {
    durationMs: frames[frames.length - 1].t - frames[0].t,
    dx, dy, dz,
    displacement, pathLen, curvature,
    maxDown, maxUp, maxLeft, maxRight,
    turnsX, turnsY,
  };
}

/**
 * Проверка, что в буфере есть достаточно кадров, в которых форма соответствует
 * заданной (например, isPoseI).
 * Возвращает долю ∈ [0,1]: сколько из последних N кадров совпало.
 */
function poseConsistency(frames, poseFn, fromIdx = 0, toIdx = null) {
  if (!frames.length) return 0;
  const to = toIdx ?? frames.length;
  let match = 0, total = 0;
  for (let i = fromIdx; i < to; i++) {
    total++;
    if (poseFn(frames[i].lm)) match++;
  }
  return total ? match / total : 0;
}

// ====== Детекторы конкретных динамических букв ======

/**
 * Каждый детектор получает массив последних кадров и возвращает:
 *   { confidence: 0..1, reasons: {...}  }
 *
 * Порог confidence, при котором мы говорим «да, это она», — DETECT_THRESHOLD.
 */

const DETECT_THRESHOLD = 0.7;

/**
 * Й — поза И + маленькое резкое покачивающее движение запястьем.
 *
 * Главный признак: в середине буфера форма руки должна быть «И» (мизинец вверх,
 * остальные согнуты), и запястье должно совершить характерное короткое
 * движение — обычно вниз-вбок, как будто «рисуя» галочку над мизинцем.
 */
function detectY(frames) {
  const r = { confidence: 0, reasons: {} };
  if (frames.length < 8) { r.reasons.tooShort = true; return r; }

  const motion = analyzeWrist(frames);
  if (!motion) return r;

  // Поза И должна держаться в БОЛЬШИНСТВЕ кадров буфера.
  const iShare = poseConsistency(frames, isPoseI);
  r.reasons.iShare = iShare;

  // Движение должно быть заметным, но коротким.
  const moved = motion.pathLen >= 0.04 && motion.pathLen <= 0.5;
  const fastEnough = motion.durationMs >= 150 && motion.durationMs <= 1200;
  r.reasons.pathLen = motion.pathLen.toFixed(3);
  r.reasons.durationMs = motion.durationMs;
  r.reasons.curvature = motion.curvature.toFixed(2);

  // Собираем confidence из компонент.
  let c = 0;
  if (iShare >= 0.5) c += 0.5;       // половина confidence за правильную форму
  else if (iShare >= 0.3) c += 0.25;

  if (moved) c += 0.25;
  if (fastEnough) c += 0.15;
  if (motion.curvature > 0.3) c += 0.1;  // «не прямая» — бонус (значит было качание)

  r.confidence = Math.min(1, c);
  return r;
}

/**
 * Ц — поза У + резкий крючок ВНИЗ.
 */
function detectTs(frames) {
  const r = { confidence: 0, reasons: {} };
  if (frames.length < 8) { r.reasons.tooShort = true; return r; }
  const motion = analyzeWrist(frames);
  if (!motion) return r;

  const uShare = poseConsistency(frames, isPoseU);
  r.reasons.uShare = uShare;
  r.reasons.maxDown = motion.maxDown.toFixed(3);

  let c = 0;
  if (uShare >= 0.4) c += 0.5;
  if (motion.maxDown >= 0.025 && motion.maxDown < 0.25) c += 0.3;
  if (motion.durationMs < 1200) c += 0.2;
  r.confidence = Math.min(1, c);
  return r;
}

/**
 * Ч — поза Ш + движение вниз.
 */
function detectCh(frames) {
  const r = { confidence: 0, reasons: {} };
  if (frames.length < 8) { r.reasons.tooShort = true; return r; }
  const motion = analyzeWrist(frames);
  if (!motion) return r;

  const shShare = poseConsistency(frames, isPoseSh);
  r.reasons.shShare = shShare;
  r.reasons.maxDown = motion.maxDown.toFixed(3);

  let c = 0;
  if (shShare >= 0.4) c += 0.5;
  if (motion.maxDown >= 0.02) c += 0.3;
  if (motion.turnsY <= 2) c += 0.2;   // не зигзаг
  r.confidence = Math.min(1, c);
  return r;
}

/**
 * Щ — поза Ш + выраженный зигзаг (≥2 разворота по Y ИЛИ X).
 */
function detectShch(frames) {
  const r = { confidence: 0, reasons: {} };
  if (frames.length < 8) { r.reasons.tooShort = true; return r; }
  const motion = analyzeWrist(frames);
  if (!motion) return r;

  const shShare = poseConsistency(frames, isPoseSh);
  r.reasons.shShare = shShare;
  r.reasons.turnsX = motion.turnsX;
  r.reasons.turnsY = motion.turnsY;

  let c = 0;
  if (shShare >= 0.4) c += 0.5;
  if (motion.turnsX + motion.turnsY >= 3) c += 0.5;
  else if (motion.turnsX + motion.turnsY >= 2) c += 0.3;
  r.confidence = Math.min(1, c);
  return r;
}

/**
 * Ь — форма Б/И + крючок вниз.
 */
function detectSoftSign(frames) {
  const r = { confidence: 0, reasons: {} };
  if (frames.length < 8) { r.reasons.tooShort = true; return r; }
  const motion = analyzeWrist(frames);
  if (!motion) return r;

  const bShare = poseConsistency(frames, isPoseB);
  const iShare = poseConsistency(frames, isPoseI);
  r.reasons.bShare = bShare;
  r.reasons.iShare = iShare;
  r.reasons.maxDown = motion.maxDown.toFixed(3);

  let c = 0;
  if (Math.max(bShare, iShare) >= 0.4) c += 0.4;
  if (motion.maxDown >= 0.03) c += 0.4;
  if (motion.turnsY <= 1) c += 0.2;
  r.confidence = Math.min(1, c);
  return r;
}

/**
 * Ъ — форма Б + движение ВВЕРХ.
 */
function detectHardSign(frames) {
  const r = { confidence: 0, reasons: {} };
  if (frames.length < 8) { r.reasons.tooShort = true; return r; }
  const motion = analyzeWrist(frames);
  if (!motion) return r;

  const bShare = poseConsistency(frames, isPoseB);
  r.reasons.bShare = bShare;
  r.reasons.maxUp = motion.maxUp.toFixed(3);

  let c = 0;
  if (bShare >= 0.4) c += 0.4;
  if (motion.maxUp >= 0.03) c += 0.5;
  r.confidence = Math.min(1, c);
  return r;
}

/**
 * Ы — форма Б + горизонтальное движение.
 */
function detectYery(frames) {
  const r = { confidence: 0, reasons: {} };
  if (frames.length < 8) { r.reasons.tooShort = true; return r; }
  const motion = analyzeWrist(frames);
  if (!motion) return r;

  const bShare = poseConsistency(frames, isPoseB);
  r.reasons.bShare = bShare;
  const sideways = Math.max(motion.maxLeft, motion.maxRight);
  r.reasons.sideways = sideways.toFixed(3);

  let c = 0;
  if (bShare >= 0.4) c += 0.4;
  if (sideways >= 0.03) c += 0.4;
  // Вертикальное должно быть меньше горизонтального.
  if (sideways > Math.max(motion.maxDown, motion.maxUp)) c += 0.2;
  r.confidence = Math.min(1, c);
  return r;
}

/**
 * Р — форма как Ш/И + заметная ротация/вибрация.
 * Определяем как: высокий turnsX+turnsY И при этом короткое общее смещение.
 */
function detectR(frames) {
  const r = { confidence: 0, reasons: {} };
  if (frames.length < 10) { r.reasons.tooShort = true; return r; }
  const motion = analyzeWrist(frames);
  if (!motion) return r;

  const shShare = poseConsistency(frames, isPoseSh);
  const iShare = poseConsistency(frames, isPoseI);
  const baseShare = Math.max(shShare, iShare);
  r.reasons.baseShare = baseShare;
  r.reasons.turnsTotal = motion.turnsX + motion.turnsY;
  r.reasons.curvature = motion.curvature.toFixed(2);

  let c = 0;
  if (baseShare >= 0.35) c += 0.3;
  if (motion.turnsX + motion.turnsY >= 3) c += 0.4;
  else if (motion.turnsX + motion.turnsY >= 2) c += 0.2;
  if (motion.curvature > 0.5) c += 0.3;  // много «петляния» = Р
  r.confidence = Math.min(1, c);
  return r;
}

// ====== Публичное API — список букв и основной класс ======

export const DYNAMIC_LETTERS = [
  { id: "Й", label: "Й", description: "Поза И + покачивание", detect: detectY },
  { id: "Р", label: "Р", description: "Поза Ш + вибрация/ротация", detect: detectR },
  { id: "Ц", label: "Ц", description: "Поза У + крючок вниз", detect: detectTs },
  { id: "Ч", label: "Ч", description: "Поза Ш + движение вниз", detect: detectCh },
  { id: "Щ", label: "Щ", description: "Поза Ш + зигзаг", detect: detectShch },
  { id: "Ы", label: "Ы", description: "Поза Б + движение в сторону", detect: detectYery },
  { id: "Ь", label: "Ь", description: "Поза И/Б + крючок вниз", detect: detectSoftSign },
  { id: "Ъ", label: "Ъ", description: "Поза Б + движение вверх", detect: detectHardSign },
];

/**
 * Таргетированный распознаватель: мы проверяем ТОЛЬКО одну выбранную букву.
 * Это даёт лучшую точность, чем попытки угадать «какая-то из 8» одновременно.
 */
export class TargetedDynamicRecognizer {
  constructor() {
    this.buffer = [];          // [{lm, t}]
    this.targetLetter = null;  // "Й" / "Р" / и т.д.
    this.lastDetection = null; // для UI
    this.cooldownUntil = 0;    // чтоб не срабатывать дважды на одно движение
    this.lastReasons = {};     // для отладки
  }

  setTarget(letter) {
    this.targetLetter = letter;
    this.buffer = [];
    this.lastDetection = null;
    this.cooldownUntil = 0;
    this.lastReasons = {};
  }

  clearTarget() {
    this.setTarget(null);
  }

  reset() {
    this.buffer = [];
    this.lastDetection = null;
    this.lastReasons = {};
  }

  /**
   * На каждом кадре — пушим landmarks в буфер и пытаемся детектить.
   * Возвращает {letter, confidence} если буква только что распознана, иначе null.
   */
  process(lm, now) {
    if (!this.targetLetter) return null;
    if (!lm || lm.length < 21) return null;

    this.buffer.push({ lm, t: now });
    // чистим старое
    const cutoff = now - BUFFER_MS;
    while (this.buffer.length > 0 && this.buffer[0].t < cutoff) {
      this.buffer.shift();
    }

    if (now < this.cooldownUntil) return null;

    const def = DYNAMIC_LETTERS.find(x => x.id === this.targetLetter);
    if (!def) return null;

    const result = def.detect(this.buffer);
    this.lastReasons = result.reasons;
    this.lastDetection = { confidence: result.confidence, at: now };

    if (result.confidence >= DETECT_THRESHOLD) {
      // подтверждено — ставим cooldown и очищаем буфер,
      // чтобы не сработать ещё раз на той же записи.
      this.cooldownUntil = now + 1200;
      this.buffer = [];
      return {
        letter: this.targetLetter,
        confidence: result.confidence,
      };
    }
    return null;
  }

  getDebug() {
    return {
      target: this.targetLetter,
      bufferSize: this.buffer.length,
      lastConfidence: this.lastDetection?.confidence ?? 0,
      reasons: this.lastReasons,
      onCooldown: Date.now() < this.cooldownUntil,
    };
  }
}

// Экспорт вспомогательных проверок поз — могут пригодиться в UI
// для подсказки «вы в правильной стартовой форме».
export { isPoseI, isPoseU, isPoseSh, isPoseB };
