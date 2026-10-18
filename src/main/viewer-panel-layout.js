// 오른쪽 SEEON 패널은 펼침·접힘 모두 폭을 고정하고, 창 크기는 건드리지 않는다. 접으면 패널이 비운 폭만큼 Meet 화면이 늘고, 펴면 준다.
// Meet 화면 크기가 바뀌면 캡처 해상도와 공유 화면 위치가 바뀌므로, 뷰어는 새 좌표가 자리 잡을 때까지 화면을 자르지 않는다.
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

module.exports = { computeViewBoundsPair, createMeetResizeNotifier, VIEWER_PANEL_WIDTH_MAP };
