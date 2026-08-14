// 버튼에 붙어 뜨는 패널(설정 패널)의 위치를 버튼 위치에서 계산한다.
// 화면이 좁아 머리줄이 두 줄로 접히면 버튼이 아래로 내려가므로, 고정 위치로 띄우면 패널이 버튼을 덮는다.

export const PANEL_GAP_PX = 8;
export const PANEL_EDGE_MARGIN_PX = 8;
const PANEL_MIN_HEIGHT_PX = 120;

/**
 * @description 버튼 바로 아래, 버튼 오른쪽 끝에 맞춘 패널 위치(position: fixed 기준)를 낸다.
 *   화면 가장자리 여백을 지키고, 화면이 패널보다 좁으면 왼쪽 밖으로 나가지 않게 오른쪽 거리를 줄인다.
 * @param {{ anchorRect: { right: number, bottom: number }, viewportWidth: number, viewportHeight: number,
 *   panelWidth: number, gapPx?: number, edgeMarginPx?: number }} args
 * @returns {{ top: number, right: number, maxHeight: number }}
 */
export function computeAnchoredPanelPosition({
  anchorRect, viewportWidth, viewportHeight, panelWidth,
  gapPx = PANEL_GAP_PX, edgeMarginPx = PANEL_EDGE_MARGIN_PX,
}) {
  const top = Math.round(anchorRect.bottom + gapPx);
  const alignedRight = Math.max(edgeMarginPx, Math.round(viewportWidth - anchorRect.right));
  const maxRightToStayInView = Math.max(0, viewportWidth - panelWidth - edgeMarginPx);
  const right = Math.min(alignedRight, maxRightToStayInView);
  const maxHeight = Math.max(PANEL_MIN_HEIGHT_PX, Math.round(viewportHeight - top - edgeMarginPx));
  return { top, right, maxHeight };
}
