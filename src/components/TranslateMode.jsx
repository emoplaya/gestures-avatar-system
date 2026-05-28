import { useEffect, useMemo, useRef, useState } from "react";
import { useGestureRecorder } from "../hooks/useGestureRecorder";
import { useVideoRecognition } from "../hooks/useVideoRecognition";
import { useAdmin } from "../hooks/useAdmin";
import { TemplateMatcher } from "../utils/templateMatcher";
import {
  IconText, IconHand, IconPlay, IconStop, IconCamera, IconCameraOff,
  IconCheck, IconClose,
} from "./icons";

/**
 * Режим «Перевод».
 *
 * Два подрежима:
 *   1. "text"     — текст → анимация.
 *   2. "recognize" — камера → распознавание жеста по эталонам из «Обучение».
 *
 * В подрежиме "recognize" используется тот же TemplateMatcher, что и в
 * TemplateMode (вкладка «Интерактив» → «Обучение»). Это значит:
 *   - распознавание работает по тем же эталонам, что записаны в «Обучение»;
 *   - если при записи эталона пользователь согласился сохранить жест как
 *     анимацию (importRecording), то при распознавании метки находим
 *     соответствующую запись и проигрываем её на аватаре.
 */

export const TranslateMode = ({ onRecognizeActive }) => {
  const recordings = useGestureRecorder((s) => s.recordings);

  const [subMode, setSubMode] = useState("text"); // "text" | "recognize"

  // ===== Общий плеер (используется обоими подрежимами) =====
  const timerRef = useRef(null);
  const playingCtxRef = useRef(null);
  // Последний переведённый жест — показывается большим текстом на экране.
  const [lastTranslated, setLastTranslated] = useState("");

  // Ссылка на ОРИГИНАЛЬНЫЙ resultsCallback аватара (тот, что установил VRMAvatar
  // через setResultsCallback). В режиме "recognize" мы подменяем store.resultsCallback
  // на фильтрующую обёртку, но сам оригинал вызываем только из плеера.
  const avatarCbRef = useRef(null);

  const stopPlayback = () => {
    clearTimeout(timerRef.current);
    playingCtxRef.current = null;
    // Отправляем пустой кадр напрямую аватару, чтобы он вернулся в T-позу.
    if (avatarCbRef.current) {
      avatarCbRef.current({});
    } else {
      const cb = useVideoRecognition.getState().resultsCallback;
      if (cb) cb({});
    }
  };

  const playRecording = (recording, onDone) => {
    if (!recording || !recording.frames || recording.frames.length === 0) {
      onDone?.();
      return;
    }
    playingCtxRef.current = {
      frames: recording.frames,
      frameIdx: 0,
      onDone,
    };
    tickPlayback();
  };

  const tickPlayback = () => {
    const ctx = playingCtxRef.current;
    if (!ctx) return;

    // Прямая функция-отправитель: если есть сохранённый avatarCb — шлём
    // напрямую в него, в обход store (чтобы фильтр в listeningCb не блокировал).
    // Иначе (режим "text", обычный поток) — через store.resultsCallback.
    const sendToAvatar = (payload) => {
      if (avatarCbRef.current) {
        avatarCbRef.current(payload);
      } else {
        const cb = useVideoRecognition.getState().resultsCallback;
        if (cb) cb(payload);
      }
    };

    if (ctx.frameIdx >= ctx.frames.length) {
      sendToAvatar({});
      const done = ctx.onDone;
      playingCtxRef.current = null;
      timerRef.current = setTimeout(() => done?.(), 400);
      return;
    }

    const frame = ctx.frames[ctx.frameIdx];
    const nextFrame = ctx.frames[ctx.frameIdx + 1];
    sendToAvatar({
      poseLandmarks: frame.poseLandmarks,
      poseWorldLandmarks: frame.poseWorldLandmarks,
      leftHandLandmarks: frame.leftHandLandmarks,
      rightHandLandmarks: frame.rightHandLandmarks,
      faceLandmarks: frame.faceLandmarks,
    });
    ctx.frameIdx++;

    let delay = 33;
    if (nextFrame && typeof frame.t === "number" && typeof nextFrame.t === "number") {
      delay = Math.max(16, Math.min(100, nextFrame.t - frame.t));
    }
    timerRef.current = setTimeout(tickPlayback, delay);
  };

  useEffect(() => {
    return () => stopPlayback();
  }, []);

  // Автоматическая отсылка «нужна ли камера» по подрежиму убрана —
  // теперь камерой в режиме распознавания управляет кнопка внутри панели.
  // При уходе со вкладки «Перевод» компонент размонтируется, и всё очистится.

  // Статус, который видно в большом баннере: null | "playing" | "done".
  // Передаётся из RecognizeGesturePanel через setLastTranslatedState.
  const [translatedState, setTranslatedState] = useState(null); // null | "playing" | "done"

  useEffect(() => {
    if (translatedState === "done") {
      const t = setTimeout(() => {
        setLastTranslated("");
        setTranslatedState(null);
      }, 1400);
      return () => clearTimeout(t);
    }
  }, [translatedState]);

  return (
    <>
      <style>{`
        @keyframes translatedFadeIn {
          from { opacity: 0; transform: translateX(-50%) translateY(-6px); }
          to   { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
      `}</style>
      {/* Большой экранный баннер статуса распознавания. */}
      {lastTranslated && (
        <div style={{
          ...styles.translatedBanner,
          borderColor: translatedState === "playing"
            ? "rgba(74,222,128,0.55)"
            : "rgba(129,140,248,0.45)",
        }}>
          <div style={styles.translatedLabel}>
            {translatedState === "playing" ? (
              <><IconPlay size={11} /> Воспроизвожу</>
            ) : (
              <><IconCheck size={11} /> Распознано</>
            )}
          </div>
          <div style={styles.translatedText}>{lastTranslated}</div>
        </div>
      )}

      <div style={styles.container}>
        <div style={styles.header}>
          <IconText size={18} />
          <span>Перевод</span>
        </div>

        {/* Переключатель подрежимов */}
        <div style={styles.subTabBar}>
          {[
            { id: "text", label: "Из текста" },
            { id: "recognize", label: "Распознать жест" },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => {
                stopPlayback();
                setSubMode(t.id);
                setLastTranslated("");
              }}
              style={{
                ...styles.subTabBtn,
                background: subMode === t.id ? "rgba(99,102,241,0.7)" : "transparent",
                color: subMode === t.id ? "#fff" : "#aaa",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {subMode === "text" ? (
          <FromTextPanel
            recordings={recordings}
            playRecording={playRecording}
            stopPlayback={stopPlayback}
            setLastTranslated={setLastTranslated}
          />
        ) : (
          <RecognizeGesturePanel
            recordings={recordings}
            playRecording={playRecording}
            stopPlayback={stopPlayback}
            onCameraActiveChange={onRecognizeActive}
            setLastTranslated={setLastTranslated}
            setTranslatedState={setTranslatedState}
            avatarCbRef={avatarCbRef}
          />
        )}
      </div>
    </>
  );
};

// ================= Подрежим: текст → жест =================

const FromTextPanel = ({ recordings, playRecording, stopPlayback, setLastTranslated }) => {
  const isAdmin = useAdmin((s) => s.isAdmin);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState("idle"); // idle | playing
  const [queue, setQueue] = useState([]);
  const [currentIdx, setCurrentIdx] = useState(-1);

  const recordingByName = useMemo(() => {
    const m = new Map();
    for (const r of recordings) m.set(r.name.trim().toUpperCase(), r);
    return m;
  }, [recordings]);

  const buildQueue = (text) => {
    const words = text
      .split(/\s+/)
      .map((w) => w.trim().toUpperCase())
      .filter(Boolean);
    return words.map((w) => ({
      label: w,
      recording: recordingByName.get(w) || null,
      found: recordingByName.has(w),
    }));
  };

  const playAt = (idx, q) => {
    if (idx >= q.length) {
      stop();
      return;
    }
    const item = q[idx];
    if (!item.found) {
      const nextFound = q.findIndex((x, i) => i > idx && x.found);
      if (nextFound < 0) {
        stop();
        return;
      }
      playAt(nextFound, q);
      return;
    }
    setCurrentIdx(idx);
    setLastTranslated?.(item.label);
    playRecording(item.recording, () => {
      const nextFound = q.findIndex((x, i) => i > idx && x.found);
      if (nextFound < 0) {
        stop();
        return;
      }
      playAt(nextFound, q);
    });
  };

  const handleTranslate = () => {
    if (!input.trim()) return;
    const q = buildQueue(input);
    setQueue(q);
    setCurrentIdx(-1);
    const firstFound = q.findIndex((x) => x.found);
    if (firstFound < 0) {
      setStatus("idle");
      return;
    }
    setStatus("playing");
    playAt(firstFound, q);
  };

  const stop = () => {
    stopPlayback();
    setStatus("idle");
    setCurrentIdx(-1);
  };

  const missingCount = queue.filter((x) => !x.found).length;

  return (
    <div style={styles.body}>
      <div style={styles.label}>Введите слова, которые хотите показать</div>
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="ПРИВЕТ СПАСИБО ДА"
        rows={3}
        disabled={status === "playing"}
        style={styles.textarea}
      />

      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
        {status === "idle" ? (
          <button
            onClick={handleTranslate}
            disabled={!input.trim() || recordings.length === 0}
            style={{
              ...styles.playBtn,
              opacity: !input.trim() || recordings.length === 0 ? 0.4 : 1,
              cursor:
                !input.trim() || recordings.length === 0 ? "not-allowed" : "pointer",
            }}
          >
            <IconPlay size={13} />
            <span>Перевести</span>
          </button>
        ) : (
          <button onClick={stop} style={styles.stopBtn}>
            <IconStop size={13} />
            <span>Остановить</span>
          </button>
        )}
      </div>

      {recordings.length === 0 && (
        <div style={styles.warn}>
          {isAdmin
            ? "Нет записанных жестов. Перейдите на вкладку «Интерактив» → «Обучение», запишите жест, и при сохранении согласитесь добавить его как анимацию."
            : "Администратор ещё не загрузил ни одного жеста."}
        </div>
      )}

      {queue.length > 0 && (
        <div style={styles.queueBox}>
          <div style={styles.label}>Очередь воспроизведения</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {queue.map((item, i) => (
              <div
                key={i}
                style={{
                  ...styles.chip,
                  background:
                    i === currentIdx
                      ? "rgba(74,222,128,0.3)"
                      : item.found
                      ? "rgba(129,140,248,0.15)"
                      : "rgba(239,68,68,0.15)",
                  color:
                    i === currentIdx
                      ? "#4ade80"
                      : item.found
                      ? "#a78bfa"
                      : "#ef4444",
                  borderColor:
                    i === currentIdx
                      ? "#4ade80"
                      : item.found
                      ? "rgba(129,140,248,0.3)"
                      : "rgba(239,68,68,0.3)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                }}
              >
                {i === currentIdx && <IconPlay size={10} color="#4ade80" />}
                {item.label}
                {!item.found && " (нет)"}
              </div>
            ))}
          </div>
          {missingCount > 0 && status === "idle" && (
            <div style={{ fontSize: 11, color: "#ef4444", marginTop: 6 }}>
              Не найдено жестов: {missingCount}. Запишите их во вкладке «Обучение».
            </div>
          )}
        </div>
      )}

      <div style={styles.hint}>
        Сохранённых жестов: {recordings.length}. Слова ищутся по имени записи.
        Регистр не важен.
      </div>
    </div>
  );
};

// ============ Подрежим: камера → распознавание → жест ============

const RecognizeGesturePanel = ({
  recordings,
  playRecording,
  stopPlayback,
  onCameraActiveChange,
  setLastTranslated,
  setTranslatedState,
  avatarCbRef,
}) => {
  const isAdmin = useAdmin((s) => s.isAdmin);
  // Статусы: idle (ждём жест) | playing (проигрываем ответ)
  const [status, setStatus] = useState("idle");
  const [cameraOn, setCameraOn] = useState(false);
  const [lastMatch, setLastMatch] = useState(null); // { name, distance }
  const [history, setHistory] = useState([]);

  const statusRef = useRef("idle");
  statusRef.current = status;

  // TemplateMatcher — тот же, что в «Обучение». Эталоны теперь хранятся на
  // backend; load() их подтягивает (async). Поэтому стартуем с 0 и
  // обновляем счётчик после первой загрузки + периодически.
  const matcherRef = useRef(null);
  if (!matcherRef.current) {
    matcherRef.current = new TemplateMatcher();
  }
  const [templatesCount, setTemplatesCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    matcherRef.current.load().then(() => {
      if (!cancelled) setTemplatesCount(matcherRef.current.getTemplates().length);
    });
    return () => { cancelled = true; };
  }, []);

  const videoElement = useVideoRecognition((s) => s.videoElement);

  // Индекс «запись по метке» — чтобы по label от TemplateMatcher найти
  // соответствующую анимацию в useGestureRecorder.
  const recordingsByLabel = useMemo(() => {
    const m = new Map();
    for (const r of recordings) m.set(r.name.trim().toUpperCase(), r);
    return m;
  }, [recordings]);

  // Сообщаем наружу, нужно ли держать камеру включённой.
  useEffect(() => {
    onCameraActiveChange?.(cameraOn);
    return () => onCameraActiveChange?.(false);
  }, [cameraOn, onCameraActiveChange]);

  // Каждые 2 секунды переподтягиваем эталоны с сервера — на случай,
  // если пользователь только что записал новый жест во вкладке «Обучение»
  // и вернулся сюда (или жест был добавлен с другого устройства).
  useEffect(() => {
    let cancelled = false;
    const id = setInterval(async () => {
      await matcherRef.current.load();
      if (!cancelled) {
        setTemplatesCount(matcherRef.current.getTemplates().length);
      }
    }, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Пока камера включена в этом режиме — БЛОКИРУЕМ передачу живых кадров
  // от MediaPipe к аватару через глобальный флаг в store. Аватар стоит
  // в T-позе вне зависимости от того, что показывает камера.
  //
  // Проигрывание записанной анимации идёт через avatarCbRef напрямую,
  // минуя MediaPipe-пайплайн (см. tickPlayback в TranslateMode).
  const setGestureCallback = useVideoRecognition((s) => s.setGestureCallback);
  const setLiveFeedBlocked = useVideoRecognition((s) => s.setLiveFeedBlocked);

  useEffect(() => {
    if (!cameraOn) {
      setGestureCallback(null);
      setLiveFeedBlocked(false);
      return;
    }

    // Блокируем живые кадры для аватара на всё время работы в этом подрежиме.
    setLiveFeedBlocked(true);

    // Сохраняем ссылку на avatar-callback, чтобы плеер мог кормить его
    // кадрами записи напрямую (обходя блокировку).
    const store = useVideoRecognition.getState();
    if (!avatarCbRef.current && store.resultsCallback) {
      avatarCbRef.current = store.resultsCallback;
    }

    // Слушаем жест через отдельный канал gestureCallback.
    const listeningCb = (results) => {
      if (!results) return;
      if (statusRef.current === "playing") return;
      const lm = results.rightHandLandmarks || results.leftHandLandmarks;
      if (!lm) return;

      const result = matcherRef.current.process(lm, Date.now());
      if (!result) return;

      const label = result.label.trim().toUpperCase();
      const rec = recordingsByLabel.get(label);
      if (rec) {
        handleRecognized(rec, result);
      } else {
        setLastMatch({ name: result.label, distance: result.distance });
        setLastTranslated?.(result.label);
        setHistory((h) => [
          ...h.slice(-9),
          { name: result.label + " (нет анимации)", at: Date.now() },
        ]);
      }
    };
    setGestureCallback(listeningCb);

    return () => {
      setGestureCallback(null);
      // Разблокируем живые кадры при выходе из подрежима.
      setLiveFeedBlocked(false);
    };
  }, [cameraOn, recordingsByLabel, setGestureCallback, setLiveFeedBlocked, avatarCbRef]);

  // Обновление ссылки на avatar-callback, когда VRMAvatar его пересоздаёт.
  // Проверяем раз в 500 мс — это дёшево, и покрывает редкие переизменения
  // (при смене videoElement, аватара, и т.д.).
  useEffect(() => {
    if (!cameraOn) return;
    const id = setInterval(() => {
      const current = useVideoRecognition.getState().resultsCallback;
      if (current && current !== avatarCbRef.current) {
        avatarCbRef.current = current;
      }
    }, 500);
    return () => clearInterval(id);
  }, [cameraOn, avatarCbRef]);

  const handleRecognized = (recording, matchResult) => {
    setStatus("playing");
    setLastMatch({ name: recording.name, distance: matchResult.distance });
    setLastTranslated?.(recording.name);
    setTranslatedState?.("playing");
    setHistory((h) => [
      ...h.slice(-9),
      { name: recording.name, at: Date.now() },
    ]);

    // playRecording пишет кадры в resultsCallback аватара напрямую.
    // Наш gestureCallback отключится через useEffect при смене status → playing.
    playRecording(recording, () => {
      setStatus("idle");
      // Сигнал о завершении — баннер сам исчезнет через ~1.4с.
      setTranslatedState?.("done");
    });
  };

  const handleClearHistory = () => {
    setHistory([]);
    setLastMatch(null);
    setLastTranslated?.("");
  };

  const handleToggleCamera = () => {
    if (cameraOn) {
      stopPlayback();
      setStatus("idle");
    }
    setCameraOn((v) => !v);
  };

  return (
    <div style={styles.body}>
      {/* Кнопка управления камерой */}
      <button
        onClick={handleToggleCamera}
        style={{
          ...styles.playBtn,
          width: "100%",
          background: cameraOn
            ? "#ef4444"
            : "linear-gradient(90deg, #818cf8, #a78bfa)",
          marginBottom: 10,
        }}
      >
        {cameraOn ? (
          <><IconCameraOff size={13} /><span>Выключить камеру</span></>
        ) : (
          <><IconCamera size={13} /><span>Включить камеру</span></>
        )}
      </button>

      {templatesCount === 0 ? (
        <div style={styles.warn}>
          {isAdmin
            ? "Нет записанных эталонов. Сначала запишите жесты во вкладке «Интерактив» → «Обучение» и при сохранении согласитесь добавить их как анимации."
            : "Администратор ещё не записал ни одного жеста для распознавания."}
        </div>
      ) : (
        <>
          <div
            style={{
              ...styles.statusPill,
              background: !cameraOn
                ? "rgba(255,255,255,0.06)"
                : status === "playing"
                ? "rgba(74,222,128,0.2)"
                : "rgba(129,140,248,0.15)",
              color: !cameraOn
                ? "#777"
                : status === "playing"
                ? "#4ade80"
                : "#a78bfa",
            }}
          >
            {!cameraOn ? (
              <>Камера выключена</>
            ) : status === "playing" ? (
              <>
                <IconPlay size={11} />
                <span>Проигрываю: <b>{lastMatch?.name}</b></span>
              </>
            ) : (
              <>
                <span style={{
                  display: "inline-block", width: 8, height: 8, borderRadius: "50%",
                  background: "currentColor", animation: "pulse 1.4s infinite",
                }} />
                <span>Слушаю…</span>
              </>
            )}
          </div>

          {lastMatch && status !== "playing" && (
            <div style={styles.lastMatch}>
              Последнее: <b>{lastMatch.name}</b>
              <span style={{ color: "#777", marginLeft: 6 }}>
                (dist {lastMatch.distance.toFixed(3)})
              </span>
            </div>
          )}

          {history.length > 0 && (
            <div style={styles.queueBox}>
              <div
                style={{
                  ...styles.label,
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <span>История</span>
                <button onClick={handleClearHistory} style={styles.clearBtn}>
                  Очистить
                </button>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {history.map((item, i) => (
                  <div key={i} style={styles.historyChip}>
                    {item.name}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <div style={styles.hint}>
        Включите камеру и покажите один из записанных жестов. Аватар
        проиграет соответствующую анимацию, а на экране появится перевод.
        Эталонов: {templatesCount}. Анимаций: {recordings.length}.
      </div>
    </div>
  );
};

const styles = {
  translatedBanner: {
    position: "fixed",
    top: "80px",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 9998,
    minWidth: "280px",
    textAlign: "center",
    padding: "14px 28px",
    background: "rgba(10,10,15,0.88)",
    border: "2px solid",
    borderRadius: "14px",
    backdropFilter: "blur(12px)",
    boxShadow: "0 8px 40px rgba(0,0,0,0.5)",
    animation: "translatedFadeIn 0.25s ease-out",
  },
  translatedLabel: {
    fontSize: "11px",
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    color: "#aaa",
    marginBottom: "6px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "6px",
    lineHeight: 1,
  },
  translatedText: {
    fontSize: "32px",
    fontWeight: 800,
    color: "#fff",
    letterSpacing: "0.02em",
    lineHeight: 1,
  },
  container: {
    position: "fixed",
    top: "16px",
    right: "16px",
    zIndex: 9999,
    width: "300px",
    fontFamily: "sans-serif",
    color: "#fff",
    userSelect: "none",
    background: "rgba(10,10,15,0.92)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: "16px",
    backdropFilter: "blur(12px)",
    boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
    overflow: "hidden",
  },
  header: {
    padding: "12px 14px",
    fontSize: "14px",
    fontWeight: 700,
    borderBottom: "1px solid rgba(255,255,255,0.08)",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    letterSpacing: "0.02em",
  },
  subTabBar: {
    display: "flex",
    gap: 4,
    padding: "8px 10px",
    borderBottom: "1px solid rgba(255,255,255,0.06)",
    boxSizing: "border-box",
  },
  subTabBtn: {
    flex: 1,
    minWidth: 0,
    padding: "6px 8px",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 6,
    fontSize: 11,
    fontWeight: 700,
    cursor: "pointer",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    boxSizing: "border-box",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "6px",
    lineHeight: 1,
    textAlign: "center",
  },
  body: { padding: "12px 14px" },
  label: {
    fontSize: "11px",
    color: "#777",
    marginBottom: "6px",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  textarea: {
    width: "100%",
    boxSizing: "border-box",
    background: "rgba(255,255,255,0.08)",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: 6,
    color: "#fff",
    padding: "8px 10px",
    fontSize: 13,
    fontFamily: "inherit",
    resize: "vertical",
    outline: "none",
  },
  playBtn: {
    flex: 1,
    padding: "10px",
    background: "linear-gradient(90deg, #818cf8, #a78bfa)",
    border: "none",
    borderRadius: "8px",
    color: "#fff",
    fontSize: "13px",
    fontWeight: 700,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "8px",
    lineHeight: 1,
    boxSizing: "border-box",
  },
  stopBtn: {
    flex: 1,
    padding: "10px",
    background: "#ef4444",
    border: "none",
    borderRadius: "8px",
    color: "#fff",
    fontSize: "13px",
    fontWeight: 700,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "8px",
    lineHeight: 1,
    boxSizing: "border-box",
  },
  queueBox: {
    marginTop: 10,
    padding: "8px 10px",
    background: "rgba(255,255,255,0.04)",
    borderRadius: 6,
  },
  chip: {
    fontSize: 11,
    fontWeight: 700,
    padding: "4px 8px",
    borderRadius: 4,
    border: "1px solid",
    fontFamily: "ui-monospace, monospace",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "4px",
    lineHeight: 1,
    boxSizing: "border-box",
  },
  historyChip: {
    fontSize: 11,
    fontWeight: 700,
    padding: "4px 8px",
    borderRadius: 4,
    border: "1px solid rgba(129,140,248,0.3)",
    background: "rgba(129,140,248,0.15)",
    color: "#a78bfa",
    fontFamily: "ui-monospace, monospace",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "4px",
    lineHeight: 1,
    boxSizing: "border-box",
  },
  warn: {
    marginTop: 10,
    padding: "8px 10px",
    background: "rgba(245,158,11,0.12)",
    border: "1px solid rgba(245,158,11,0.3)",
    borderRadius: 6,
    color: "#f59e0b",
    fontSize: 11,
    lineHeight: 1.4,
  },
  hint: {
    fontSize: 11,
    color: "#777",
    lineHeight: 1.4,
    padding: "8px 10px",
    background: "rgba(255,255,255,0.03)",
    borderRadius: 6,
    marginTop: 8,
  },
  statusPill: {
    padding: "10px 12px",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    textAlign: "center",
    marginBottom: 8,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "8px",
    lineHeight: 1,
  },
  lastMatch: {
    fontSize: 12,
    color: "#aaa",
    marginBottom: 8,
  },
  clearBtn: {
    background: "transparent",
    border: "1px solid rgba(255,255,255,0.1)",
    color: "#888",
    fontSize: 10,
    padding: "2px 6px",
    borderRadius: 4,
    cursor: "pointer",
    textTransform: "none",
    letterSpacing: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "4px",
    lineHeight: 1,
    boxSizing: "border-box",
  },
};
