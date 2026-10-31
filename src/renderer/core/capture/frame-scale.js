// GPU 서버로 보내는 화면 이미지의 긴 변 상한. 창이 크거나 고해상도 화면이면 캡처가 커지고,
// VLM 이미지 토큰이 픽셀 수에 비례해 늘어 이미 포화된 GPU 를 더 쓴다.
// 이보다 더 줄이면 VLM 시간은 거의 줄지 않는데(출력 문장 생성이 시간을 대부분 차지한다),
// 작은 글자를 OCR 은 잘못 읽고 VLM 은 다른 값으로 지어내기 시작한다.
export const MAX_FRAME_LONG_EDGE_PX = 1280;

const MIN_FRAME_EDGE_PX = 2;

export function fitWithinLongEdge({ width, height, maxLongEdge = MAX_FRAME_LONG_EDGE_PX }) {
  const scale = Math.min(1, maxLongEdge / Math.max(width, height));
  return {
    width: Math.max(MIN_FRAME_EDGE_PX, Math.round(width * scale)),
    height: Math.max(MIN_FRAME_EDGE_PX, Math.round(height * scale)),
  };
}
