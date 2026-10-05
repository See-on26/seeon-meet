// production viewer preload 가 노출하는 API 를 가로채 받는다. contextBridge 는 같은 이름을 두 번 노출할 수 없어서
// 불러오는 동안만 노출 함수를 바꿔 끼우고, 받은 API 에 실험용 함수를 덧붙여 다시 노출한다.
function captureExposedApi({ contextBridge, load }) {
  const capturedMap = {};
  const originalExpose = contextBridge.exposeInMainWorld;
  contextBridge.exposeInMainWorld = (key, api) => { capturedMap[key] = api; };
  try {
    load();
  } finally {
    contextBridge.exposeInMainWorld = originalExpose;
  }
  return capturedMap;
}

module.exports = { captureExposedApi };
