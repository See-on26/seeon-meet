const { ipcMain } = require('electron');
const { createSummaryGenerator, SUMMARY_STAGE_MAP } = require('./summary-generator');
const { SUMMARIES_DIR } = require('../paths');

function registerSummary({ getViewerView, pipelineHandle, meetingArchive = null }) {
  const generator = createSummaryGenerator({
    config: pipelineHandle.config,
    summariesDir: SUMMARIES_DIR,
    onProgress: (payload) => getViewerView()?.webContents.send('summary-progress', payload),
  });

  ipcMain.handle('summary-generate', async () => {
    const session = pipelineHandle.consumeLastSession();
    const contextSnapshot = pipelineHandle.consumeLastContext();
    if (!session) return { isOk: false, message: '요약할 세션이 없습니다' };
    try {
      const result = await generator.generate({ session, contextSnapshot });
      // 사용자 문서 폴더의 회의 기록에 요약 텍스트·음성을 같이 둔다. 실패해도 요약 결과는 돌려준다.
      await meetingArchive?.saveSummary({
        sessionId: session.sessionId, startedAt: session.startedAt,
        summaryText: result.documentText, audioFilePath: result.audioFilePath,
      }).catch((error) => console.warn(`[archive] 요약 기록 저장 실패(무시): ${error.message}`));

      return {
        isOk: true,
        textFilePath: result.textFilePath,
        audioFilePath: result.audioFilePath,
        slideCount: result.slideCount,
        violationCount: result.violationCount,
        isTruncated: result.isTruncated,
      };
    } catch (error) {
      console.error('[summary] 요약 생성 실패:', error.message);
      getViewerView()?.webContents.send('summary-progress', {
        stage: SUMMARY_STAGE_MAP.fail, message: `요약 생성 실패 — ${error.message}`,
        doneCount: 0, totalCount: 0,
      });
      return { isOk: false, message: error.message };
    }
  });
}

module.exports = { registerSummary };
