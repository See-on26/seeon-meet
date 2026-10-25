const path = require('path');
const electron = require('electron');
const { createSummaryGenerator, buildSummaryProgress, SUMMARY_STAGE_MAP } = require('./summary-generator');
const { SUMMARY_STATUS_MAP } = require('../archive/meeting-archive');
const { SUMMARIES_DIR } = require('../paths');

// 회의가 끝나면 요약 글을 만들어 돌려주고, 음성은 기다리지 않고 진행 중인 회의가 없을 때 따로 만든다.
// ipcMain·생성기는 바꿔 끼울 수 있다(기본은 electron 의 ipcMain 과 실제 생성기).
function registerSummary({
  getViewerView, pipelineHandle, meetingArchive = null,
  ipcMain = electron.ipcMain, createGenerator = createSummaryGenerator,
}) {
  const sendProgress = (progress) => getViewerView()?.webContents.send('summary-progress', progress);
  const generator = createGenerator({
    config: pipelineHandle.config,
    summariesDir: SUMMARIES_DIR,
    onProgress: sendProgress,
    isMeetingLive: pipelineHandle.isMeetingLive,
  });

  // 사용자 문서 폴더의 회의 기록 쓰기. 실패해도 요약 흐름은 계속한다.
  async function writeArchive({ label, write }) {
    if (!meetingArchive) return;
    try {
      await write();
    } catch (error) {
      console.warn(`[archive] ${label} 실패(무시): ${error.message}`);
    }
  }

  function setSummaryStatus({ session, status }) {
    return writeArchive({
      label: `요약 상태(${status}) 저장`,
      write: () => meetingArchive.setSummaryStatus({ sessionId: session.sessionId, startedAt: session.startedAt, status }),
    });
  }

  async function saveSummaryAudio({ session, language, documentText }) {
    const audioFilePath = await generator.generateAudio({ sessionId: session.sessionId, documentText, language });
    if (!audioFilePath) return;
    await writeArchive({
      label: '요약 음성 저장',
      write: () => meetingArchive.saveSummaryAudio({
        sessionId: session.sessionId, startedAt: session.startedAt, audioFilePath,
      }),
    });
    const progress = buildSummaryProgress({
      stage: SUMMARY_STAGE_MAP.audioDone, language, detail: { audioFileName: path.basename(audioFilePath) },
    });
    console.log(`[summary] ${progress.message}`);
    sendProgress(progress);
  }

  ipcMain.handle('summary-generate', async () => {
    const session = pipelineHandle.consumeLastSession();
    const contextSnapshot = pipelineHandle.consumeLastContext();
    if (!session) return { isOk: false, message: '요약할 세션이 없습니다' };
    const language = session.captionLanguage || 'ko';
    await setSummaryStatus({ session, status: SUMMARY_STATUS_MAP.pending });

    let result;
    try {
      result = await generator.generateText({ session, contextSnapshot });
    } catch (error) {
      console.error('[summary] 요약 생성 실패:', error.message);
      await setSummaryStatus({ session, status: SUMMARY_STATUS_MAP.failed });
      sendProgress(buildSummaryProgress({
        stage: SUMMARY_STAGE_MAP.fail, language, detail: { errorMessage: error.message },
      }));
      return { isOk: false, message: error.message };
    }

    await writeArchive({
      label: '요약 기록 저장',
      write: () => meetingArchive.saveSummary({
        sessionId: session.sessionId, startedAt: session.startedAt, summaryText: result.documentText,
      }),
    });
    await setSummaryStatus({ session, status: SUMMARY_STATUS_MAP.done });

    saveSummaryAudio({ session, language, documentText: result.documentText })
      .catch((error) => console.warn(`[summary] 요약 음성 처리 실패(무시): ${error?.message}`));
    return {
      isOk: true,
      textFilePath: result.textFilePath,
      slideCount: result.slideCount,
      violationCount: result.violationCount,
      isTruncated: result.isTruncated,
    };
  });
}

module.exports = { registerSummary };
