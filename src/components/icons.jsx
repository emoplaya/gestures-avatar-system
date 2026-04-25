/**
 * Набор SVG-иконок для интерфейса.
 * Все иконки — inline SVG, 24×24 viewBox, принимают проп size и color.
 * Используются вместо эмодзи для согласованного вида.
 */

const defaults = {
  size: 16,
  color: "currentColor",
  strokeWidth: 2,
};

const svgProps = (size, color, strokeWidth) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: color,
  strokeWidth,
  strokeLinecap: "round",
  strokeLinejoin: "round",
});

export const IconPlay = ({ size = defaults.size, color = defaults.color }) => (
  <svg {...svgProps(size, color, 0)} fill={color}>
    <path d="M8 5v14l11-7z" />
  </svg>
);

export const IconPause = ({ size = defaults.size, color = defaults.color }) => (
  <svg {...svgProps(size, color, 0)} fill={color}>
    <path d="M6 4h4v16H6zM14 4h4v16h-4z" />
  </svg>
);

export const IconStop = ({ size = defaults.size, color = defaults.color }) => (
  <svg {...svgProps(size, color, 0)} fill={color}>
    <rect x="6" y="6" width="12" height="12" rx="1" />
  </svg>
);

export const IconRec = ({ size = defaults.size, color = "#ef4444" }) => (
  <svg {...svgProps(size, color, 0)} fill={color}>
    <circle cx="12" cy="12" r="6" />
  </svg>
);

export const IconCamera = ({ size = defaults.size, color = defaults.color }) => (
  <svg {...svgProps(size, color, 2)}>
    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
    <circle cx="12" cy="13" r="4" />
  </svg>
);

export const IconCameraOff = ({ size = defaults.size, color = defaults.color }) => (
  <svg {...svgProps(size, color, 2)}>
    <path d="M1 1l22 22" />
    <path d="M21 21H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3m3-3h6l2 3h4a2 2 0 0 1 2 2v9.34m-7.72-2.06a4 4 0 1 1-5.56-5.56" />
  </svg>
);

export const IconCheck = ({ size = defaults.size, color = defaults.color }) => (
  <svg {...svgProps(size, color, 2.5)}>
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

export const IconClose = ({ size = defaults.size, color = defaults.color }) => (
  <svg {...svgProps(size, color, 2.5)}>
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

export const IconTrash = ({ size = defaults.size, color = defaults.color }) => (
  <svg {...svgProps(size, color, 2)}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);

export const IconMic = ({ size = defaults.size, color = defaults.color }) => (
  <svg {...svgProps(size, color, 2)}>
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" y1="19" x2="12" y2="23" />
    <line x1="8" y1="23" x2="16" y2="23" />
  </svg>
);

export const IconGraduation = ({ size = defaults.size, color = defaults.color }) => (
  <svg {...svgProps(size, color, 2)}>
    <path d="M22 10L12 5 2 10l10 5 10-5z" />
    <path d="M6 12v5c0 1 2 3 6 3s6-2 6-3v-5" />
  </svg>
);

export const IconHand = ({ size = defaults.size, color = defaults.color }) => (
  <svg {...svgProps(size, color, 2)}>
    <path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0" />
    <path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2" />
    <path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8" />
    <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
  </svg>
);

export const IconText = ({ size = defaults.size, color = defaults.color }) => (
  <svg {...svgProps(size, color, 2)}>
    <polyline points="4 7 4 4 20 4 20 7" />
    <line x1="9" y1="20" x2="15" y2="20" />
    <line x1="12" y1="4" x2="12" y2="20" />
  </svg>
);

export const IconRotate = ({ size = defaults.size, color = defaults.color }) => (
  <svg {...svgProps(size, color, 2)}>
    <polyline points="1 4 1 10 7 10" />
    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
  </svg>
);

export const IconUsers = ({ size = defaults.size, color = defaults.color }) => (
  <svg {...svgProps(size, color, 2)}>
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

export const IconMirror = ({ size = defaults.size, color = defaults.color }) => (
  <svg {...svgProps(size, color, 2)}>
    <rect x="3" y="4" width="7" height="16" rx="1" />
    <rect x="14" y="4" width="7" height="16" rx="1" />
    <line x1="12" y1="2" x2="12" y2="22" strokeDasharray="2 2" />
  </svg>
);

export const IconFilm = ({ size = defaults.size, color = defaults.color }) => (
  <svg {...svgProps(size, color, 2)}>
    <rect x="2" y="2" width="20" height="20" rx="2" />
    <line x1="7" y1="2" x2="7" y2="22" />
    <line x1="17" y1="2" x2="17" y2="22" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <line x1="2" y1="7" x2="7" y2="7" />
    <line x1="2" y1="17" x2="7" y2="17" />
    <line x1="17" y1="17" x2="22" y2="17" />
    <line x1="17" y1="7" x2="22" y2="7" />
  </svg>
);

export const IconArrowRight = ({ size = defaults.size, color = defaults.color }) => (
  <svg {...svgProps(size, color, 2)}>
    <line x1="5" y1="12" x2="19" y2="12" />
    <polyline points="12 5 19 12 12 19" />
  </svg>
);

export const IconChevronDown = ({ size = defaults.size, color = defaults.color }) => (
  <svg {...svgProps(size, color, 2)}>
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

export const IconMenu = ({ size = defaults.size, color = defaults.color }) => (
  <svg {...svgProps(size, color, 2)}>
    <line x1="3" y1="12" x2="21" y2="12" />
    <line x1="3" y1="6" x2="21" y2="6" />
    <line x1="3" y1="18" x2="21" y2="18" />
  </svg>
);
