const fs = require('fs');
const path = require('path');
const { buildTimeMap, wallToMediaMs, resolveCaptureStartWallMs } = require('../time-map');
const { buildTranscriptUtteranceList, buildTranscriptText, toAsrEventListFromRecordList } = require('./transcript');
const { buildAdTimeline, summarizeAdTiming } = require('./ad-timeline');
const { buildMergedTimelineText } = require('./s-condition');
const { buildAdSrt } = require('./srt');
const { buildSlideList } = require('./slides');
const { readSessionRecordList, filterRecordKind } = require('./pipeline-records');
const { buildRunInfo } = require('./run-info');
const { buildFlowFile } = require('../flow/flow-snapshot');

const RESULT_FILE_MAP = {
  runInfo: 'run.json',
  transcriptJson: 'transcript.json',
  transcriptText: 'transcript.txt',
  adTimeline: 'ad-timeline.json',
  adSrt: 'ad.srt',
  sCondition: 's-condition.txt',
  outputAudio: 'output-audio.webm',
  slideDir: 'slides',
  slideList: 'slides.json',
  pipelineRecords: 'pipeline.jsonl',
  flow: 'flow.json',
};

const FINALIZE_ERROR_MAP = {
  sessionUnknown: 'session_unknown',
  recordReadFailed: 'record_read_failed',
  recordLineBroken: 'record_line_broken',
  noPlayerTime: 'no_player_time',
  noPlaybackReport: 'no_playback_report',
  noOutputAudio: 'no_output_audio',
  slideCopyFailed: 'slide_copy_failed',
  writeFailed: 'write_failed',
  flowFailed: 'flow_failed',
};

// 이 오류가 하나라도 있으면 결과물에 빠진 것이 있다(run.json.isComplete=false).
// 녹음(output-audio.webm)은 사람 평가 입력이고, 해설이 왔는데 재생 알림이 없으면 AD 타임라인의 들린 자리가 모두 빠진다.
// 문자열 코드는 실행 제어기(run-controller.js RUN_ERROR_MAP) 것이다. 녹음 시작·정지·쓰기 실패는 파일이 비지 않아도
// 끝부분이 빠졌을 수 있어 빠진 것으로 본다. start_failed 는 결과 폴더를 만든 뒤 재생을 시작하지 못한 실행이다.
const INCOMPLETE_CODE_LIST = [
  FINALIZE_ERROR_MAP.sessionUnknown, FINALIZE_ERROR_MAP.recordReadFailed, FINALIZE_ERROR_MAP.noPlayerTime,
  FINALIZE_ERROR_MAP.noOutputAudio, FINALIZE_ERROR_MAP.noPlaybackReport,
  FINALIZE_ERROR_MAP.writeFailed, 'capture_failed', 'session_end_timeout', 'roi_missing',
  'output_record_failed', 'start_failed',
];

async function writeResultFile({ fsApi, runDir, name, content, errorList }) {
  try {
    await fsApi.writeFile(path.join(runDir, name), content, 'utf8');
  } catch (error) {
    errorList.push({ code: FINALIZE_ERROR_MAP.writeFailed, message: `${name}: ${error.message}` });
  }
}

async function copySlideList({ slideList, runDir, fsApi, errorList }) {
  if (!slideList.length) return [];
  // 슬라이드 폴더를 못 만들어도 나머지 결과 파일은 쓴다.
  try {
    await fsApi.mkdir(path.join(runDir, RESULT_FILE_MAP.slideDir), { recursive: true });
  } catch (error) {
    errorList.push({ code: FINALIZE_ERROR_MAP.slideCopyFailed, message: `${RESULT_FILE_MAP.slideDir}: ${error.message}` });
    return [];
  }
  const copiedList = [];
  for (const slide of slideList) {
    try {
      await fsApi.copyFile(slide.sourcePath, path.join(runDir, slide.file));
      copiedList.push({ label: slide.label, startMediaMs: slide.startMediaMs, file: slide.file });
    } catch (error) {
      errorList.push({ code: FINALIZE_ERROR_MAP.slideCopyFailed, message: `${slide.sourcePath}: ${error.message}` });
    }
  }
  return copiedList;
}

// flow.json 은 흐름을 눈으로 보는 보조 파일이라 만들거나 쓰지 못해도 결과물 완전성에 넣지 않는다(INCOMPLETE_CODE_LIST 밖).
async function writeFlowFileSafely({ fsApi, runDir, recordList, run, toMediaMs, errorList }) {
  try {
    const flowFile = buildFlowFile({ recordList, run, toMediaMs });
    await fsApi.writeFile(path.join(runDir, RESULT_FILE_MAP.flow), `${JSON.stringify(flowFile, null, 2)}\n`, 'utf8');
    return flowFile.flowList.length;
  } catch (error) {
    errorList.push({ code: FINALIZE_ERROR_MAP.flowFailed, message: `${RESULT_FILE_MAP.flow}: ${error.message}` });
    return null;
  }
}

async function readRecordListSafely({ run, readRecords, errorList }) {
  if (!run.sessionId || !run.recordPath) {
    errorList.push({ code: FINALIZE_ERROR_MAP.sessionUnknown, message: '파이프라인 세션 ID·기록 파일을 받지 못했다' });
    return [];
  }
  try {
    const { recordList, brokenLineCount } = await readRecords({ recordPath: run.recordPath, sessionId: run.sessionId });
    if (brokenLineCount) {
      errorList.push({ code: FINALIZE_ERROR_MAP.recordLineBroken, message: `세션 기록 ${brokenLineCount}줄을 읽지 못해 건너뛰었다` });
    }
    return recordList;
  } catch (error) {
    errorList.push({ code: FINALIZE_ERROR_MAP.recordReadFailed, message: error.message });
    return [];
  }
}

// 모은 것까지만이라도 쓴다. 빠진 것이 있으면 run.json.isComplete=false 와 errorList 로 남긴다. run.json 은 맨 마지막에 쓴다.
async function finalizeRun({ run, modelConfig, fsApi = fs.promises, readRecords = readSessionRecordList }) {
  const errorList = [...run.errorList];
  const runDir = run.runDir;
  await fsApi.mkdir(runDir, { recursive: true });
  const recordList = await readRecordListSafely({ run, readRecords, errorList });

  const timeMap = buildTimeMap({ reportList: run.playerTimeList });
  if (!timeMap.length) errorList.push({ code: FINALIZE_ERROR_MAP.noPlayerTime, message: '재생 화면 시각 보고가 없다' });
  if (run.captionEventList.length && !run.playbackList.length) {
    errorList.push({ code: FINALIZE_ERROR_MAP.noPlaybackReport, message: '해설은 왔는데 재생 시작 알림이 하나도 없다 (TTS 없음 또는 알림 배선 확인)' });
  }
  const toMediaMs = (wallMs) => wallToMediaMs({ timeMap, wallMs });
  const captureStartWallMs = resolveCaptureStartWallMs({
    captureRequestedWallMs: run.captureRequestedWallMs, playbackList: run.playbackList,
  });

  const asrEventList = run.asrEventList.length ? run.asrEventList : toAsrEventListFromRecordList(recordList);
  const utteranceList = buildTranscriptUtteranceList({ asrEventList, toMediaMs });
  const { adList, droppedList } = buildAdTimeline({
    captionEventList: run.captionEventList,
    playbackList: run.playbackList,
    deixisRecordList: filterRecordKind(recordList, 'deixis'),
    narrationRecordList: filterRecordKind(recordList, 'narration'),
    rendererDropList: run.rendererDropList,
    utteranceList,
    toMediaMs,
    captureStartWallMs,
    outputStartWallMs: run.outputStartWallMs,
  });
  const slideList = await copySlideList({
    slideList: buildSlideList({ slideMarkRecordList: filterRecordKind(recordList, 'slide_mark'), toMediaMs }),
    runDir, fsApi, errorList,
  });

  const fileList = [
    [RESULT_FILE_MAP.transcriptJson, `${JSON.stringify({ utteranceList }, null, 2)}\n`],
    [RESULT_FILE_MAP.transcriptText, `${buildTranscriptText({ utteranceList })}\n`],
    [RESULT_FILE_MAP.adTimeline, `${JSON.stringify({ adList, droppedList }, null, 2)}\n`],
    [RESULT_FILE_MAP.adSrt, buildAdSrt({ adList })],
    [RESULT_FILE_MAP.sCondition, `${buildMergedTimelineText({ utteranceList, adList })}\n`],
    [RESULT_FILE_MAP.slideList, `${JSON.stringify({ slideList }, null, 2)}\n`],
    [RESULT_FILE_MAP.pipelineRecords, recordList.map((record) => JSON.stringify(record)).join('\n') + (recordList.length ? '\n' : '')],
  ];
  for (const [name, content] of fileList) await writeResultFile({ fsApi, runDir, name, content, errorList });
  const flowCount = await writeFlowFileSafely({ fsApi, runDir, recordList, run, toMediaMs, errorList });

  const hasOutputAudio = await fsApi.stat(path.join(runDir, RESULT_FILE_MAP.outputAudio))
    .then((stat) => stat.size > 0).catch(() => false);
  if (!hasOutputAudio) errorList.push({ code: FINALIZE_ERROR_MAP.noOutputAudio, message: 'viewer 소리 녹음이 비었다' });

  const hasIncompleteError = () => errorList.some((error) => INCOMPLETE_CODE_LIST.includes(error.code));
  const isComplete = !hasIncompleteError();
  const countMap = {
    utteranceCount: utteranceList.length,
    captionCount: run.captionEventList.length,
    adCount: adList.length,
    droppedCount: droppedList.length,
    slideCount: slideList.length,
    recordCount: recordList.length,
    playerTimeCount: run.playerTimeList.length,
    flowCount,
  };
  const runInfo = buildRunInfo({
    run, modelConfig, captureStartWallMs, adTiming: summarizeAdTiming({ adList }), countMap, errorList, isComplete,
  });
  await writeResultFile({ fsApi, runDir, name: RESULT_FILE_MAP.runInfo, content: `${JSON.stringify(runInfo, null, 2)}\n`, errorList });
  // run.json 자체를 못 쓴 실패는 run.json 에 남길 수 없으므로 돌려주는 값에만 반영한다.
  return { isComplete: !hasIncompleteError(), errorList, runDir, countMap };
}

module.exports = { finalizeRun, RESULT_FILE_MAP, FINALIZE_ERROR_MAP, INCOMPLETE_CODE_LIST };
