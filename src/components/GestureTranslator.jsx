import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  recognizeGesture,
  recognizeDactylLetter,
} from "../utils/gestureRecognizer";
import { TemplateMode } from "./TemplateMode";
import { useVideoRecognition } from "../hooks/useVideoRecognition";
import { useGestureRecorder } from "../hooks/useGestureRecorder";
import { useTeacher } from "../hooks/useTeacher";
import {
  IconHand, IconFilm, IconGraduation, IconMirror,
  IconClose, IconTrash, IconCheck,
} from "./icons";

const HOLD_MS = 900;
const COOLDOWN_MS = 1200;
const DACTYL_HOLD_MS = 700;
const DACTYL_COOLDOWN_MS = 600;

// Метаданные режимов. Порядок здесь определяет порядок кнопок в панели.
// Свойство teacherOnly=true означает, что режим доступен только учителю.
const MODE_META = {
  gesture: { label: "Жесты",    title: "Распознавание РЖЯ", icon: <IconHand size={18} /> },
  dactyl:  { label: "Дактиль",  title: "Дактильная азбука", icon: <IconHand size={18} /> },
  mirror:  { label: "Зеркало",  title: "Зеркало",           icon: <IconMirror size={18} /> },
  teach:   { label: "Обучение", title: "Обучение",          icon: <IconGraduation size={18} />, teacherOnly: true },
  record:  { label: "Запись",   title: "Запись жестов",     icon: <IconFilm size={18} />, teacherOnly: true },
};

export const GestureTranslator = ({ onDactylLetterRecognized } = {}) => {
  const setGestureCallback = useVideoRecognition((s) => s.setGestureCallback);
  const videoElement = useVideoRecognition((s) => s.videoElement);
  const isTeacher = useTeacher((s) => s.isTeacher);

  // Список доступных режимов с учётом роли — обычному пользователю
  // видны только Жесты / Дактиль / Зеркало.
  const MODES = useMemo(
    () =>
      Object.entries(MODE_META)
        .filter(([, m]) => isTeacher || !m.teacherOnly)
        .map(([id, m]) => ({ id, label: m.label })),
    [isTeacher],
  );

  const [mode, setMode] = useState("gesture"); // gesture | dactyl | mirror | teach | record

  // Если пользователь сидел в режиме учителя и вышел — переключим
  // на безопасный «жесты», иначе UI зависнет на скрытой кнопке.
  useEffect(() => {
    const def = MODE_META[mode];
    if (!def || (def.teacherOnly && !isTeacher)) {
      setMode("gesture");
    }
  }, [isTeacher, mode]);
  const [currentGesture, setCurrentGesture] = useState(null);
  const [holdProgress, setHoldProgress] = useState(0);
  const [words, setWords] = useState([]);

  // Дактиль
  const [currentLetter, setCurrentLetter] = useState(null);
  const [dactylProgress, setDactylProgress] = useState(0);
  const [dactylText, setDactylText] = useState("");

  const holdStartRef = useRef(null);
  const lastGestureIdRef = useRef(null);
  const lastConfirmedRef = useRef(0);

  const dactylHoldStartRef = useRef(null);
  const lastDactylIdRef = useRef(null);
  const lastDactylConfirmedRef = useRef(0);

  // Запись (сам захват кадров делает CameraWidget — здесь только UI)
  const isRecording = useGestureRecorder((s) => s.isRecording);
  const recordings = useGestureRecorder((s) => s.recordings);
  const startRecording = useGestureRecorder((s) => s.startRecording);
  const stopRecording = useGestureRecorder((s) => s.stopRecording);
  const cancelRecording = useGestureRecorder((s) => s.cancelRecording);
  const deleteRecording = useGestureRecorder((s) => s.deleteRecording);

  const [recordName, setRecordName] = useState("");
  const [showRecordings, setShowRecordings] = useState(false);
  const [recDuration, setRecDuration] = useState(0);
  const recTimerRef = useRef(null);

  // Таймер записи (для индикатора)
  useEffect(() => {
    if (isRecording) {
      const start = Date.now();
      recTimerRef.current = setInterval(
        () => setRecDuration(Date.now() - start),
        100,
      );
    } else {
      clearInterval(recTimerRef.current);
      setRecDuration(0);
    }
    return () => clearInterval(recTimerRef.current);
  }, [isRecording]);

  const processResults = useCallback(
    (results) => {
      const lm = results.rightHandLandmarks || results.leftHandLandmarks;

      if (!lm) {
        // Используем функциональные сеттеры для проверки изменения без prev в closure.
        setCurrentGesture((prev) => prev === null ? prev : null);
        setHoldProgress((prev) => prev === 0 ? prev : 0);
        holdStartRef.current = null;
        lastGestureIdRef.current = null;
        setCurrentLetter((prev) => prev === null ? prev : null);
        setDactylProgress((prev) => prev === 0 ? prev : 0);
        dactylHoldStartRef.current = null;
        lastDactylIdRef.current = null;
        return;
      }

      // Режим жестов
      if (mode === "gesture" || mode === "record") {
        const gesture = recognizeGesture(lm);
        // Обновляем только если реально поменялось — экономия перерисовок.
        setCurrentGesture((prev) =>
          (prev?.id || null) === (gesture?.id || null) ? prev : gesture,
        );

        if (!gesture) {
          setHoldProgress((prev) => prev === 0 ? prev : 0);
          holdStartRef.current = null;
          lastGestureIdRef.current = null;
          return;
        }

        const now = Date.now();
        if (gesture.id !== lastGestureIdRef.current) {
          lastGestureIdRef.current = gesture.id;
          holdStartRef.current = now;
          setHoldProgress((prev) => prev === 0 ? prev : 0);
          return;
        }

        const held = now - holdStartRef.current;
        const progress = Math.min(held / HOLD_MS, 1);
        // Обновляем прогресс только если изменение заметное (>3%).
        setHoldProgress((prev) => Math.abs(prev - progress) < 0.03 ? prev : progress);

        if (held >= HOLD_MS && now - lastConfirmedRef.current > COOLDOWN_MS) {
          lastConfirmedRef.current = now;
          holdStartRef.current = now;
          setWords((prev) => [...prev.slice(-49), gesture.label]);
        }
      }

      // Режим дактиля (статика).
      if (mode === "dactyl") {
        const gesture = recognizeGesture(lm);
        setCurrentGesture((prev) =>
          (prev?.id || null) === (gesture?.id || null) ? prev : gesture,
        );

        const letter = recognizeDactylLetter(lm);
        setCurrentLetter((prev) =>
          (prev?.id || null) === (letter?.id || null) ? prev : letter,
        );

        if (!letter) {
          setDactylProgress((prev) => prev === 0 ? prev : 0);
          dactylHoldStartRef.current = null;
          lastDactylIdRef.current = null;
          return;
        }

        const now = Date.now();
        if (letter.id !== lastDactylIdRef.current) {
          lastDactylIdRef.current = letter.id;
          dactylHoldStartRef.current = now;
          setDactylProgress((prev) => prev === 0 ? prev : 0);
          return;
        }

        const held = now - dactylHoldStartRef.current;
        const progress = Math.min(held / DACTYL_HOLD_MS, 1);
        setDactylProgress((prev) => Math.abs(prev - progress) < 0.03 ? prev : progress);

        if (
          held >= DACTYL_HOLD_MS &&
          now - lastDactylConfirmedRef.current > DACTYL_COOLDOWN_MS
        ) {
          lastDactylConfirmedRef.current = now;
          dactylHoldStartRef.current = now;
          setDactylText((prev) => prev + letter.letter);
          if (typeof onDactylLetterRecognized === "function") {
            onDactylLetterRecognized(letter.letter);
          }
        }
      }
    },
    [mode, onDactylLetterRecognized],
  );

  useEffect(() => {
    // В режиме "teach" callback устанавливается самим TemplateMode,
    // чтобы не было конфликта.
    // В режиме "mirror" распознавание не нужно — аватар просто повторяет.
    if (mode === "teach" || mode === "mirror") {
      return;
    }
    setGestureCallback(processResults);
    return () => setGestureCallback(null);
  }, [processResults, setGestureCallback, mode]);

  if (!videoElement) return null;

  const formatDuration = (ms) => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, "0")}`;
  };

  return (
    <div style={styles.container}>
      {/* Заголовок */}
      <div style={styles.header}>
        <span style={{ display: "inline-flex", alignItems: "center" }}>
          {MODE_META[mode].icon}
        </span>
        <span>{MODE_META[mode].title}</span>
        {(words.length > 0 || dactylText) && (
          <button
            onClick={() => {
              setWords([]);
              setDactylText("");
            }}
            title="Очистить"
            style={styles.clearBtn}
          >
            <IconClose size={12} />
          </button>
        )}
      </div>

      {/* Переключатель режимов — сетка 3×2 (5 кнопок, последняя ячейка пустая). */}
      <div style={styles.modeBar}>
        {MODES.map((m) => (
          <button
            key={m.id}
            onClick={() => setMode(m.id)}
            style={{
              ...styles.modeBtn,
              background:
                mode === m.id ? "rgba(99,102,241,0.7)" : "transparent",
              color: mode === m.id ? "#fff" : "#aaa",
            }}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* ===== РЕЖИМ ЖЕСТОВ ===== */}
      {(mode === "gesture" || mode === "record") && (
        <div style={styles.body}>
          {currentGesture ? (
            <>
              <div style={styles.gestureRow}>
                <span style={{ fontSize: "28px", lineHeight: 1 }}>
                  {currentGesture.emoji}
                </span>
                <div>
                  <div style={{ fontSize: "18px", fontWeight: 700 }}>
                    {currentGesture.label}
                  </div>
                  <div
                    style={{
                      fontSize: "11px",
                      color: "#aaa",
                      marginTop: "2px",
                    }}
                  >
                    {holdProgress < 1 ? "Держите жест..." : "Подтверждено ✓"}
                  </div>
                </div>
              </div>
              <ProgressBar value={holdProgress} />
            </>
          ) : (
            <div style={styles.placeholder}>Покажите жест в камеру</div>
          )}
        </div>
      )}

      {/* ===== РЕЖИМ ДАКТИЛЯ (статика) ===== */}
      {mode === "dactyl" && (
        <div style={styles.body}>
          {currentLetter ? (
            <>
              <div style={styles.gestureRow}>
                <span
                  style={{
                    fontSize: "32px",
                    fontWeight: 900,
                    lineHeight: 1,
                    color: dactylProgress >= 1 ? "#4ade80" : "#818cf8",
                  }}
                >
                  {currentLetter.letter}
                </span>
                <div>
                  <div style={{ fontSize: "14px", fontWeight: 700 }}>
                    Буква: {currentLetter.letter}
                  </div>
                  <div
                    style={{
                      fontSize: "11px",
                      color: "#aaa",
                      marginTop: "2px",
                    }}
                  >
                    {dactylProgress < 1 ? "Держите букву..." : "Добавлено ✓"}
                  </div>
                </div>
              </div>
              <ProgressBar value={dactylProgress} />
            </>
          ) : (
            <div style={styles.placeholder}>Покажите дактильную букву</div>
          )}

          {dactylText && (
            <div style={styles.dactylTextBox}>
              <div
                style={{
                  fontSize: "11px",
                  color: "#888",
                  marginBottom: "4px",
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                }}
              >
                Текст
              </div>
              <div
                style={{
                  fontSize: "18px",
                  fontWeight: 600,
                  letterSpacing: "0.05em",
                  wordBreak: "break-word",
                }}
              >
                {dactylText}
              </div>
              <div style={{ display: "flex", gap: "6px", marginTop: "6px" }}>
                <button
                  onClick={() => setDactylText("")}
                  style={styles.smallBtn}
                >
                  Очистить
                </button>
                <button
                  onClick={() => setDactylText((t) => t.slice(0, -1))}
                  style={styles.smallBtn}
                >
                  ← Удалить
                </button>
                <button
                  onClick={() => setDactylText((t) => t + " ")}
                  style={styles.smallBtn}
                >
                  Пробел
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ===== РЕЖИМ «ОБУЧЕНИЕ» (template matching, DTW) ===== */}
      {mode === "teach" && (
        <TemplateMode onRecognized={onDactylLetterRecognized} />
      )}

      {/* ===== РЕЖИМ «ЗЕРКАЛО» ===== */}
      {mode === "mirror" && (
        <div style={{ ...styles.body, borderRadius: "0 0 16px 16px" }}>
          <div style={styles.mirrorHero}>
            <IconMirror size={28} color="#a78bfa" />
            <div>
              <div style={styles.mirrorTitle}>Живое отражение</div>
              <div style={styles.mirrorSub}>
                Аватар повторяет ваши движения в реальном времени.
                Распознавание выключено — только трансляция позы и мимики.
              </div>
            </div>
          </div>
          <div style={styles.mirrorStatus}>
            <span style={styles.mirrorDot} />
            <span>Отражение активно</span>
          </div>
        </div>
      )}

      {/* ===== РЕЖИМ ЗАПИСИ ===== */}
      {mode === "record" && (
        <div style={styles.recordSection}>
          {!isRecording ? (
            <>
              <div style={{ fontSize: "11px", color: "#888", marginBottom: "8px", lineHeight: 1.4 }}>
                Записывается полная сцена (поза, обе руки, лицо).
                Запись доступна во вкладке «Анимации».
              </div>
              <button onClick={startRecording} style={styles.recBtn}>
                <span style={{ color: "#ef4444", fontSize: "14px", lineHeight: 1 }}>●</span>
                <span>Начать запись</span>
              </button>
              <button
                onClick={() => setShowRecordings((p) => !p)}
                style={styles.recListBtn}
              >
                <span style={{ fontSize: "10px", lineHeight: 1 }}>
                  {showRecordings ? "▲" : "▼"}
                </span>
                <span>Записи ({recordings.length})</span>
              </button>
            </>
          ) : (
            <div style={styles.recActive}>
              <div
                style={{ display: "flex", alignItems: "center", gap: "8px" }}
              >
                <span
                  style={{
                    color: "#ef4444",
                    fontSize: "14px",
                    animation: "blink 1s infinite",
                  }}
                >
                  ●
                </span>
                <span style={{ fontWeight: 700 }}>REC</span>
                <span style={{ color: "#aaa", fontSize: "13px" }}>
                  {formatDuration(recDuration)}
                </span>
              </div>
              <div style={{ display: "flex", gap: "6px", marginTop: "8px" }}>
                <input
                  type="text"
                  placeholder="Имя анимации..."
                  value={recordName}
                  onChange={(e) => setRecordName(e.target.value)}
                  style={styles.recInput}
                />
                <button
                  onClick={() => {
                    stopRecording(recordName || undefined);
                    setRecordName("");
                  }}
                  title="Сохранить"
                  style={{
                    ...styles.smallBtn,
                    background: "#4ade80",
                    color: "#000",
                  }}
                >
                  <IconCheck size={12} color="#000" />
                </button>
                <button
                  onClick={cancelRecording}
                  title="Отмена"
                  style={{ ...styles.smallBtn, background: "#ef4444" }}
                >
                  <IconClose size={12} />
                </button>
              </div>
            </div>
          )}

          {showRecordings && recordings.length > 0 && (
            <div style={styles.recList}>
              {recordings.map((rec) => (
                <div key={rec.id} style={styles.recItem}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: "13px",
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                      title={rec.name}
                    >
                      {rec.name}
                    </div>
                    <div style={{ fontSize: "11px", color: "#888" }}>
                      {formatDuration(rec.duration)} · {rec.frames.length}{" "}
                      кадров
                    </div>
                  </div>
                  <button
                    onClick={() => deleteRecording(rec.id)}
                    title="Удалить"
                    style={{
                      ...styles.smallBtn,
                      background: "rgba(255,255,255,0.1)",
                    }}
                  >
                    <IconTrash size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {showRecordings && recordings.length === 0 && (
            <div style={{ fontSize: "12px", color: "#888", padding: "8px 0" }}>
              Записей пока нет.
            </div>
          )}
        </div>
      )}

      {/* Накопленный текст (жесты) */}
      {mode === "gesture" && words.length > 0 && (
        <div style={styles.translationBox}>
          <div style={styles.translationLabel}>Перевод</div>
          <div style={styles.translationText}>{words.join(" ")}</div>
        </div>
      )}

      {/* Шпаргалка */}
      {mode === "gesture" && <GestureHint />}
      {mode === "dactyl" && <DactylHint />}

      <style>{`
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </div>
  );
};

// ---------- Подкомпоненты ----------

function ProgressBar({ value }) {
  return (
    <div
      style={{
        height: "4px",
        background: "rgba(255,255,255,0.15)",
        borderRadius: "2px",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          height: "100%",
          width: `${value * 100}%`,
          background:
            value >= 1 ? "#4ade80" : "linear-gradient(90deg, #818cf8, #a78bfa)",
          borderRadius: "2px",
          transition: "width 0.05s linear",
        }}
      />
    </div>
  );
}

function GestureHint() {
  const [open, setOpen] = useState(false);
  const gestures = [
    { emoji: "☝️", label: "один" },
    { emoji: "✌️", label: "два" },
    { emoji: "3️⃣", label: "три" },
    { emoji: "4️⃣", label: "четыре" },
    { emoji: "🖐️", label: "пять" },
    { emoji: "👍", label: "хорошо" },
    { emoji: "👎", label: "плохо" },
    { emoji: "👌", label: "понял" },
    { emoji: "✋", label: "стоп" },
    { emoji: "✊", label: "нет" },
    { emoji: "🤘", label: "рок" },
    { emoji: "🤙", label: "позвони" },
    { emoji: "👋", label: "привет" },
    { emoji: "👉", label: "ты" },
    { emoji: "🤞", label: "вместе" },
  ];

  return (
    <div style={styles.hintContainer}>
      <button onClick={() => setOpen((p) => !p)} style={styles.hintToggle}>
        <span style={{ fontSize: "10px", lineHeight: 1 }}>
          {open ? "▲" : "▼"}
        </span>
        <span>Доступные жесты</span>
      </button>
      {open && (
        <div style={styles.hintGrid}>
          {gestures.map((g) => (
            <div
              key={g.label}
              style={{ textAlign: "center", fontSize: "11px", color: "#ccc" }}
            >
              <div style={{ fontSize: "20px" }}>{g.emoji}</div>
              <div>{g.label}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DactylHint() {
  const [open, setOpen] = useState(false);
  const letters = [
    "А","Б","В","Г","Д","Е","Ж","З","И","К","Л","М","Н","О","П",
    "Р","С","Т","У","Ф","Х","Ш","Ы","Э","Ю","Я",
  ];

  return (
    <div style={styles.hintContainer}>
      <button onClick={() => setOpen((p) => !p)} style={styles.hintToggle}>
        <span style={{ fontSize: "10px", lineHeight: 1 }}>
          {open ? "▲" : "▼"}
        </span>
        <span>Дактильный алфавит</span>
      </button>
      {open && (
        <div
          style={{ ...styles.hintGrid, gridTemplateColumns: "repeat(6, 1fr)" }}
        >
          {letters.map((l) => (
            <div
              key={l}
              style={{
                textAlign: "center",
                fontSize: "16px",
                fontWeight: 700,
                color: "#a78bfa",
                padding: "4px",
              }}
            >
              {l}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Стили ----------

const styles = {
  container: {
    position: "fixed",
    top: "16px",
    right: "16px",
    zIndex: 9999,
    width: "300px",
    fontFamily: "sans-serif",
    color: "#fff",
    userSelect: "none",
  },
  header: {
    background: "rgba(0,0,0,0.75)",
    borderRadius: "16px 16px 0 0",
    padding: "10px 14px 8px",
    fontSize: "13px",
    fontWeight: 700,
    letterSpacing: "0.03em",
    borderBottom: "1px solid rgba(255,255,255,0.1)",
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
  clearBtn: {
    marginLeft: "auto",
    background: "none",
    border: "none",
    color: "#aaa",
    cursor: "pointer",
    fontSize: "14px",
    padding: "0 2px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 1,
  },
  modeBar: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: "4px",
    padding: "8px 10px",
    background: "rgba(0,0,0,0.7)",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
    boxSizing: "border-box",
  },
  modeBtn: {
    border: "1px solid rgba(255,255,255,0.08)",
    cursor: "pointer",
    fontSize: "11px",
    fontWeight: 600,
    padding: "6px 4px",
    transition: "all 0.15s",
    borderRadius: "6px",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0,
    letterSpacing: "0.02em",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "4px",
    lineHeight: 1,
    boxSizing: "border-box",
    textAlign: "center",
  },
  body: {
    background: "rgba(0,0,0,0.65)",
    padding: "12px 14px 10px",
  },
  gestureRow: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    marginBottom: "8px",
  },
  placeholder: {
    color: "#888",
    fontSize: "13px",
    textAlign: "center",
    padding: "6px 0",
  },
  dactylTextBox: {
    marginTop: "10px",
    padding: "8px 10px",
    background: "rgba(255,255,255,0.06)",
    borderRadius: "8px",
  },
  smallBtn: {
    border: "none",
    background: "rgba(255,255,255,0.15)",
    color: "#fff",
    borderRadius: "4px",
    padding: "4px 8px",
    fontSize: "11px",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "4px",
    lineHeight: 1,
    boxSizing: "border-box",
    whiteSpace: "nowrap",
  },
  recordSection: {
    background: "rgba(0,0,0,0.65)",
    padding: "10px 14px",
  },
  recBtn: {
    width: "100%",
    border: "none",
    background: "rgba(239,68,68,0.15)",
    color: "#fff",
    borderRadius: "8px",
    padding: "10px",
    fontSize: "13px",
    fontWeight: 600,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "8px",
    marginBottom: "6px",
  },
  recListBtn: {
    width: "100%",
    border: "none",
    background: "none",
    color: "#888",
    fontSize: "12px",
    cursor: "pointer",
    padding: "4px 0",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "6px",
    lineHeight: 1,
    boxSizing: "border-box",
  },
  recActive: {
    padding: "4px 0",
  },
  recInput: {
    flex: 1,
    border: "1px solid rgba(255,255,255,0.2)",
    background: "rgba(255,255,255,0.1)",
    color: "#fff",
    borderRadius: "4px",
    padding: "4px 8px",
    fontSize: "12px",
    outline: "none",
  },
  recList: {
    marginTop: "6px",
    maxHeight: "200px",
    overflowY: "auto",
  },
  recItem: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "6px 0",
    borderBottom: "1px solid rgba(255,255,255,0.06)",
  },
  translationBox: {
    background: "rgba(0,0,0,0.75)",
    padding: "10px 14px",
    borderTop: "1px solid rgba(255,255,255,0.08)",
  },
  translationLabel: {
    fontSize: "11px",
    color: "#888",
    marginBottom: "6px",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  translationText: {
    fontSize: "15px",
    lineHeight: 1.5,
    wordBreak: "break-word",
    maxHeight: "120px",
    overflowY: "auto",
  },
  hintContainer: {
    background: "rgba(0,0,0,0.6)",
    borderRadius: "0 0 16px 16px",
    marginTop: "2px",
    overflow: "hidden",
  },
  hintToggle: {
    width: "100%",
    background: "none",
    border: "none",
    color: "#888",
    fontSize: "12px",
    cursor: "pointer",
    padding: "6px 14px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "6px",
    lineHeight: 1,
    boxSizing: "border-box",
  },
  hintGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr 1fr",
    gap: "4px",
    padding: "4px 10px 12px",
  },
  // --- Стили панели «Зеркало» ---
  mirrorHero: {
    display: "flex",
    alignItems: "flex-start",
    gap: "10px",
    padding: "12px",
    background:
      "linear-gradient(135deg, rgba(129,140,248,0.12), rgba(167,139,250,0.08))",
    border: "1px solid rgba(167,139,250,0.25)",
    borderRadius: "10px",
    marginBottom: "10px",
  },
  mirrorTitle: {
    fontSize: "13px",
    fontWeight: 700,
    color: "#fff",
    marginBottom: "4px",
  },
  mirrorSub: {
    fontSize: "11px",
    color: "#aaa",
    lineHeight: 1.45,
  },
  mirrorStatus: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "8px 12px",
    background: "rgba(74,222,128,0.1)",
    border: "1px solid rgba(74,222,128,0.25)",
    borderRadius: "8px",
    fontSize: "11px",
    fontWeight: 600,
    color: "#4ade80",
  },
  mirrorDot: {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    background: "#4ade80",
    animation: "blink 1.4s ease-in-out infinite",
  },
};
