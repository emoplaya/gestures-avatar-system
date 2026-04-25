/**
 * Распознавание ДИНАМИЧЕСКИХ букв дактиля через модель Hold-Movement-Hold.
 *
 * Вход: поток MediaPipe-кадров (landmarks руки).
 * Выход: буква Й / Р / Ц / Ч / Щ / Ы / Ь / Ъ или null.
 *
 * Идея:
 *   1. Сегментируем поток на участки HOLD (рука фиксирована) и MOVE (движение).
 *      Сегментация по Δ(t) — сумме изменений формы кисти с вычетом движения запястья.
 *   2. В каждом HOLD запоминаем статическую форму (через recognizeDactylLetter).
 *   3. Когда видим последовательность HOLD_A → MOVE → HOLD_B, извлекаем
 *      параметры траектории запястья: направление, амплитуда, кривизна,
 *      количество разворотов (zero-crossings скорости).
 *   4. Сравниваем тройку (static_A, motion_params, static_B) со словарём
 *      динамических букв.
 *
 * Важно: алгоритм НЕ требует обучения. Это эвристика, как и основной
 * recognizeDactylLetter — просто расширенная на время.
 */

// ====== настройки сегментации ======

// Порог Δ выше которого считаем, что кисть ДВИЖЕТСЯ.
// Ниже — что замерла. Сглаженные данные сравниваются с этим значением.
const HOLD_DELTA_THRESHOLD = 0.05;

// Минимальная длительность удержания, мс. Нужно для фильтрации
// случайных одиночных «замираний» во время движения.
const MIN_HOLD_MS = 120;

// МИНИМАЛЬНАЯ длительность MOVE, мс. Если меньше — это не движение,
// а шум на границе HOLD (рука просто дёрнулась). Критично для Й/Ь/Ц,
// где в пике траектории скорость на мгновение падает.
const MIN_MOVE_MS = 80;

// МИНИМАЛЬНАЯ амплитуда движения запястья, чтобы считать MOVE настоящим.
// Если запястье сдвинулось меньше чем на это расстояние — стейт-машина
// не выходит из HOLD. Единицы — нормализованные координаты MediaPipe.
const MIN_MOVE_AMPLITUDE = 0.015;

// Максимальная длительность движения, мс.
const MAX_MOVE_MS = 2000;

// Размер окна для сглаживания Δ.
const DELTA_SMOOTH_WINDOW = 5;

// Окно для голосования по статической букве в HOLD, мс.
// В это окно собираем все опознанные буквы и берём самую частую.
const STATIC_VOTE_WINDOW_MS = 200;

// ====== вспомогательная математика ======

function deltaFormWrist(lm, prev) {
  if (!prev) return 0;
  const dxW = lm[0].x - prev[0].x;
  const dyW = lm[0].y - prev[0].y;
  const dzW = lm[0].z - prev[0].z;
  let s = 0;
  for (let i = 1; i < 21; i++) {
    s +=
      Math.abs(lm[i].x - prev[i].x - dxW) +
      Math.abs(lm[i].y - prev[i].y - dyW) +
      Math.abs(lm[i].z - prev[i].z - dzW);
  }
  return s;
}

function movingAverage(buf, window) {
  if (buf.length < window) return buf[buf.length - 1] ?? 0;
  let s = 0;
  for (let i = buf.length - window; i < buf.length; i++) s += buf[i];
  return s / window;
}

/**
 * Параметры траектории запястья за период движения.
 * wristPath — массив {x,y,z,t} точек запястья во времени.
 */
function analyzeWristPath(wristPath) {
  if (wristPath.length < 3) {
    return {
      dx: 0, dy: 0, dz: 0,
      amplitude: 0,
      turns: 0,
      dominantAxis: "none",
      direction: "none",
      durationMs: 0,
      maxDownY: 0, maxUpY: 0, maxLeftX: 0, maxRightX: 0,
      peakDirection: "none",
    };
  }
  const start = wristPath[0];
  const end = wristPath[wristPath.length - 1];
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dz = end.z - start.z;

  // Амплитуда = максимальное отклонение от прямой старт→конец.
  let amplitude = 0;
  for (const p of wristPath) {
    const proj = ((p.x - start.x) * dx + (p.y - start.y) * dy) / (dx * dx + dy * dy + 1e-9);
    const px = start.x + proj * dx;
    const py = start.y + proj * dy;
    const dev = Math.hypot(p.x - px, p.y - py);
    if (dev > amplitude) amplitude = dev;
  }

  // Максимальные отклонения от стартовой позиции по каждой оси.
  // ЭТО ключевая метрика для возвратных жестов (Й = вниз-вверх, стартовая и
  // конечная точки могут совпадать, но maxDownY покажет что движение было).
  let maxDownY = 0, maxUpY = 0, maxLeftX = 0, maxRightX = 0;
  for (const p of wristPath) {
    const dyi = p.y - start.y, dxi = p.x - start.x;
    if (dyi > maxDownY) maxDownY = dyi;   // y растёт вниз
    if (-dyi > maxUpY) maxUpY = -dyi;
    if (dxi > maxRightX) maxRightX = dxi;
    if (-dxi > maxLeftX) maxLeftX = -dxi;
  }
  // peakDirection — куда было НАИБОЛЬШЕЕ отклонение (а не куда пришли).
  const peaks = [
    { name: "down", value: maxDownY },
    { name: "up", value: maxUpY },
    { name: "right", value: maxRightX },
    { name: "left", value: maxLeftX },
  ].sort((a, b) => b.value - a.value);
  const peakDirection = peaks[0].value > 0.005 ? peaks[0].name : "none";

  // Количество «разворотов» = смены знака скорости по ведущей оси.
  let turns = 0;
  const leadingAxis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
  let lastSign = 0;
  for (let i = 1; i < wristPath.length; i++) {
    const d = leadingAxis === "x"
      ? wristPath[i].x - wristPath[i - 1].x
      : wristPath[i].y - wristPath[i - 1].y;
    const sign = d > 0.002 ? 1 : d < -0.002 ? -1 : 0;
    if (sign !== 0 && lastSign !== 0 && sign !== lastSign) turns++;
    if (sign !== 0) lastSign = sign;
  }

  // Доминирующая ось и направление финального смещения.
  const absX = Math.abs(dx), absY = Math.abs(dy), absZ = Math.abs(dz);
  let dominantAxis = "x", direction = dx > 0 ? "right" : "left";
  if (absY > absX && absY > absZ) {
    dominantAxis = "y";
    direction = dy > 0 ? "down" : "up";
  } else if (absZ > absX && absZ > absY) {
    dominantAxis = "z";
    direction = dz > 0 ? "away" : "toward";
  }

  return {
    dx, dy, dz,
    amplitude,
    turns,
    dominantAxis,
    direction,
    durationMs: end.t - start.t,
    maxDownY, maxUpY, maxLeftX, maxRightX,
    peakDirection,
  };
}

// ====== словарь динамических букв ======
//
// Правила сделаны «мягкими» — достаточно подходящей стартовой формы И
// характерного движения. Конечная форма используется только там, где
// она действительно ключевая.

const DYNAMIC_DEFINITIONS = [
  {
    letter: "Й",
    // Й = рука в позе И + кратковременное ОТКЛОНЕНИЕ ВНИЗ (куда бы
    // рука потом ни вернулась). Используем maxDownY/peakDirection, чтобы
    // жест «вниз-вверх в ту же точку» тоже срабатывал.
    match: (a, b, m) =>
      a === "И" &&
      m.peakDirection === "down" &&
      m.maxDownY >= 0.015 && m.maxDownY < 0.30 &&
      m.durationMs < 900,
  },
  {
    letter: "Щ",
    // Щ = форма Ш (три пальца вверх) + зигзаг (>=2 разворотов).
    // Идёт раньше «Ч», потому что более специфичное (turns >= 2).
    match: (a, b, m) =>
      a === "Ш" && m.turns >= 2,
  },
  {
    letter: "Ч",
    // Ч = форма Ш + движение вниз без зигзага.
    match: (a, b, m) =>
      a === "Ш" && m.direction === "down" && m.turns < 2,
  },
  {
    letter: "Ъ",
    // Ъ = форма Б + комбинированное движение (вниз-вправо), заметная амплитуда.
    match: (a, b, m) =>
      a === "Б" && m.amplitude > 0.04 &&
      (m.dominantAxis === "x" || m.turns >= 1),
  },
  {
    letter: "Ь",
    // Ь = форма Б + короткое движение вниз без разворотов.
    match: (a, b, m) =>
      a === "Б" && m.direction === "down" &&
      m.turns === 0 && m.amplitude < 0.06,
  },
  {
    letter: "Ы",
    // Ы = поза Б/У, короткий сдвиг по горизонтали.
    match: (a, b, m) =>
      (a === "Б" || a === "У") &&
      m.dominantAxis === "x" && m.turns === 0,
  },
  {
    letter: "Ц",
    // Ц = форма У (два пальца) + крючок вниз.
    match: (a, b, m) =>
      a === "У" && m.direction === "down" && m.amplitude < 0.10,
  },
  {
    letter: "Р",
    // Р = выпрямленный указательный (форма похожа на В/И/Б) + виляющее
    // движение (>=2 разворотов), не по оси Z.
    match: (a, b, m) =>
      (a === "В" || a === "И" || a === "Б" || a === "Ш") &&
      m.turns >= 2 && m.dominantAxis !== "z",
  },
];

// ====== стейт-машина ======

export class DynamicLetterRecognizer {
  constructor(recognizeStaticFn) {
    this.recognizeStatic = recognizeStaticFn;

    this.state = "IDLE";           // IDLE | HOLD_A | MOVE | HOLD_B
    this.stateEnteredAt = 0;
    this.prevLm = null;
    this.deltaBuffer = [];
    this.holdA = null;             // {letter}
    this.holdB = null;
    this.wristPath = [];
    this.lastEmitted = { letter: null, at: 0 };

    // Буфер голосования за статическую букву в HOLD.
    // Каждый элемент: {letter, t}. Отбрасываем всё старше STATIC_VOTE_WINDOW_MS.
    this.voteBuffer = [];

    // Статистика MOVE — для отладки и для проверки «настоящего» движения.
    this.moveStats = { maxDelta: 0, amplitude: 0 };
  }

  reset() {
    this.state = "IDLE";
    this.holdA = null;
    this.holdB = null;
    this.wristPath = [];
    this.deltaBuffer = [];
    this.prevLm = null;
    this.voteBuffer = [];
    this.moveStats = { maxDelta: 0, amplitude: 0 };
  }

  /**
   * Добавляет в буфер голосования результат recognizeStatic за текущий кадр.
   * Старые записи (> STATIC_VOTE_WINDOW_MS) удаляются.
   */
  _voteStatic(letter, now) {
    this.voteBuffer.push({ letter, t: now });
    // Чистим старое.
    const cutoff = now - STATIC_VOTE_WINDOW_MS;
    while (this.voteBuffer.length > 0 && this.voteBuffer[0].t < cutoff) {
      this.voteBuffer.shift();
    }
  }

  /**
   * Возвращает самую частую букву в буфере голосования, если её доля
   * не меньше 60% от всех голосов (включая null). Иначе null.
   */
  _winningStatic() {
    if (this.voteBuffer.length === 0) return null;
    const counts = new Map();
    for (const v of this.voteBuffer) {
      counts.set(v.letter, (counts.get(v.letter) || 0) + 1);
    }
    let best = null, bestCount = 0;
    for (const [l, c] of counts) {
      if (l !== null && c > bestCount) {
        best = l;
        bestCount = c;
      }
    }
    if (!best) return null;
    // Требуем, чтобы лучший ответ встречался хотя бы в половине случаев.
    return bestCount / this.voteBuffer.length >= 0.5 ? best : null;
  }

  /**
   * Настоящее ли это движение? Проверяем:
   *   - длительность >= MIN_MOVE_MS
   *   - амплитуда (смещение запястья относительно старта MOVE) >= MIN_MOVE_AMPLITUDE
   */
  _moveIsReal(now) {
    if (this.wristPath.length < 2) return false;
    const durationMs = now - this.stateEnteredAt;
    if (durationMs < MIN_MOVE_MS) return false;

    const start = this.wristPath[0];
    let maxR = 0;
    for (const p of this.wristPath) {
      const r = Math.hypot(p.x - start.x, p.y - start.y);
      if (r > maxR) maxR = r;
    }
    return maxR >= MIN_MOVE_AMPLITUDE;
  }

  /**
   * Вызывать на каждом кадре.
   * lm — landmarks руки (массив 21 точки) или null, если руки в кадре нет.
   * now — Date.now() или performance.now()
   *
   * Возвращает {letter, type: 'dynamic'|'static', confidence} или null.
   */
  process(lm, now) {
    if (!lm || lm.length < 21) {
      // Потеряли руку — через секунду обнуляем состояние.
      if (this.state !== "IDLE" && now - this.stateEnteredAt > 800) {
        this.reset();
      }
      return null;
    }

    // === Δ(t) ===
    const d = this.prevLm ? deltaFormWrist(lm, this.prevLm) : 0;
    this.deltaBuffer.push(d);
    if (this.deltaBuffer.length > DELTA_SMOOTH_WINDOW * 3) {
      this.deltaBuffer.shift();
    }

    let dSmooth, isHold;
    if (this.deltaBuffer.length < 3) {
      // На старте считаем HOLD, чтобы стейт-машина могла опознать
      // начальную форму сразу.
      dSmooth = 0;
      isHold = true;
    } else {
      dSmooth = movingAverage(this.deltaBuffer, DELTA_SMOOTH_WINDOW);
      isHold = dSmooth < HOLD_DELTA_THRESHOLD;
    }

    this.prevLm = lm;

    // Статику распознаём на КАЖДОМ кадре и отправляем в буфер голосования.
    // Это ключ — через 200 мс у нас есть «mode» (самая частая буква), а не
    // случайный результат в момент pivot'а.
    const staticResult = this.recognizeStatic(lm);
    this._voteStatic(staticResult?.letter || null, now);

    // === стейт-машина ===
    switch (this.state) {
      case "IDLE":
        if (isHold) {
          const winner = this._winningStatic();
          if (winner) {
            this.holdA = { letter: winner };
            this._enter("HOLD_A", now);
          }
        }
        break;

      case "HOLD_A":
        // В HOLD_A постоянно обновляем holdA по текущему голосованию.
        {
          const winner = this._winningStatic();
          if (winner) this.holdA = { letter: winner };
        }

        if (!isHold) {
          // Форма перестала быть стабильной — возможно, начинается движение.
          if (this.holdA) {
            this.wristPath = [{ x: lm[0].x, y: lm[0].y, z: lm[0].z, t: now }];
            this.moveStats = { maxDelta: dSmooth, amplitude: 0 };
            this._enter("MOVE", now);
          } else {
            this.state = "IDLE";
          }
        }
        break;

      case "MOVE":
        // Продолжаем писать траекторию запястья.
        this.wristPath.push({ x: lm[0].x, y: lm[0].y, z: lm[0].z, t: now });
        if (dSmooth > this.moveStats.maxDelta) this.moveStats.maxDelta = dSmooth;

        // Обновляем текущую амплитуду для отладки.
        {
          const s = this.wristPath[0];
          let maxR = 0;
          for (const p of this.wristPath) {
            const r = Math.hypot(p.x - s.x, p.y - s.y);
            if (r > maxR) maxR = r;
          }
          this.moveStats.amplitude = maxR;
        }

        if (now - this.stateEnteredAt > MAX_MOVE_MS) {
          this.reset();
          break;
        }

        // Переходим в HOLD_B только если MOVE был НАСТОЯЩИМ (по длительности
        // и амплитуде). Иначе это короткая пауза в середине движения —
        // останемся в MOVE.
        if (isHold && this._moveIsReal(now)) {
          this._enter("HOLD_B", now);
          // Критично: чистим буфер голосования, иначе в HOLD_B попадут
          // голоса за промежуточные формы из MOVE и «mode» будет не
          // финальной буквой, а шумом.
          this.voteBuffer = [];
        } else if (isHold) {
          // Мнимый HOLD (пик траектории) — пропускаем.
          // Если amplitude совсем мала и прошло мало времени — вернёмся в HOLD_A.
          if (
            now - this.stateEnteredAt < MIN_MOVE_MS &&
            this.moveStats.amplitude < MIN_MOVE_AMPLITUDE
          ) {
            // Рука просто дёрнулась в HOLD — возвращаемся.
            this.state = "HOLD_A";
            this.stateEnteredAt = now;
            this.wristPath = [];
          }
        }
        break;

      case "HOLD_B": {
        // Собираем статику по тому же механизму голосования.
        const winner = this._winningStatic();
        if (winner) this.holdB = { letter: winner };

        if (!isHold) {
          // Снова движение — мы не успели зафиксировать HOLD_B,
          // возвращаемся в MOVE, продолжаем записывать путь.
          this.wristPath.push({ x: lm[0].x, y: lm[0].y, z: lm[0].z, t: now });
          this.state = "MOVE";
          this.stateEnteredAt = now - MIN_MOVE_MS; // чтобы не ждать снова
          this.holdB = null;
          break;
        }

        // Раннее срабатывание: если в правиле динамической буквы финальная
        // форма не важна — пробуем матчить сразу, не ждём MIN_HOLD_MS.
        // Это критично для Й: после возврата руки в И пользователь не
        // обязательно долго её держит.
        const motion = analyzeWristPath(this.wristPath);
        const bForMatch = this.holdB?.letter ?? this.holdA.letter;
        const earlyLetter = this._matchDynamic(
          this.holdA.letter, bForMatch, motion,
        );

        const enoughTimeOrEarly =
          earlyLetter || (this.holdB && now - this.stateEnteredAt >= MIN_HOLD_MS);

        if (enoughTimeOrEarly) {
          const matchedLetter = earlyLetter;
          const result = matchedLetter
            ? { letter: matchedLetter, type: "dynamic", confidence: 0.8, motion }
            : null;

          // Сдвигаем контекст: HOLD_B становится HOLD_A для следующей буквы.
          this.holdA = this.holdB || this.holdA;
          this.holdB = null;
          this.wristPath = [];
          this.state = "HOLD_A";
          this.stateEnteredAt = now;

          if (result && !this._isDuplicate(result.letter, now)) {
            this.lastEmitted = { letter: result.letter, at: now };
            return result;
          }
        }
        break;
      }
    }

    return null;
  }

  _enter(state, now) {
    this.state = state;
    this.stateEnteredAt = now;
    if (state === "IDLE") this.reset();
  }

  _isDuplicate(letter, now) {
    return (
      this.lastEmitted.letter === letter &&
      now - this.lastEmitted.at < 600
    );
  }

  _matchDynamic(a, b, motion) {
    for (const def of DYNAMIC_DEFINITIONS) {
      try {
        if (def.match(a, b, motion)) return def.letter;
      } catch {
        // игнорируем — правила могут падать на граничных случаях
      }
    }
    return null;
  }

  /** Получить текущее состояние для отладочного UI. */
  getDebugState() {
    const lastDelta =
      this.deltaBuffer.length > 0
        ? this.deltaBuffer[this.deltaBuffer.length - 1]
        : 0;
    let smoothed = 0;
    if (this.deltaBuffer.length >= DELTA_SMOOTH_WINDOW) {
      let s = 0;
      for (let i = this.deltaBuffer.length - DELTA_SMOOTH_WINDOW; i < this.deltaBuffer.length; i++) s += this.deltaBuffer[i];
      smoothed = s / DELTA_SMOOTH_WINDOW;
    } else if (this.deltaBuffer.length > 0) {
      smoothed = lastDelta;
    }
    return {
      state: this.state,
      holdA: this.holdA?.letter || null,
      holdB: this.holdB?.letter || null,
      wristPathLen: this.wristPath.length,
      lastDelta,
      smoothedDelta: smoothed,
      threshold: HOLD_DELTA_THRESHOLD,
      isHold: smoothed < HOLD_DELTA_THRESHOLD,
      timeInState: this.stateEnteredAt ? Date.now() - this.stateEnteredAt : 0,
      lastEmitted: this.lastEmitted.letter,
      // Новые поля для отладки:
      votedStatic: this._winningStatic(),
      voteBufferSize: this.voteBuffer.length,
      moveAmplitude: this.moveStats.amplitude,
      moveMaxDelta: this.moveStats.maxDelta,
      moveThreshold: MIN_MOVE_AMPLITUDE,
    };
  }
}

export { analyzeWristPath, DYNAMIC_DEFINITIONS };
