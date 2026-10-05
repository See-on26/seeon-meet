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

// 가로챈 API 를 이름마다 모두 다시 노출한다. extensionMap 의 이름은 그 API 에 실험용 함수를 덧붙여 노출한다.
// 덧붙일 API 를 받지 못했으면(production preload 가 이름을 바꿨거나 노출하지 않음) 그 API 없이 조용히 돌지 않게
// 아무것도 노출하기 전에 멈춘다.
function exposeCapturedApi({ contextBridge, capturedMap, extensionMap = {} }) {
  for (const key of Object.keys(extensionMap)) {
    const api = capturedMap[key];
    if (!api || typeof api !== 'object') {
      const capturedKeyText = Object.keys(capturedMap).join(', ') || '없음';
      throw new Error(`[lab] production viewer preload 가 window.${key} 을 노출하지 않았다 (받은 이름: ${capturedKeyText}) — 실험용 함수를 덧붙일 수 없다`);
    }
  }
  for (const [key, api] of Object.entries(capturedMap)) {
    contextBridge.exposeInMainWorld(key, extensionMap[key] ? { ...api, ...extensionMap[key] } : api);
  }
}

module.exports = { captureExposedApi, exposeCapturedApi };
