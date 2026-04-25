import { Loader } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { Suspense, useState } from "react";
import { CameraWidget } from "./components/CameraWidget";
import { Experience } from "./components/Experience";
import { GestureTranslator } from "./components/GestureTranslator";
import { ControlPanel } from "./components/ControlPanel";
import { AnimationPlayer } from "./components/AnimationPlayer";
import { TranslateMode } from "./components/TranslateMode";

function App() {
  // Настройки VRM-аватара
  const [avatar, setAvatar] = useState("ivan.vrm");
  const [animation, setAnimation] = useState("Idle");
  const [flipAvatar, setFlipAvatar] = useState(true);
  const [scenePreset, setScenePreset] = useState("dark");

  // Режим приложения:
  //   "interactive" — камера + распознавание жестов/дактиля/обучи/запись/зеркало
  //   "animations"  — плеер записанных анимаций
  //   "translate"   — перевод (текст → жест, либо камера → анимация)
  const [tab, setTab] = useState("interactive");

  const [inputText, setInputText] = useState("");
  const [cameraActive, setCameraActive] = useState(false);

  // Подрежим «Распознать жест» во вкладке «Перевод» — требует камеру.
  const [translateRecognizeActive, setTranslateRecognizeActive] = useState(false);

  const handleLetterRecognized = (letter) => {
    if (!letter) return;
    setInputText((prev) => prev + letter);
  };

  const handleAvatarChange = (newAvatar) => {
    setAvatar(newAvatar);
    setFlipAvatar(true);
  };

  const isInteractiveTab = tab === "interactive";
  const isAnimationsTab = tab === "animations";
  const isTranslateTab = tab === "translate";
  // В плейбек-режимах аватар стоит в T-позе (или получает кадры из записи).
  const isPlaybackTab = isAnimationsTab || isTranslateTab;

  // Камера активна, если:
  //  - Интерактив: пользователь включил её в ControlPanel.
  //  - Перевод: активен подрежим распознавания с камеры.
  //  - Анимации: никогда.
  let effectiveCameraActive;
  if (isAnimationsTab) effectiveCameraActive = false;
  else if (isTranslateTab) effectiveCameraActive = translateRecognizeActive;
  else effectiveCameraActive = cameraActive;

  const SCENE_PRESETS = {
    dark:  { bg: "#050508", fogNear: 8,  fogFar: 18 },
    light: { bg: "#d8dce6", fogNear: 12, fogFar: 24 },
    gray:  { bg: "#2a2a2e", fogNear: 10, fogFar: 20 },
  };
  const preset = SCENE_PRESETS[scenePreset] || SCENE_PRESETS.dark;

  return (
    <>
      <ControlPanel
        tab={tab}
        setTab={setTab}
        avatar={avatar}
        setAvatar={handleAvatarChange}
        flipAvatar={flipAvatar}
        onFlipToggle={() => setFlipAvatar((p) => !p)}
        scenePreset={scenePreset}
        setScenePreset={setScenePreset}
        animation={animation}
        setAnimation={setAnimation}
        inputText={inputText}
        setInputText={setInputText}
        cameraActive={effectiveCameraActive}
        onCameraToggle={() => setCameraActive((p) => !p)}
      />

      {/* Интерактивный режим: камера + распознавание + зеркало */}
      {isInteractiveTab && (
        <>
          <CameraWidget active={effectiveCameraActive} />
          <GestureTranslator onDactylLetterRecognized={handleLetterRecognized} />
        </>
      )}

      {/* Плеер записанных анимаций */}
      {isAnimationsTab && <AnimationPlayer />}

      {/* Перевод: текст → жест / камера → жест → анимация */}
      {isTranslateTab && (
        <>
          <CameraWidget active={effectiveCameraActive} />
          <TranslateMode onRecognizeActive={setTranslateRecognizeActive} />
        </>
      )}

      <Loader />
      <div
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          width: "100vw",
          height: "100vh",
          zIndex: 1,
        }}
      >
        <Canvas shadows camera={{ position: [0.25, 0.25, 2], fov: 30 }}>
          <color attach="background" args={[preset.bg]} />
          <fog attach="fog" args={[preset.bg, preset.fogNear, preset.fogFar]} />
          <Suspense>
            <Experience
              avatar={avatar}
              flipAvatar={flipAvatar}
              scenePreset={scenePreset}
              // В плейбек-режимах (Анимации / Перевод) аватар в T-позе,
              // fbx-анимация выключена — управление идёт через resultsCallback.
              animation={isPlaybackTab ? "None" : animation}
              playbackMode={isPlaybackTab}
            />
          </Suspense>
        </Canvas>
      </div>
    </>
  );
}

export default App;
