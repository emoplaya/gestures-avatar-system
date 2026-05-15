import { useState } from "react";
import { IconRotate, IconMenu, IconChevronDown } from "./icons";

const VRM_MODELS = [
  { file: "ivan.vrm", name: "Иван" },
  { file: "glasses.vrm", name: "В очках" },
  { file: "3859814441197244330.vrm", name: "Персонаж 1" },
  { file: "8087383217573817818.vrm", name: "Персонаж 4" },
];

const ANIMATIONS = [
  { id: "None", name: "Нет" },
  { id: "Idle", name: "Ожидание" },
  { id: "Swing Dancing", name: "Танец" },
  { id: "Thriller Part 2", name: "Триллер" },
];

const SCENE_PRESETS = [
  { id: "dark",  name: "Тёмная" },
  { id: "light", name: "Светлая" },
  { id: "gray",  name: "Серая" },
];

export const ControlPanel = ({
  tab, setTab,
  avatar, setAvatar,
  flipAvatar, onFlipToggle,
  scenePreset, setScenePreset,
  animation, setAnimation,
  inputText, setInputText,
  cameraActive, onCameraToggle,
}) => {
  const [minimized, setMinimized] = useState(false);
  // Для обоих плейбек-режимов (Анимации, Перевод) прячем вещи, релевантные
  // только интерактивному трекингу.
  const isPlaybackTab = tab === "animations" || tab === "translate";

  if (minimized) {
    return (
      <button
        onClick={() => setMinimized(false)}
        style={styles.minimizedBtn}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 12h18M3 6h18M3 18h18" />
        </svg>
      </button>
    );
  }

  return (
    <div className="cp" style={styles.panel}>
      <div style={styles.panelHeader}>
        <span>Управление</span>
        <button onClick={() => setMinimized(true)} style={styles.minimizeBtn}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 15l-6-6-6 6" />
          </svg>
        </button>
      </div>

      {/* ===== Переключатель режима ===== */}
      <div style={styles.tabBar}>
        {[
          { id: "interactive", label: "Интерактив" },
          { id: "animations",  label: "Анимации" },
          { id: "translate",   label: "Перевод" },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              ...styles.tabBtn,
              background: tab === t.id ? "rgba(99,102,241,0.7)" : "transparent",
              color: tab === t.id ? "#fff" : "#aaa",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ===== Аватар ===== */}
      <Section title="Аватар" defaultOpen>
        <Label text="Модель" />
        <div style={{ display: "flex", gap: "6px" }}>
          <select
            value={avatar}
            onChange={(e) => setAvatar(e.target.value)}
            style={{ ...styles.select, flex: 1 }}
          >
            {VRM_MODELS.map((m) => (
              <option key={m.file} value={m.file}>{m.name}</option>
            ))}
          </select>
          <button
            onClick={onFlipToggle}
            title={flipAvatar ? "Аватар повёрнут. Нажмите, чтобы вернуть ориентацию." : "Аватар не повёрнут. Нажмите, чтобы развернуть."}
            style={{
              ...styles.iconBtn,
              background: flipAvatar ? "rgba(129,140,248,0.15)" : "rgba(255,255,255,0.06)",
              color: flipAvatar ? "#a78bfa" : "#888",
            }}
          >
            <IconRotate size={14} />
          </button>
        </div>

        <Label text="Сцена" />
        <div style={styles.sceneGrid}>
          {SCENE_PRESETS.map((s) => (
            <button
              key={s.id}
              onClick={() => setScenePreset(s.id)}
              style={{
                ...styles.sceneBtn,
                background: scenePreset === s.id ? "rgba(129,140,248,0.25)" : "rgba(255,255,255,0.04)",
                color: scenePreset === s.id ? "#fff" : "#aaa",
                borderColor: scenePreset === s.id ? "#818cf8" : "rgba(255,255,255,0.08)",
              }}
            >
              {s.name}
            </button>
          ))}
        </div>

        {/* Идл/fbx-анимация релевантна только в интерактивном режиме */}
        {!isPlaybackTab && (
          <>
            <Label text="Анимация" />
            <select
              value={animation}
              onChange={(e) => setAnimation(e.target.value)}
              style={styles.select}
            >
              {ANIMATIONS.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </>
        )}
      </Section>

      {/* ===== Камера (только для интерактивного режима) ===== */}
      {!isPlaybackTab && (
        <Section title="Камера" defaultOpen>
          <button
            onClick={onCameraToggle}
            style={{
              ...styles.actionBtn,
              width: "100%",
              background: cameraActive ? "#ef4444" : "rgba(79, 195, 247, 0.15)",
              border: `1px solid ${cameraActive ? "#ef4444" : "#4FC3F7"}`,
              color: cameraActive ? "#fff" : "#4FC3F7",
            }}
          >
            {cameraActive ? "Выключить камеру" : "Включить камеру"}
          </button>
          {cameraActive && (
            <div style={{ ...styles.hint, marginTop: "8px", color: "#4FC3F7" }}>
              Видеопоток отображается справа внизу.
              Движения рук и лица переносятся на VRM-аватар в реальном времени.
            </div>
          )}
          {!cameraActive && (
            <div style={{ ...styles.hint, marginTop: "8px" }}>
              Включите камеру, чтобы аватар повторял ваши движения
              и распознавал дактильные жесты.
            </div>
          )}
        </Section>
      )}

      {/* Распознанный текст показывается только в правой панели,
          чтобы не дублировать UI. Сюда больше не выводим. */}

      {/* ===== Подсказка для плейбек-режимов ===== */}
      {tab === "animations" && (
        <Section title="Плеер анимаций" defaultOpen>
          <div style={{ ...styles.hint, marginTop: 0 }}>
            Аватар находится в T-позе. Выберите запись в правой панели и нажмите «Запустить»,
            чтобы воспроизвести жест. После окончания аватар вернётся в исходную позу.
          </div>
        </Section>
      )}
      {tab === "translate" && (
        <Section title="Перевод текста" defaultOpen>
          <div style={{ ...styles.hint, marginTop: 0 }}>
            Введите в правой панели слова, которые хотите показать. Приложение найдёт
            для каждого слова записанный жест и проиграет их последовательно на аватаре.
            Жесты записываются в «Интерактив → Обучение».
          </div>
        </Section>
      )}

      <style>{`
        .cp, .cp * {
          box-sizing: border-box;
        }
        .cp select {
          background-color: #1a1a1f !important;
          color: #e0e0e0 !important;
          max-width: 100%;
        }
        .cp select option {
          background-color: #1a1a1f;
          color: #e0e0e0;
          padding: 6px 8px;
        }
        .cp select option:hover,
        .cp select option:checked {
          background-color: #2a2a35 !important;
          color: #fff !important;
        }
        .cp select:focus {
          border-color: rgba(79, 195, 247, 0.5) !important;
        }
        .cp button {
          font-family: inherit;
        }
        .cp::-webkit-scrollbar {
          width: 6px;
        }
        .cp::-webkit-scrollbar-track {
          background: transparent;
        }
        .cp::-webkit-scrollbar-thumb {
          background: rgba(255,255,255,0.12);
          border-radius: 3px;
        }
        .cp::-webkit-scrollbar-thumb:hover {
          background: rgba(255,255,255,0.2);
        }
      `}</style>
    </div>
  );
};

function Section({ title, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={styles.section}>
      <div style={styles.sectionHeader} onClick={() => setOpen(!open)}>
        <span>{title}</span>
        <span style={{ fontSize: "10px", color: "#666", transition: "transform 0.2s" }}>
          {open ? "\u25B2" : "\u25BC"}
        </span>
      </div>
      {open && <div style={styles.sectionBody}>{children}</div>}
    </div>
  );
}

function Label({ text }) {
  return <div style={styles.label}>{text}</div>;
}

const styles = {
  panel: {
    position: "fixed",
    top: "16px",
    left: "16px",
    width: "256px",
    maxHeight: "calc(100vh - 32px)",
    background: "rgba(10, 10, 15, 0.92)",
    borderRadius: "12px",
    border: "1px solid rgba(255,255,255,0.08)",
    backdropFilter: "blur(12px)",
    zIndex: 1000,
    color: "#fff",
    fontFamily: "'Segoe UI', system-ui, sans-serif",
    fontSize: "13px",
    overflowY: "auto",
    overflowX: "hidden",
    boxSizing: "border-box",
    boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
  },
  panelHeader: {
    padding: "14px 16px 10px",
    fontSize: "14px",
    fontWeight: 700,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    borderBottom: "1px solid rgba(255,255,255,0.06)",
    letterSpacing: "0.02em",
  },
  tabBar: {
    display: "flex",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
    width: "100%",
    boxSizing: "border-box",
  },
  tabBtn: {
    flex: 1,
    minWidth: 0,
    border: "none",
    cursor: "pointer",
    fontSize: "12px",
    fontWeight: 600,
    padding: "10px 4px",
    transition: "all 0.15s",
    letterSpacing: "0.02em",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    background: "transparent",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "6px",
    lineHeight: 1,
    textAlign: "center",
    boxSizing: "border-box",
  },
  minimizeBtn: {
    background: "none",
    border: "none",
    color: "#666",
    cursor: "pointer",
    padding: "2px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 1,
  },
  minimizedBtn: {
    position: "fixed",
    top: "16px",
    left: "16px",
    zIndex: 1000,
    width: "40px",
    height: "40px",
    background: "rgba(10, 10, 15, 0.92)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: "10px",
    color: "#aaa",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backdropFilter: "blur(12px)",
    boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
  },
  section: {
    borderBottom: "1px solid rgba(255,255,255,0.04)",
    boxSizing: "border-box",
  },
  sectionHeader: {
    padding: "10px 16px",
    fontSize: "12px",
    fontWeight: 600,
    cursor: "pointer",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    userSelect: "none",
    color: "#ccc",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  sectionBody: {
    padding: "0 16px 14px",
    boxSizing: "border-box",
    overflow: "hidden",
  },
  label: {
    fontSize: "11px",
    color: "#777",
    marginBottom: "5px",
    marginTop: "10px",
  },
  select: {
    width: "100%",
    padding: "6px 8px",
    fontSize: "12px",
    backgroundColor: "#1a1a1f",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: "6px",
    color: "#e0e0e0",
    outline: "none",
    cursor: "pointer",
    boxSizing: "border-box",
    minWidth: 0,
  },
  iconBtn: {
    width: "32px",
    flexShrink: 0,
    padding: "6px 0",
    fontSize: "16px",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: "6px",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
  },
  sceneGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr 1fr",
    gap: "4px",
    marginBottom: "8px",
  },
  sceneBtn: {
    padding: "6px 0",
    fontSize: "11px",
    fontWeight: 600,
    border: "1px solid",
    borderRadius: "5px",
    cursor: "pointer",
    transition: "all 0.12s",
    boxSizing: "border-box",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "4px",
    lineHeight: 1,
    textAlign: "center",
  },
  textarea: {
    width: "100%",
    padding: "8px",
    fontSize: "13px",
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: "6px",
    color: "#fff",
    outline: "none",
    resize: "vertical",
    fontFamily: "inherit",
    boxSizing: "border-box",
  },
  actionBtn: {
    padding: "8px 12px",
    fontSize: "12px",
    fontWeight: 600,
    border: "none",
    borderRadius: "6px",
    color: "#fff",
    cursor: "pointer",
    transition: "all 0.15s",
    boxSizing: "border-box",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "8px",
    lineHeight: 1,
    textAlign: "center",
  },
  hint: {
    marginTop: "8px",
    padding: "8px 10px",
    fontSize: "11px",
    color: "#777",
    background: "rgba(255,255,255,0.03)",
    borderRadius: "6px",
    lineHeight: 1.4,
  },
};
