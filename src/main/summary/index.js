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
    // 렌더러가 지난 회의 창에 열린 그 회의 상세를 알아볼 수 있게 세션을 함께 보낸다.
    sendProgress({ ...progress, sessionId: session.sessionId });
  }

  async function failSummary({ session, language, message }) {
    await setSummaryStatus({ session, status: SUMMARY_STATUS_MAP.failed });
    sendProgress(buildSummaryProgress({ stage: SUMMARY_STAGE_MAP.fail, language, detail: { errorMessage: message } }));
    return { isOk: false, message, sessionId: session.sessionId };
  }

  // 회의 기록에 요약 글을 쓰지 못하면 지난 회의에서 요약을 볼 수 없으므로 오류를 돌려준다(없으면 null).
  async function saveArchiveSummary({ session, documentText }) {
    if (!meetingArchive) return null;
    try {
      await meetingArchive.saveSummary({ sessionId: session.sessionId, startedAt: session.startedAt, summaryText: documentText });
      return null;
    } catch (error) {
      console.error(`[archive] 요약 기록 저장 실패: ${error.message}`);
      return error;
    }
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
      return failSummary({ session, language, message: error.message });
    }

    // 요약 문서(out/summaries)는 남지만 지난 회의에는 없으므로 실패로 알리고 음성도 만들지 않는다.
    const saveError = await saveArchiveSummary({ session, documentText: result.documentText });
    if (saveError) {
      return failSummary({ session, language, message: `회의 기록에 요약을 저장하지 못했다 — ${saveError.message}` });
    }
    await setSummaryStatus({ session, status: SUMMARY_STATUS_MAP.done });

    saveSummaryAudio({ session, language, documentText: result.documentText })
      .catch((error) => console.warn(`[summary] 요약 음성 처리 실패(무시): ${error?.message}`));
    return {
      isOk: true,
      sessionId: session.sessionId,
      textFilePath: result.textFilePath,
      slideCount: result.slideCount,
      violationCount: result.violationCount,
      isTruncated: result.isTruncated,
    };
  });
}

module.exports = { registerSummary };
