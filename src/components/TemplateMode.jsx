import { useCallback, useEffect, useRef, useState } from "react";
import { useVideoRecognition } from "../hooks/useVideoRecognition";
import { useGestureRecorder } from "../hooks/useGestureRecorder";
import {
  IconRec, IconStop, IconClose, IconGraduation, IconTrash, IconCheck,
} from "./icons";
import { TemplateMatcher } from "../utils/templateMatcher";

/**
 * Режим «Обучи-покажи»:
 *   1. Пользователь записывает эталонные жесты (метка + 1-2 секунды записи).
 *   2. В режиме распознавания эталоны сравниваются с живым потоком через DTW.
 *
 * Работает с ЛЮБЫМИ жестами — буквами, словами, любыми движениями руки.
 * Точность напрямую зависит от качества эталонов (2-3 записи одного жеста
 * обычно дают достаточно стабильное распознавание).
 */
export const TemplateMode = ({ onRecognized }) => {
  const videoElement = useVideoRecognition(s => s.videoElement);
  const setGestureCallback = useVideoRecognition(s => s.setGestureCallback);

  // Синглтон матчера — переживает ремонты компонента, но НЕ перерендеры.
  const matcherRef = useRef(null);
  if (!matcherRef.current) {
    matcherRef.current = new TemplateMatcher();
    matcherRef.current.load();
  }

  const [templates, setTemplates] = useState(() => matcherRef.current.getTemplates());
  const [recognized, setRecognized] = useState("");
  const [status, setStatus] = useState("idle"); // idle | recording | armed
  const [label, setLabel] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [debug, setDebug] = useState(null);

  // После успешной записи эталона — диалог «сохранить ли как анимацию?».
  // Храним кадры в промежуточном буфере между записью и решением юзера.
  const [pendingSave, setPendingSave] = useState(null);
  // pendingSave: { label, fullFrames } | null

  const importRecording = useGestureRecorder(s => s.importRecording);

  // Буфер текущей записи. Храним:
  //   - lm  (только landmarks нужной руки — для DTW эталонов)
  //   - full (все MediaPipe результаты — для сохранения как анимации)
  //   - t   (время)
  const recBufferRef = useRef([]);
  // Таймер записи.
  const recTimerRef = useRef(null);

  const refreshTemplates = useCallback(() => {
    setTemplates(matcherRef.current.getTemplates());
  }, []);

  // --- Основной колбэк на каждом кадре ---
  // Debug-панель обновляется не чаще 5 раз в секунду, чтобы не мерцала
  // от изменений каждую 30-ю секунды. Данные свежие, просто UI
  // перерисовывается реже.
  const lastDebugUpdateRef = useRef(0);
  const DEBUG_UPDATE_MS = 200;

  const onFrame = useCallback((results) => {
    const lm = results.rightHandLandmarks || results.leftHandLandmarks;
    const now = Date.now();

    if (status === "recording") {
      // Записываем ВСЕ landmarks (поза + обе руки + лицо), а не только
      // рабочую руку. Это нужно для сохранения как полноценной анимации.
      // ВАЖНО: poseWorldLandmarks тоже сохраняем — без них Pose.solve не
      // вычислит 3D-ориентацию тела, и аватар будет шевелить только
      // головой/руками, но не корпусом/плечами.
      // У MediaPipe Holistic world-координаты живут в одном из трёх полей,
      // зависит от версии: poseWorldLandmarks (канонично), либо za/ea.
      const worldLm =
        results.poseWorldLandmarks || results.za || results.ea || null;
      const startTime = recBufferRef.current[0]?.tAbs || now;
      recBufferRef.current.push({
        lm,
        t: now - startTime,
        tAbs: now,
        full: {
          poseLandmarks: results.poseLandmarks
            ? results.poseLandmarks.map(p => ({ ...p }))
            : null,
          poseWorldLandmarks: worldLm
            ? worldLm.map(p => ({ ...p }))
            : null,
          leftHandLandmarks: results.leftHandLandmarks
            ? results.leftHandLandmarks.map(p => ({ ...p }))
            : null,
          rightHandLandmarks: results.rightHandLandmarks
            ? results.rightHandLandmarks.map(p => ({ ...p }))
            : null,
          faceLandmarks: results.faceLandmarks
            ? results.faceLandmarks.map(p => ({ ...p }))
            : null,
        },
      });
    }

    // Живое распознавание только в armed-режиме.
    if (status === "armed") {
      if (lm) {
        const result = matcherRef.current.process(lm, now);
        if (result) {
          setRecognized(prev => {
            const sep = prev.length === 0 || prev.endsWith(" ") ? "" : " ";
            return prev + sep + result.label + " ";
          });
          if (typeof onRecognized === "function") onRecognized(result.label);
        }
      }
      if (now - lastDebugUpdateRef.current >= DEBUG_UPDATE_MS) {
        lastDebugUpdateRef.current = now;
        setDebug(matcherRef.current.getDebug());
      }
    }
  }, [status, onRecognized]);

  useEffect(() => {
    setGestureCallback(onFrame);
    return () => setGestureCallback(null);
  }, [onFrame, setGestureCallback]);

  // --- Запись эталона с обратным отсчётом ---
  const startRecording = () => {
    if (!label.trim()) {
      alert("Введите метку жеста (например, ПРИВЕТ или Й)");
      return;
    }
    setStatus("countdown");
    setCountdown(3);
    const id = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) {
          clearInterval(id);
          // Непосредственно запись.
          recBufferRef.current = [];
          setStatus("recording");
          // Автостоп через 2 секунды.
          recTimerRef.current = setTimeout(() => stopRecording(), 2000);
          return 0;
        }
        return c - 1;
      });
    }, 700);
  };

  const stopRecording = () => {
    if (recTimerRef.current) clearTimeout(recTimerRef.current);
    recTimerRef.current = null;

    const frames = recBufferRef.current;
    recBufferRef.current = [];

    // Отфильтровываем кадры, в которых рука распознана (для DTW эталона).
    const framesWithHand = frames.filter(f => f.lm);

    if (framesWithHand.length < 4) {
      alert("Слишком мало кадров — руку было плохо видно. Попробуйте ещё раз.");
      setStatus("idle");
      return;
    }
    try {
      const finalLabel = label.trim().toUpperCase();
      // Эталон для DTW — только нужная рука.
      matcherRef.current.addTemplate(
        finalLabel,
        framesWithHand.map(f => ({ lm: f.lm, t: f.t })),
      );
      refreshTemplates();

      // Предложить сохранить как полноценную анимацию (поза+обе руки+лицо).
      setPendingSave({
        label: finalLabel,
        fullFrames: frames
          .filter(f => f.full)
          .map(f => ({ ...f.full, t: f.t })),
      });

      setLabel("");
      setStatus("idle");
    } catch (e) {
      alert("Ошибка: " + e.message);
      setStatus("idle");
    }
  };

  // --- Подтверждение «сохранить жест как запись аватара» ---
  const confirmSaveRecording = () => {
    if (!pendingSave) return;
    const { label, fullFrames } = pendingSave;
    if (fullFrames.length < 2) {
      alert("Нет кадров для сохранения анимации.");
      setPendingSave(null);
      return;
    }
    importRecording(label, fullFrames);
    setPendingSave(null);
  };

  const skipSaveRecording = () => setPendingSave(null);

  const cancelRecording = () => {
    if (recTimerRef.current) clearTimeout(recTimerRef.current);
    recTimerRef.current = null;
    recBufferRef.current = [];
    setStatus("idle");
    setCountdown(0);
  };

  const toggleArmed = () => {
    if (status === "armed") {
      setStatus("idle");
    } else {
      if (templates.length === 0) {
        alert("Сначала запишите хотя бы один эталон.");
        return;
      }
      setStatus("armed");
    }
  };

  const deleteTemplate = (id) => {
    matcherRef.current.removeTemplate(id);
    refreshTemplates();
  };

  const clearAll = () => {
    if (!confirm("Удалить все эталоны?")) return;
    matcherRef.current.clear();
    refreshTemplates();
  };

  // Группируем эталоны по метке (можно записать один жест несколько раз).
  const grouped = new Map();
  for (const t of templates) {
    if (!grouped.has(t.label)) grouped.set(t.label, []);
    grouped.get(t.label).push(t);
  }

  if (!videoElement) return null;

  return (
    <div>
      {/* Блок записи */}
      <div style={styles.section}>
        <div style={styles.label}>Записать новый жест</div>
        <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
          <input
            type="text"
            placeholder="Метка (ПРИВЕТ / Й / СПАСИБО)"
            value={label}
            onChange={e => setLabel(e.target.value)}
            disabled={status !== "idle"}
            style={styles.input}
          />
          {status === "idle" && (
            <button onClick={startRecording} style={{ ...styles.btn, background: "#4ade80", color: "#000" }}>
              <IconRec size={12} color="#000" /><span>REC</span>
            </button>
          )}
          {status === "countdown" && (
            <button onClick={cancelRecording} style={{ ...styles.btn, background: "#ef4444" }}>
              <IconClose size={14} />
            </button>
          )}
          {status === "recording" && (
            <button onClick={stopRecording} style={{ ...styles.btn, background: "#ef4444" }}>
              <IconStop size={14} />
            </button>
          )}
        </div>

        {status === "countdown" && (
          <div style={styles.bigCenter}>
            <div style={{ fontSize: 48, fontWeight: 900, color: "#f59e0b" }}>{countdown}</div>
            <div style={styles.hint}>Приготовьтесь...</div>
          </div>
        )}
        {status === "recording" && (
          <div style={styles.bigCenter}>
            <div style={{ fontSize: 32, fontWeight: 900, color: "#ef4444" }}>● ЗАПИСЬ</div>
            <div style={styles.hint}>Покажите жест (2 секунды, кадров: {recBufferRef.current.length})</div>
          </div>
        )}
        {status === "idle" && (
          <div style={styles.hint}>
            Введите метку, нажмите REC, после «3, 2, 1» — покажите жест. Можно записать
            один и тот же жест несколько раз — точность вырастет.
          </div>
        )}
      </div>

      {/* Диалог: сохранить жест ещё и как анимацию аватара? */}
      {pendingSave && (
        <div style={styles.saveDialog}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
            Жест «{pendingSave.label}» добавлен в эталоны DTW.
          </div>
          <div style={{ fontSize: 11, color: "#aaa", marginBottom: 10, lineHeight: 1.4 }}>
            Сохранить его также как запись анимации? Тогда вы сможете набрать «{pendingSave.label}»
            во вкладке «Перевод», и аватар проиграет этот жест.
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              onClick={confirmSaveRecording}
              style={{ ...styles.btn, background: "#4ade80", color: "#000", flex: 1 }}
            >
              Да, сохранить
            </button>
            <button
              onClick={skipSaveRecording}
              style={{ ...styles.btn, background: "rgba(255,255,255,0.08)", flex: 1 }}
            >
              Нет
            </button>
          </div>
        </div>
      )}

      {/* Блок распознавания */}
      {status !== "recording" && status !== "countdown" && (
        <div style={styles.section}>
          <div style={styles.label}>Распознавание</div>
          <button
            onClick={toggleArmed}
            style={{
              ...styles.btn,
              width: "100%",
              background: status === "armed" ? "#4ade80" : "rgba(129,140,248,0.7)",
              color: status === "armed" ? "#000" : "#fff",
              padding: "10px",
              fontWeight: 700,
            }}
          >
            {status === "armed" ? "● Распознавание ВКЛ (нажмите для стопа)" : "▶ Включить распознавание"}
          </button>

          {status === "armed" && debug?.lastReport && (
            <div style={styles.debugBox}>
              <div style={{ fontSize: 10, color: "#888", marginBottom: 4, textTransform: "uppercase" }}>
                Ближайшие совпадения (меньше = лучше):
              </div>
              {debug.lastReport.top.map((s, i) => (
                <div key={i} style={styles.debugRow}>
                  <span style={{ fontWeight: 700, color: i === 0 && s.distance < 0.45 ? "#4ade80" : "#ccc" }}>
                    {s.label}
                  </span>
                  <span style={{
                    color: s.distance < 0.45 ? "#4ade80" : s.distance < 0.7 ? "#f59e0b" : "#888",
                    fontFamily: "ui-monospace, monospace",
                    marginLeft: "auto",
                  }}>
                    {s.distance.toFixed(3)}
                  </span>
                </div>
              ))}
              {debug.onCooldown && (
                <div style={{ fontSize: 10, color: "#f59e0b", marginTop: 4 }}>
                  cooldown (1.5с) — не сработает дважды
                </div>
              )}
              <div style={{ fontSize: 10, color: "#666", marginTop: 4 }}>
                порог матча: 0.450 · буфер: {debug.liveBufferSize} кадров
              </div>
              {debug.liveKeyframeCount > 0 && (
                <div style={{ fontSize: 10, color: "#818cf8", marginTop: 2, fontFamily: "ui-monospace, monospace" }}>
                  ключевых кадров (экстремумы Δ): {debug.liveKeyframeCount}
                  {debug.liveKeyframeIndices.length > 0 && (
                    <> · индексы: [{debug.liveKeyframeIndices.join(", ")}]</>
                  )}
                </div>
              )}
            </div>
          )}

          {recognized && (
            <div style={styles.recognizedBox}>
              <div style={{ fontSize: 10, color: "#888", marginBottom: 4, textTransform: "uppercase" }}>
                Распознано
              </div>
              <div style={{ fontSize: 16, fontWeight: 600, wordBreak: "break-word" }}>
                {recognized}
              </div>
              <button onClick={() => setRecognized("")} style={{ ...styles.btnSm, marginTop: 6 }}>
                Очистить
              </button>
            </div>
          )}
        </div>
      )}

      {/* Список эталонов */}
      <div style={styles.section}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <div style={styles.label}>Эталоны ({templates.length})</div>
          {templates.length > 0 && (
            <button onClick={clearAll} style={{ ...styles.btnSm, marginLeft: "auto", color: "#ef4444" }}>
              Очистить всё
            </button>
          )}
        </div>
        {templates.length === 0 ? (
          <div style={styles.hint}>Пока нет записанных эталонов.</div>
        ) : (
          <div style={{ maxHeight: 200, overflowY: "auto" }}>
            {Array.from(grouped.entries()).map(([lbl, group]) => (
              <div key={lbl} style={styles.templateGroup}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#818cf8" }}>
                  {lbl} <span style={{ fontSize: 10, color: "#666", fontWeight: 400 }}>× {group.length}</span>
                </div>
                <div style={{ display: "flex", gap: 4, marginTop: 2, flexWrap: "wrap" }}>
                  {group.map(t => (
                    <button
                      key={t.id}
                      onClick={() => deleteTemplate(t.id)}
                      title={`${t.rawLength} исходных → ${t.keyframeCount} ключевых кадров · ${new Date(t.createdAt).toLocaleTimeString()}`}
                      style={styles.templateBadge}
                    >
                      {t.rawLength}→{t.keyframeCount}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const styles = {
  section: {
    padding: "10px 14px",
    background: "rgba(0,0,0,0.65)",
    borderBottom: "1px solid rgba(255,255,255,0.04)",
  },
  label: {
    fontSize: 11,
    color: "#777",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    marginBottom: 6,
  },
  input: {
    flex: 1,
    border: "1px solid rgba(255,255,255,0.2)",
    background: "rgba(255,255,255,0.1)",
    color: "#fff",
    borderRadius: 4,
    padding: "6px 8px",
    fontSize: 12,
    outline: "none",
  },
  btn: {
    border: "none",
    borderRadius: 4,
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    color: "#fff",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "6px",
    lineHeight: 1,
    boxSizing: "border-box",
    whiteSpace: "nowrap",
  },
  btnSm: {
    border: "none",
    background: "rgba(255,255,255,0.1)",
    color: "#aaa",
    borderRadius: 4,
    padding: "3px 8px",
    fontSize: 10,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "4px",
    lineHeight: 1,
    boxSizing: "border-box",
    whiteSpace: "nowrap",
  },
  bigCenter: {
    textAlign: "center",
    padding: "10px 0",
  },
  hint: {
    fontSize: 11,
    color: "#888",
    lineHeight: 1.4,
  },
  debugBox: {
    marginTop: 8,
    padding: "6px 8px",
    background: "rgba(255,255,255,0.04)",
    borderRadius: 6,
    border: "1px solid rgba(255,255,255,0.06)",
  },
  debugRow: {
    display: "flex",
    alignItems: "center",
    fontSize: 11,
    padding: "2px 0",
  },
  recognizedBox: {
    marginTop: 8,
    padding: "8px 10px",
    background: "rgba(255,255,255,0.06)",
    borderRadius: 8,
  },
  templateGroup: {
    padding: "6px 0",
    borderBottom: "1px solid rgba(255,255,255,0.04)",
  },
  templateBadge: {
    background: "rgba(129,140,248,0.2)",
    color: "#a78bfa",
    border: "none",
    borderRadius: 3,
    padding: "2px 6px",
    fontSize: 10,
    cursor: "pointer",
    fontFamily: "ui-monospace, monospace",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "4px",
    lineHeight: 1,
    boxSizing: "border-box",
  },
  saveDialog: {
    padding: "12px 14px",
    background: "rgba(74,222,128,0.08)",
    border: "1px solid rgba(74,222,128,0.25)",
    borderBottom: "1px solid rgba(74,222,128,0.25)",
  },
};
