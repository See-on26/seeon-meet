// 지시 판정 때 찍는 화면. 가리킨 영역이 있으면 잘린 그림(지시 해설용)과 전체 화면(수치·척도 해설용)을 함께 찍는다.
// 두 그림은 기다림 없이 이어서 그려 같은 영상 프레임에서 나온다. 영역이 없으면 지금처럼 전체 화면 한 장만 찍는다.
export async function captureDeixisFrameSet({ frame, subRegion = null, narrowRegion, captureRegion }) {
  if (!frame) return { buffer: null, fullBuffer: null };
  if (!subRegion) return { buffer: await captureRegion(frame), fullBuffer: null };
  const [buffer, fullBuffer] = await Promise.all([captureRegion(narrowRegion(frame, subRegion)), captureRegion(frame)]);
  return { buffer, fullBuffer };
}
