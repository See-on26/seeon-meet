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

// 잘린 그림과 같은 여백을 더한 가리킨 영역의 공유 화면 비율 상자(0~1). main 의 발화 ROI 가 발화로 찾은 곳과 견주는 데 쓴다.
export function toPointingRect({ subRegion, margin }) {
  if (!subRegion) return null;
  const x0 = Math.max(0, subRegion.x - margin);
  const y0 = Math.max(0, subRegion.y - margin);
  const x1 = Math.min(1, subRegion.x + subRegion.w + margin);
  const y1 = Math.min(1, subRegion.y + subRegion.h + margin);
  return { x: roundRatio(x0), y: roundRatio(y0), w: roundRatio(x1 - x0), h: roundRatio(y1 - y0) };
}
