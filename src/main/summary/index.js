const { ipcMain } = require('electron');
const { createSummaryGenerator, SUMMARY_STAGE_MAP } = require('./summary-generator');
const { SUMMARIES_DIR } = require('../paths');

function registerSummary({ getViewerView, pipelineHandle }) {
  const generator = createSummaryGenerator({
    config: pipelineHandle.config,
    summariesDir: SUMMARIES_DIR,
    onProgress: (payload) => getViewerView()?.webContents.send('summary-progress', payload),
  });

  ipcMain.handle('summary-generate', async () => {
    const session = pipelineHandle.consumeLastSession();
    if (!session) return { isOk: false, message: '요약할 세션이 없습니다' };
    try {
      const result = await generator.generate({ session });

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
