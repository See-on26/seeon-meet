// production 모듈이 ipcMain.handle 로 등록하는 채널의 결과를 실험 main 이 함께 받는다(세션 ID·기록 파일·세션 종료).
// production 코드는 고치지 않고, 등록 전에 handle 을 감싼다. registerPipeline 보다 먼저 불러야 한다.
function observeIpcHandleList({ ipcMain, observerMap, onWarn = (message) => console.warn(message) }) {
  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => {
    const observer = observerMap[channel];
    if (!observer) return originalHandle(channel, listener);
    return originalHandle(channel, async (...argList) => {
      const result = await listener(...argList);
      try {
        observer({ argList: argList.slice(1), result });
      } catch (error) {
        onWarn(`[lab] ${channel} 결과 받기 실패(무시): ${error.message}`);
      }
      return result;
    });
  };
}

module.exports = { observeIpcHandleList };
