const path = require('path');
const { app, ipcMain } = require('electron');
const { loadEnvFile } = require('../env');

loadEnvFile();
// 제품 앱과 userData 를 나눈다. 같은 폴더면 두 앱을 함께 띄울 때 저장소 잠금이 부딪힌다.
app.setPath('userData', path.join(app.getPath('appData'), 'seeon-lab'));

const fs = require('fs');
const { FRAMES_DIR, DEIXIS_NARRATED_DIR, DEIXIS_SKIPPED_DIR, SLIDES_DIR, SUMMARIES_DIR } = require('../paths');
const { registerIpc } = require('../ipc');
const { registerPipeline } = require('../caption-pipeline');
const { registerSummary } = require('../summary');
const { registerCommandShortcut } = require('../shortcut');
const { observeIpcHandleList } = require('./ipc-observer');
const labWindow = require('./window');
const { registerLabIpc } = require('./lab-ipc');
const { readAutorunOption } = require('./autorun-option');

// 파이프라인이 세션 시작·종료 결과(세션 ID·기록 파일)를 돌려줄 때 실험 기록에도 넘긴다. 등록보다 먼저 감싼다.
// 세션 시작은 viewer 가 보낸 요청({ mode, asrLanguage })도 함께 넘겨 이번 실행에 실린 회의 언어를 남긴다.
let sessionListener = { onStart: () => {}, onEnd: () => {} };
observeIpcHandleList({
  ipcMain,
  observerMap: {
    'pipeline-session-start': ({ argList, result }) => sessionListener.onStart(result, argList[0]),
    'pipeline-session-end': ({ result }) => sessionListener.onEnd(result),
  },
});

function waitForLoad(webContents) {
  return webContents.isLoading()
    ? new Promise((resolve) => { webContents.once('did-finish-load', resolve); }) : Promise.resolve();
}

async function startAutorun({ controller, autorun }) {
  await Promise.all([waitForLoad(labWindow.getViewerView().webContents), waitForLoad(labWindow.getPlayerView().webContents)]);
  console.log(`[lab] 자동 실행 — ${autorun.videoPath} (모드 ${autorun.mode || '평가 설정 기본'}, 평가 설정 ${autorun.isEvalPreset ? '켜짐' : '꺼짐'}`
    + `, 회의 언어 ${autorun.asrLanguage})`);
  const result = await controller.start(autorun);
  if (!result.isOk && controller.getStatus().phase === 'failed' && autorun.isExitOnDone && !result.runDir) {
    console.error(`[lab] 자동 실행 시작 실패: ${result.message}`);
    app.exit(1);
  }
}

app.whenReady().then(() => {
  for (const dir of [FRAMES_DIR, DEIXIS_NARRATED_DIR, DEIXIS_SKIPPED_DIR, SLIDES_DIR, SUMMARIES_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  registerIpc({ getViewerView: labWindow.getViewerView });
  // 실험 기록이 문서 폴더의 "지난 회의"에 섞이지 않게 회의 기록 보관을 넘기지 않는다.
  const pipelineHandle = registerPipeline({ getViewerView: labWindow.getViewerView, meetingArchive: null });
  registerSummary({ getViewerView: labWindow.getViewerView, pipelineHandle, meetingArchive: null });

  const autorun = readAutorunOption(process.env);
  // viewer preload 가 첫 줄에서 sendSync 로 기능 토글·회의 언어를 받으므로 창(viewer)을 불러오기 전에 등록한다.
  const controller = registerLabIpc({
    ipcMain,
    labWindow,
    pipelineConfig: pipelineHandle.config,
    onRunFinished: (result) => {
      console.log(`[lab] 결과 폴더 ${result.runDir} (완료=${result.isComplete}${result.errorList.length ? ` · 오류 ${result.errorList.map((error) => error.code).join(',')}` : ''})`);
      if (autorun?.isExitOnDone) app.exit(result.isComplete ? 0 : 1);
    },
  });
  sessionListener = controller.sessionListener;

  labWindow.createLabWindow();
  registerCommandShortcut({ getViewerView: labWindow.getViewerView });
  if (autorun) startAutorun({ controller, autorun });
});

app.on('window-all-closed', () => app.quit());
