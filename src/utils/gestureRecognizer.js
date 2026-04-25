/**
 * Распознавание жестов РЖЯ (Русский Жестовый Язык)
 * Использует 21 ключевую точку руки от MediaPipe Holistic.
 *
 * Индексы точек MediaPipe:
 *  0 — запястье
 *  1-4  — большой палец  (CMC, MCP, IP, TIP)
 *  5-8  — указательный   (MCP, PIP, DIP, TIP)
 *  9-12 — средний        (MCP, PIP, DIP, TIP)
 * 13-16 — безымянный     (MCP, PIP, DIP, TIP)
 * 17-20 — мизинец        (MCP, PIP, DIP, TIP)
 */

// ---------- Геометрические утилиты ----------

function dist3D(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

function vec3(a, b) {
  return { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function len(v) {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

/**
 * Угол между тремя точками (в радианах).
 * Угол в точке B между лучами BA и BC.
 */
function angleBetween(a, b, c) {
  const ba = vec3(b, a);
  const bc = vec3(b, c);
  const cosAngle = dot(ba, bc) / (len(ba) * len(bc) + 1e-8);
  return Math.acos(Math.max(-1, Math.min(1, cosAngle)));
}

/**
 * Определяет, выпрямлен ли палец по углам суставов.
 * Палец считается выпрямленным, если оба угла > порога (близки к 180°).
 */
function isExtendedByAngle(lm, mcpIdx, pipIdx, dipIdx, tipIdx, threshold = 2.4) {
  const anglePIP = angleBetween(lm[mcpIdx], lm[pipIdx], lm[dipIdx]);
  const angleDIP = angleBetween(lm[pipIdx], lm[dipIdx], lm[tipIdx]);
  return anglePIP > threshold && angleDIP > threshold;
}

/**
 * Определяет, выпрямлен ли большой палец.
 * Использует комбинацию: угол + расстояние от кончика до запястья.
 */
function isThumbExtended(lm) {
  const angle = angleBetween(lm[1], lm[2], lm[3]);
  const tipDist = dist3D(lm[0], lm[4]);
  const mcpDist = dist3D(lm[0], lm[2]);
  return angle > 2.2 && tipDist > mcpDist * 1.1;
}

/**
 * Определяет, согнут ли палец (кончик близко к ладони).
 */
function isCurled(lm, tipIdx, mcpIdx, threshold = 0.9) {
  const wrist = lm[0];
  return dist3D(wrist, lm[tipIdx]) < dist3D(wrist, lm[mcpIdx]) * threshold;
}

/**
 * Извлекает состояния пяти пальцев с использованием угловых проверок.
 */
function getFingerStates(lm) {
  return {
    thumb:  isThumbExtended(lm),
    index:  isExtendedByAngle(lm, 5, 6, 7, 8),
    middle: isExtendedByAngle(lm, 9, 10, 11, 12),
    ring:   isExtendedByAngle(lm, 13, 14, 15, 16),
    pinky:  isExtendedByAngle(lm, 17, 18, 19, 20),
  };
}

/**
 * Проверяет, образует ли большой палец кольцо с указательным (жест "ОК").
 */
function isThumbTouchingIndex(lm) {
  return dist3D(lm[4], lm[8]) < dist3D(lm[0], lm[5]) * 0.4;
}

/**
 * Проверяет, касается ли большой палец кончика среднего.
 */
function isThumbTouchingMiddle(lm) {
  return dist3D(lm[4], lm[12]) < dist3D(lm[0], lm[9]) * 0.4;
}

/**
 * Возвращает направление большого пальца: 'up' / 'down' / 'side'
 */
function getThumbDirection(lm) {
  const dy = lm[4].y - lm[0].y;
  if (dy < -0.10) return "up";
  if (dy > 0.10) return "down";
  return "side";
}

/**
 * Проверяет, направлена ли ладонь к камере.
 */
function isPalmFacingCamera(lm) {
  const palmZ = (lm[5].z + lm[9].z + lm[13].z + lm[17].z) / 4;
  return palmZ < lm[0].z;
}

/**
 * Среднее расстояние кончиков пальцев друг от друга (мера "растопырки").
 */
function getFingerSpread(lm) {
  const tips = [lm[8], lm[12], lm[16], lm[20]];
  let total = 0, count = 0;
  for (let i = 0; i < tips.length; i++)
    for (let j = i + 1; j < tips.length; j++) {
      total += dist3D(tips[i], tips[j]);
      count++;
    }
  return total / count;
}

/**
 * Угол сгиба пальца (0 = полностью разогнут, 1 = полностью согнут)
 */
function getFingerCurl(lm, mcpIdx, pipIdx, dipIdx, tipIdx) {
  const anglePIP = angleBetween(lm[mcpIdx], lm[pipIdx], lm[dipIdx]);
  const angleDIP = angleBetween(lm[pipIdx], lm[dipIdx], lm[tipIdx]);
  const avgAngle = (anglePIP + angleDIP) / 2;
  return Math.max(0, Math.min(1, 1 - (avgAngle - 1.0) / (Math.PI - 1.0)));
}

// ---------- Временное сглаживание ----------

const SMOOTHING_WINDOW = 4;
const landmarkHistory = [];

function smoothLandmarks(rawLm) {
  landmarkHistory.push(rawLm.map(p => ({ x: p.x, y: p.y, z: p.z })));
  if (landmarkHistory.length > SMOOTHING_WINDOW) {
    landmarkHistory.shift();
  }

  const n = landmarkHistory.length;
  if (n === 1) return rawLm;

  return rawLm.map((_, idx) => {
    let sx = 0, sy = 0, sz = 0;
    let totalWeight = 0;
    for (let i = 0; i < n; i++) {
      const w = (i + 1) / n; // более поздние кадры имеют больший вес
      sx += landmarkHistory[i][idx].x * w;
      sy += landmarkHistory[i][idx].y * w;
      sz += landmarkHistory[i][idx].z * w;
      totalWeight += w;
    }
    return {
      x: sx / totalWeight,
      y: sy / totalWeight,
      z: sz / totalWeight,
    };
  });
}

// ---------- Стабилизация результата ----------

let lastGestureId = null;
let gestureCounter = 0;
const STABILITY_FRAMES = 3; // жест должен держаться N кадров для подтверждения

function stabilizeGesture(gesture) {
  if (!gesture) {
    if (gestureCounter > 0) {
      gestureCounter--;
      if (gestureCounter > 0) {
        return { id: lastGestureId, _keep: true };
      }
    }
    lastGestureId = null;
    gestureCounter = 0;
    return null;
  }

  if (gesture.id === lastGestureId) {
    gestureCounter = Math.min(gestureCounter + 1, STABILITY_FRAMES + 2);
  } else {
    lastGestureId = gesture.id;
    gestureCounter = 1;
  }

  if (gestureCounter >= STABILITY_FRAMES) {
    return gesture;
  }
  return null;
}

// ---------- Определения жестов РЖЯ ----------

const GESTURE_DEFINITIONS = [
  // ─── ЧИСЛА ───
  {
    id: "one",
    label: "один",
    emoji: "☝️",
    priority: 10,
    check: ({ thumb, index, middle, ring, pinky }) =>
      !thumb && index && !middle && !ring && !pinky,
  },
  {
    id: "two",
    label: "два",
    emoji: "✌️",
    priority: 10,
    check: ({ thumb, index, middle, ring, pinky }) =>
      !thumb && index && middle && !ring && !pinky,
  },
  {
    id: "three",
    label: "три",
    emoji: "3️⃣",
    priority: 10,
    check: ({ thumb, index, middle, ring, pinky }) =>
      !thumb && index && middle && ring && !pinky,
  },
  {
    id: "four",
    label: "четыре",
    emoji: "4️⃣",
    priority: 10,
    check: ({ thumb, index, middle, ring, pinky }) =>
      !thumb && index && middle && ring && pinky,
  },
  {
    id: "five",
    label: "пять",
    emoji: "🖐️",
    priority: 8,
    check: ({ thumb, index, middle, ring, pinky }, lm) => {
      const spread = getFingerSpread(lm);
      return thumb && index && middle && ring && pinky && spread > 0.08;
    },
  },

  // ─── БАЗОВЫЕ ЖЕСТЫ / СЛОВА ───
  {
    id: "thumbs_up",
    label: "хорошо",
    emoji: "👍",
    priority: 15,
    check: ({ thumb, index, middle, ring, pinky }, lm) =>
      thumb && !index && !middle && !ring && !pinky &&
      getThumbDirection(lm) === "up",
  },
  {
    id: "thumbs_down",
    label: "плохо",
    emoji: "👎",
    priority: 15,
    check: ({ thumb, index, middle, ring, pinky }, lm) =>
      thumb && !index && !middle && !ring && !pinky &&
      getThumbDirection(lm) === "down",
  },
  {
    id: "ok",
    label: "понял",
    emoji: "👌",
    priority: 20,
    check: ({ middle, ring, pinky }, lm) =>
      middle && ring && pinky && isThumbTouchingIndex(lm),
  },
  {
    id: "open_hand",
    label: "стоп",
    emoji: "✋",
    priority: 5,
    check: ({ index, middle, ring, pinky }, lm) => {
      const spread = getFingerSpread(lm);
      return index && middle && ring && pinky && isPalmFacingCamera(lm) && spread > 0.07;
    },
  },
  {
    id: "fist",
    label: "нет",
    emoji: "✊",
    priority: 12,
    check: ({ index, middle, ring, pinky }, lm) =>
      !index && !middle && !ring && !pinky &&
      isCurled(lm, 8, 5) && isCurled(lm, 12, 9),
  },
  {
    id: "horns",
    label: "рок",
    emoji: "🤘",
    priority: 18,
    check: ({ index, middle, ring, pinky }) =>
      index && !middle && !ring && pinky,
  },
  {
    id: "call_me",
    label: "позвони",
    emoji: "🤙",
    priority: 18,
    check: ({ thumb, index, middle, ring, pinky }) =>
      thumb && !index && !middle && !ring && pinky,
  },

  // ─── РЖЯ — конкретные слова ───
  {
    id: "hello",
    label: "привет",
    emoji: "👋",
    priority: 6,
    check: ({ index, middle, ring, pinky }, lm) => {
      const spread = getFingerSpread(lm);
      return index && middle && ring && pinky && !isPalmFacingCamera(lm) && spread > 0.07;
    },
  },
  {
    id: "you",
    label: "ты",
    emoji: "👉",
    priority: 9,
    check: ({ thumb, index, middle, ring, pinky }, lm) =>
      !thumb && index && !middle && !ring && !pinky && lm[8].z < lm[5].z - 0.05,
  },
  {
    id: "pinky_up",
    label: "маленький",
    emoji: "🤏",
    priority: 12,
    check: ({ index, middle, ring, pinky }) =>
      !index && !middle && !ring && pinky,
  },
  {
    id: "crossed_index_middle",
    label: "вместе",
    emoji: "🤞",
    priority: 14,
    check: ({ index, middle, ring, pinky }, lm) => {
      if (!index || !middle || ring || pinky) return false;
      return dist3D(lm[8], lm[12]) < dist3D(lm[5], lm[9]) * 0.6;
    },
  },
];

// ---------- Дактильная азбука ----------

const DACTYL_DEFINITIONS = [
  {
    id: "dactyl_a",
    letter: "А",
    check: ({ thumb, index, middle, ring, pinky }, lm) =>
      !thumb && !index && !middle && !ring && !pinky &&
      isCurled(lm, 8, 5) && isCurled(lm, 12, 9) &&
      isCurled(lm, 16, 13) && isCurled(lm, 20, 17) &&
      // Большой палец сбоку от кулака
      dist3D(lm[4], lm[5]) < dist3D(lm[0], lm[5]) * 0.7,
  },
  {
    id: "dactyl_b",
    letter: "Б",
    check: ({ thumb, index, middle, ring, pinky }, lm) =>
      // Все пальцы кроме большого выпрямлены и вместе
      !thumb && index && middle && ring && pinky &&
      getFingerSpread(lm) < 0.06,
  },
  {
    id: "dactyl_v",
    letter: "В",
    check: ({ thumb, index, middle, ring, pinky }, lm) =>
      // Указательный и средний вверх, остальные согнуты, пальцы вместе
      !thumb && index && middle && !ring && !pinky &&
      dist3D(lm[8], lm[12]) < dist3D(lm[5], lm[9]) * 0.5,
  },
  {
    id: "dactyl_g",
    letter: "Г",
    check: ({ thumb, index, middle, ring, pinky }, lm) =>
      // Указательный палец горизонтально, остальные согнуты
      !thumb && index && !middle && !ring && !pinky &&
      Math.abs(lm[8].y - lm[6].y) < 0.04, // кончик и PIP на одной высоте
  },
  {
    id: "dactyl_d",
    letter: "Д",
    check: ({ thumb, index, middle, ring, pinky }, lm) =>
      // Средний палец вверх, указательный касается большого
      !index && middle && !ring && !pinky &&
      dist3D(lm[4], lm[8]) < 0.05,
  },
  {
    id: "dactyl_e",
    letter: "Е",
    check: ({ thumb, index, middle, ring, pinky }, lm) =>
      // Указательный и средний раздвинуты (V), остальные согнуты
      index && middle && !ring && !pinky &&
      dist3D(lm[8], lm[12]) > dist3D(lm[5], lm[9]) * 0.8,
  },
  {
    id: "dactyl_zh",
    letter: "Ж",
    check: ({ thumb, index, middle, ring, pinky }, lm) =>
      // Три средних пальца врозь, мизинец и большой согнуты
      !thumb && index && middle && ring && !pinky &&
      getFingerSpread(lm) > 0.08,
  },
  {
    id: "dactyl_z",
    letter: "З",
    check: ({ thumb, index, middle, ring, pinky }, lm) =>
      // Указательный согнут в форме крючка, остальные согнуты
      !thumb && !middle && !ring && !pinky &&
      // Кончик указательного ниже PIP
      lm[8].y > lm[6].y &&
      dist3D(lm[0], lm[8]) > dist3D(lm[0], lm[5]) * 0.6,
  },
  {
    id: "dactyl_i",
    letter: "И",
    check: ({ thumb, index, middle, ring, pinky }, lm) =>
      // Мизинец выпрямлен, остальные согнуты
      !thumb && !index && !middle && !ring && pinky,
  },
  {
    id: "dactyl_k",
    letter: "К",
    check: ({ thumb, index, middle, ring, pinky }, lm) =>
      // Указательный и средний вверх, средний согнут к указательному
      index && !ring && !pinky &&
      angleBetween(lm[9], lm[10], lm[12]) < 2.2 &&
      isExtendedByAngle(lm, 5, 6, 7, 8),
  },
  {
    id: "dactyl_l",
    letter: "Л",
    check: ({ thumb, index, middle, ring, pinky }, lm) =>
      // Большой и указательный подняты (буква L)
      thumb && index && !middle && !ring && !pinky &&
      Math.abs(lm[4].x - lm[8].x) > 0.06, // между ними расстояние
  },
  {
    id: "dactyl_m",
    letter: "М",
    check: ({ thumb, index, middle, ring, pinky }, lm) =>
      // Три пальца (указ, средний, безымянный) загнуты вниз, мизинец согнут
      !thumb && !pinky &&
      lm[8].y > lm[5].y && lm[12].y > lm[9].y && lm[16].y > lm[13].y,
  },
  {
    id: "dactyl_n",
    letter: "Н",
    check: ({ thumb, index, middle, ring, pinky }, lm) =>
      // Указательный и средний загнуты вниз, остальные согнуты
      !thumb && !ring && !pinky &&
      lm[8].y > lm[5].y && lm[12].y > lm[9].y &&
      !(lm[16].y > lm[13].y), // безымянный НЕ загнут (отличие от М)
  },
  {
    id: "dactyl_o",
    letter: "О",
    check: ({ thumb, index, middle, ring, pinky }, lm) =>
      // Все пальцы образуют кольцо (кончики вместе)
      isThumbTouchingIndex(lm) &&
      !middle && !ring && !pinky &&
      dist3D(lm[4], lm[8]) < 0.04,
  },
  {
    id: "dactyl_p",
    letter: "П",
    check: ({ thumb, index, middle, ring, pinky }, lm) =>
      // Указательный горизонтально, средний вниз
      index && !ring && !pinky &&
      Math.abs(lm[8].y - lm[6].y) < 0.04 &&
      lm[12].y > lm[10].y,
  },
  {
    id: "dactyl_r",
    letter: "Р",
    check: ({ thumb, index, middle, ring, pinky }, lm) =>
      // Указательный и средний перекрещены
      index && middle && !ring && !pinky &&
      // Перекрёстие: индексы X
      ((lm[8].x > lm[12].x) !== (lm[6].x > lm[10].x)),
  },
  {
    id: "dactyl_s",
    letter: "С",
    check: ({ thumb, index, middle, ring, pinky }, lm) =>
      // Рука в форме буквы С — полусогнутые пальцы
      dist3D(lm[4], lm[8]) > 0.04 && dist3D(lm[4], lm[8]) < 0.10 &&
      !isCurled(lm, 8, 5) && !isExtendedByAngle(lm, 5, 6, 7, 8, 2.6),
  },
  {
    id: "dactyl_t",
    letter: "Т",
    check: ({ thumb, index, middle, ring, pinky }, lm) =>
      // Кулак, большой палец между указательным и средним
      !index && !middle && !ring && !pinky &&
      lm[4].x > Math.min(lm[5].x, lm[9].x) &&
      lm[4].x < Math.max(lm[5].x, lm[9].x),
  },
  {
    id: "dactyl_u",
    letter: "У",
    check: ({ thumb, index, middle, ring, pinky }, lm) =>
      // Указательный и мизинец вверх ("рожки"), средний и безымянный согнуты
      index && !middle && !ring && pinky &&
      thumb, // большой отведён
  },
  {
    id: "dactyl_f",
    letter: "Ф",
    check: ({ thumb, index, middle, ring, pinky }, lm) =>
      // Большой и указательный образуют кольцо, остальные выпрямлены
      isThumbTouchingIndex(lm) && middle && ring && pinky,
  },
  {
    id: "dactyl_h",
    letter: "Х",
    check: ({ thumb, index, middle, ring, pinky }, lm) =>
      // Указательный согнут крючком
      !thumb && !middle && !ring && !pinky &&
      angleBetween(lm[6], lm[7], lm[8]) < 1.8 &&
      isExtendedByAngle(lm, 5, 6, 7, 8) === false,
  },
  {
    id: "dactyl_sh",
    letter: "Ш",
    check: ({ thumb, index, middle, ring, pinky }, lm) =>
      // Три пальца (указ, средний, безымянный) вверх, растопырены
      !thumb && index && middle && ring && !pinky &&
      getFingerSpread(lm) > 0.06 &&
      getFingerSpread(lm) < 0.12,
  },
  {
    id: "dactyl_y",
    letter: "Ы",
    check: ({ thumb, index, middle, ring, pinky }, lm) =>
      // Указательный и средний вверх, большой отведён в сторону
      thumb && index && middle && !ring && !pinky &&
      dist3D(lm[4], lm[5]) > 0.08,
  },
  {
    id: "dactyl_ee",
    letter: "Э",
    check: ({ thumb, index, middle, ring, pinky }, lm) =>
      // Указательный полусогнут (форма буквы С одной рукой)
      !thumb && !middle && !ring && !pinky &&
      angleBetween(lm[6], lm[7], lm[8]) > 1.5 &&
      angleBetween(lm[6], lm[7], lm[8]) < 2.3,
  },
  {
    id: "dactyl_yu",
    letter: "Ю",
    check: ({ thumb, index, middle, ring, pinky }, lm) =>
      // Большой и указательный образуют кольцо, мизинец выпрямлен
      isThumbTouchingIndex(lm) && !middle && !ring && pinky,
  },
  {
    id: "dactyl_ya",
    letter: "Я",
    check: ({ thumb, index, middle, ring, pinky }, lm) =>
      // Большой и мизинец выпрямлены ("позвони"), рука повёрнута к камере
      thumb && !index && !middle && !ring && pinky &&
      isPalmFacingCamera(lm),
  },
];

// ---------- Публичный API ----------

/**
 * Основная функция распознавания жестов.
 * @param {Array} landmarks — 21 точка руки от MediaPipe
 * @returns {{ id, label, emoji, confidence } | null}
 */
export function recognizeGesture(landmarks) {
  if (!landmarks || landmarks.length < 21) return null;

  const smoothed = smoothLandmarks(landmarks);
  const states = getFingerStates(smoothed);
  const matches = [];

  for (const gesture of GESTURE_DEFINITIONS) {
    try {
      if (gesture.check(states, smoothed)) {
        matches.push(gesture);
      }
    } catch {
      // ошибки в check игнорируем
    }
  }

  if (matches.length === 0) {
    const result = stabilizeGesture(null);
    if (result && result._keep) {
      const prev = GESTURE_DEFINITIONS.find(g => g.id === result.id);
      if (prev) return { id: prev.id, label: prev.label, emoji: prev.emoji, confidence: 0.6 };
    }
    return null;
  }

  matches.sort((a, b) => b.priority - a.priority);
  const winner = matches[0];

  const stable = stabilizeGesture(winner);
  if (!stable) return null;

  return {
    id: winner.id,
    label: winner.label,
    emoji: winner.emoji,
    confidence: 1.0,
  };
}

/**
 * Распознавание дактильной буквы.
 * @param {Array} landmarks — 21 точка руки от MediaPipe
 * @returns {{ id, letter, confidence } | null}
 */
export function recognizeDactylLetter(landmarks) {
  if (!landmarks || landmarks.length < 21) return null;

  const smoothed = smoothLandmarks(landmarks);
  const states = getFingerStates(smoothed);
  const matches = [];

  for (const def of DACTYL_DEFINITIONS) {
    try {
      if (def.check(states, smoothed)) {
        matches.push(def);
      }
    } catch {
      // ignore
    }
  }

  if (matches.length === 0) return null;
  const winner = matches[0];

  return {
    id: winner.id,
    letter: winner.letter,
    confidence: 0.85,
  };
}

/**
 * Возвращает сырые данные о ладони для записи.
 */
export function extractHandData(landmarks) {
  if (!landmarks || landmarks.length < 21) return null;
  const smoothed = smoothLandmarks(landmarks);
  const states = getFingerStates(smoothed);
  const curls = {
    index: getFingerCurl(smoothed, 5, 6, 7, 8),
    middle: getFingerCurl(smoothed, 9, 10, 11, 12),
    ring: getFingerCurl(smoothed, 13, 14, 15, 16),
    pinky: getFingerCurl(smoothed, 17, 18, 19, 20),
  };
  return {
    landmarks: smoothed.map(p => ({ x: p.x, y: p.y, z: p.z })),
    states,
    curls,
    spread: getFingerSpread(smoothed),
    palmFacing: isPalmFacingCamera(smoothed),
    thumbDir: getThumbDirection(smoothed),
    timestamp: Date.now(),
  };
}

export { GESTURE_DEFINITIONS, DACTYL_DEFINITIONS };
