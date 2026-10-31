// 발화 ROI 확대 그림을 해설 VLM 요청에 붙이는 방법. 확대 그림이 없으면 지금처럼 한 장·같은 프롬프트다.
const { ZOOM_KIND_MAP } = require('../../prompts/zoom-image-intro');

// 확대 그림이 있으면 [화면 전체, 확대] 순서로 두 장을 한 요청에 넣는다.
function toZoomImageArgs({ jpegBuffer, zoomJpegBuffer = null }) {
  return zoomJpegBuffer ? { jpegBufferList: [jpegBuffer, zoomJpegBuffer] } : { jpegBuffer };
}

// 프롬프트의 두 장 안내는 확대 그림이 실제로 붙을 때만 넣는다(종류·낱말만 와도 무시한다).
function toZoomPromptArgs({ zoomJpegBuffer = null, zoomKind = null, zoomTerm = null }) {
  return zoomJpegBuffer ? { zoomKind: zoomKind || ZOOM_KIND_MAP.speech, zoomTerm } : {};
}

module.exports = { toZoomImageArgs, toZoomPromptArgs };
