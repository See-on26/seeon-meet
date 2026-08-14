const fs = require('fs');
const path = require('path');
const { createSlideRecaptionAgent } = require('../caption-pipeline/agents/slide-recaption-agent');
const { createSegmentSummaryAgent } = require('../caption-pipeline/output/segment-summary-agent');
const { createMeetingSummaryAgent } = require('../caption-pipeline/output/meeting-summary-agent');
const { createSummaryRewriteAgent } = require('../caption-pipeline/output/summary-rewrite-agent');
const { createTtsClient } = require('../caption-pipeline/output/tts-client');
const { listSegments } = require('../caption-pipeline/context/segment-plan');
const {
  buildSegmentMaterial, hasSegmentContent, isScreenFillNeeded,
} = require('../caption-pipeline/context/segment-material');
const { defaultVlmTraffic } = require('../caption-pipeline/agents/shared/vlm-traffic');
const { SEGMENT_STATUS_MAP } = require('../caption-pipeline/context/context-store');
const { flattenAsrSegmentList } = require('./slide-timeline');
const { resolveSlideAssetList } = require('./slide-asset-resolver');
const { fitIntegrationInput } = require('./integration-input');
const { buildIntegrationDraft } = require('./integration-draft');
const { readNumbersForSpeech } = require('./speech-number');
const { buildSummaryDocument, findMarkupViolationList, buildSummaryFileName } = require('./summary-document');
const {
  buildFullTranscript, listSlideMajorWithoutTransitionLine,
} = require('../caption-pipeline/context/transcript-script');

const RECAPTION_CONCURRENCY = 3;
// 진행 중인 회의가 있으면 요약 음성 합성을 이만큼마다 다시 확인하며 미룬다.
const DEFAULT_LIVE_CHECK_MS = 5000;

// 렌더러에 보내는 진행 알림의 단계. 이 밖의 단계별 진행은 로그로만 남긴다.
const SUMMARY_STAGE_MAP = {
  start: 'start',
  done: 'done',
  fail: 'fail',
  audioDone: 'audio-done',
};

// 진행 알림 문구. 그 회의의 캡션 언어로 쓴다.
const SUMMARY_PROGRESS_TEXT_MAP = {
  ko: {
    [SUMMARY_STAGE_MAP.start]: () => '회의 요약 생성 중입니다…',
    [SUMMARY_STAGE_MAP.done]: ({ textFileName }) => `요약본 저장 완료 — ${textFileName}`,
    [SUMMARY_STAGE_MAP.fail]: ({ errorMessage }) => `요약 생성 실패 — ${errorMessage}`,
    [SUMMARY_STAGE_MAP.audioDone]: ({ audioFileName }) => `요약본 음성 저장 완료 — ${audioFileName}`,
  },
  en: {
    [SUMMARY_STAGE_MAP.start]: () => 'Creating the meeting summary…',
    [SUMMARY_STAGE_MAP.done]: ({ textFileName }) => `Summary saved — ${textFileName}`,
    [SUMMARY_STAGE_MAP.fail]: ({ errorMessage }) => `Summary failed — ${errorMessage}`,
    [SUMMARY_STAGE_MAP.audioDone]: ({ audioFileName }) => `Summary audio saved — ${audioFileName}`,
  },
};
const readProgressText = (language) => SUMMARY_PROGRESS_TEXT_MAP[language] || SUMMARY_PROGRESS_TEXT_MAP.ko;

// 실패 없이 구간 요약이 모두 빈 회의의 요약 본문. 통합 요약은 재료가 없으면 지어내므로 부르지 않는다.
const EMPTY_SUMMARY_BODY_TEXT_MAP = {
  ko: '회의에서 요약할 만한 말과 화면 기록이 없어요',
  en: 'There was no speech or screen record to summarize',
};
const readEmptySummaryBodyText = (language) => EMPTY_SUMMARY_BODY_TEXT_MAP[language] || EMPTY_SUMMARY_BODY_TEXT_MAP.ko;

// 화면 정보 텍스트화 결과를 구간 재료의 화면 설명 한 줄로 쓸 때의 최대 길이.
const SCREEN_FILL_MAX_CHARS = 80;
// 회의 뒤 구간 요약이 이만큼 잇달아 실패하면 GPU 서버가 응답하지 않는 것으로 보고 나머지 구간을 묻지 않는다.
// 구간마다 요청 시간 제한(60초)을 다 기다리지 않게 한다.
const MAX_CONSECUTIVE_SEGMENT_FAILURE_COUNT = 3;

function buildSummaryProgress({ stage, language, detail = {} }) {
  return { stage, message: readProgressText(language)[stage](detail) };
}

function logStep(message) {
  console.log(`[summary] ${message}`);
}

async function mapWithConcurrencyLimit({ itemList, limit, run }) {
  const resultList = new Array(itemList.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < itemList.length) {
      const index = nextIndex;
      nextIndex += 1;
      resultList[index] = await run({ item: itemList[index], index });
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, itemList.length) }, runWorker));
  return resultList;
}

// 화면 정보 텍스트화 결과를 한 줄로 줄인다. 제목이 있으면 제목, 없으면 화면 서술의 첫 문장이다.
function toScreenFillText(recaption) {
  const title = String(recaption?.title ?? '').trim();
  if (title) return title;
  const firstSentence = String(recaption?.bodyText ?? '').trim().split(/(?<=[.!?])\s|\n/)[0] || '';
  return firstSentence.length > SCREEN_FILL_MAX_CHARS
    ? `${firstSentence.slice(0, SCREEN_FILL_MAX_CHARS)}…` : firstSentence;
}

// 맥락 저장소 스냅숏이 없으면(세션 기록만 남은 경우) 발화만으로 요약 재료와 스크립트를 만든다. 화자 힌트는 기록에 있으면 쓴다.
function buildSnapshotFromSession({ session }) {
  const utteranceList = [];
  for (const entry of session.asrEntryList || []) {
    for (const segment of flattenAsrSegmentList({ asrEntryList: [entry] })) {
      utteranceList.push({
        ts: segment.ts, text: segment.text, speakerHint: entry.speakerHint || null,
        isSpeakerTracked: entry.isSpeakerTracked !== false,
      });
    }
  }
  return { startedAt: session.startedAt, slideList: [], transitionList: [], utteranceList };
}

function countScreen({ snapshot }) {
  return new Set((snapshot.transitionList || []).map((transition) => transition.slideMajor)).size;
}

const hasSummaryText = (segmentSummary) => Boolean(segmentSummary.text.trim());

// 회의 뒤 화면 정보 텍스트화 대상. 다시 만들 구간이 쓰는 화면 가운데 전환 고지가 한 번도 없었고 묘사·라벨도 없는
// 화면이다 — 구간 재료는 묘사·라벨이 있으면 채움 줄을 쓰지 않고, 회의 중에 요약을 마친 구간은 재료를 다시 만들지 않는다.
function listScreenFillTargetMajor({ snapshot, missingSegmentList }) {
  const missingMajorSet = new Set(missingSegmentList.map((segment) => String(segment.slideMajor)));
  const slideByMajorMap = new Map((snapshot.slideList || []).map((slide) => [String(slide.major), slide]));
  return listSlideMajorWithoutTransitionLine({ snapshot })
    .filter((major) => missingMajorSet.has(major) && isScreenFillNeeded({ slide: slideByMajorMap.get(major) }));
}

// 회의 중에 ready 로 끝난 구간 요약 가운데 지금 계산한 구간과 시작·끝 시각까지 같은 것만 쓴다.
// 회의 중에는 닫힌 것으로 본 방문이 뒤에 이어 붙거나(취소된 전환) 구간 범위가 바뀌면 그 요약은 구간 일부만 담는다.
function buildReadyTextByKeyMap({ snapshot, segmentList }) {
  const segmentByKeyMap = new Map(segmentList.map((segment) => [segment.key, segment]));
  return new Map((snapshot.segmentSummaryList || [])
    .filter((segmentSummary) => {
      const segment = segmentByKeyMap.get(segmentSummary.key);
      return segmentSummary.status === SEGMENT_STATUS_MAP.ready && Boolean(segment)
        && segmentSummary.startTs === segment.startTs && segmentSummary.endTs === segment.endTs;
    })
    .map((segmentSummary) => [segmentSummary.key, segmentSummary.text || '']));
}

// 에이전트·TTS·회의 진행 여부·GPU 요청 순위는 바꿔 끼울 수 있다(기본은 실제 모델·서버, 진행 중인 회의 없음).
function createSummaryGenerator({
  config, summariesDir, onProgress = null,
  recaptionAgent = createSlideRecaptionAgent({ config }),
  segmentSummaryAgent = createSegmentSummaryAgent({ config }),
  summaryAgent = createMeetingSummaryAgent({ config }),
  rewriteAgent = createSummaryRewriteAgent({ config }),
  ttsClient = createTtsClient({ config }),
  isMeetingLive = () => false,
  vlmTraffic = defaultVlmTraffic,
  liveCheckMs = DEFAULT_LIVE_CHECK_MS,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
}) {
  function reportProgress({ stage, language, detail }) {
    const progress = buildSummaryProgress({ stage, language, detail });
    logStep(progress.message);
    onProgress?.(progress);
  }

  // 화면 정보 텍스트화. 실패하면 null 을 돌려주고 그 화면의 구간 재료에는 화면 설명 줄이 없다.
  // 회의 뒤 일이라 GPU 배경 순위로 보낸다 — 다음 회의가 시작됐으면 실시간 해설 요청이 먼저 나간다.
  async function recaptionSlide({ asset }) {
    try {
      const baseJpegBuffer = fs.readFileSync(asset.baseFilePath);
      const annotationJpegBuffer = asset.lastAnnotationFilePath
        ? fs.readFileSync(asset.lastAnnotationFilePath) : null;
      return await vlmTraffic.runBackground(() => recaptionAgent.generate({
        baseJpegBuffer, annotationJpegBuffer, slideMajor: asset.major,
      }));
    } catch (error) {
      console.warn(`[summary] 슬라이드 ${asset.major} 화면 정보 텍스트화 실패: ${error.message}`);
      return null;
    }
  }

  // 대상 화면(listScreenFillTargetMajor)만 회의 후에 텍스트로 바꿔 그 화면 구간 재료의 화면 설명을 채운다.
  async function buildScreenFillByMajorMap({ snapshot, assetList, missingSegmentList }) {
    const targetMajorSet = new Set(listScreenFillTargetMajor({ snapshot, missingSegmentList }));
    const targetList = assetList.filter((asset) => targetMajorSet.has(String(asset.major)));
    let doneCount = 0;
    const recaptionList = await mapWithConcurrencyLimit({
      itemList: targetList,
      limit: RECAPTION_CONCURRENCY,
      run: async ({ item }) => {
        const recaption = await recaptionSlide({ asset: item });
        doneCount += 1;
        logStep(`화면 정보 텍스트화 ${doneCount}/${targetList.length}`);
        return recaption;
      },
    });
    return new Map(targetList.map((asset, index) => [String(asset.major), toScreenFillText(recaptionList[index])]));
  }

  // 회의 중에 ready 로 끝난 구간 요약은 그대로 쓰고, 나머지(마지막 화면·실패·종료 때 요청 중이던 구간)는 지금 만든다.
  // 실시간 해설과 GPU 를 나눠 쓰므로 한 번에 하나씩 보낸다. 일부 구간이 실패하면 빈 요약으로 두고 계속하지만,
  // 글이 있는 구간 없이 실패만 있거나 연속으로 실패하면 던져 요약 실패로 알린다 — "요약할 내용 없음"으로 저장하지 않는다.
  async function fillSegmentSummaryList({
    snapshot, segmentList, readyTextByKeyMap, missingCount, screenFillByMajorMap, language,
  }) {
    logStep(`구간 요약 ${segmentList.length}개 가운데 빠진 ${missingCount}개를 만든다`);

    const segmentSummaryList = [];
    let failedCount = 0;
    let consecutiveFailedCount = 0;
    let lastErrorMessage = '';
    for (const segment of segmentList) {
      const { key, slideMajor, startTs, endTs, isRevisit } = segment;
      const { text, status, errorMessage, isAsked } = readyTextByKeyMap.has(key)
        ? { text: readyTextByKeyMap.get(key), status: SEGMENT_STATUS_MAP.ready, isAsked: false }
        : await summarizeSegment({ snapshot, segment, screenFillByMajorMap, language });
      if (status === SEGMENT_STATUS_MAP.failed) {
        failedCount += 1;
        consecutiveFailedCount += 1;
        lastErrorMessage = errorMessage;
        if (consecutiveFailedCount >= MAX_CONSECUTIVE_SEGMENT_FAILURE_COUNT) {
          throw new Error(`구간 요약이 연속 ${consecutiveFailedCount}개 실패해 나머지 구간을 묻지 않았다 — ${lastErrorMessage}`);
        }
      } else if (isAsked) {
        consecutiveFailedCount = 0;
      }
      segmentSummaryList.push({ key, slideMajor, startTs, endTs, isRevisit, text, status });
    }
    if (failedCount && !segmentSummaryList.some(hasSummaryText)) {
      throw new Error(`구간 요약 ${failedCount}개가 실패하고 글이 있는 구간이 없다 — ${lastErrorMessage}`);
    }
    if (failedCount) {
      console.warn(`[summary] 구간 요약 ${segmentList.length}개 가운데 ${failedCount}개가 실패해 빈 요약으로 두고 통합한다`);
    }
    return segmentSummaryList;
  }

  // 재료가 없는 구간은 GPU 에 묻지 않고 빈 구간으로 둔다. isAsked 는 GPU 가 실제로 답했는지다(연속 실패 판정).
  async function summarizeSegment({ snapshot, segment, screenFillByMajorMap, language }) {
    if (!hasSegmentContent({ snapshot, segment, screenFillByMajorMap })) {
      logStep(`구간 요약 ${segment.key} — 재료 없음(묻지 않음)`);
      return { text: '', status: SEGMENT_STATUS_MAP.ready, isAsked: false };
    }
    const startedAt = Date.now();
    try {
      const materialText = buildSegmentMaterial({ snapshot, segment, screenFillByMajorMap });
      const { text } = await segmentSummaryAgent.summarize({ materialText, language });
      const summaryText = typeof text === 'string' ? text : '';
      logStep(`구간 요약 ${segment.key} — ${summaryText ? `${summaryText.length}자` : '빈 구간'} (${Date.now() - startedAt}ms)`);
      return { text: summaryText, status: SEGMENT_STATUS_MAP.ready, isAsked: true };
    } catch (error) {
      console.warn(`[summary] 구간 요약 ${segment.key} 실패: ${error?.message}`);
      return { text: '', status: SEGMENT_STATUS_MAP.failed, errorMessage: error?.message || String(error), isAsked: true };
    }
  }

  // 구간 요약을 모아 통합 요약 → 낭독용 재작성. 통합 입력이 넘치면 구간 요약 에이전트로 묶음을 줄인다.
  async function summarizeMeeting({ segmentSummaryList, snapshot, language }) {
    const fitted = await fitIntegrationInput({
      segmentSummaryList,
      snapshot,
      language,
      reduce: ({ text, language: reduceLanguage }) => segmentSummaryAgent.summarize({
        materialText: text, language: reduceLanguage,
      }),
    });
    logStep(`통합 요약 — 입력 ${fitted.text.length}자${fitted.isTruncated ? ' (길이 제한으로 자름)' : ''}`);
    const draft = await buildIntegrationDraft({ integrationText: fitted.text, language, summaryAgent, logStep });
    logStep('요약본 듣는 글로 재구성');
    const rewritten = await rewriteAgent.rewrite({ draftText: draft.text, isTruncated: draft.isTruncated, language });
    return { bodyText: rewritten.text, isTruncated: fitted.isTruncated || draft.isTruncated || rewritten.isTruncated };
  }

  // 회의 뒤 요약 글. 그 회의의 캡션 언어(세션 기록)로 요약 글·진행 알림을 낸다. 음성은 generateAudio 가 따로 만든다.
  async function generateText({ session, contextSnapshot = null }) {
    const language = session.captionLanguage || 'ko';
    reportProgress({ stage: SUMMARY_STAGE_MAP.start, language });
    const snapshot = contextSnapshot || buildSnapshotFromSession({ session });
    const assetList = resolveSlideAssetList({ slideMarkList: session.slideMarkList });
    logStep(`요약 재료 수집 — 화면 ${countScreen({ snapshot })}개 · 발화 ${session.asrEntryList.length}건`);

    const segmentList = listSegments({ snapshot, endTs: session.endedAt });
    const readyTextByKeyMap = buildReadyTextByKeyMap({ snapshot, segmentList });
    const missingSegmentList = segmentList.filter((segment) => !readyTextByKeyMap.has(segment.key));
    const screenFillByMajorMap = await buildScreenFillByMajorMap({ snapshot, assetList, missingSegmentList });
    const segmentSummaryList = await fillSegmentSummaryList({
      snapshot, segmentList, readyTextByKeyMap, missingCount: missingSegmentList.length, screenFillByMajorMap, language,
    });
    const { bodyText, isTruncated } = segmentSummaryList.some(hasSummaryText)
      ? await summarizeMeeting({ segmentSummaryList, snapshot, language })
      : { bodyText: readEmptySummaryBodyText(language), isTruncated: false };

    const documentText = buildSummaryDocument({
      meetingMeta: {
        sessionId: session.sessionId,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        slideCount: countScreen({ snapshot }),
        utteranceCount: session.asrEntryList.length,
      },
      bodyText,
      isTruncated,
      language,
    });

    const violationList = findMarkupViolationList({ text: documentText });
    if (violationList.length) {
      console.warn(`[summary] 형식 위반 ${violationList.length}건 (첫 건: ${violationList[0].lineNumber}행 ${violationList[0].reason})`);
    }

    fs.mkdirSync(summariesDir, { recursive: true });
    const textFilePath = path.join(
      summariesDir, buildSummaryFileName({ sessionId: session.sessionId, extension: 'txt' }),
    );
    fs.writeFileSync(textFilePath, documentText, 'utf8');
    // 스크립트 전문(발화·화자·질문답) 파일 쓰기에 실패해도 요약 문서는 그대로 쓴다.
    const scriptText = buildFullTranscript({ snapshot, language });
    const scriptFilePath = textFilePath.replace(/\.txt$/, '-script.txt');
    try {
      fs.writeFileSync(scriptFilePath, scriptText, 'utf8');
    } catch (error) {
      console.warn(`[summary] 회의 스크립트 쓰기 실패(무시) ${scriptFilePath}: ${error.message}`);
    }

    reportProgress({ stage: SUMMARY_STAGE_MAP.done, language, detail: { textFileName: path.basename(textFilePath) } });
    return {
      isOk: true,
      textFilePath,
      documentText,
      scriptText,
      slideCount: countScreen({ snapshot }),
      violationCount: violationList.length,
      isTruncated,
    };
  }

  // 긴 글 합성 서버는 회의 중 해설 음성과 같은 프로그램이라, 진행 중인 회의가 있으면 그 회의가 끝날 때까지 미룬다.
  async function waitUntilNoLiveMeeting() {
    for (let checkCount = 0; isMeetingLive(); checkCount += 1) {
      if (checkCount === 0) logStep('진행 중인 회의가 있어 요약본 음성 합성을 그 회의가 끝날 때까지 미룬다');
      await sleep(liveCheckMs);
    }
  }

  // 요약 글을 읽은 mp3 를 만든다. 실패하면 null 이다(글은 이미 저장돼 있다).
  async function generateAudio({ sessionId, documentText, language = 'ko' }) {
    try {
      await waitUntilNoLiveMeeting();
      logStep('요약본 음성 합성');
      // 글은 아라비아 숫자 그대로 두고, 음성 서버가 잘못 읽는 숫자 꼴만 읽는 말로 바꿔 합성한다.
      const mp3Buffer = await ttsClient.synthesizeLong({ text: readNumbersForSpeech({ text: documentText, language }), language });
      const audioFilePath = path.join(summariesDir, buildSummaryFileName({ sessionId, extension: 'mp3' }));
      fs.writeFileSync(audioFilePath, mp3Buffer);
      return audioFilePath;
    } catch (error) {
      console.warn(`[summary] 요약본 음성 합성 실패(텍스트만 남김): ${error?.message}`);
      return null;
    }
  }

  return { generateText, generateAudio };
}

module.exports = {
  createSummaryGenerator, buildSummaryProgress, mapWithConcurrencyLimit,
  SUMMARY_STAGE_MAP, RECAPTION_CONCURRENCY, toScreenFillText, buildSnapshotFromSession,
};
