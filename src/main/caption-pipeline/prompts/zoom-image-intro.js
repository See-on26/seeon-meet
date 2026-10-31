// 해설 요청에 [화면 전체, 확대] 두 장을 넣을 때 프롬프트 첫 줄(그림 한 장 안내)을 바꾸는 줄 묶음.
// 확대 안내에 넣는 낱말은 발화에서 온 말뿐이다. 화면 OCR 글자는 넣지 않는다 — 지시 해설이 옆 칸 글자를 대상에 붙였다.

const ZOOM_KIND_MAP = { speech: 'speech', pointing: 'pointing', merged: 'merged' };
// target: 대상 이름을 읽는 해설(지시), value: 값과 항목의 짝을 읽는 해설(수치·척도).
const ZOOM_USAGE_MAP = { target: 'target', value: 'value' };

const MAX_ZOOM_TERM_LENGTH = 20;
const POINTING_FOCUS = '발표자가 방금 필기하거나 포인터로 가리킨 영역';

function toSpokenFocus(zoomTerm) {
  const term = String(zoomTerm || '').replace(/["“”]/g, '').trim().slice(0, MAX_ZOOM_TERM_LENGTH);
  return term ? `발화에 나온 "${term}"에 해당하는 글자가 있는 곳 둘레` : '발화에 나온 대상의 이름이 적힌 곳 둘레';
}

function buildZoomFocus({ zoomKind, zoomTerm }) {
  if (zoomKind === ZOOM_KIND_MAP.pointing) return `${POINTING_FOCUS}을`;
  if (zoomKind === ZOOM_KIND_MAP.merged) return `${POINTING_FOCUS}과 ${toSpokenFocus(zoomTerm)}를`;
  return `${toSpokenFocus(zoomTerm)}를`;
}

// 사실 카드·그래프 어림값은 화면 전체를 읽은 덩어리다. 덩어리의 "이미지와 다르면"·"막대 수·순서가 맞지 않으면"을 일부만 보이는
// 확대 그림과 맞춰 보면 맞는 덩어리도 버려지므로, 그런 덩어리가 함께 들어갈 때 첫째 이미지와 맞춰 보게 한다.
const WHOLE_SCREEN_BLOCK_LINE = '아래 참고 덩어리(사실 카드·OCR 글자·그래프 어림값)는 화면 전체를 읽은 것이다.'
  + ' 덩어리를 이미지와 맞춰 볼 때는 첫째 이미지와 맞추고, 둘째 이미지에 일부만 보인다고 맞지 않는다고 보지 않는다.';

// 확대 그림이 없으면 빈 목록이다(호출부는 지금의 한 장 안내를 그대로 쓴다).
// hasWholeScreenBlock: 사실 카드·그래프 어림값 덩어리가 같은 프롬프트에 들어가는지. OCR 글자만 있으면 값 줄이 이미 배치를 첫째 이미지로 확인하게 한다.
function buildZoomImageIntroLineList({ zoomKind = null, zoomTerm = null, usage = ZOOM_USAGE_MAP.target,
  hasWholeScreenBlock = false } = {}) {
  if (!Object.values(ZOOM_KIND_MAP).includes(zoomKind)) return [];
  return [
    '첫째 이미지는 회의에서 공유 중인 화면 전체다.',
    `둘째 이미지는 같은 순간 그 화면에서 ${buildZoomFocus({ zoomKind, zoomTerm })} 확대한 것이다.`,
    '글자·수치는 둘째 이미지에서 먼저 읽고, 대상이 둘째 이미지에 없거나 잘렸으면 첫째 이미지에서 찾는다. 둘째 이미지는 화면 일부라 그 밖에도 대상이 있다.',
    usage === ZOOM_USAGE_MAP.value
      ? '값·항목 이름은 둘째 이미지에서 먼저 읽되, 어느 값이 어느 항목의 것인지는 첫째 이미지의 배치로 확인한다.'
      : '',
    hasWholeScreenBlock ? WHOLE_SCREEN_BLOCK_LINE : '',
    '이미지가 두 장이라는 것, 확대했다는 것은 출력에 쓰지 않는다.',
  ].filter(Boolean);
}

module.exports = { buildZoomImageIntroLineList, ZOOM_KIND_MAP, ZOOM_USAGE_MAP };
