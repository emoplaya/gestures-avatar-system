import { CameraControls, Gltf } from "@react-three/drei";
import { useRef } from "react";
import { VRMAvatar } from "./VRMAvatar";

// Настройки освещения для каждого пресета сцены.
const LIGHT_PRESETS = {
  dark: {
    ambient: 0.45,
    main: 1.1,
    back: 0.4,
    backColor: "#c8d8ff",
    showScene: false,
  },
  light: {
    ambient: 0.9,
    main: 1.4,
    back: 0.3,
    backColor: "#ffffff",
    showScene: true,  // в светлом пресете возвращаем фоновую сцену
  },
  gray: {
    ambient: 0.6,
    main: 1.0,
    back: 0.35,
    backColor: "#eeeeee",
    showScene: false,
  },
};

export const Experience = ({
  avatar = "ivan.vrm",
  animation = "Idle",
  playbackMode = false,
  flipAvatar = true,
  scenePreset = "dark",
}) => {
  const controls = useRef();
  const lp = LIGHT_PRESETS[scenePreset] || LIGHT_PRESETS.dark;

  return (
    <>
      <CameraControls
        ref={controls}
        maxPolarAngle={Math.PI / 2}
        minDistance={1}
        maxDistance={10}
      />

      <ambientLight intensity={lp.ambient} />
      <directionalLight intensity={lp.main} position={[2, 3, 5]} />
      <directionalLight intensity={lp.back} position={[-1, 4, -2]} color={lp.backColor} />

      <group position-y={-1.25}>
        <VRMAvatar
          avatar={avatar}
          animation={animation}
          playbackMode={playbackMode}
          flipAvatar={flipAvatar}
        />
        {lp.showScene && (
          <Gltf
            src="models/scene.glb"
            position-z={-1.4}
            position-x={-0.5}
            scale={0.65}
          />
        )}
      </group>
    </>
  );
};
