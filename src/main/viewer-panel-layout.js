// 오른쪽 SEEON 패널은 펼침·접힘 모두 폭을 고정하고, 접고 펼 때는 창 폭을 그 차이만큼 바꾼다.
// Meet 화면 크기가 그대로여야 캡처 해상도와 화면 공유 위치가 바뀌지 않아 슬라이드 전환 감지가 초기화되지 않는다.
const VIEWER_PANEL_WIDTH_MAP = Object.freeze({ expanded: 600, collapsed: 48 });

function computeViewBoundsPair({ contentWidth, contentHeight, isCollapsed }) {
  const panelWidth = isCollapsed ? VIEWER_PANEL_WIDTH_MAP.collapsed : VIEWER_PANEL_WIDTH_MAP.expanded;
  const viewerWidth = Math.min(contentWidth, panelWidth);
  const meetWidth = contentWidth - viewerWidth;
  return {
    meetBounds: { x: 0, y: 0, width: meetWidth, height: contentHeight },
    viewerBounds: { x: meetWidth, y: 0, width: viewerWidth, height: contentHeight },
  };
}

// 펼칠 때 화면 오른쪽 끝을 넘으면 창을 왼쪽으로 옮긴다. 화면보다 넓어지면 화면 폭에 맞추는데, 이때만 Meet 폭이 줄어든다.
function computeToggledWindowBounds({ windowBounds, workArea, isCollapsed }) {
  const widthDelta = VIEWER_PANEL_WIDTH_MAP.expanded - VIEWER_PANEL_WIDTH_MAP.collapsed;
  if (isCollapsed) {
    return { ...windowBounds, width: Math.max(VIEWER_PANEL_WIDTH_MAP.collapsed, windowBounds.width - widthDelta) };
  }
  const width = Math.min(windowBounds.width + widthDelta, workArea.width);
  const workAreaRight = workArea.x + workArea.width;
  const x = Math.max(workArea.x, Math.min(windowBounds.x, workAreaRight - width));
  return { ...windowBounds, x, width };
}

// Meet 화면 크기가 바뀔 때만 새 크기를 알린다. 처음 배치는 이전 크기에서 잰 좌표가 없어 기다릴 것이 없으므로 알리지 않는다.
function createMeetResizeNotifier({ notify }) {
  let lastSizeKey = null;
  return {
    observe({ width, height }) {
      const sizeKey = `${width}x${height}`;
      const isResized = lastSizeKey !== null && sizeKey !== lastSizeKey;
      lastSizeKey = sizeKey;
      if (isResized) notify({ width, height });
    },
    reset() {
      lastSizeKey = null;
    },
  };
}

module.exports = {
  computeViewBoundsPair, computeToggledWindowBounds, createMeetResizeNotifier, VIEWER_PANEL_WIDTH_MAP,
};
