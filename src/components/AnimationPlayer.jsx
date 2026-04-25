import { useEffect, useRef, useState } from "react";
import { useGestureRecorder } from "../hooks/useGestureRecorder";
import { useVideoRecognition } from "../hooks/useVideoRecognition";
import { IconFilm, IconPlay, IconStop, IconTrash } from "./icons";

/**
 * Плеер записанных анимаций.
 *
 * Логика:
 * 1. Когда активна вкладка «Анимации» — аватар уже в T-позе (см. VRMAvatar.playbackMode).
 * 2. Пользователь выбирает запись → START.
 * 3. Каждый кадр отправляется в resultsCallback аватара (как если бы это пришло от MediaPipe).
 * 4. По окончании кадров мы отправляем «пустой» results —
 *    VRMAvatar видит hasAnyInput=false и плавно возвращается в T-позу.
 */
export const AnimationPlayer = () => {
  const recordings = useGestureRecorder((s) => s.recordings);
  const isPlaying = useGestureRecorder((s) => s.isPlaying);
  const playingIndex = useGestureRecorder((s) => s.playingIndex);
  const startPlayback = useGestureRecorder((s) => s.startPlayback);
  const stopPlayback = useGestureRecorder((s) => s.stopPlayback);
  const advancePlayback = useGestureRecorder((s) => s.advancePlayback);
  const getPlaybackDelay = useGestureRecorder((s) => s.getPlaybackDelay);
  const deleteRecording = useGestureRecorder((s) => s.deleteRecording);
  const renameRecording = useGestureRecorder((s) => s.renameRecording);

  const [selectedId, setSelectedId] = useState(null);
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState("");

  const timerRef = useRef(null);

  // При смене списка записей — обновляем выбранный id, если старый пропал.
  useEffect(() => {
    if (recordings.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!recordings.find((r) => r.id === selectedId)) {
      setSelectedId(recordings[0].id);
    }
  }, [recordings, selectedId]);

  // Основной цикл проигрывания
  useEffect(() => {
    if (!isPlaying) {
      clearTimeout(timerRef.current);
      // При остановке отправляем пустой results, чтобы аватар вернулся в T-позу.
      const cb = useVideoRecognition.getState().resultsCallback;
      if (cb) cb({});
      return;
    }

    const tick = () => {
      const frame = advancePlayback();
      const cb = useVideoRecognition.getState().resultsCallback;

      if (!frame) {
        // Кадры закончились — отправляем пустой results для возврата в T-позу.
        if (cb) cb({});
        return;
      }

      if (cb) {
        // Формируем объект в том же виде, что MediaPipe Holistic
        cb({
          poseLandmarks: frame.poseLandmarks,
          poseWorldLandmarks: frame.poseWorldLandmarks,
          leftHandLandmarks: frame.leftHandLandmarks,
          rightHandLandmarks: frame.rightHandLandmarks,
          faceLandmarks: frame.faceLandmarks,
        });
      }

      const delay = getPlaybackDelay();
      // Минимум 16мс (~60fps), максимум 100мс чтобы не зависать на «дырах» в записи.
      const clamped = Math.max(16, Math.min(delay || 33, 100));
      timerRef.current = setTimeout(tick, clamped);
    };

    tick();

    return () => clearTimeout(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, playingIndex]);

  // При размонтировании плеера — сбросить аватар.
  useEffect(() => {
    return () => {
      const cb = useVideoRecognition.getState().resultsCallback;
      if (cb) cb({});
      stopPlayback();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePlay = () => {
    if (!selectedId) return;
    const idx = recordings.findIndex((r) => r.id === selectedId);
    if (idx < 0) return;
    startPlayback(idx);
  };

  const handleStop = () => stopPlayback();

  const startRename = (rec) => {
    setRenamingId(rec.id);
    setRenameValue(rec.name);
  };

  const commitRename = () => {
    if (renamingId && renameValue.trim()) {
      renameRecording(renamingId, renameValue);
    }
    setRenamingId(null);
    setRenameValue("");
  };

  const formatDuration = (ms) => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, "0")}`;
  };

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <IconFilm size={18} />
        <span>Плеер анимаций</span>
      </div>

      <div style={styles.body}>
        {recordings.length === 0 ? (
          <div style={styles.empty}>
            Нет сохранённых анимаций.
            <br />
            <span style={{ color: "#aaa", fontSize: "11px" }}>
              Перейдите в раздел «Интерактив», включите камеру и запишите жест.
            </span>
          </div>
        ) : (
          <>
            <div style={styles.label}>Выберите анимацию</div>
            <div style={styles.list}>
              {recordings.map((rec, idx) => {
                const isSelected = rec.id === selectedId;
                const isThisPlaying = isPlaying && playingIndex === idx;
                return (
                  <div
                    key={rec.id}
                    onClick={() => setSelectedId(rec.id)}
                    style={{
                      ...styles.item,
                      background: isSelected
                        ? "rgba(99,102,241,0.25)"
                        : "transparent",
                      borderColor: isSelected
                        ? "rgba(129,140,248,0.5)"
                        : "rgba(255,255,255,0.08)",
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {renamingId === rec.id ? (
                        <input
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={commitRename}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitRename();
                            if (e.key === "Escape") {
                              setRenamingId(null);
                              setRenameValue("");
                            }
                          }}
                          onClick={(e) => e.stopPropagation()}
                          style={styles.renameInput}
                        />
                      ) : (
                        <div
                          style={styles.itemName}
                          title={rec.name}
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            startRename(rec);
                          }}
                        >
                          {rec.name}
                        </div>
                      )}
                      <div style={styles.itemMeta}>
                        {formatDuration(rec.duration)} · {rec.frames.length} кадров
                      </div>
                    </div>
                    {isThisPlaying && (
                      <span style={styles.playingDot}><IconPlay size={10} color="#4ade80" /></span>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`Удалить запись «${rec.name}»?`)) {
                          deleteRecording(rec.id);
                        }
                      }}
                      style={styles.deleteBtn}
                      title="Удалить"
                    >
                      <IconTrash size={13} />
                    </button>
                  </div>
                );
              })}
            </div>

            <div style={styles.controls}>
              {!isPlaying ? (
                <button
                  onClick={handlePlay}
                  disabled={!selectedId}
                  style={{
                    ...styles.playBtn,
                    opacity: selectedId ? 1 : 0.4,
                    cursor: selectedId ? "pointer" : "not-allowed",
                  }}
                >
                  <IconPlay size={13} /><span>Запустить</span>
                </button>
              ) : (
                <button onClick={handleStop} style={styles.stopBtn}>
                  <IconStop size={13} /><span>Остановить</span>
                </button>
              )}
            </div>

            <div style={styles.hint}>
              Аватар стартует в T-позе, воспроизводит жест и возвращается в исходное положение.
            </div>
          </>
        )}
      </div>
    </div>
  );
};

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
  body: {
    padding: "12px 14px",
  },
  empty: {
    textAlign: "center",
    padding: "20px 10px",
    fontSize: "13px",
    color: "#ccc",
    lineHeight: 1.5,
  },
  label: {
    fontSize: "11px",
    color: "#777",
    marginBottom: "8px",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  list: {
    maxHeight: "260px",
    overflowY: "auto",
    marginBottom: "10px",
    border: "1px solid rgba(255,255,255,0.06)",
    borderRadius: "8px",
  },
  item: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "8px 10px",
    borderBottom: "1px solid rgba(255,255,255,0.04)",
    cursor: "pointer",
    borderLeft: "2px solid",
    transition: "background 0.1s",
  },
  itemName: {
    fontSize: "13px",
    fontWeight: 600,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  itemMeta: {
    fontSize: "11px",
    color: "#888",
    marginTop: "2px",
  },
  renameInput: {
    width: "100%",
    background: "rgba(255,255,255,0.08)",
    border: "1px solid rgba(129,140,248,0.5)",
    borderRadius: "4px",
    color: "#fff",
    fontSize: "13px",
    padding: "3px 6px",
    outline: "none",
  },
  playingDot: {
    color: "#4ade80",
    fontSize: "12px",
    animation: "pulse 1s ease-in-out infinite",
  },
  deleteBtn: {
    border: "none",
    background: "transparent",
    color: "#888",
    cursor: "pointer",
    fontSize: "14px",
    padding: "2px 4px",
    borderRadius: "4px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 1,
    boxSizing: "border-box",
  },
  controls: {
    display: "flex",
    gap: "8px",
    marginBottom: "8px",
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
    letterSpacing: "0.03em",
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
    letterSpacing: "0.03em",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "8px",
    lineHeight: 1,
    boxSizing: "border-box",
  },
  hint: {
    fontSize: "11px",
    color: "#777",
    lineHeight: 1.4,
    padding: "8px 10px",
    background: "rgba(255,255,255,0.03)",
    borderRadius: "6px",
  },
};
