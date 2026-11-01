import { APPEARED_REGION_KIND } from '../trigger/appeared-region.js';

// 지시 판정 때 찍는 화면. 가리킨 영역이 있으면 잘린 그림(지시 해설용)과 전체 화면(수치·척도 해설용)을 함께 찍는다.
// 두 그림은 기다림 없이 이어서 그려 같은 영상 프레임에서 나온다. 영역이 없으면 지금처럼 전체 화면 한 장만 찍는다.
export async function captureDeixisFrameSet({ frame, subRegion = null, narrowRegion, captureRegion }) {
  if (!frame) return { buffer: null, fullBuffer: null };
  if (!subRegion) return { buffer: await captureRegion(frame), fullBuffer: null };
  const [buffer, fullBuffer] = await Promise.all([captureRegion(narrowRegion(frame, subRegion)), captureRegion(frame)]);
  return { buffer, fullBuffer };
}

const POINTING_RECT_DIGIT = 4;
const roundRatio = (value) => Math.round(value * 10 ** POINTING_RECT_DIGIT) / 10 ** POINTING_RECT_DIGIT;
// 방금 나타난 그림 영역은 바뀐 칸 상자가 이미 그림을 덮으므로 가리킴 여백(펜 자국 둘레의 대상까지)을 두지 않는다.
// 칸 경계에 걸려 빠진 그림 가장자리만 살리게 칸 하나(32칸 격자의 1/32)만큼 둔다. 여백이 크면 그림 속 작은 글자의 몫이 준다.
export const APPEARED_CROP_MARGIN = 0.03;

// 잘린 그림과 같은 여백을 더한 가리킨 영역의 공유 화면 비율 상자(0~1). main 의 발화 ROI 가 발화로 찾은 곳과 견주는 데 쓴다.
// 영역에 종류(방금 나타난 그림)가 있으면 그 여백을 쓰고 종류를 함께 넘겨 main 이 확대 안내를 고르게 한다.
export function toPointingRect({ subRegion, margin }) {
  if (!subRegion) return null;
  const isAppeared = subRegion.kind === APPEARED_REGION_KIND;
  const regionMargin = isAppeared ? APPEARED_CROP_MARGIN : margin;
  const x0 = Math.max(0, subRegion.x - regionMargin);
  const y0 = Math.max(0, subRegion.y - regionMargin);
  const x1 = Math.min(1, subRegion.x + subRegion.w + regionMargin);
  const y1 = Math.min(1, subRegion.y + subRegion.h + regionMargin);
  const rect = { x: roundRatio(x0), y: roundRatio(y0), w: roundRatio(x1 - x0), h: roundRatio(y1 - y0) };
  return isAppeared ? { ...rect, kind: APPEARED_REGION_KIND } : rect;
}
