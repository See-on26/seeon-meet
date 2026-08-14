const SCREEN_TYPE_MAP = {
  ppt: 'ppt',
  web: 'web',
  doc: 'doc',
  sheet: 'sheet',
  etc: 'etc',
  desktop: 'desktop',
  fileExplorer: 'file_explorer',
  osUi: 'os_ui',
  unknown: 'unknown',
};

const SILENT_SCREEN_TYPE_LIST = [
  SCREEN_TYPE_MAP.desktop, SCREEN_TYPE_MAP.fileExplorer,
  SCREEN_TYPE_MAP.osUi, SCREEN_TYPE_MAP.unknown,
];

const TRANSITION_AXIS_TYPE_LIST = [SCREEN_TYPE_MAP.ppt, SCREEN_TYPE_MAP.web];

function buildScreenKey({ screenType, title }) {
  return `${screenType}:${(title || '').trim()}`;
}

function isSilentScreenType({ screenType }) {
  return SILENT_SCREEN_TYPE_LIST.includes(screenType);
}

function isTransitionAxis({ screenType }) {
  return TRANSITION_AXIS_TYPE_LIST.includes(screenType);
}

function createScreenRegistry() {
  const seenKeySet = new Set();

  function judgeAnnouncement({ screenType, title = '' }) {
    if (isSilentScreenType({ screenType })) {
      return { shouldAnnounce: false, reason: `silent_type:${screenType}` };
    }
    if (isTransitionAxis({ screenType })) {
      return { shouldAnnounce: true, reason: `transition_axis:${screenType}` };
    }
    const key = buildScreenKey({ screenType, title });
    if (seenKeySet.has(key)) {
      return { shouldAnnounce: false, reason: 'already_seen' };
    }
    seenKeySet.add(key);
    return { shouldAnnounce: true, reason: 'first_appearance' };
  }

  function reset() {
    seenKeySet.clear();
  }

  return { judgeAnnouncement, reset };
}

module.exports = {
  createScreenRegistry, buildScreenKey, isSilentScreenType, isTransitionAxis,
  SCREEN_TYPE_MAP, SILENT_SCREEN_TYPE_LIST, TRANSITION_AXIS_TYPE_LIST,
};
