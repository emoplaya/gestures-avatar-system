import { Camera } from "@mediapipe/camera_utils";
import { drawConnectors, drawLandmarks } from "@mediapipe/drawing_utils";
import {
  FACEMESH_TESSELATION,
  HAND_CONNECTIONS,
  Holistic,
  POSE_CONNECTIONS,
} from "@mediapipe/holistic";
import { useEffect, useRef } from "react";
import { useVideoRecognition } from "../hooks/useVideoRecognition";
import { useGestureRecorder } from "../hooks/useGestureRecorder";
import { useTrajectoryLogger } from "../hooks/useTrajectoryLogger";

export const CameraWidget = ({ active = false }) => {
  const videoElement = useRef();
  const drawCanvas = useRef();
  const setVideoElement = useVideoRecognition((state) => state.setVideoElement);

  // Инстансы MediaPipe — хранятся между циклами включения/выключения,
  // чтобы повторное включение камеры не инициализировало холистик заново
  // (это медленно и может давать «чёрный экран» на несколько секунд).
  const holisticRef = useRef(null);
  const cameraRef = useRef(null);

  // ---- UI логгера траекторий ----
  const logIsRunning = useTrajectoryLogger((s) => s.isLogging);
  const logFrames = useTrajectoryLogger((s) => s.frames);
  const logStart = useTrajectoryLogger((s) => s.start);
  const logStop = useTrajectoryLogger((s) => s.stop);
  const logClear = useTrajectoryLogger((s) => s.clear);
  const logExport = useTrajectoryLogger((s) => s.exportCSV);

  const drawResults = (results) => {
    drawCanvas.current.width = videoElement.current.videoWidth;
    drawCanvas.current.height = videoElement.current.videoHeight;
    let canvasCtx = drawCanvas.current.getContext("2d");
    canvasCtx.save();
    canvasCtx.clearRect(
      0,
      0,
      drawCanvas.current.width,
      drawCanvas.current.height,
    );
    // Поза и руки — рисуем. Лицо (FACEMESH_TESSELATION) НЕ рисуем —
    // там 10к+ треугольников на кадр, сжирает FPS. Для задачи жестов
    // скелет рук важнее, чем точки лица.
    drawConnectors(canvasCtx, results.poseLandmarks, POSE_CONNECTIONS, {
      color: "#00cff7",
      lineWidth: 3,
    });
    drawLandmarks(canvasCtx, results.poseLandmarks, {
      color: "#ff0364",
      lineWidth: 1,
    });
    drawConnectors(canvasCtx, results.leftHandLandmarks, HAND_CONNECTIONS, {
      color: "#eb1064",
      lineWidth: 4,
    });
    drawLandmarks(canvasCtx, results.leftHandLandmarks, {
      color: "#00cff7",
      lineWidth: 2,
    });
    drawConnectors(canvasCtx, results.rightHandLandmarks, HAND_CONNECTIONS, {
      color: "#22c3e3",
      lineWidth: 4,
    });
    drawLandmarks(canvasCtx, results.rightHandLandmarks, {
      color: "#ff0364",
      lineWidth: 2,
    });
  };

  useEffect(() => {
    if (!active) {
      // Останавливаем камеру (MediaPipe-стрим), но инстансы сохраняем —
      // при следующем включении не будем заново загружать модели.
      if (cameraRef.current) {
        try {
          cameraRef.current.stop();
        } catch {
          /* ignore */
        }
      }
      // Отвязываемся от стрима браузера полностью, чтобы лампочка погасла.
      if (videoElement.current && videoElement.current.srcObject) {
        const tracks = videoElement.current.srcObject.getTracks?.() || [];
        tracks.forEach((t) => t.stop());
        videoElement.current.srcObject = null;
      }
      setVideoElement(null);
      return;
    }

    // Активация камеры.
    setVideoElement(videoElement.current);

    // Создаём holistic один раз, переиспользуем при повторных включениях.
    if (!holisticRef.current) {
      const holistic = new Holistic({
        locateFile: (file) =>
          `https://cdn.jsdelivr.net/npm/@mediapipe/holistic@0.5.1635989137/${file}`,
      });
      holistic.setOptions({
        modelComplexity: 1,
        smoothLandmarks: true,
        minDetectionConfidence: 0.7,
        minTrackingConfidence: 0.7,
        refineFaceLandmarks: false,
      });
      holistic.onResults((results) => {
        drawResults(results);
        // Живые кадры аватару — только если не заблокированы.
        // Блокировка используется в режиме «Перевод → Распознать жест»:
        // аватар ждёт в T-позе, а proигрывание идёт через прямой
        // вызов avatar-callback в плеере, минуя MediaPipe.
        const store = useVideoRecognition.getState();
        if (!store.liveFeedBlocked) {
          store.resultsCallback?.(results);
        }
        store.gestureCallback?.(results);

        const recorder = useGestureRecorder.getState();
        if (recorder.isRecording) recorder.addResultsFrame(results);

        const logger = useTrajectoryLogger.getState();
        if (logger.isLogging) logger.pushFrame(results);
      });
      holisticRef.current = holistic;
    }

    // Создаём Camera один раз, переиспользуем.
    if (!cameraRef.current) {
      cameraRef.current = new Camera(videoElement.current, {
        onFrame: async () => {
          if (holisticRef.current) {
            await holisticRef.current.send({ image: videoElement.current });
          }
        },
        width: 640,
        height: 480,
      });
    }
    cameraRef.current.start();
  }, [active]);

  return (
    <>
      <div
        className={`fixed z-[999999] bottom-4 right-4 w-[320px] h-[240px] rounded-[20px] overflow-hidden ${
          !active ? "hidden" : ""
        }`}
      >
        <canvas
          ref={drawCanvas}
          className="absolute z-10 w-full h-full bg-black/50 top-0 left-0"
        />
        <video
          ref={videoElement}
          className="absolute z-0 w-full h-full top-0 left-0"
        />
      </div>

      {/* Виджет логгера траекторий — виден только когда камера включена */}
      {active && (
        <div style={loggerStyles.box}>
          <div style={loggerStyles.header}>
            <span>📈</span> Лог траектории
          </div>
          {!logIsRunning ? (
            <>
              <button
                onClick={() => logStart()}
                style={{
                  ...loggerStyles.btn,
                  background: "#4ade80",
                  color: "#000",
                }}
              >
                ● Старт лога
              </button>
              {logFrames.length > 0 && (
                <>
                  <div style={loggerStyles.info}>
                    Кадров: {logFrames.length}
                  </div>
                  <div style={{ display: "flex", gap: 4 }}>
                    <button onClick={logExport} style={loggerStyles.btn}>
                      ⬇ CSV
                    </button>
                    <button
                      onClick={logClear}
                      style={{
                        ...loggerStyles.btn,
                        background: "rgba(239,68,68,0.3)",
                      }}
                    >
                      ✕ Очистить
                    </button>
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              <div style={loggerStyles.rec}>
                ● REC{" "}
                <span style={{ color: "#aaa" }}>{logFrames.length} кадров</span>
              </div>
              <button
                onClick={logStop}
                style={{ ...loggerStyles.btn, background: "#ef4444" }}
              >
                ⏹ Стоп
              </button>
            </>
          )}
          <div style={loggerStyles.hint}>
            Покажите всю последовательность букв слитно. Потом выгрузите CSV и
            откройте в анализаторе.
          </div>
        </div>
      )}
    </>
  );
};

const loggerStyles = {
  box: {
    position: "fixed",
    bottom: "270px",
    right: "16px",
    width: "320px",
    background: "rgba(10,10,15,0.92)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: "12px",
    padding: "10px 12px",
    color: "#fff",
    fontFamily: "sans-serif",
    fontSize: "12px",
    zIndex: 9999,
    boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
  },
  header: {
    fontWeight: 700,
    fontSize: "13px",
    marginBottom: "8px",
    display: "flex",
    alignItems: "center",
    gap: "6px",
  },
  btn: {
    border: "none",
    borderRadius: "6px",
    padding: "6px 10px",
    fontSize: "12px",
    fontWeight: 600,
    cursor: "pointer",
    background: "rgba(129,140,248,0.7)",
    color: "#fff",
    flex: 1,
  },
  info: {
    fontSize: "11px",
    color: "#aaa",
    margin: "6px 0",
  },
  rec: {
    color: "#ef4444",
    fontWeight: 700,
    marginBottom: "6px",
  },
  hint: {
    fontSize: "10px",
    color: "#777",
    marginTop: "8px",
    lineHeight: 1.3,
  },
};
