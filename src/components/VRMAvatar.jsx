import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { useAnimations, useFBX, useGLTF } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { Face, Hand, Pose } from "kalidokit";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Euler, Object3D, Quaternion, Vector3 } from "three";
import { lerp } from "three/src/math/MathUtils.js";
import { useVideoRecognition } from "../hooks/useVideoRecognition";
import { remapMixamoAnimationToVrm } from "../utils/remapMixamoAnimationToVrm";

const tmpQuat = new Quaternion();
const tmpEuler = new Euler();
const identityQuat = new Quaternion(); // w=1, остальное 0 — базовая ориентация бинда

// Список костей, которые мы вообще трогаем из трекинга/записи.
// Именно их нужно сбрасывать при возврате в T-позу.
const TRACKED_BONES = [
  "neck",
  "chest", "spine", "hips",
  "leftUpperArm", "leftLowerArm", "leftHand",
  "rightUpperArm", "rightLowerArm", "rightHand",
  "leftThumbProximal", "leftThumbMetacarpal", "leftThumbDistal",
  "leftIndexProximal", "leftIndexIntermediate", "leftIndexDistal",
  "leftMiddleProximal", "leftMiddleIntermediate", "leftMiddleDistal",
  "leftRingProximal", "leftRingIntermediate", "leftRingDistal",
  "leftLittleProximal", "leftLittleIntermediate", "leftLittleDistal",
  "rightThumbProximal", "rightThumbMetacarpal", "rightThumbDistal",
  "rightIndexProximal", "rightIndexIntermediate", "rightIndexDistal",
  "rightMiddleProximal", "rightMiddleIntermediate", "rightMiddleDistal",
  "rightRingProximal", "rightRingIntermediate", "rightRingDistal",
  "rightLittleProximal", "rightLittleIntermediate", "rightLittleDistal",
];

export const VRMAvatar = ({
  avatar,
  animation = "Idle",
  /**
   * Если true — аватар стоит в T-позе и принимает кадры только через
   * resultsCallback (из плеера записей). Fbx-анимации отключены.
   */
  playbackMode = false,
  /**
   * Разворот аватара на 180°. true = стандартный VRM (+Z → к камере).
   * false = модель уже экспортирована лицом к камере.
   */
  flipAvatar = true,
  ...props
}) => {
  const { scene, userData } = useGLTF(
    `models/${avatar}`,
    undefined,
    undefined,
    (loader) => {
      loader.register((parser) => {
        return new VRMLoaderPlugin(parser);
      });
    },
  );

  const assetA = useFBX("models/animations/Swing Dancing.fbx");
  const assetB = useFBX("models/animations/Thriller Part 2.fbx");
  const assetC = useFBX("models/animations/Breathing Idle.fbx");

  const currentVrm = userData.vrm;

  const animationClipA = useMemo(() => {
    const clip = remapMixamoAnimationToVrm(currentVrm, assetA);
    clip.name = "Swing Dancing";
    return clip;
  }, [assetA, currentVrm]);

  const animationClipB = useMemo(() => {
    const clip = remapMixamoAnimationToVrm(currentVrm, assetB);
    clip.name = "Thriller Part 2";
    return clip;
  }, [assetB, currentVrm]);

  const animationClipC = useMemo(() => {
    const clip = remapMixamoAnimationToVrm(currentVrm, assetC);
    clip.name = "Idle";
    return clip;
  }, [assetC, currentVrm]);

  const { actions } = useAnimations(
    [animationClipA, animationClipB, animationClipC],
    currentVrm.scene,
  );

  useEffect(() => {
    const vrm = userData.vrm;
    VRMUtils.removeUnnecessaryVertices(scene);
    VRMUtils.combineSkeletons(scene);
    VRMUtils.combineMorphs(vrm);

    vrm.scene.traverse((obj) => {
      obj.frustumCulled = false;
    });

    // Нормализация скелета — сбрасывает T-позу для моделей с «кривым»
    // бинд-положением (руки не по сторонам).
    if (vrm.humanoid?.resetNormalizedPose) {
      vrm.humanoid.resetNormalizedPose();
    }
  }, [scene]);

  const setResultsCallback = useVideoRecognition(
    (state) => state.setResultsCallback,
  );
  const videoElement = useVideoRecognition((state) => state.videoElement);
  const riggedFace = useRef();
  const riggedPose = useRef();
  const riggedLeftHand = useRef();
  const riggedRightHand = useRef();

  const prevLeftHand = useRef(null);
  const prevRightHand = useRef(null);

  const smoothHand = (current, prev, factor = 0.4) => {
    if (!prev) return current;
    const result = {};
    for (const key of Object.keys(current)) {
      if (typeof current[key] === 'object' && current[key] !== null && 'x' in current[key]) {
        result[key] = {
          x: prev[key].x + (current[key].x - prev[key].x) * factor,
          y: prev[key].y + (current[key].y - prev[key].y) * factor,
          z: prev[key].z + (current[key].z - prev[key].z) * factor,
        };
      } else {
        result[key] = current[key];
      }
    }
    return result;
  };

  const resultsCallback = useCallback(
    (results) => {
      if (!currentVrm) {
        return;
      }
      // Для Face.solve/Pose.solve нужен video для оценки размеров.
      // В плеере видео нет — используем заглушку с теми же размерами, что MediaPipe выдавал.
      const videoForSolve =
        videoElement || { videoWidth: 640, videoHeight: 480 };

      if (results.faceLandmarks) {
        riggedFace.current = Face.solve(results.faceLandmarks, {
          runtime: "mediapipe",
          video: videoForSolve,
          imageSize: { width: 640, height: 480 },
          smoothBlink: true,
          blinkSettings: [0.25, 0.75],
        });
      } else {
        riggedFace.current = null;
      }

      const worldLandmarks =
        results.poseWorldLandmarks || results.za || results.ea;
      if (worldLandmarks && results.poseLandmarks) {
        riggedPose.current = Pose.solve(worldLandmarks, results.poseLandmarks, {
          runtime: "mediapipe",
          video: videoForSolve,
        });
      } else {
        riggedPose.current = null;
      }

      if (results.leftHandLandmarks) {
        const raw = Hand.solve(results.leftHandLandmarks, "Right");
        riggedRightHand.current = smoothHand(raw, prevRightHand.current);
        prevRightHand.current = riggedRightHand.current;
      } else {
        riggedRightHand.current = null;
        prevRightHand.current = null;
      }
      if (results.rightHandLandmarks) {
        const raw = Hand.solve(results.rightHandLandmarks, "Left");
        riggedLeftHand.current = smoothHand(raw, prevLeftHand.current);
        prevLeftHand.current = riggedLeftHand.current;
      } else {
        riggedLeftHand.current = null;
        prevLeftHand.current = null;
      }
    },
    [videoElement, currentVrm],
  );

  useEffect(() => {
    setResultsCallback(resultsCallback);
  }, [resultsCallback]);

  // Когда камера выключается (videoElement становится null) в ИНТЕРАКТИВНОМ
  // режиме — нужно очистить rigged-буферы, чтобы useFrame не применял
  // устаревшие значения поверх Idle-анимации (они конкурируют за кости → дрожь).
  //
  // В playbackMode — НЕ чистим: эти буферы как раз заполняются плеером
  // через resultsCallback при проигрывании записи. Иначе аватар застрянет
  // в T-позе и будет шевелить только головой/лицом.
  useEffect(() => {
    if (!videoElement && !playbackMode) {
      riggedFace.current = null;
      riggedPose.current = null;
      riggedLeftHand.current = null;
      riggedRightHand.current = null;
      prevLeftHand.current = null;
      prevRightHand.current = null;
    }
  }, [videoElement, playbackMode]);

  // Запуск/остановка Idle-анимации.
  // В playbackMode fbx-анимации всегда выключены — аватар стартует в T-позе.
  useEffect(() => {
    if (playbackMode) return;
    if (animation === "None" || videoElement) {
      return;
    }
    const action = actions[animation];
    if (!action) return;
    // fadeIn даёт плавный переход от текущей позы костей (после трекинга)
    // к первому кадру анимации, вместо резкого «щелчка».
    action.reset().fadeIn(0.3).play();
    return () => {
      action.fadeOut(0.2);
      // через fadeOut-задержку остановим совсем
      setTimeout(() => action.stop(), 300);
    };
  }, [actions, animation, videoElement, playbackMode]);

  // Ключевая утилита: сброс костей в T-позу.
  // Плавно (slerpFactor < 1) или мгновенно (slerpFactor = 1).
  const resetToTPose = useCallback(
    (slerpFactor = 1) => {
      if (!currentVrm?.humanoid) return;
      for (const boneName of TRACKED_BONES) {
        const bone = currentVrm.humanoid.getNormalizedBoneNode(boneName);
        if (!bone) continue;
        if (slerpFactor >= 1) {
          bone.quaternion.copy(identityQuat);
        } else {
          bone.quaternion.slerp(identityQuat, slerpFactor);
        }
      }
      // Сбросить мимику.
      if (currentVrm.expressionManager) {
        ["aa", "ih", "ee", "oh", "ou", "blinkLeft", "blinkRight"].forEach(
          (name) => {
            try {
              currentVrm.expressionManager.setValue(name, 0);
            } catch {
              // не все модели имеют все expression'ы
            }
          },
        );
      }
      // Сбросить буферы последних распознанных данных,
      // чтобы после возврата в T-позу аватар не «дёрнулся» старым кадром.
      riggedFace.current = null;
      riggedPose.current = null;
      riggedLeftHand.current = null;
      riggedRightHand.current = null;
      prevLeftHand.current = null;
      prevRightHand.current = null;
    },
    [currentVrm],
  );

  // Когда входим в playbackMode или в нём ещё нет входных данных —
  // принудительно встаём в T-позу (мгновенно).
  useEffect(() => {
    if (playbackMode) {
      resetToTPose(1);
    }
  }, [playbackMode, avatar, resetToTPose]);

  const lerpExpression = (name, value, lerpFactor) => {
    userData.vrm.expressionManager.setValue(
      name,
      lerp(userData.vrm.expressionManager.getValue(name), value, lerpFactor),
    );
  };

  const rotateBone = (boneName, value, slerpFactor, flip = { x: 1, y: 1, z: 1 }) => {
    const bone = userData.vrm.humanoid.getNormalizedBoneNode(boneName);
    if (!bone) return;

    tmpEuler.set(value.x * flip.x, value.y * flip.y, value.z * flip.z);
    tmpQuat.setFromEuler(tmpEuler);
    bone.quaternion.slerp(tmpQuat, slerpFactor);
  };

  // Плавный возврат в T-позу, когда в playbackMode нет входных данных
  // (т.е. после окончания проигрывания записи).
  const returningToTPose = useRef(false);

  useFrame((_, delta) => {
    if (!userData.vrm) {
      return;
    }

    // === Ветка плеера ===
    // Нет живого видео, но включён playbackMode:
    // данные поступают через resultsCallback от AnimationPlayer.
    // Когда буферы пустые — плавно возвращаемся в T-позу.
    const hasAnyInput =
      riggedFace.current ||
      riggedPose.current ||
      riggedLeftHand.current ||
      riggedRightHand.current;

    if (playbackMode && !hasAnyInput) {
      // Плавный slerp к identity.
      for (const boneName of TRACKED_BONES) {
        const bone = userData.vrm.humanoid.getNormalizedBoneNode(boneName);
        if (!bone) continue;
        bone.quaternion.slerp(identityQuat, delta * 6);
      }
      // Сбрасываем мимику плавно.
      if (userData.vrm.expressionManager) {
        ["aa", "ih", "ee", "oh", "ou", "blinkLeft", "blinkRight"].forEach(
          (name) => {
            try {
              lerpExpression(name, 0, delta * 6);
            } catch {}
          },
        );
      }
      userData.vrm.update(delta);
      return;
    }

    // === Обычная ветка (живая камера ИЛИ активный плеер с кадром) ===

    if (videoElement || playbackMode) {
      if (riggedFace.current) {
        [
          { name: "aa", value: riggedFace.current.mouth.shape.A },
          { name: "ih", value: riggedFace.current.mouth.shape.I },
          { name: "ee", value: riggedFace.current.mouth.shape.E },
          { name: "oh", value: riggedFace.current.mouth.shape.O },
          { name: "ou", value: riggedFace.current.mouth.shape.U },
          { name: "blinkLeft", value: 1 - riggedFace.current.eye.l },
          { name: "blinkRight", value: 1 - riggedFace.current.eye.r },
        ].forEach((item) => {
          lerpExpression(item.name, item.value, delta * 12);
        });

        // Eyes
        if (lookAtTarget.current) {
          userData.vrm.lookAt.target = lookAtTarget.current;
          lookAtDestination.current.set(
            -2 * riggedFace.current.pupil.x,
            2 * riggedFace.current.pupil.y,
            0,
          );
          lookAtTarget.current.position.lerp(
            lookAtDestination.current,
            delta * 5,
          );
        }

        // Neck
        rotateBone("neck", riggedFace.current.head, delta * 5, {
          x: 0.7,
          y: 0.7,
          z: 0.7,
        });
      }
    }

    if (riggedPose.current) {
      rotateBone("chest", riggedPose.current.Spine, delta * 5, {
        x: 0.3,
        y: 0.3,
        z: 0.3,
      });
      rotateBone("spine", riggedPose.current.Spine, delta * 5, {
        x: 0.3,
        y: 0.3,
        z: 0.3,
      });
      rotateBone("hips", riggedPose.current.Hips.rotation, delta * 5, {
        x: 0.7,
        y: 0.7,
        z: 0.7,
      });

      rotateBone("leftUpperArm", riggedPose.current.LeftUpperArm, delta * 5);
      rotateBone("leftLowerArm", riggedPose.current.LeftLowerArm, delta * 5);

      rotateBone("rightUpperArm", riggedPose.current.RightUpperArm, delta * 5);
      rotateBone("rightLowerArm", riggedPose.current.RightLowerArm, delta * 5);

      const handLerp = delta * 18;
      if (riggedLeftHand.current) {
        rotateBone(
          "leftHand",
          {
            z: riggedPose.current.LeftHand.z,
            y: riggedLeftHand.current.LeftWrist.y,
            x: riggedLeftHand.current.LeftWrist.x,
          },
          handLerp,
        );
        rotateBone("leftRingProximal", riggedLeftHand.current.LeftRingProximal, handLerp);
        rotateBone("leftRingIntermediate", riggedLeftHand.current.LeftRingIntermediate, handLerp);
        rotateBone("leftRingDistal", riggedLeftHand.current.LeftRingDistal, handLerp);
        rotateBone("leftIndexProximal", riggedLeftHand.current.LeftIndexProximal, handLerp);
        rotateBone("leftIndexIntermediate", riggedLeftHand.current.LeftIndexIntermediate, handLerp);
        rotateBone("leftIndexDistal", riggedLeftHand.current.LeftIndexDistal, handLerp);
        rotateBone("leftMiddleProximal", riggedLeftHand.current.LeftMiddleProximal, handLerp);
        rotateBone("leftMiddleIntermediate", riggedLeftHand.current.LeftMiddleIntermediate, handLerp);
        rotateBone("leftMiddleDistal", riggedLeftHand.current.LeftMiddleDistal, handLerp);
        rotateBone("leftThumbProximal", riggedLeftHand.current.LeftThumbProximal, handLerp);
        rotateBone("leftThumbMetacarpal", riggedLeftHand.current.LeftThumbIntermediate, handLerp);
        rotateBone("leftThumbDistal", riggedLeftHand.current.LeftThumbDistal, handLerp);
        rotateBone("leftLittleProximal", riggedLeftHand.current.LeftLittleProximal, handLerp);
        rotateBone("leftLittleIntermediate", riggedLeftHand.current.LeftLittleIntermediate, handLerp);
        rotateBone("leftLittleDistal", riggedLeftHand.current.LeftLittleDistal, handLerp);
      }

      if (riggedRightHand.current) {
        rotateBone("rightHand", {
          z: riggedPose.current.RightHand.z,
          y: riggedRightHand.current.RightWrist.y,
          x: riggedRightHand.current.RightWrist.x,
        }, handLerp);
        rotateBone("rightRingProximal", riggedRightHand.current.RightRingProximal, handLerp);
        rotateBone("rightRingIntermediate", riggedRightHand.current.RightRingIntermediate, handLerp);
        rotateBone("rightRingDistal", riggedRightHand.current.RightRingDistal, handLerp);
        rotateBone("rightIndexProximal", riggedRightHand.current.RightIndexProximal, handLerp);
        rotateBone("rightIndexIntermediate", riggedRightHand.current.RightIndexIntermediate, handLerp);
        rotateBone("rightIndexDistal", riggedRightHand.current.RightIndexDistal, handLerp);
        rotateBone("rightMiddleProximal", riggedRightHand.current.RightMiddleProximal, handLerp);
        rotateBone("rightMiddleIntermediate", riggedRightHand.current.RightMiddleIntermediate, handLerp);
        rotateBone("rightMiddleDistal", riggedRightHand.current.RightMiddleDistal, handLerp);
        rotateBone("rightThumbProximal", riggedRightHand.current.RightThumbProximal, handLerp);
        rotateBone("rightThumbMetacarpal", riggedRightHand.current.RightThumbIntermediate, handLerp);
        rotateBone("rightThumbDistal", riggedRightHand.current.RightThumbDistal, handLerp);
        rotateBone("rightLittleProximal", riggedRightHand.current.RightLittleProximal, handLerp);
        rotateBone("rightLittleIntermediate", riggedRightHand.current.RightLittleIntermediate, handLerp);
        rotateBone("rightLittleDistal", riggedRightHand.current.RightLittleDistal, handLerp);
      }
    }

    userData.vrm.update(delta);
  });

  const lookAtDestination = useRef(new Vector3(0, 0, 0));
  const camera = useThree((state) => state.camera);
  const lookAtTarget = useRef();
  useEffect(() => {
    lookAtTarget.current = new Object3D();
    camera.add(lookAtTarget.current);
  }, [camera]);

  // Список моделей, которые ЭКСПОРТИРОВАНЫ уже лицом к камере (-Z).
  // Их не нужно разворачивать на π. Остальные экспортированы лицом в +Z
  // и требуют разворота на 180°.
  //
  // Важно: если модель развернуть на π, то И локальные оси костей тоже
  // «откорректируются» — тело будет слушаться трекинг правильно. Если
  // не разворачивать модель, которая экспортирована в +Z, то кости
  // будут двигаться реверсивно (руки вверх/вниз перепутаны, пальцы
  // сгибаются не в ту сторону). Т.е. если есть выбор — лучше
  // разворачивать.
  return (
    <group {...props}>
      <primitive
        object={scene}
        rotation-y={flipAvatar ? Math.PI : 0}
      />
    </group>
  );
};
