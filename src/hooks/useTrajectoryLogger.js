import { create } from "zustand";

/**
 * Логгер траекторий рук — для офлайн-анализа моментов фиксации жеста.
 *
 * На каждом кадре пишет 21 точку (x,y,z) обеих рук + производные величины:
 *  - суммарное смещение по L1 (Σ|Δxᵢ| + |Δyᵢ|) — «скорость» облака точек
 *  - то же самое, но относительно запястья (убирает глобальное движение руки)
 *  - суммарная скорость изменения углов в 15 суставах (три на палец × 5)
 *
 * Запись стартует по начальной позиции (первый кадр = baseline) и ведётся
 * до остановки. После остановки — экспорт в CSV.
 */
export const useTrajectoryLogger = create((set, get) => ({
  isLogging: false,
  sessionId: null,
  frames: [],          // массив кадров, см. формат в pushFrame
  startTime: null,

  start: (label = "") => {
    set({
      isLogging: true,
      sessionId: Date.now().toString(36),
      frames: [],
      startTime: Date.now(),
      label,
    });
  },

  stop: () => {
    set({ isLogging: false });
  },

  clear: () => {
    set({ frames: [], sessionId: null, startTime: null });
  },

  /**
   * Вызывается на каждом кадре из onResults MediaPipe.
   * results — то же, что приходит в VRMAvatar.resultsCallback.
   */
  pushFrame: (results) => {
    const state = get();
    if (!state.isLogging) return;
    const t = Date.now() - state.startTime;

    // Берём правую руку (если есть), иначе левую.
    // В MediaPipe Holistic leftHandLandmarks — это ваша левая рука с точки
    // зрения пользователя (зеркально), обычно мы распознаём по правой.
    const lm = results.rightHandLandmarks || results.leftHandLandmarks;
    if (!lm || lm.length < 21) {
      // Пустой кадр всё равно пишем, чтобы по времени ничего не «сжималось».
      set({
        frames: [...state.frames, { t, missing: true }],
      });
      return;
    }

    const frame = {
      t,
      missing: false,
      lm: lm.map((p) => ({ x: p.x, y: p.y, z: p.z })),
    };

    set({ frames: [...state.frames, frame] });
  },

  /**
   * Экспорт в CSV. Один кадр = одна строка.
   * Колонки:
   *  - t               (мс от старта)
   *  - missing         (1 если руки не было в кадре)
   *  - delta_l1        (Σ|Δx|+|Δy| по 21 точке, относительно ПРЕДЫДУЩЕГО кадра)
   *  - delta_l1_wrist  (то же, но с вычетом смещения запястья — «чистая форма»)
   *  - delta_angles    (сумма |Δугла| по 15 суставам, радианы)
   *  - x0..x20, y0..y20, z0..z20  (сырые координаты 21 точки)
   *
   * Для каждого производного канала первая строка = NaN (нет предыдущего кадра).
   */
  exportCSV: () => {
    const state = get();
    if (state.frames.length === 0) return;

    const header = [
      "t", "missing",
      "delta_l1", "delta_l1_wrist", "delta_angles",
    ];
    for (let i = 0; i < 21; i++) header.push(`x${i}`, `y${i}`, `z${i}`);

    const rows = [header.join(",")];
    let prev = null;

    for (const f of state.frames) {
      if (f.missing || !f.lm) {
        const empty = new Array(21 * 3).fill("").join(",");
        rows.push([f.t, 1, "", "", "", empty].join(","));
        prev = null;
        continue;
      }

      let dL1 = "", dL1Wrist = "", dAng = "";
      if (prev) {
        dL1 = sumL1(f.lm, prev);
        dL1Wrist = sumL1Wrist(f.lm, prev);
        dAng = sumAngleChange(f.lm, prev);
      }

      const coords = [];
      for (const p of f.lm) coords.push(p.x, p.y, p.z);

      rows.push([
        f.t, 0,
        fmt(dL1), fmt(dL1Wrist), fmt(dAng),
        ...coords.map(fmt),
      ].join(","));

      prev = f.lm;
    }

    const csv = rows.join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url;
    a.download = `trajectory_${state.label || "session"}_${stamp}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  },
}));

// ===== вспомогательные =====

function sumL1(curr, prev) {
  // Σ|Δx|+|Δy|+|Δz| по 21 точке — сырая «скорость» облака точек.
  let s = 0;
  for (let i = 0; i < 21; i++) {
    s +=
      Math.abs(curr[i].x - prev[i].x) +
      Math.abs(curr[i].y - prev[i].y) +
      Math.abs(curr[i].z - prev[i].z);
  }
  return s;
}

function sumL1Wrist(curr, prev) {
  // То же, но с вычетом движения запястья (lm[0]).
  // Получаем смещение КАЖДОЙ точки относительно запястья,
  // и смотрим, насколько оно изменилось между кадрами.
  const dxW = curr[0].x - prev[0].x;
  const dyW = curr[0].y - prev[0].y;
  const dzW = curr[0].z - prev[0].z;
  let s = 0;
  for (let i = 1; i < 21; i++) {
    s +=
      Math.abs(curr[i].x - prev[i].x - dxW) +
      Math.abs(curr[i].y - prev[i].y - dyW) +
      Math.abs(curr[i].z - prev[i].z - dzW);
  }
  return s;
}

/**
 * Сумма изменений углов в 15 суставах между текущим и предыдущим кадром.
 * Для каждого пальца берём 3 угла: MCP→PIP→DIP, PIP→DIP→TIP, и корень пальца.
 * Для большого пальца используем индексы 1,2,3,4; для остальных 5..20.
 */
function sumAngleChange(curr, prev) {
  const joints = [
    // большой
    [0, 1, 2], [1, 2, 3], [2, 3, 4],
    // указательный
    [0, 5, 6], [5, 6, 7], [6, 7, 8],
    // средний
    [0, 9, 10], [9, 10, 11], [10, 11, 12],
    // безымянный
    [0, 13, 14], [13, 14, 15], [14, 15, 16],
    // мизинец
    [0, 17, 18], [17, 18, 19], [18, 19, 20],
  ];
  let s = 0;
  for (const [a, b, c] of joints) {
    const aCurr = angle(curr[a], curr[b], curr[c]);
    const aPrev = angle(prev[a], prev[b], prev[c]);
    s += Math.abs(aCurr - aPrev);
  }
  return s;
}

function angle(a, b, c) {
  const bax = a.x - b.x, bay = a.y - b.y, baz = a.z - b.z;
  const bcx = c.x - b.x, bcy = c.y - b.y, bcz = c.z - b.z;
  const d = bax * bcx + bay * bcy + baz * bcz;
  const la = Math.sqrt(bax * bax + bay * bay + baz * baz);
  const lc = Math.sqrt(bcx * bcx + bcy * bcy + bcz * bcz);
  const cos = Math.max(-1, Math.min(1, d / (la * lc + 1e-9)));
  return Math.acos(cos);
}

function fmt(v) {
  if (v === "" || v === null || v === undefined) return "";
  if (typeof v !== "number" || !isFinite(v)) return "";
  return v.toFixed(6);
}
