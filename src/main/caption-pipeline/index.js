const fs = require('fs');
const { ipcMain, BrowserWindow } = require('electron');
const { readPipelineConfig, resolveSlideTextBackend, CHART_ESTIMATE_MODE_MAP } = require('./config');
const {
  NARRATION_TYPE_MAP, VISUAL_DESCRIPTION_KIND_MAP, SPEAKER_SOURCE_MAP, NARRATION_CLASS_MAP,
  INTERPRETATION_KIND_MAP,
} = require('./contracts/narration-types');
const { toNarrationClass, NARRATION_ORIGIN_MAP } = require('./contracts/narration-class');
const { buildSpeakerIdentityFromDom } = require('./agents/speaker-identity-agent');
const { DEBUG_STAGE_MAP, DEBUG_VERDICT_MAP } = require('./contracts/debug-events');
const { DEFAULT_CAPTION_LANGUAGE, resolveCaptionLanguage } = require('./contracts/caption-language');
const { createDevFlow } = require('../dev-flow');
const { flattenPlaybackReport } = require('../dev-flow/playback-report');
const { createAgentFieldMap } = require('./agents');
const { createUnifiedRouter, ROUTER_MODE_MAP, resolveNarrationEventVideoTimeMs } = require('./router/unified-router');
const { createSpeechTrigger, TRIGGER_TYPE_LABEL_MAP } = require('./trigger/speech-trigger');
const { createBoundaryTrigger } = require('./trigger/boundary-trigger');
const { createKiwiTokenizer } = require('./trigger/kiwi-tokenizer');
const { resolveKiwiModelDir } = require('./trigger/kiwi-model');
const { createDeixisJudgeClient } = require('./router/deixis-judge');
const { createSilenceJudge } = require('./router/silence-judge');
const { createSilenceNarrationGate, SILENCE_GATE_LABEL_MAP } = require('./orchestrator/silence-gate');
const { createFeatureGate } = require('./orchestrator/feature-gate');
const { createCaptionDescribedRegistry } = require('./orchestrator/caption-described-registry');
const { createSilenceNarrator, SILENCE_RESULT_MAP } = require('./orchestrator/silence-narrator');
const { selectGeneratableCandidate } = require('./orchestrator/candidate-selector');
const { createDescribedStore } = require('./orchestrator/described-store');
const { createScreenRegistry, SCREEN_TYPE_MAP } = require('./orchestrator/screen-registry');
const { createSlideTopicRegistry, SLIDE_TOPIC_VERDICT_MAP } = require('./orchestrator/slide-topic-registry');
const { buildTransitionNarration, buildRevisitNarration, resolveHeardSlideNumber } = require('./orchestrator/slide-transition-text');
const { createSpeakerRegistry } = require('./orchestrator/speaker-registry');
const { createNarrationHistory } = require('./orchestrator/narration-history');
const {
  readBlockingRelation, NARRATION_CLASS_LABEL_MAP, BLOCKING_RELATION_LABEL_MAP,
} = require('./orchestrator/blocking-policy');
const { createAsrClient } = require('./perception/asr-client');
const { createAsrLanguageSession, applySessionMeetingLanguage } = require('./perception/asr-language');
const { createEmbedClient } = require('./perception/embed-client');
const { createTtsClient } = require('./output/tts-client');
const { createGapInferenceAgent, countGapCandidateSource } = require('./output/gap-inference-agent');
const { createRecordStore, RECORD_KIND_MAP } = require('./instrumentation/record-store');
const { createSessionStore } = require('./instrumentation/session-store');
const { requestVlmContent } = require('./agents/shared/vlm-gateway');
const { createSlideTextAgent } = require('./agents/slide-text-agent');
const { describeAgentRejection } = require('./agents/shared/caption-parser');
const { assembleNarration } = require('./agents/shared/narration-format');
const { createOcrClient } = require('./agents/shared/ocr-client');
const { createSlideTextStore } = require('./orchestrator/slide-text-store');
const { createFactCardAgent } = require('./agents/fact-card-agent');
const { createFactCardStore, FACT_CARD_STATUS_MAP } = require('./orchestrator/fact-card-store');
const {
  createFactCardTokenizer, selectFactCards, resolveFactCardUsage, formatFactCardSummary,
} = require('./orchestrator/fact-card-select');
const {
  verifyValuePresence, readValueCheckTarget, approximateChartNarration, VALUE_PRESENCE_VERDICT_MAP, VALUE_CHECK_SOURCE_MAP,
} = require('./orchestrator/value-presence');
const {
  createChartEstimator, detectTickSnapSuspect, toChartValueList, CHART_STATUS_MAP,
} = require('./perception/chart-value-estimator');
const {
  createFrameDecoder, resolveNativeImage, createChartFrameSaver, buildChartFrameTag,
} = require('./perception/frame-bitmap');
const { checkSpokenValueMatch, SPOKEN_VALUE_VERDICT_MAP } = require('./prompts/approximate-value');
const {
  createScreenTextGrounding, shouldStartScreenTextGrounding, isScreenTextNarrationType, finalizeScreenTextRecord,
  formatScreenTextSummary,
} = require('./orchestrator/screen-text-grounding');
const { resolveDeixisFrameSet } = require('./orchestrator/deixis-frame-set');
const {
  createSpeechRoiResolver, buildZoomAgentArgs, formatSpeechRoiSummary, SPEECH_ROI_MODE_MAP,
} = require('./orchestrator/speech-roi');
const { createSlideLayoutStore, createSharedOcrClient } = require('./orchestrator/speech-roi/slide-layout-store');
const { createFrameImageOps } = require('./orchestrator/speech-roi/frame-image');
const { createScreenChangeService } = require('./orchestrator/screen-change-service');
const {
  createContextStore, toSlideMajor, LABEL_STATUS_MAP, SLIDE_FRAME_KIND_BASE,
} = require('./context/context-store');
const { createSlideLabeler } = require('./context/slide-labeler');
const { createSegmentSummaryScheduler } = require('./context/segment-summary-scheduler');
const { createSegmentSummaryAgent } = require('./output/segment-summary-agent');
const { createContextFileWriter } = require('./context/context-file');
const { buildTranscriptScript, buildFullTranscript, buildScriptFileName } = require('./context/transcript-script');
const { pickMeetingTitle } = require('../archive/meeting-archive');
const { classifyQuestion, QUESTION_ROUTE_MAP } = require('./context/question-classifier');
const { createQuestionRouter } = require('./context/question-router');
const { formatQaHistory, buildPresetQa } = require('./context/qa-history');
const { buildCurrentScreenContextText } = require('./context/current-screen-context');
const { createQuestionAnswerer, readAnswerText, ANSWER_TEXT_KEY_MAP } = require('./context/question-answerer');
const { OUT_DIR, CONTEXT_DIR, CHART_FRAMES_DIR } = require('../paths');

const ASR_DRAIN_TIMEOUT_MS = 8000;
const ASR_DRAIN_POLL_MS = 100;

const PIPELINE_STAGE_MAP = { frame: 'frame', judge: 'judge', vlm: 'vlm', caption: 'caption', tts: 'tts', asr: 'asr' };

const RECENT_NARRATION_LIMIT = 4;
// 시간으로 자르는 구간과 닫힌 뒤 기다림이 지난 구간은 새 기록 없이도 생기므로 세션 동안 이 간격으로 다시 본다.
const SEGMENT_SUMMARY_POLL_MS = 15000;

async function appendErrorRecordSafely({ appendRecord, record }) {
  try {
    await appendRecord(record);
  } catch (appendError) {
    console.error('[pipeline] 에러 레코드 적재 실패:', appendError.message);
  }
}

function truncateForLog(text, maxLength = 60) {
  if (typeof text !== 'string') return '';
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function readElectronApp() {
  try {
    return require('electron').app;
  } catch {
    return undefined;
  }
}

function formatTriggerCandidateList(candidateList = []) {
  return candidateList.map((candidate) => `${TRIGGER_TYPE_LABEL_MAP[candidate.type] || candidate.type}:"${candidate.phrase}"`).join(', ');
}

function registerPipeline({ getViewerView, meetingArchive = null }) {
  const config = readPipelineConfig();
  // 개발자 모드 흐름 창(로고 연타). viewer 로 보내는 사건·렌더러 debug·버림·재생 시작을 이번 회의분만 모은다.
  const devFlow = createDevFlow({ ipcMain, BrowserWindow });
  function sendPipelineEvent(payload) {
    getViewerView()?.webContents.send('pipeline-event', payload);
    devFlow.recorder.addPipelineEvent(payload);
  }
  const recordStore = createRecordStore({ outDir: OUT_DIR });
  const sessionStore = createSessionStore();
  let pendingAsrCount = 0;
  let lastSession = null;
  // 사용자에게 들리는 말의 언어. 캡처를 시작할 때 설정 화면에서 고른 값이 넘어온다.
  // 해설 에이전트·질문 답·무발화·전환 머리말이 부를 때마다 이 값을 읽는다.
  let sessionCaptionLanguage = DEFAULT_CAPTION_LANGUAGE;
  const getCaptionLanguage = () => sessionCaptionLanguage;
  const agentFieldMap = createAgentFieldMap({ config, getCaptionLanguage });
  const embedClient = createEmbedClient({ config });
  const ttsClient = createTtsClient({ config });

  const gapAgent = createGapInferenceAgent({ config });
  const asrClient = createAsrClient({ config });
  const asrLanguageSession = createAsrLanguageSession({ asrClient, config });
  const judgeClient = createDeixisJudgeClient({ config });
  const routerClient = createUnifiedRouter({ config });
  const isRouterMode = config.routerMode === ROUTER_MODE_MAP.unified;
  // 탐지 Layer 트리거: 한국어는 Kiwi 형태소 분석으로 맞춘다. 모델을 읽는 1초 남짓 이 스레드가 멈추므로 앱이 뜬 뒤 한 번만 만든다.
  const electronApp = readElectronApp();
  const kiwiTokenizer = createKiwiTokenizer({
    modelDir: resolveKiwiModelDir({ isPackaged: Boolean(electronApp?.isPackaged), resourcesPath: process.resourcesPath }),
  });
  const speechTrigger = createSpeechTrigger({ tokenizer: kiwiTokenizer });
  const boundaryTrigger = createBoundaryTrigger({ detect: speechTrigger.detect });
  setImmediate(() => {
    kiwiTokenizer.load()
      .then(({ elapsedMs }) => console.log(`[pipeline] 트리거 형태소 분석기(Kiwi) 준비 (${elapsedMs}ms)`))
      .catch((error) => console.warn(`[pipeline] Kiwi 를 띄우지 못해 한국어 트리거를 대체 규칙으로 잡는다: ${error.message}`));
  });
  const describedStore = createDescribedStore();
  const captionDescribed = createCaptionDescribedRegistry({ describedStore });
  const screenRegistry = createScreenRegistry();
  const slideTopicRegistry = createSlideTopicRegistry();
  const speakerRegistry = createSpeakerRegistry();
  const narrationHistory = createNarrationHistory({
    minIntervalMsByClassMap: { [NARRATION_CLASS_MAP.screenChange]: config.screenChangeMinIntervalMs },
  });
  const silenceGate = createSilenceNarrationGate();
  const featureGate = createFeatureGate();
  const silenceNarrator = createSilenceNarrator({
    gate: silenceGate, judge: createSilenceJudge({ config }), getCaptionLanguage,
  });
  console.log(`[pipeline] 발화 축 판정 경로: ${config.routerMode}`);
  console.log(`[pipeline] 탐지 판정 LLM: ${config.judgeBackend === 'gpu'
    ? `GPU ${config.judgeGpuModel} (실패하면 판정 없이 넘어감)` : `Bedrock ${config.judgeModelId}`}`);
  console.log(`[pipeline] ASR 언어: 회의 ${config.asrLanguage} · 질문 ${config.questionAsrLanguage}`);

  const contextFile = createContextFileWriter({ outDir: CONTEXT_DIR });
  const contextStore = createContextStore({
    onChange: () => contextFile.schedule({
      sessionId: contextStore.getSessionInfo().sessionId, getSnapshot: contextStore.snapshot,
    }),
  });
  let lastContextSnapshot = null;
  // 라벨 요청이 정지·재시작 뒤에 도착하면 새 세션의 같은 번호 슬라이드에 붙는다. 세대가 바뀌었으면 버린다.
  let contextGeneration = 0;
  // 라벨링·질문 라우팅은 이미지 없이 GPU VLM 을 부른다.
  const requestText = ({ prompt, label, maxTokens }) => requestVlmContent({
    config, prompt, label, maxTokens, temperature: 0,
  });
  const slideLabeler = createSlideLabeler({ requestText });
  const questionRouter = createQuestionRouter({ requestText });
  const questionAnswerer = createQuestionAnswerer({
    contextStore,
    requestText,
    requestImage: ({ jpegBuffer, prompt, label, maxTokens }) => requestVlmContent({
      config, jpegBuffer, prompt, label, maxTokens,
    }),
    readImage: (filePath) => fs.promises.readFile(filePath).catch(() => null),
    getCaptionLanguage,
  });
  // 회의 요약 스위치(렌더러)는 세션 시작 때 넘어오고, 회의 중에 바꾸면 다시 알려 온다.
  let isSessionMeetingSummaryEnabled = true;
  const segmentSummaryScheduler = createSegmentSummaryScheduler({
    contextStore,
    segmentSummaryAgent: createSegmentSummaryAgent({ config }),
    getCaptionLanguage,
    isEnabled: () => config.isLiveSegmentSummaryEnabled && isSessionMeetingSummaryEnabled,
  });
  let segmentSummaryTimer = null;

  // 구간 요약 확인이 실패해도 기록 반영·세션은 계속한다.
  function pollSegmentSummary() {
    try {
      segmentSummaryScheduler.poll();
    } catch (error) {
      console.warn(`[summary] 구간 요약 확인 실패(무시): ${error?.message}`);
    }
  }

  function stopSegmentSummaryTimer() {
    if (segmentSummaryTimer) clearInterval(segmentSummaryTimer);
    segmentSummaryTimer = null;
  }

  function startSegmentSummaryTimer() {
    stopSegmentSummaryTimer();
    segmentSummaryTimer = setInterval(pollSegmentSummary, SEGMENT_SUMMARY_POLL_MS);
  }

  function appendRecord(record) {
    try {
      if (contextStore.applyRecord(record)) {
        labelReadySlides();
        // 구간은 슬라이드 방문(base 마크)으로 닫힌다. poll 은 Store 스냅숏을 뜨므로 주석 판 마크나 다른 기록마다 부르지 않는다.
        if (record.kind === RECORD_KIND_MAP.slideMark && record.frameKind === SLIDE_FRAME_KIND_BASE) pollSegmentSummary();
      }
    } catch (error) {
      console.warn(`[context] 기록 반영 실패(무시) kind=${record?.kind}: ${error.message}`);
    }
    return recordStore.append(sessionStore.addRecord({ record }));
  }

  function labelReadySlides() {
    for (const major of contextStore.listReadyForLabelMajors()) {
      contextStore.markLabelRequested(major);
      const slide = contextStore.getSlide(major);
      const startedAt = Date.now();
      const generation = contextGeneration;
      slideLabeler.label({ slide }).then((label) => {
        if (generation !== contextGeneration) return;
        contextStore.setLabel({ major, label, status: LABEL_STATUS_MAP.ready });
        markDebug({
          stage: DEBUG_STAGE_MAP.context, verdict: DEBUG_VERDICT_MAP.info,
          reason: `슬라이드 ${major} 라벨`,
          detail: `"${label.title}" [${label.keywordList.join(', ')}] (${Date.now() - startedAt}ms)`,
        });
      }).catch((error) => {
        if (generation !== contextGeneration) return;
        contextStore.setLabel({ major, label: null, status: LABEL_STATUS_MAP.failed });
        markDebug({
          stage: DEBUG_STAGE_MAP.context, verdict: DEBUG_VERDICT_MAP.fail,
          reason: `슬라이드 ${major} 라벨 실패 — 주제·묘사로 색인`, detail: error.message,
        });
      });
    }
  }

  async function drainPendingAsr() {
    const startCount = pendingAsrCount;
    const deadline = Date.now() + ASR_DRAIN_TIMEOUT_MS;
    while (pendingAsrCount > 0 && Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, ASR_DRAIN_POLL_MS); });
    }
    if (pendingAsrCount > 0) {
      console.warn(`[pipeline] ASR 드레인 상한 초과 — ${pendingAsrCount}건을 남기고 진행합니다`);
    }
    return startCount - pendingAsrCount;
  }

  function markDebug({ stage, verdict, reason, detail = '', narrationType = null, ts = Date.now() }) {
    const entry = { stage, verdict, reason, detail, narrationType, ts };
    appendRecord({ kind: RECORD_KIND_MAP.debug, ...entry }).catch(() => {});
    sendPipelineEvent({ type: 'debug', ...entry });
  }

  // 화면 글자 읽기 방법은 설정 화면에서 고른 값이 회의마다 넘어온다. 넘어오지 않으면 .env 값이다.
  let sessionSlideTextBackend = config.slideTextBackend;
  // 슬라이드 전사와 수치 해설 근거가 OCR 클라이언트 하나를 같이 써서, 서비스가 응답하지 않을 때의 건너뛰기 상태를 나눈다.
  const ocrClient = createOcrClient({ config });
  // 발화 ROI 가 켜져 있으면 전환 JPEG 하나로 전사(백엔드 ocr)와 위치 사전이 /ocr 한 번의 결과를 같이 쓴다. 꺼져 있으면 지금 클라이언트 그대로다.
  const sharedOcrClient = config.speechRoiMode === SPEECH_ROI_MODE_MAP.on ? createSharedOcrClient({ ocrClient }) : ocrClient;
  const slideTextAgent = createSlideTextAgent({
    config, ocrClient: sharedOcrClient, getBackend: () => sessionSlideTextBackend,
  });
  // 그래프 어림(세로 막대)은 수치 해설 때 근거 OCR 줄과 같은 프레임 화소로 한다. log 는 기록만 남기고, on 은 수치 에이전트와 값 검사에도 쓴다.
  const chartEstimator = config.chartEstimateMode === CHART_ESTIMATE_MODE_MAP.off ? null : createChartEstimator({
    decoder: createFrameDecoder({ nativeImage: resolveNativeImage() }),
    saveFrame: createChartFrameSaver({ dir: CHART_FRAMES_DIR }).save,
  });
  const isChartEstimateInPrompt = config.chartEstimateMode === CHART_ESTIMATE_MODE_MAP.on;
  console.log(`[pipeline] 그래프 어림: ${config.chartEstimateMode}`);
  // 발화로 ROI 잡기: 새 슬라이드마다 줄 위치를 뽑아 두고(전환 때), 해설 순간 발화 낱말과 맞춰 확대 그림을 둘째 장으로 붙인다.
  const frameImageOps = createFrameImageOps();
  const slideLayoutStore = createSlideLayoutStore({
    recognize: sharedOcrClient.recognize, imageOps: frameImageOps,
    onSettled: ({ slideLabel, status, reason, lineCount, errorMessage, elapsedMs }) => markDebug({
      stage: DEBUG_STAGE_MAP.slide, verdict: status === 'failed' ? DEBUG_VERDICT_MAP.fail : DEBUG_VERDICT_MAP.info,
      reason: `발화 ROI 위치 사전 ${status}`,
      detail: `슬라이드=${slideLabel} 줄=${lineCount}${reason ? ` 까닭=${reason}` : ''} ${elapsedMs}ms${errorMessage ? ` · ${errorMessage}` : ''}`,
    }),
  });
  const speechRoi = createSpeechRoiResolver({ config, tokenizer: kiwiTokenizer, layoutStore: slideLayoutStore, imageOps: frameImageOps });
  console.log(`[pipeline] 발화 ROI: ${config.speechRoiMode}${speechRoi.isEnabled()
    ? ` (유형 ${config.speechRoiTypeList.join(',')} · 지시 OCR ${config.isSpeechRoiFrameOcrEnabled ? 'on' : 'off'}`
      + ` · 가리킴 짝 ${config.isSpeechRoiPointingPairEnabled ? 'on' : 'off'})` : ''}`);
  // 수치·척도 해설 근거 OCR 은 「화면 글자 읽기」 설정과 상관없이 돈다(그 설정은 슬라이드 전사 엔진만 고른다).
  const screenTextGrounding = createScreenTextGrounding({
    ocrClient, isEnabled: () => config.isScreenTextGroundingEnabled, chartEstimator,
  });
  ipcMain.handle('pipeline-slide-text-backend-default', async () => ({ backend: config.slideTextBackend }));
  // 장마다 전사를 읽은 엔진(ocr·vlm). 사실 카드 값 검증 기록에 대조 원본으로 남긴다.
  const slideTextSourceMap = new Map();
  const slideTextStore = createSlideTextStore({
    transcribe: ({ jpegBuffer }) => slideTextAgent.transcribe({ jpegBuffer }),
    onSettled: ({ slideLabel, status, textLength, errorMessage, source, fallbackReason, lineCount, elapsedMs }) => {
      slideTextSourceMap.set(slideLabel, source || null);
      markDebug({
        stage: DEBUG_STAGE_MAP.valueCheck,
        verdict: status === 'failed' ? DEBUG_VERDICT_MAP.fail : DEBUG_VERDICT_MAP.info,
        reason: `슬라이드 텍스트 전사 ${status}`,
        detail: `슬라이드=${slideLabel} 글자수=${textLength} 출처=${source || '-'}`
          + `${fallbackReason ? ` 넘김=${fallbackReason}` : ''} 줄=${lineCount} ${elapsedMs}ms`
          + `${errorMessage ? ` · ${errorMessage}` : ''}`,
      });
      contextStore.applySlideText({
        slideLabel, status, text: slideTextStore.get(slideLabel).text,
      });
      labelReadySlides();
    },
  });
  // 화면 사실 카드(SEEON_FACT_CARD). 새 장의 전사와 나란히 VLM 한 번으로 만들고, 카드의 숫자는 그 전사 글자로 검증한다.
  // 해설 순간에는 만들어 둔 카드에서 고르기만 하고 VLM 을 더 부르지 않는다.
  const factCardAgent = createFactCardAgent({ config });
  const factCardTokenizer = createFactCardTokenizer({ kiwiTokenizer });
  const factCardStore = createFactCardStore({
    build: ({ jpegBuffer }) => factCardAgent.build({ jpegBuffer }),
    slideTextStore,
    readSlideTextSource: (major) => slideTextSourceMap.get(major) ?? null,
    isEnabled: () => config.isFactCardEnabled,
    onSettled: ({ slideLabel, status, frameTs, isRetry, screenTitle, cardList, verify, elapsedMs, queuedMs,
      rawLength, jsonMode, isTruncated, errorMessage }) => {
      appendRecord({
        kind: RECORD_KIND_MAP.factSheet, ts: Date.now(), slideLabel, status, frameTs, isRetry, screenTitle, cardList,
        verify, elapsedMs, queuedMs, jsonMode, rawLength, isTruncated, ...(errorMessage ? { errorMessage } : {}),
      }).catch(() => {});
      markDebug({
        stage: DEBUG_STAGE_MAP.context,
        verdict: status === FACT_CARD_STATUS_MAP.failed ? DEBUG_VERDICT_MAP.fail : DEBUG_VERDICT_MAP.info,
        reason: `슬라이드 ${slideLabel} 사실 카드 ${status}${isRetry ? '(복귀 재시도)' : ''}`,
        detail: `${cardList.length}장 [${cardList.map((card) => card.title || card.kind || '-').join(', ')}]`
          + ` 생성 ${elapsedMs ?? '-'}ms 대기 ${queuedMs ?? '-'}ms`
          + `${verify ? ` · 값 검증 ${verify.source} 비움 ${verify.droppedValueCount}/${verify.checkedValueCount}` : ''}`
          + `${isTruncated ? ' · 출력 상한에서 잘림' : ''}${errorMessage ? ` · ${errorMessage}` : ''}`,
      });
    },
  });
  // 같은 슬라이드 안 화면 변화 해설과 늦은 근거 재시도. SEEON_SCREEN_CHANGE=off(기본)이면 아무것도 하지 않는다.
  const screenChange = createScreenChangeService({
    config, agentFieldMap, ocrClient, narrationHistory, describedStore, captionDescribed, slideTextStore,
    sendCaption, appendRecord, markDebug, getCaptionLanguage,
  });

  async function sendCaption({ ts, text, source, slideLabel = null, isDedupeExempt = false,
    rationale = null, slotMap = null, hasPointingRegion = false,
    narrationClass = null, eventVideoTimeMs = null }) {
    if (!narrationClass) {
      markDebug({
        stage: DEBUG_STAGE_MAP.session, verdict: DEBUG_VERDICT_MAP.fail, narrationType: source, ts,
        reason: '재생 분류 누락 — deixis 로 취급', detail: `source=${source} "${text}"`,
      });
    }
    const resolvedClass = narrationClass || NARRATION_CLASS_MAP.deixis;
    // 사용자가 끈 분류(C15)는 맥락 저장소 기록만 남기고 TTS·재생을 하지 않는다. 재생되지 않았으므로 해설 목록에도 들어가지 않는다.
    if (!featureGate.isEnabled(resolvedClass)) {
      captionDescribed.revert({ ts, text });
      await appendRecord({
        kind: RECORD_KIND_MAP.narration, ts, source, text, slideLabel, isEmitted: false,
        skipReason: 'feature_off', narrationClass: resolvedClass,
      });
      console.log(`[pipeline]   기능 꺼짐 [${resolvedClass}] "${truncateForLog(text)}"`);
      markDebug({
        stage: DEBUG_STAGE_MAP.toggle, verdict: DEBUG_VERDICT_MAP.skip, narrationType: source, ts,
        reason: '기능 꺼짐 — 캡션 내보내지 않음', detail: `분류=${resolvedClass} "${text}"`,
      });
      return { isEmitted: false, reason: 'feature_off' };
    }
    // 간격 억제: 어느 분류가 어느 분류를 얼마 동안 막는지는 orchestrator/blocking-policy.js 표가 정한다.
    const rate = narrationHistory.findRateLimited({ narrationClass: resolvedClass, ts, hasPointingRegion });
    if (rate.isRateLimited) {
      const blockingRelation = readBlockingRelation({
        narrationClass: resolvedClass, blockedByClass: rate.blockedByClass,
      });
      const blockedByLabel = NARRATION_CLASS_LABEL_MAP[rate.blockedByClass];
      const relationLabel = BLOCKING_RELATION_LABEL_MAP[blockingRelation];
      const sinceSec = Math.round(rate.sinceMs / 1000);
      await appendRecord({
        kind: RECORD_KIND_MAP.narration, ts, source, text, slideLabel, isEmitted: false,
        skipReason: 'rate-limited', narrationClass: resolvedClass, blockedByClass: rate.blockedByClass,
        blockingRelation, sinceMs: rate.sinceMs, minIntervalMs: rate.minIntervalMs,
      });
      console.log(`[pipeline]   간격 억제 [${resolvedClass}] "${truncateForLog(text)}"`
        + ` ← 직전 ${blockedByLabel} 해설(${relationLabel}) ${sinceSec}초 < ${rate.minIntervalMs / 1000}초`);
      // 기록을 읽는 도구가 reason '간격 억제' 를 그대로 대조하므로 reason 은 두고, 막은 분류·관계는 detail 에 적는다.
      markDebug({
        stage: DEBUG_STAGE_MAP.dedupe, verdict: DEBUG_VERDICT_MAP.skip, narrationType: source, ts,
        reason: '간격 억제',
        detail: `"${text}" — 직전 ${blockedByLabel} 해설(${relationLabel})과 ${sinceSec}초 간격`
          + ` (최소 ${rate.minIntervalMs / 1000}초 · ${NARRATION_CLASS_LABEL_MAP[resolvedClass] || resolvedClass}`
          + `${hasPointingRegion ? ', 필기 있음' : ''})`,
      });
      return { isEmitted: false, reason: 'rate-limited' };
    }
    const duplicate = isDedupeExempt
      ? { isDuplicate: false, matchedText: '', similarity: 0, reason: '', threshold: 0 }
      : narrationHistory.findDuplicate({ text, source, slotMap, slideLabel });
    if (duplicate.isDuplicate) {
      await appendRecord({
        kind: RECORD_KIND_MAP.narration, ts, source, text, slideLabel, isEmitted: false,
        skipReason: `duplicate:${duplicate.reason}`,
        matchedText: duplicate.matchedText, similarity: Number(duplicate.similarity.toFixed(3)),
      });
      console.log(`[pipeline]   중복 내레이션 억제 [${source}] "${truncateForLog(text)}" ≈ "${truncateForLog(duplicate.matchedText)}"`);
      markDebug({
        stage: DEBUG_STAGE_MAP.dedupe, verdict: DEBUG_VERDICT_MAP.skip, narrationType: source, ts,
        reason: `중복(${duplicate.reason})`,
        detail: `"${text}" ≈ 기존 "${duplicate.matchedText}"`
          + ` (유사도 ${duplicate.similarity.toFixed(2)} ≥ 임계 ${duplicate.threshold})`,
      });
      return { isEmitted: false, reason: `duplicate:${duplicate.reason}` };
    }
    narrationHistory.remember({ text, source, ts, slotMap, slideLabel, narrationClass: resolvedClass });
    // Orchestrator 의 main 단계는 여기까지다(기능 끄기 → 차단 규칙 → 중복). 렌더러의 우선순위 대기 줄이 재생할 해설을 고르면
    // 그때 pipeline-tts 로 합성한다(Orchestrator → TTS → 전달 Layer). 대기 줄에서 버려지는 해설은 합성하지 않는다.
    await appendRecord({
      kind: RECORD_KIND_MAP.narration, ts, source, text, slideLabel, isEmitted: true,
      narrationClass: resolvedClass,
      eventVideoTimeMs: Number.isFinite(eventVideoTimeMs) ? eventVideoTimeMs : null,
    });
    sendPipelineEvent({
      type: 'caption', ts, text, source, slideLabel, rationale,
      narrationClass: resolvedClass,
      eventVideoTimeMs: Number.isFinite(eventVideoTimeMs) ? eventVideoTimeMs : null,
    });
    return { isEmitted: true };
  }

  // 전달 Layer 앞의 TTS. 렌더러 대기 줄이 이번에 재생할 해설로 고른 것만 합성한다.
  ipcMain.handle('pipeline-tts', async (_event, { ts = Date.now(), text = '', source = null } = {}) => {
    try {
      const wavData = await ttsClient.synthesize({ text, language: getCaptionLanguage() });
      await appendRecord({ kind: RECORD_KIND_MAP.tts, ts, byteLength: wavData.byteLength });
      markDebug({
        stage: DEBUG_STAGE_MAP.tts, verdict: DEBUG_VERDICT_MAP.pass, narrationType: source, ts,
        reason: '합성 완료', detail: `${Math.round(wavData.byteLength / 1024)}KB · "${text}"`,
      });
      return { isOk: true, wavData };
    } catch (ttsError) {
      console.warn(`[pipeline]   TTS 실패(소리 없이 넘어감) [${source}]: ${ttsError.message}`);
      markDebug({
        stage: DEBUG_STAGE_MAP.tts, verdict: DEBUG_VERDICT_MAP.fail, narrationType: source, ts,
        reason: 'TTS 실패(소리 없이 넘어감)', detail: ttsError.message,
      });
      return { isOk: false, message: ttsError.message };
    }
  });

  ipcMain.handle('pipeline-session-start', async (_event, {
    mode = '', asrLanguage, captionLanguage, slideTextBackend, isMeetingSummaryEnabled,
  } = {}) => {
    describedStore.reset();
    captionDescribed.reset();
    screenRegistry.reset();
    slideTopicRegistry.reset();
    speakerRegistry.reset();
    narrationHistory.reset();
    silenceGate.reset();
    slideTextStore.reset();
    factCardStore.reset();
    slideTextSourceMap.clear();
    slideLayoutStore.reset();
    boundaryTrigger.reset();
    screenChange.reset();
    const meetingLanguage = applySessionMeetingLanguage({ asrLanguageSession, asrLanguage });
    sessionSlideTextBackend = resolveSlideTextBackend({ requested: slideTextBackend, fallback: config.slideTextBackend });
    sessionCaptionLanguage = resolveCaptionLanguage(captionLanguage);
    const { sessionId } = sessionStore.startSession({ mode, asrLanguage: meetingLanguage, captionLanguage: sessionCaptionLanguage });
    devFlow.recorder.start({ sessionId, mode });
    contextGeneration += 1;
    segmentSummaryScheduler.reset();
    isSessionMeetingSummaryEnabled = isMeetingSummaryEnabled !== false;
    contextStore.start({ sessionId, startedAt: Date.now() });
    startSegmentSummaryTimer();
    console.log(`[pipeline] ■ 캡처 세션 시작 (모드=${mode}, 받아쓰기=${meetingLanguage}, 캡션 언어=${sessionCaptionLanguage}, 화면 글자=${sessionSlideTextBackend}, 화면 변화=${screenChange.describeSessionText()}, ${sessionId}) — 중복 이력·화면 레지스트리 초기화`);
    markDebug({
      stage: DEBUG_STAGE_MAP.session, verdict: DEBUG_VERDICT_MAP.info,
      reason: '세션 시작', detail: `모드=${mode} · 받아쓰기=${meetingLanguage} · 캡션 언어=${sessionCaptionLanguage} · 화면 글자=${sessionSlideTextBackend} · 화면 변화=${screenChange.describeSessionText()} · ${sessionId} · 기록=${recordStore.filePath}`,
    });
    if (speechRoi.isEnabled()) {
      markDebug({
        stage: DEBUG_STAGE_MAP.session, verdict: DEBUG_VERDICT_MAP.info, reason: '발화 ROI 켜짐',
        detail: `유형=${config.speechRoiTypeList.join(',')} · 지시 OCR=${config.isSpeechRoiFrameOcrEnabled ? 'on' : 'off'}`
          + ` · 가리킴 짝=${config.isSpeechRoiPointingPairEnabled ? 'on' : 'off'}`,
      });
    }

    return {
      isOk: true, sessionId, recordPath: recordStore.filePath, gapSource: config.gapSource,
      screenChange: screenChange.describeSession(),
    };
  });

  ipcMain.handle('pipeline-session-end', async () => {
    const sessionId = sessionStore.getCurrentSessionId();
    if (!sessionId) return { isOk: false, message: '진행 중인 세션이 없습니다' };
    const drainedCount = await drainPendingAsr();

    const sessionEndEntry = {
      ts: Date.now(), stage: DEBUG_STAGE_MAP.session, verdict: DEBUG_VERDICT_MAP.info,
      reason: '세션 종료', detail: `${sessionId} · ASR 드레인 ${drainedCount}건`, narrationType: null,
    };
    await appendRecord({ kind: RECORD_KIND_MAP.debug, ...sessionEndEntry });
    devFlow.recorder.addDebug(sessionEndEntry);
    devFlow.recorder.markEnded();

    lastSession = sessionStore.endSession({ endedAt: Date.now() });
    // 구간 요약을 멈추고 돌고 있던 요청의 응답은 버린다. ready 가 아닌 구간은 회의 뒤 생성기가 다시 만든다.
    stopSegmentSummaryTimer();
    segmentSummaryScheduler.stop();
    lastContextSnapshot = contextStore.snapshot();
    const contextFilePath = await contextFile.flush();
    console.log(`[context] 컨텍스트 저장 ${contextFilePath || '(실패)'} — 슬라이드 ${lastContextSnapshot.slideList.length}장 · 발화 ${lastContextSnapshot.utteranceList.length}건`);
    const scriptFilePath = await contextFile.writeText({
      fileName: buildScriptFileName({ sessionId }), text: buildTranscriptScript({ snapshot: lastContextSnapshot }),
    });
    console.log(`[context] 대화 스크립트 ${scriptFilePath || '(실패)'}`);
    // 사용자 문서 폴더의 회의 기록. 실패해도 회의 종료는 계속한다.
    // 대화 스크립트는 발화·화자·질문답만 담은 전문이고, 질문·답 이름표는 그 회의 캡션 언어로 적는다.
    const archiveDir = await meetingArchive?.saveScript({
      sessionId, startedAt: lastSession.startedAt, endedAt: lastSession.endedAt,
      title: pickMeetingTitle({ snapshot: lastContextSnapshot }),
      slideCount: lastContextSnapshot.slideList.length, utteranceCount: lastContextSnapshot.utteranceList.length,
      scriptText: buildFullTranscript({ snapshot: lastContextSnapshot, language: lastSession.captionLanguage }),
    }).catch((error) => {
      console.warn(`[archive] 회의 기록 저장 실패(무시): ${error.message}`);
      return null;
    });
    if (archiveDir) console.log(`[archive] 회의 기록 ${archiveDir}`);
    console.log(`[pipeline] ■ 캡처 세션 종료 (${sessionId}) — 발화 ${lastSession.asrEntryList.length}건 · 슬라이드 마크 ${lastSession.slideMarkList.length}건`);
    return {
      isOk: true,
      sessionId,
      asrCount: lastSession.asrEntryList.length,
      slideMarkCount: lastSession.slideMarkList.length,
    };
  });

  // 회의 중에 회의 요약 스위치를 끄면 구간 요약도 멈추고, 켜면 다음 확인부터 다시 한다.
  ipcMain.handle('pipeline-set-meeting-summary-enabled', async (_event, { isEnabled } = {}) => {
    isSessionMeetingSummaryEnabled = isEnabled !== false;
    return { isOk: true };
  });

  ipcMain.on('pipeline-slide-mark', (_event, { ts, slideLabel, frameKind, filePath, transitionTs = null }) => {
    appendRecord({
      kind: RECORD_KIND_MAP.slideMark, ts, slideLabel, frameKind, filePath, transitionTs,
    }).catch(() => {});
  });

  ipcMain.handle('pipeline-frame', async (_event, { ts, buffer, slideLabel, wordBudget, isRevisit, eventVideoTimeMs = null }) => {
    let stage = PIPELINE_STAGE_MAP.vlm;
    const startedAt = Date.now();
    describedStore.setCurrentSlide(slideLabel);
    console.log(`[pipeline] ▶ 전환 프레임 ts=${ts} slide=${slideLabel}${isRevisit ? ' (복귀)' : ''} (${Math.round(buffer.byteLength / 1024)}KB)`);
    // 건너뛰었거나 실패한 사실 카드는 그 장으로 돌아와 체류가 확정된 프레임으로 한 번만 다시 만든다(저장소가 상태·횟수를 본다).
    if (isRevisit && config.isFactCardEnabled) {
      factCardStore.ensure({ slideLabel, jpegBuffer: Buffer.from(buffer), isRetry: true });
    }
    try {
      const result = await agentFieldMap[NARRATION_TYPE_MAP.pageTransition].generate({
        jpegBuffer: Buffer.from(buffer), ts,
        minWordCount: wordBudget?.minWordCount, maxWordCount: wordBudget?.maxWordCount,
      });

      const verdict = screenRegistry.judgeAnnouncement({
        screenType: result.screenType, title: result.pageTopic,
      });
      if (!verdict.shouldAnnounce) {
        await appendRecord({
          kind: RECORD_KIND_MAP.pageTransition, ts, slideLabel, screenType: result.screenType,
          narration: '', skipReason: verdict.reason,
        });
        console.log(`[pipeline]   전환 고지 스킵 (${Date.now() - startedAt}ms) [${result.screenType}] → ${verdict.reason}`);
        markDebug({
          stage: DEBUG_STAGE_MAP.screen, verdict: DEBUG_VERDICT_MAP.skip, ts,
          narrationType: NARRATION_TYPE_MAP.pageTransition,
          reason: verdict.reason, detail: `화면유형=${result.screenType} 슬라이드=${slideLabel}`,
        });
        return { isOk: true, narration: '', isEmitted: false };
      }
      markDebug({
        stage: DEBUG_STAGE_MAP.screen, verdict: DEBUG_VERDICT_MAP.pass, ts,
        narrationType: NARRATION_TYPE_MAP.pageTransition,
        reason: verdict.reason,
        detail: `화면유형=${result.screenType} 주제="${result.pageTopic}" 사진단독=${result.isPhotoOnly}`,
      });
      const isSlideScreen = result.screenType === SCREEN_TYPE_MAP.ppt;

      const topicVerdict = slideTopicRegistry.judge({
        topic: result.pageTopic, description: result.description,
      });
      const topicDetail = `주제="${result.pageTopic}" 주제유사도=${topicVerdict.similarity.toFixed(3)}`
        + ` 묘사유사도=${topicVerdict.descriptionSimilarity.toFixed(3)} 최근접="${topicVerdict.matchedTopic}"`;
      if (topicVerdict.kind === SLIDE_TOPIC_VERDICT_MAP.same) {
        await appendRecord({
          kind: RECORD_KIND_MAP.pageTransition, ts, slideLabel, screenType: result.screenType,
          narration: '', skipReason: 'same_topic', topicSimilarity: topicVerdict.similarity,
          descriptionSimilarity: topicVerdict.descriptionSimilarity,
          pageTopic: result.pageTopic, description: result.description,
        });
        console.log(`[pipeline]   같은 화면 재검출 — 고지하지 않음 (${topicDetail})`);
        markDebug({
          stage: DEBUG_STAGE_MAP.screen, verdict: DEBUG_VERDICT_MAP.skip, ts,
          narrationType: NARRATION_TYPE_MAP.pageTransition,
          reason: '직전과 같은 화면 — 고지하지 않음', detail: topicDetail,
        });
        return { isOk: true, narration: '', isEmitted: false };
      }
      const isRevisitFinal = topicVerdict.kind === SLIDE_TOPIC_VERDICT_MAP.revisit;
      const visiblePageNumber = Number.isFinite(result.pageNumber) && result.pageNumber > 0
        ? Number(result.pageNumber) : null;
      const slideEntry = slideTopicRegistry.remember({
        topic: result.pageTopic, description: result.description, pageNumber: visiblePageNumber,
        isSlide: isSlideScreen,
      });
      // 임베딩 라벨(slideLabel)은 OS 화면까지 세는 내부 번호라 들려주는 번호로 쓰지 않는다. 들려주는 번호는 PPT 에만 있다.
      const displayNumber = resolveHeardSlideNumber({
        isSlide: isSlideScreen, registryNumber: slideTopicRegistry.resolveDisplayNumber({ entry: slideEntry }), visiblePageNumber,
      });
      markDebug({
        stage: DEBUG_STAGE_MAP.slide, verdict: DEBUG_VERDICT_MAP.info, ts,
        narrationType: NARRATION_TYPE_MAP.pageTransition,
        reason: `주제 판정 ${topicVerdict.kind}`,
        detail: `${topicDetail} 번호=${displayNumber ?? '-'}`
          + `(${visiblePageNumber ? '화면표기' : '안내순서'}) 임베딩라벨=${slideLabel}`
          + (isRevisit && !isRevisitFinal ? ' · 임베딩 복귀 판정을 주제로 뒤집음' : ''),
      });

      if (isRevisitFinal) {
        const revisitNarration = buildRevisitNarration({
          isSlide: isSlideScreen, displayNumber, topic: result.pageTopic || result.narration, language: getCaptionLanguage(),
        });
        await appendRecord({
          kind: RECORD_KIND_MAP.pageTransition, ts, slideLabel, screenType: result.screenType,
          narration: revisitNarration, isRevisit: true, displayNumber,
        });
        console.log(`[pipeline]   복귀 축약 고지 (${Date.now() - startedAt}ms) "${truncateForLog(revisitNarration)}"`);
        const revisitSent = await sendCaption({
          ts, text: revisitNarration, source: 'page-transition', slideLabel,
          narrationClass: NARRATION_CLASS_MAP.pageTransition, eventVideoTimeMs,
          rationale: {
            subKind: result.subKind,
            summary: `이전 화면으로 복귀 · 화면유형=${result.screenType} 슬라이드=${slideLabel}`,
          },
        });
        return { isOk: true, narration: revisitNarration, isEmitted: revisitSent.isEmitted };
      }
      if (!result.narration) {
        await appendRecord({
          kind: RECORD_KIND_MAP.pageTransition, ts, slideLabel, screenType: result.screenType,
          narration: '', skipReason: result.rejectedReason === 'han' ? 'han_character' : 'incomplete_description',
          rejectedDescription: result.rejectedDescription,
          rejectedRawDescription: result.rejectedRawDescription,
          displayNumber, pageNumber: result.pageNumber, pageTopic: result.pageTopic,
        });
        console.log(`[pipeline]   묘사 미완결 드롭 [${result.screenType}] 절삭후="${result.rejectedDescription}" 원문="${result.rejectedRawDescription}"`);
        markDebug({
          stage: DEBUG_STAGE_MAP.vlm, verdict: DEBUG_VERDICT_MAP.skip, ts,
          narrationType: NARRATION_TYPE_MAP.pageTransition,
          reason: result.rejectedReason === 'han' ? '묘사에 한자가 섞여 고지하지 않음' : '묘사가 완결되지 않아 고지하지 않음',
          detail: `화면유형=${result.screenType} 슬라이드=${slideLabel} 절삭후="${result.rejectedDescription}" 원문="${result.rejectedRawDescription}"`,
        });
        return { isOk: true, narration: '', isEmitted: false };
      }
      // 고지를 끈 상태면 사용자가 듣지 못한 요소이므로 지시 해설이 "이미 설명함"으로 건너뛰지 않게 등록하지 않는다.
      const isTransitionEnabled = featureGate.isEnabled(NARRATION_CLASS_MAP.pageTransition);
      const narration = buildTransitionNarration({
        isSlide: isSlideScreen, displayNumber, narration: result.narration, language: getCaptionLanguage(),
      });
      if (isTransitionEnabled) {
        captionDescribed.add({ ts, text: narration, slideLabel, elementList: result.describedElementList });
      }
      await appendRecord({
        kind: RECORD_KIND_MAP.pageTransition, ts, slideLabel, screenType: result.screenType,
        narration, describedElementList: result.describedElementList,
        pageNumber: result.pageNumber, pageTopic: result.pageTopic, description: result.description,
        displayNumber,
      });
      console.log(`[pipeline]   전환 내레이션 (${Date.now() - startedAt}ms) [${result.screenType}] "${truncateForLog(narration)}"`);
      markDebug({
        stage: DEBUG_STAGE_MAP.vlm, verdict: DEBUG_VERDICT_MAP.pass, ts,
        narrationType: NARRATION_TYPE_MAP.pageTransition,
        reason: result.isRetried ? '전환 내레이션 생성(묘사가 길어 다시 물음)' : '전환 내레이션 생성',
        detail: `"${narration}" (${Date.now() - startedAt}ms, 묘사="${result.description}")`,
      });
      const sent = await sendCaption({
        ts, text: narration, source: 'page-transition', slideLabel,
        narrationClass: NARRATION_CLASS_MAP.pageTransition, eventVideoTimeMs,
        rationale: {
          subKind: result.subKind,
          summary: `화면 전환 감지 · 화면유형=${result.screenType} 주제="${result.pageTopic}"`,
        },
      });

      if (result.isPhotoOnly) {
        try {
          const visual = await agentFieldMap[NARRATION_TYPE_MAP.visualDescription].generate({
            jpegBuffer: Buffer.from(buffer),
            subKind: VISUAL_DESCRIPTION_KIND_MAP.reaction,
            minWordCount: wordBudget?.minWordCount, maxWordCount: wordBudget?.maxWordCount,
            describedElementList: describedStore.getDescribed(slideLabel),
          });
          if (visual.isGrounded && visual.text) {
            // 사진 묘사 생성 중에 고지를 껐을 수 있어 등록할 때 다시 확인한다.
            if (featureGate.isEnabled(NARRATION_CLASS_MAP.pageTransition)) {
              captionDescribed.add({ ts, text: visual.text, slideLabel, elementList: [visual.text] });
            }
            await appendRecord({
              kind: RECORD_KIND_MAP.deixis, ts, utterance: '', caption: visual.text, isGrounded: true,
              slideLabel, narrationType: NARRATION_TYPE_MAP.visualDescription,
              subKind: VISUAL_DESCRIPTION_KIND_MAP.reaction,
            });
            console.log(`[pipeline]   사진 단독 화면 묘사(페이지 전환) "${truncateForLog(visual.text)}"`);
            markDebug({
              stage: DEBUG_STAGE_MAP.vlm, verdict: DEBUG_VERDICT_MAP.pass, ts,
              narrationType: NARRATION_TYPE_MAP.visualDescription,
              reason: '사진 단독 화면 묘사(페이지 전환) 생성', detail: `"${visual.text}"`,
            });
            await sendCaption({
              ts, text: visual.text, source: NARRATION_TYPE_MAP.visualDescription, slideLabel,
              narrationClass: NARRATION_CLASS_MAP.pageTransition, eventVideoTimeMs,
              rationale: {
                subKind: VISUAL_DESCRIPTION_KIND_MAP.reaction,
                summary: '사진이 단독으로 제시된 화면 (전환 고지에 이어지는 묘사)',
              },
            });
          } else {
            markDebug({
              stage: DEBUG_STAGE_MAP.vlm, verdict: DEBUG_VERDICT_MAP.skip, ts,
              narrationType: NARRATION_TYPE_MAP.visualDescription,
              reason: '사진 단독 화면 묘사(페이지 전환) — 묘사할 것 없음', detail: `슬라이드=${slideLabel}`,
            });
          }
        } catch (visualError) {
          console.warn(`[pipeline]   사진 단독 화면 묘사(페이지 전환) 실패(무시): ${visualError.message}`);
          markDebug({
            stage: DEBUG_STAGE_MAP.vlm, verdict: DEBUG_VERDICT_MAP.fail, ts,
            narrationType: NARRATION_TYPE_MAP.visualDescription,
            reason: '사진 단독 화면 묘사(페이지 전환) 생성 실패(무시)', detail: visualError.message,
          });
        }
      }
      return { isOk: true, narration, isEmitted: sent.isEmitted };
    } catch (error) {
      console.error(`[pipeline] ✖ 전환 내레이션 실패 ts=${ts}: ${error.message}`);
      await appendErrorRecordSafely({
        appendRecord, record: { kind: RECORD_KIND_MAP.error, ts, stage, message: error.message },
      });
      markDebug({
        stage: DEBUG_STAGE_MAP.vlm, verdict: DEBUG_VERDICT_MAP.fail, ts,
        narrationType: NARRATION_TYPE_MAP.pageTransition,
        reason: '전환 내레이션 실패', detail: `${stage}: ${error.message}`,
      });
      return { isOk: false, message: error.message };
    }
  });

  ipcMain.handle('pipeline-screen-change', async (_event, payload) => screenChange.handleChange(payload));
  ipcMain.handle('pipeline-screen-change-baseline', async (_event, payload) => screenChange.handleBaseline(payload));

  ipcMain.handle('pipeline-slide-text', async (_event, { slideLabel, buffer }) => {
    const jpegBuffer = Buffer.from(buffer);
    const isStarted = slideTextStore.ensure({ slideLabel, jpegBuffer });
    // 사실 카드는 같은 그림으로 전사와 나란히 만든다(카드 쪽이 한 번에 하나, 밀리면 최신 장만).
    if (config.isFactCardEnabled) factCardStore.ensure({ slideLabel, jpegBuffer });
    // 발화 ROI 가 켜져 있으면 같은 전환 JPEG 의 줄 위치를 뽑아 둔다(해설 경로 밖, 새 장마다 한 번).
    if (speechRoi.isEnabled()) slideLayoutStore.ensure({ slideLabel, jpegBuffer });
    return { isOk: true, isStarted };
  });

  ipcMain.handle('embed-frame', async (_event, { buffer }) => {
    try {
      const embedding = await embedClient.embedFrame({ jpegBuffer: Buffer.from(buffer) });
      return { isOk: true, embedding };
    } catch (error) {
      return { isOk: false, message: error.message };
    }
  });

  ipcMain.handle('pipeline-speaker', async (_event, {
    ts, buffer, wordBudget, source = SPEAKER_SOURCE_MAP.vlm,
    speakerName = '', position = '', participantId = '', eventVideoTimeMs = null,
  }) => {
    const stage = PIPELINE_STAGE_MAP.vlm;
    const startedAt = Date.now();
    try {
      const isDomPath = source === SPEAKER_SOURCE_MAP.dom;
      const result = isDomPath
        ? buildSpeakerIdentityFromDom({ speakerName, position, participantId, language: getCaptionLanguage() })
        : await agentFieldMap[NARRATION_TYPE_MAP.speakerIdentity].generate({
          jpegBuffer: Buffer.from(buffer),
          minWordCount: wordBudget?.minWordCount, maxWordCount: wordBudget?.maxWordCount,
        });
      if (!result.isGrounded) {
        markDebug({
          stage: DEBUG_STAGE_MAP.speaker, verdict: DEBUG_VERDICT_MAP.skip, ts,
          narrationType: NARRATION_TYPE_MAP.speakerIdentity,
          reason: 'NONE — 강조된 타일 없음/확신 없음',
          detail: `src=${source} ${Date.now() - startedAt}ms`,
        });
        return { isOk: true, isAnnounced: false, speakerName: '' };
      }

      const verdict = speakerRegistry.judgeAnnouncement({ speakerKey: result.speakerKey, ts });
      await appendRecord({
        kind: RECORD_KIND_MAP.speakerIdentity, ts, narration: result.text,
        speakerKey: result.speakerKey, subKind: result.subKind, speakerSource: source,
        isEmitted: verdict.shouldAnnounce, skipReason: verdict.shouldAnnounce ? '' : verdict.reason,
      });
      if (!verdict.shouldAnnounce) {
        markDebug({
          stage: DEBUG_STAGE_MAP.speaker, verdict: DEBUG_VERDICT_MAP.skip, ts,
          narrationType: NARRATION_TYPE_MAP.speakerIdentity,
          reason: `고지 안 함 (${verdict.reason})`,
          detail: `발화자=${result.speakerKey} 직전=${verdict.previousSpeakerKey || '-'} src=${source}`,
        });
        return { isOk: true, isAnnounced: false, speakerName: result.speakerName };
      }
      console.log(`[pipeline] 발화자 변경 (${Date.now() - startedAt}ms) ${verdict.previousSpeakerKey || '-'} → ${result.speakerKey} "${truncateForLog(result.text)}"`);
      markDebug({
        stage: DEBUG_STAGE_MAP.speaker, verdict: DEBUG_VERDICT_MAP.pass, ts,
        narrationType: NARRATION_TYPE_MAP.speakerIdentity,
        reason: `발화자 ${verdict.reason}`,
        detail: `"${result.text}" (직전=${verdict.previousSpeakerKey || '-'}, src=${source}, ${Date.now() - startedAt}ms)`,
      });

      const sent = await sendCaption({
        ts, text: result.text, source: NARRATION_TYPE_MAP.speakerIdentity, isDedupeExempt: true,
        narrationClass: NARRATION_CLASS_MAP.speakerIdentity, eventVideoTimeMs,
        rationale: {
          subKind: result.subKind,
          summary: `${isDomPath ? '회의앱 DOM의 발화 표시' : '참가자 타일 테두리 강조'}로 발화자 변경 감지`
            + ` (${verdict.previousSpeakerKey || '없음'} → ${result.speakerKey})`,
        },
      });
      return { isOk: true, isAnnounced: sent.isEmitted, text: result.text, speakerName: result.speakerName };
    } catch (error) {
      console.error(`[pipeline] ✖ 발화자 안내 실패 ts=${ts}: ${error.message}`);
      await appendErrorRecordSafely({
        appendRecord, record: { kind: RECORD_KIND_MAP.error, ts, stage, message: error.message },
      });
      markDebug({
        stage: DEBUG_STAGE_MAP.speaker, verdict: DEBUG_VERDICT_MAP.fail, ts,
        narrationType: NARRATION_TYPE_MAP.speakerIdentity,
        reason: '발화자 안내 실패', detail: `${stage}: ${error.message}`,
      });
      return { isOk: false, message: error.message };
    }
  });

  // 렌더러 재생 대기 줄이 버린 해설(대기 시간 초과·트리거에서 멀어짐·슬라이드 변경·TTS 실패 등). 듣지 못했으므로 중복 억제·재설명 금지 기록을 되돌린다.
  ipcMain.on('pipeline-narration-dropped', (_event, {
    ts, text, slideLabel = null, narrationClass = null, reason = '',
  } = {}) => {
    devFlow.recorder.addRendererDrop({ ts, text, slideLabel, narrationClass, reason });
    const isForgotten = narrationHistory.forget({ ts, text });
    const described = captionDescribed.revert({ ts, text });
    const isContextForgotten = contextStore.forgetNarration({ ts, text });
    // 듣지 못한 화자 안내면 같은 화자를 다음 폴링에서 다시 안내하게 한다.
    if (narrationClass === NARRATION_CLASS_MAP.speakerIdentity) speakerRegistry.reset();
    // 듣지 못한 무발화 해설이면 그 슬라이드의 "이미 냄" 기록을 지운다(슬라이드당 1회·분당 1회).
    if (narrationClass === NARRATION_CLASS_MAP.silenceBased) silenceGate.revert({ slideLabel });
    if (narrationClass === NARRATION_CLASS_MAP.screenChange) screenChange.revert({ slideLabel });
    markDebug({
      stage: DEBUG_STAGE_MAP.queue, verdict: DEBUG_VERDICT_MAP.info, ts,
      reason: '재생 안 된 해설을 중복·재설명 기록에서 지움',
      detail: `"${text}" · 사유=${reason} · 슬라이드 ${slideLabel ?? '-'}`
        + ` · 중복 기록 ${isForgotten ? '지움' : '없음'} · 재설명 금지 ${described ? `${described.elementList.length}개 뺌` : '없음'}`
        + ` · 해설 목록 ${isContextForgotten ? '뺌' : '없음'}`,
    });
  });

  // 체류 3초를 못 채운 화면. 회의 스크립트에서 그 전환 AD 줄과 방문을 뺀다.
  ipcMain.on('pipeline-transition-cancelled', (_event, { slideLabel = null, requestTs = null, transitionTs = null } = {}) => {
    contextStore.cancelTransition({ slideLabel, requestTs, transitionTs });
  });

  ipcMain.handle('pipeline-feature-toggles', async (_event, { disabledClassList = [] } = {}) => {
    const { reenabledClassList } = featureGate.setDisabledClassList(disabledClassList);
    const appliedList = featureGate.getDisabledClassList();
    // 꺼진 동안에도 현재 화자는 기록돼 있어, 다시 켜면 같은 사람이 계속 말할 때 안내가 나오지 않는다.
    if (reenabledClassList.includes(NARRATION_CLASS_MAP.speakerIdentity)) speakerRegistry.reset();
    markDebug({
      stage: DEBUG_STAGE_MAP.toggle, verdict: DEBUG_VERDICT_MAP.info,
      reason: '기능 토글 적용', detail: `꺼진 분류=[${appliedList.join(', ') || '없음'}]`,
    });
    return { isOk: true, disabledClassList: appliedList };
  });

  // 무발화 기반: 발표자가 화면을 보라고 한 뒤 5초 이상 침묵하면 화면을 묘사한다. 애매하면 내지 않는다.
  ipcMain.handle('pipeline-silence', async (_event, {
    ts, buffer, slideLabel, recentTranscript = '', silenceMs = 0, wordBudget = null, eventVideoTimeMs = null,
  }) => {
    const startedAt = Date.now();
    const silenceSec = Math.round(silenceMs / 1000);
    const result = await silenceNarrator.run({
      slideLabel, transcript: recentTranscript, silenceMs,
      describe: () => agentFieldMap[NARRATION_TYPE_MAP.visualDescription].generate({
        jpegBuffer: Buffer.from(buffer), subKind: VISUAL_DESCRIPTION_KIND_MAP.reaction,
        origin: NARRATION_ORIGIN_MAP.silence, recentTranscript,
        minWordCount: wordBudget?.minWordCount, maxWordCount: wordBudget?.maxWordCount,
        describedElementList: describedStore.getDescribed(slideLabel),
      }),
      emit: async ({ text }) => {
        await appendRecord({
          kind: RECORD_KIND_MAP.deixis, ts, utterance: recentTranscript, caption: text, isGrounded: true,
          slideLabel, narrationType: NARRATION_TYPE_MAP.visualDescription,
          subKind: VISUAL_DESCRIPTION_KIND_MAP.reaction, origin: NARRATION_ORIGIN_MAP.silence,
        });
        const sent = await sendCaption({
          ts, text, source: NARRATION_TYPE_MAP.visualDescription, slideLabel,
          narrationClass: NARRATION_CLASS_MAP.silenceBased, eventVideoTimeMs,
          rationale: {
            subKind: VISUAL_DESCRIPTION_KIND_MAP.reaction,
            summary: `발표자가 화면을 보라고 한 뒤 ${silenceSec}초 침묵`,
          },
        });
        if (sent.isEmitted) captionDescribed.add({ ts, text, slideLabel, elementList: [text] });
        return sent;
      },
    });
    const elapsedMs = Date.now() - startedAt;
    const rejectionDetail = result.status === SILENCE_RESULT_MAP.none && !result.rawText
      ? describeAgentRejection(result).detailPrefix : '';
    const transcriptLog = `${rejectionDetail}직전 발화="${truncateForLog(recentTranscript, 80)}" 무음=${silenceSec}초 슬라이드=${slideLabel}`;
    const debugByStatusMap = {
      [SILENCE_RESULT_MAP.gated]: {
        verdict: DEBUG_VERDICT_MAP.skip, reason: SILENCE_GATE_LABEL_MAP[result.reason] || result.reason,
      },
      [SILENCE_RESULT_MAP.blocked]: {
        verdict: DEBUG_VERDICT_MAP.skip, reason: `화면 제시 단서 없음 → 차단 (${result.reason || result.source})`,
      },
      [SILENCE_RESULT_MAP.none]: {
        verdict: DEBUG_VERDICT_MAP.skip,
        reason: result.rawText
          ? `끝이 흐린 묘사 폐기 ("${result.rawText}")` : `묘사할 것 없음 (${describeAgentRejection(result).reason})`,
      },
      [SILENCE_RESULT_MAP.dropped]: { verdict: DEBUG_VERDICT_MAP.skip, reason: '내보내기 억제 (중복·간격)' },
      [SILENCE_RESULT_MAP.emitted]: { verdict: DEBUG_VERDICT_MAP.pass, reason: '무발화 해설 생성' },
      [SILENCE_RESULT_MAP.failed]: { verdict: DEBUG_VERDICT_MAP.fail, reason: `무발화 처리 실패: ${result.reason}` },
    };
    const debug = debugByStatusMap[result.status];
    markDebug({
      stage: DEBUG_STAGE_MAP.silence, verdict: debug.verdict, ts,
      narrationType: NARRATION_TYPE_MAP.visualDescription, reason: debug.reason,
      detail: `${result.text ? `"${result.text}" · ` : ''}${transcriptLog} (${elapsedMs}ms)`,
    });
    if (result.status === SILENCE_RESULT_MAP.emitted) {
      console.log(`[pipeline] 무발화 해설 (${elapsedMs}ms) "${truncateForLog(result.text)}"`);
    }
    return { isOk: result.status !== SILENCE_RESULT_MAP.failed, status: result.status };
  });

  ipcMain.handle('pipeline-audio', async (_event, { startTs, endTs, buffer, speakerHint, isSpeakerTracked = true }) => {
    const stage = PIPELINE_STAGE_MAP.asr;
    const startedAt = Date.now();
    pendingAsrCount += 1;
    try {
      const result = await asrLanguageSession.transcribeMeetingSegment({ webmBuffer: Buffer.from(buffer), startTs });
      const textReadyAt = Date.now();
      await appendRecord({
        kind: RECORD_KIND_MAP.asr, ts: startTs,
        text: result.text, segmentList: result.segmentList, speakerHint, isSpeakerTracked: isSpeakerTracked !== false,
        language: result.requestedLanguage, detectedLanguage: result.language,
        languageProbability: result.languageProbability,
        ...(result.hallucinationText
          ? { skipReason: 'hallucination', hallucinationText: result.hallucinationText } : {}),
      });
      if (result.hallucinationText) {
        console.log(`[pipeline] ASR 환각 차단 "${result.hallucinationText}"`);
      }

      if (result.text) {
        const trigger = boundaryTrigger.detect({ text: result.text, startTs, endTs });
        if (trigger.candidateList.length) {
          markDebug({
            stage: DEBUG_STAGE_MAP.router, verdict: DEBUG_VERDICT_MAP.info, ts: startTs,
            reason: `트리거 후보 ${trigger.candidateList.length}개 (${trigger.analyzer})`
              + `${trigger.boundaryCount ? ` · 경계 트리거 후보 ${trigger.boundaryCount}개(앞 조각 꼬리와 이어 찾음)` : ''}`,
            detail: `${formatTriggerCandidateList(trigger.candidateList)} · 전사="${truncateForLog(result.text, 80)}"`,
          });
        }
        sendPipelineEvent({
          type: 'asr', ts: startTs, endTs, text: result.text, segmentList: result.segmentList,
          triggerCandidateList: trigger.candidateList,
        });
      }

      if (typeof endTs === 'number') {
        const captureToTextMs = textReadyAt - endTs;
        const transcribeMs = textReadyAt - startedAt;
        await appendRecord({
          kind: RECORD_KIND_MAP.latency, ts: startTs,
          segmentMs: endTs - startTs, transcribeMs, captureToTextMs,
        });
        console.log(`[pipeline] ASR 지연 captureToText=${captureToTextMs}ms (전사 ${transcribeMs}ms, 세그먼트 ${endTs - startTs}ms)`);
      }
      console.log(`[pipeline] ASR (${textReadyAt - startedAt}ms) speaker=${speakerHint || '-'} "${truncateForLog(result.text, 40)}"`);
      return { isOk: true };
    } catch (error) {
      console.error(`[pipeline] ✖ asr 실패 ts=${startTs}: ${error.message}`);
      await appendErrorRecordSafely({
        appendRecord, record: { kind: RECORD_KIND_MAP.error, ts: startTs, stage, message: error.message },
      });
      return { isOk: false, message: error.message };
    } finally {
      pendingAsrCount -= 1;
    }
  });

  ipcMain.handle('pipeline-deixis', async (_event, { ts, buffer, fullBuffer = null, utterance, recentTranscript, beforeTranscript, afterTranscript, hasPointingRegion, pointingOrderHint, slideLabel, wordBudgetMap, eventVideoTimeMs = null, triggerCandidateList = [], pointingRect = null, frameTs = null }) => {
    let stage = PIPELINE_STAGE_MAP.judge;
    const startedAt = Date.now();
    const hasAnySpeech = [utterance, beforeTranscript, afterTranscript, recentTranscript]
      .some((text) => typeof text === 'string' && text.trim());
    if (!hasAnySpeech) {
      await appendRecord({
        kind: RECORD_KIND_MAP.deixis, ts, utterance: '', caption: '', isGrounded: false,
        slideLabel, skipReason: 'no-speech-at-all',
      });
      markDebug({
        stage: DEBUG_STAGE_MAP.router, verdict: DEBUG_VERDICT_MAP.skip, ts,
        narrationType: NARRATION_TYPE_MAP.deixis,
        reason: '트리거 발화도 인접 맥락도 없다 — 모사할 말이 없다',
        detail: '2-2는 상황 슬롯을 발화 모사로 채우는 형식이라, 말이 하나도 없으면 상투구밖에 나오지 않는다',
      });
      return { isOk: true, isGrounded: false };
    }
    if (!utterance || !utterance.trim()) {
      await appendRecord({
        kind: RECORD_KIND_MAP.deixis, ts, utterance: '', caption: '', isGrounded: false,
        slideLabel, skipReason: 'no-utterance',
      });
      markDebug({
        stage: DEBUG_STAGE_MAP.router, verdict: DEBUG_VERDICT_MAP.skip, ts,
        narrationType: NARRATION_TYPE_MAP.deixis,
        reason: '트리거 발화 없음 — 포인터만으로는 해설하지 않는다',
        detail: `슬라이드=${slideLabel || '-'}`,
      });
      return { isOk: true, isGrounded: false };
    }

    const describedElementList = [
      ...describedStore.getDescribed(slideLabel),
      ...narrationHistory.getRecentTextList({ limit: RECENT_NARRATION_LIMIT }),
    ];

    const beforeText = typeof beforeTranscript === 'string' ? beforeTranscript : (recentTranscript || '');
    const afterText = typeof afterTranscript === 'string' ? afterTranscript : '';
    try {
      const frameSet = resolveDeixisFrameSet({ buffer, fullBuffer });
      // 수치·척도 해설이 될 수 있는 요청이면 판단 LLM 과 함께 같은 프레임의 OCR 을 시작한다. 수치·척도 해설이 아니면 결과를 버린다.
      // 발화 ROI 의 지시 전용 OCR 스위치가 켜져 있으면 지시 요청에도 시작한다(끝나 있을 때 줄 위치로만 쓰고 프롬프트에는 넣지 않는다).
      const screenTextTask = isRouterMode && (shouldStartScreenTextGrounding({ triggerCandidateList, isScaleEnabled: config.isScaleEnabled })
        || speechRoi.shouldStartFrameOcr())
        ? screenTextGrounding.start({ jpegBuffer: frameSet.screenFrame })
        : null;
      let judgeReason = null;
      let selectedCandidate = null;
      let narrationEventVideoTimeMs = eventVideoTimeMs;
      if (utterance && utterance.trim()) {
        if (isRouterMode) {
          // 트리거가 뽑은 후보 구마다 판단 LLM 이 앞뒤 발화로 공백(O)인지 가린다.
          const routed = await routerClient.route({
            utterance, before: beforeText, after: afterText, candidateList: triggerCandidateList,
          });
          judgeReason = routed.blockedReason;
          markDebug({
            stage: DEBUG_STAGE_MAP.router, ts,
            verdict: routed.candidateList.length ? DEBUG_VERDICT_MAP.pass : DEBUG_VERDICT_MAP.skip,
            reason: `판단 LLM ${routed.judgeList.filter((entry) => entry.isGap).length}/${routed.judgeList.length} 공백`,
            detail: routed.judgeList
              .map((entry) => `${TRIGGER_TYPE_LABEL_MAP[entry.type] || entry.type}:"${entry.phrase}"=${entry.isGap ? 'O' : 'X'}(${entry.reason || '-'})`)
              .join(' · ') || '후보 없음',
          });
          const { selected, excludedList } = selectGeneratableCandidate({
            candidateList: routed.candidateList, isScaleEnabled: config.isScaleEnabled,
          });
          selectedCandidate = selected;
          narrationEventVideoTimeMs = resolveNarrationEventVideoTimeMs({
            judgeList: routed.judgeList, selectedCandidate: selected, fallbackMs: eventVideoTimeMs,
          });
          if (Number.isFinite(eventVideoTimeMs) && narrationEventVideoTimeMs !== eventVideoTimeMs) {
            const shiftSec = (narrationEventVideoTimeMs - eventVideoTimeMs) / 1000;
            markDebug({
              stage: DEBUG_STAGE_MAP.router, verdict: DEBUG_VERDICT_MAP.info, ts,
              reason: '해설 자리를 해설이 다루는 후보의 발화 시각으로 옮김',
              detail: `결정 시각 ${Math.round(eventVideoTimeMs)}ms → ${Math.round(narrationEventVideoTimeMs)}ms`
                + ` (${shiftSec >= 0 ? '+' : ''}${shiftSec.toFixed(1)}초) · 근거 표현=${selected?.anchor || '-'}`,
            });
          }
          if (excludedList.length) {
            markDebug({
              stage: DEBUG_STAGE_MAP.router, verdict: DEBUG_VERDICT_MAP.skip, ts,
              narrationType: NARRATION_TYPE_MAP.visualDescription,
              reason: '척도 꺼짐 — 척도 후보 제외',
              detail: `제외=[${excludedList.map((c) => `${c.type}/${c.subKind || '-'}`).join(', ')}] 발화="${utterance}"`,
            });
          }
          markDebug({
            stage: DEBUG_STAGE_MAP.router, ts,
            verdict: selectedCandidate ? DEBUG_VERDICT_MAP.pass : DEBUG_VERDICT_MAP.skip,
            narrationType: selectedCandidate?.type || null,
            reason: selectedCandidate
              ? `확정 ${selectedCandidate.type}/${selectedCandidate.subKind || '-'}`
              : `후보 없음${judgeReason ? ` (${judgeReason})` : ''}`,
            detail: `발화="${utterance}" 후보=[${routed.candidateList.map((c) => `${c.type}/${c.subKind || '-'}`).join(', ') || '없음'}]`
              + ` 경로=${routed.source}`,
          });
        } else {
          const verdict = await judgeClient.judge({ utterance, before: beforeText, after: afterText });
          judgeReason = verdict.reason;
          if (verdict.shouldCaption) selectedCandidate = { type: NARRATION_TYPE_MAP.deixis, subKind: null };
          markDebug({
            stage: DEBUG_STAGE_MAP.router, ts,
            verdict: selectedCandidate ? DEBUG_VERDICT_MAP.pass : DEBUG_VERDICT_MAP.skip,
            narrationType: NARRATION_TYPE_MAP.deixis,
            reason: selectedCandidate ? '판정기 통과' : `판정기 차단 (${judgeReason || '사유 없음'})`,
            detail: `발화="${utterance}"`,
          });
        }
        if (!selectedCandidate) {
          await appendRecord({
            kind: RECORD_KIND_MAP.deixis, ts, utterance, caption: '', isGrounded: false, judgeReason,
          });
          console.log(`[pipeline] 지시 판정 스킵 (${Date.now() - startedAt}ms) "${truncateForLog(utterance, 30)}" → ${judgeReason || '후보 없음'}`);
          return { isOk: true, isGrounded: false };
        }
      }
      stage = PIPELINE_STAGE_MAP.vlm;

      const narrationType = selectedCandidate?.type || NARRATION_TYPE_MAP.deixis;
      // 수치·척도 해설이면 판단 뒤 상한까지만 OCR 을 기다려 그 줄을 근거로 넘긴다. 늦거나 없으면 덩어리 없이(지금 프롬프트로) 만든다.
      // 수치 해설이면 같은 자리에서 그래프 어림도 한다(꺼져 있으면 하지 않는다).
      const screenTextPromise = isScreenTextNarrationType(narrationType) && screenTextTask
        ? screenTextTask.waitForPrompt({
          withChart: narrationType === NARRATION_TYPE_MAP.interpretation,
          frameTag: buildChartFrameTag({ ts, videoTimeMs: eventVideoTimeMs }),
        })
        : null;
      // 사실 카드가 아직 만들어지는 중이면 같은 프레임 OCR 을 기다리는 동안만 함께 기다린다(새 대기 없음).
      // OCR 작업이 없으면(지시 해설, OCR 근거 꺼짐) 기다리지 않고 지금 준비된 카드만 쓴다.
      const factCardUsage = resolveFactCardUsage({
        narrationType, subKind: selectedCandidate?.subKind || null,
        isEnabled: config.isFactCardEnabled, agentList: config.factCardAgentList,
      });
      const factCardStatePromise = factCardUsage
        ? factCardStore.waitUntil({ slideLabel, untilPromise: screenTextPromise })
        : null;
      const screenText = screenTextPromise ? await screenTextPromise : null;
      const chartEstimate = isChartEstimateInPrompt && screenText?.chart?.status === CHART_STATUS_MAP.ok ? screenText.chart : null;
      const factCardState = factCardStatePromise ? await factCardStatePromise : null;
      const factCard = factCardState ? selectFactCards({
        state: factCardState, usage: factCardUsage, utterance,
        anchorList: [
          selectedCandidate?.anchor, ...(selectedCandidate?.mergedAnchorList || []), ...(selectedCandidate?.mergedClaimList || []),
        ],
        beforeText, frameLineList: screenText?.lineList || [], requestTs: ts, tokenizer: factCardTokenizer,
      }) : null;
      const factCardArg = factCard?.cardList.length ? { factCardList: factCard.cardList } : {};
      // 발화로 ROI 잡기(켜져 있을 때만): 발화 낱말을 화면 줄 위치와 맞춰 확대 그림을 만든다. 끝난 결과만 쓰고 기다리지 않는다.
      const speechRoiResult = speechRoi.resolve({
        narrationType, subKind: selectedCandidate?.subKind || null, utterance, before: beforeText, after: afterText,
        anchor: selectedCandidate?.anchor || '', slideLabel, screenFrame: frameSet.screenFrame,
        frameLayout: screenTextTask?.peekLayout() ?? null, pointingRect,
        regionFrame: fullBuffer ? frameSet.selectAgentFrame(NARRATION_TYPE_MAP.deixis) : null,
        mergedClaimCount: selectedCandidate?.mergedClaimList?.length || 0,
      });
      if (speechRoiResult.record) {
        markDebug({
          stage: DEBUG_STAGE_MAP.vlm, verdict: DEBUG_VERDICT_MAP.info, ts, narrationType,
          reason: `발화 ROI ${speechRoiResult.record.status}`, detail: formatSpeechRoiSummary(speechRoiResult.record),
        });
      }

      const wordBudget = wordBudgetMap?.[narrationType] || null;
      const generatorArgs = {
        jpegBuffer: frameSet.selectAgentFrame(narrationType), utterance, recentTranscript, describedElementList,
        minWordCount: wordBudget?.minWordCount, maxWordCount: wordBudget?.maxWordCount,
        subKind: selectedCandidate?.subKind || null,
        mergedAnchorList: selectedCandidate?.mergedAnchorList || [],
        mergedClaimList: selectedCandidate?.mergedClaimList || [],
        // 확대 그림이 있으면 첫째 장을 화면 전체로 바꾸고 확대를 둘째 장으로 넘긴다. 없으면 아무것도 바꾸지 않는다.
        ...buildZoomAgentArgs({ roiResult: speechRoiResult, screenFrame: frameSet.screenFrame }),
      };

      const extraArgByTypeMap = {
        [NARRATION_TYPE_MAP.visualDescription]: {
          subKind: selectedCandidate?.subKind || VISUAL_DESCRIPTION_KIND_MAP.scale,
          screenLineList: screenText?.lineList || [],
        },
        [NARRATION_TYPE_MAP.deixis]: { hasPointingRegion, pointingOrderHint },
        [NARRATION_TYPE_MAP.interpretation]: { screenLineList: screenText?.lineList || [], chartEstimate },
      };
      const agent = agentFieldMap[narrationType] || agentFieldMap[NARRATION_TYPE_MAP.deixis];
      const {
        text: generatedText, isGrounded, slotMap, rejectKind = null, rejectReason = '', rawContent = '',
        screenTextBlock = null, factCardBlock = null, chartBlock = null, restoredTimeMark = null, droppedFact = null,
        appliedBudget = null,
      } = await agent.generate({
        ...generatorArgs, ...(extraArgByTypeMap[narrationType] || {}), ...factCardArg,
      });
      let text = generatedText;
      const screenTextRecord = screenText ? finalizeScreenTextRecord({ record: screenText.record, screenTextBlock, chartBlock }) : null;
      const factCardRecord = factCard
        ? { ...factCard.record, charCount: factCardBlock?.charCount ?? 0, waitedMs: factCardState.waitedMs }
        : null;
      const screenTextDetail = screenTextRecord ? ` · ${formatScreenTextSummary(screenTextRecord)}` : '';
      const factCardDetail = factCardRecord ? ` · ${formatFactCardSummary(factCardRecord)}` : '';
      // 조립이 코드로 바꾼 것(근거 칸에서 되살린 시점, seen 에 없는 숫자라 읽지 않은 fact)을 남겨 기록에서 오탐을 셀 수 있게 한다.
      const assemblyDetail = [
        restoredTimeMark ? ` · 시점 되살림="${restoredTimeMark}"` : '',
        droppedFact ? ` · 근거 없는 fact 뺌="${droppedFact}"` : '',
      ].join('');
      await appendRecord({
        kind: RECORD_KIND_MAP.deixis, ts, utterance, caption: text, isGrounded, judgeReason, slideLabel,
        routerMode: config.routerMode, narrationType, subKind: selectedCandidate?.subKind || null,
        ...(isGrounded && text ? {} : { rejectKind, rejectReason, rawContent }),
        ...(screenTextRecord ? { screenText: screenTextRecord } : {}),
        ...(factCardRecord ? { factCard: factCardRecord } : {}),
        ...(speechRoiResult.record ? { speechRoi: speechRoiResult.record } : {}),
        ...(restoredTimeMark ? { restoredTimeMark } : {}),
        ...(droppedFact ? { droppedFact } : {}),
      });
      if (!isGrounded || !text) {
        const rejection = describeAgentRejection({ rejectKind, rejectReason, rawContent });
        console.log(`[pipeline] ${narrationType} 스킵 (${Date.now() - startedAt}ms) "${truncateForLog(utterance, 30)}" → ${rejection.reason}`);
        markDebug({
          stage: DEBUG_STAGE_MAP.vlm, verdict: DEBUG_VERDICT_MAP.skip, ts, narrationType,
          reason: rejection.reason,
          detail: `${rejection.detailPrefix}발화="${utterance}" 세부=${selectedCandidate?.subKind || '-'} (${Date.now() - startedAt}ms)`
            + screenTextDetail + factCardDetail,
        });
        screenChange.noteUnresolved({
          ts, frameTs, slideLabel, narrationType, selectedCandidate, generatorArgs, rejectKind, beforeText, afterText,
        });
        return { isOk: true, isGrounded: false };
      }
      const valueCheckTarget = readValueCheckTarget({
        narrationType, subKind: selectedCandidate?.subKind || null, slotMap, text, contentSwitch: config.contentSwitch,
      });
      // 화면 값 먼저(켜짐)의 값→의미는 발표자가 말한 그 수를 읽는다. 값 칸의 수가 발화의 수(어림 값이면 ±15%)와 멀면
      // 옆 막대·다른 항목의 화면 값으로 바꿔 쓴 것이라, 화면에 있는 값이어도 읽지 않는다.
      const isSpokenValueChecked = config.contentSwitch?.isScreenValueFirstEnabled && valueCheckTarget
        && valueCheckTarget.checkSubKind === INTERPRETATION_KIND_MAP.valueToMeaning;
      const spokenValueMatch = isSpokenValueChecked ? checkSpokenValueMatch({ value: valueCheckTarget.value, utterance }) : null;
      if (spokenValueMatch?.verdict === SPOKEN_VALUE_VERDICT_MAP.far) {
        markDebug({
          stage: DEBUG_STAGE_MAP.valueCheck, verdict: DEBUG_VERDICT_MAP.skip, ts, narrationType,
          reason: '발화 값 대조 far — 발화의 수와 먼 값',
          detail: `값="${valueCheckTarget.value}" · ${spokenValueMatch.reason} → "${text}"`,
        });
        await appendRecord({
          kind: RECORD_KIND_MAP.deixis, ts, utterance, caption: text, isGrounded: false, slideLabel,
          narrationType, subKind: selectedCandidate?.subKind || null, skipReason: 'value-far-from-spoken',
          ...(screenTextRecord ? { screenText: screenTextRecord } : {}),
          ...(factCardRecord ? { factCard: factCardRecord } : {}),
          ...(speechRoiResult.record ? { speechRoi: speechRoiResult.record } : {}),
        });
        return { isOk: true, isGrounded: false };
      }
      if (valueCheckTarget) {
        const slideText = slideTextStore.get(slideLabel);
        // 해설이 본 것과 같은 프레임의 OCR 글자(믿을 줄만)가 끝나 있으면 저장 전사보다 먼저 그것과 대조한다.
        const frameText = screenTextTask?.peekFrameText() ?? null;
        const verifyValueOnSlide = (value) => verifyValuePresence({
          value, slideText: slideText.text, slideTextStatus: slideText.status, frameText,
          utterance, contextText: [beforeText, afterText].filter(Boolean).join(' '),
          subKind: valueCheckTarget.checkSubKind,
          // 값이 없다고 나오면 지금 화면을 OCR 과 다른 엔진(VLM)으로 다시 읽어, 클릭으로 나타난 값과 OCR 오독을 함께 거른다.
          retranscribe: () => slideTextAgent.transcribeWithVlm({ jpegBuffer: frameSet.screenFrame }),
          // 그래프 어림값을 프롬프트에 넣었을 때(on)만 화면에 적히지 않은 어림값을 있는 값으로 인정한다.
          chartValueList: toChartValueList(chartEstimate),
        });
        const valueVerdict = await verifyValueOnSlide(valueCheckTarget.value);
        const verdictByValueMap = {
          [VALUE_PRESENCE_VERDICT_MAP.present]: DEBUG_VERDICT_MAP.pass,
          [VALUE_PRESENCE_VERDICT_MAP.absent]: DEBUG_VERDICT_MAP.skip,
          [VALUE_PRESENCE_VERDICT_MAP.unchecked]: DEBUG_VERDICT_MAP.info,
        };
        const checkedSourceLabelMap = {
          [VALUE_CHECK_SOURCE_MAP.frameOcr]: '같은 프레임 OCR', [VALUE_CHECK_SOURCE_MAP.chartEstimate]: '그래프 어림값',
        };
        // 그래프 어림값이 있는데 값 칸 숫자가 눈금 값이고 어림값과 다르면, 막대를 눈금으로 반올림해 말한 것으로 의심해 기록만 남긴다.
        const isTickSnapSuspect = detectTickSnapSuspect({ value: valueCheckTarget.value, chart: screenText?.chart });
        markDebug({
          stage: DEBUG_STAGE_MAP.valueCheck, verdict: verdictByValueMap[valueVerdict.verdict], ts, narrationType,
          reason: `값 존재 검사 ${valueVerdict.verdict}`,
          detail: `값="${valueCheckTarget.value}" 슬라이드=${slideLabel || '-'} 전사=${slideText.status}`
            + ` 대조=${checkedSourceLabelMap[valueVerdict.checkedSource] || '저장 전사'}`
            + `${valueVerdict.reason ? ` · ${valueVerdict.reason}` : ''}`
            + `${isTickSnapSuspect ? ' · 눈금값 의심(tickSnapSuspect)' : ''} → "${text}"`,
        });
        if (valueVerdict.verdict === VALUE_PRESENCE_VERDICT_MAP.absent) {
          await appendRecord({
            kind: RECORD_KIND_MAP.deixis, ts, utterance, caption: text, isGrounded: false, slideLabel,
            narrationType, subKind: selectedCandidate?.subKind || null, skipReason: 'value-absent',
            ...(screenTextRecord ? { screenText: screenTextRecord } : {}),
            ...(factCardRecord ? { factCard: factCardRecord } : {}),
            ...(speechRoiResult.record ? { speechRoi: speechRoiResult.record } : {}),
          });
          screenChange.noteUnresolved({
            ts, frameTs, slideLabel, narrationType, selectedCandidate, generatorArgs, beforeText, afterText,
          });
          return { isOk: true, isGrounded: false };
        }
        const chartCoreList = [...(valueVerdict.chartCoreList || [])];
        let isSecondPairDropped = false;
        // 둘째 변화의 값이 화면에 없으면 둘째 쌍만 빼고 첫 쌍으로 읽는다. 첫 쌍은 에이전트가 쓴 전체 예산에 다시 맞춘다.
        if (slotMap?.value2 && text.includes(slotMap.value2)) {
          const secondVerdict = await verifyValueOnSlide(slotMap.value2);
          chartCoreList.push(...(secondVerdict.chartCoreList || []));
          if (secondVerdict.verdict === VALUE_PRESENCE_VERDICT_MAP.absent) {
            isSecondPairDropped = true;
            const firstPair = assembleNarration({
              narrationType, subKind: selectedCandidate?.subKind, rawSlotMap: { ...slotMap, target2: '', value2: '' },
              maxWordCount: appliedBudget?.maxWordCount, maxChars: appliedBudget?.maxChars,
              language: getCaptionLanguage(), contentSwitch: config.contentSwitch,
            });
            markDebug({
              stage: DEBUG_STAGE_MAP.valueCheck, verdict: DEBUG_VERDICT_MAP.skip, ts, narrationType,
              reason: '둘째 값 존재 검사 absent — 첫 쌍만 읽음',
              detail: `값="${slotMap.value2}"${secondVerdict.reason ? ` · ${secondVerdict.reason}` : ''} → "${firstPair?.text || text}"`,
            });
            text = firstPair?.text || text;
          }
        }
        // 그래프 어림값으로만 통과한 숫자는 "약"을 붙여 다시 조립한다. 붙일 수 없으면 어림을 사실처럼 말하게 되므로 버린다.
        if (chartCoreList.length) {
          const approximated = approximateChartNarration({
            narrationType, subKind: selectedCandidate?.subKind || INTERPRETATION_KIND_MAP.valueToMeaning,
            slotMap: isSecondPairDropped ? { ...slotMap, target2: '', value2: '' } : slotMap, coreList: chartCoreList,
            hasSecondClaim: !isSecondPairDropped && (selectedCandidate?.mergedClaimList || []).length > 0,
            maxWordCount: appliedBudget?.maxWordCount, maxChars: appliedBudget?.maxChars, language: getCaptionLanguage(),
          });
          markDebug({
            stage: DEBUG_STAGE_MAP.valueCheck, verdict: approximated ? DEBUG_VERDICT_MAP.pass : DEBUG_VERDICT_MAP.skip, ts, narrationType,
            reason: approximated ? '그래프 어림값 — 어림 표지 붙임' : '그래프 어림값 — 어림 표지를 붙이지 못해 버림',
            detail: `어림 숫자=${chartCoreList.join(',')} → "${approximated?.text || text}"`,
          });
          if (!approximated) {
            await appendRecord({
              kind: RECORD_KIND_MAP.deixis, ts, utterance, caption: text, isGrounded: false, slideLabel,
              narrationType, subKind: selectedCandidate?.subKind || null, skipReason: 'chart-estimate-unmarked',
              ...(screenTextRecord ? { screenText: screenTextRecord } : {}),
              ...(factCardRecord ? { factCard: factCardRecord } : {}),
              ...(speechRoiResult.record ? { speechRoi: speechRoiResult.record } : {}),
            });
            return { isOk: true, isGrounded: false };
          }
          text = approximated.text;
        }
      }
      markDebug({
        stage: DEBUG_STAGE_MAP.vlm, verdict: DEBUG_VERDICT_MAP.pass, ts, narrationType,
        reason: `생성 ${narrationType}/${selectedCandidate?.subKind || '-'}`,
        detail: `발화="${utterance}" → "${text}" (${Date.now() - startedAt}ms, 예산 ${wordBudget?.minWordCount ?? '-'}~${wordBudget?.maxWordCount ?? '-'}어절)`
          + screenTextDetail + factCardDetail + assemblyDetail,
      });

      captionDescribed.add({ ts, text, slideLabel, elementList: [text] });
      console.log(`[pipeline] ${narrationType} 캡션 (${Date.now() - startedAt}ms) "${truncateForLog(utterance, 20)}" → "${truncateForLog(text)}"`);

      stage = PIPELINE_STAGE_MAP.tts;
      const sent = await sendCaption({
        ts, text, source: narrationType, slideLabel, slotMap,
        hasPointingRegion,
        narrationClass: toNarrationClass({ narrationType }), eventVideoTimeMs: narrationEventVideoTimeMs,
        rationale: {
          utterance,
          subKind: selectedCandidate?.subKind || null,
          summary: `근거 표현=${[
            selectedCandidate?.anchor, ...(selectedCandidate?.mergedAnchorList || []), ...(selectedCandidate?.mergedClaimList || []),
          ].filter(Boolean).join(', ') || '(없음)'}`
            + `${hasPointingRegion ? ' · 필기/포인터 영역 있음' : ''}`,
        },
      });
      return { isOk: true, isGrounded: sent.isEmitted };
    } catch (error) {
      console.error(`[pipeline] ✖ 캡션 생성 실패 ts=${ts}: ${error.message}`);
      await appendErrorRecordSafely({
        appendRecord, record: { kind: RECORD_KIND_MAP.error, ts, stage, message: error.message },
      });
      markDebug({
        stage: DEBUG_STAGE_MAP.vlm, verdict: DEBUG_VERDICT_MAP.fail, ts,
        reason: '캡션 생성 실패', detail: `${stage}: ${error.message}`,
      });
      return { isOk: false, message: error.message };
    }
  });

  ipcMain.handle('pipeline-command', async (_event, { ts, buffer, command = null,
    questionText = null, questionLabel = '', recentTranscript = '', wordBudget, eventVideoTimeMs = null }) => {
    const stage = PIPELINE_STAGE_MAP.vlm;
    const startedAt = Date.now();
    const subKind = command || 'free_question';
    console.log(`[pipeline] ▶ 사용자 ${command ? `커맨드 ${command}` : `질문 "${truncateForLog(questionText)}"`} ts=${ts}`);
    try {
      const { text, isGrounded } = await agentFieldMap[NARRATION_TYPE_MAP.userCommand].generate({
        jpegBuffer: Buffer.from(buffer), command, questionText, recentTranscript,
        minWordCount: wordBudget?.minWordCount, maxWordCount: wordBudget?.maxWordCount,
      });
      await appendRecord({
        kind: RECORD_KIND_MAP.deixis, ts, utterance: questionText || '', caption: text, isGrounded,
        narrationType: NARRATION_TYPE_MAP.userCommand, subKind,
      });
      if (!isGrounded || !text) {
        console.log(`[pipeline] 응답 없음 (${Date.now() - startedAt}ms) ${subKind}`);
        return { isOk: true, isGrounded: false };
      }
      console.log(`[pipeline] 응답 (${Date.now() - startedAt}ms) ${subKind} → "${truncateForLog(text)}"`);
      // 프리셋 답도 다음 질문의 '앞서 오간 질문과 답'에 들어가게 쌓는다.
      if (command) {
        contextStore.addQa(buildPresetQa({
          ts, command, questionLabel, text, currentSlideMajor: contextStore.getCurrentSlideMajor(),
        }));
      }
      markDebug({
        stage: DEBUG_STAGE_MAP.vlm, verdict: DEBUG_VERDICT_MAP.pass, ts,
        narrationType: NARRATION_TYPE_MAP.userCommand,
        reason: `${command ? `커맨드 ${command}` : '자유 질문'} 응답`, detail: `"${text}"`,
      });

      await sendCaption({
        ts, text, source: NARRATION_TYPE_MAP.userCommand, isDedupeExempt: true,
        narrationClass: NARRATION_CLASS_MAP.userCommand, eventVideoTimeMs,
        rationale: {
          subKind,
          summary: command ? '사용자가 단축키로 직접 요청한 답변' : '사용자가 직접 물은 자유 질문',
        },
      });
      return { isOk: true, isGrounded: true };
    } catch (error) {
      console.error(`[pipeline] ✖ 커맨드 실패 ts=${ts}: ${error.message}`);
      await appendErrorRecordSafely({
        appendRecord, record: { kind: RECORD_KIND_MAP.error, ts, stage, message: error.message },
      });
      return { isOk: false, message: error.message };
    }
  });

  ipcMain.handle('pipeline-question', async (_event, { ts, buffer, questionText,
    wordBudget, currentSlideLabel = null, speakerHintNow = null, inputSource = 'typed',
    eventVideoTimeMs = null, heardWallTs = null, heardVideoTimeMs = null }) => {
    const startedAt = Date.now();
    const currentSlideMajor = toSlideMajor(currentSlideLabel) ?? contextStore.getCurrentSlideMajor();
    const qaList = contextStore.getQaList();
    try {
      const ruled = classifyQuestion(questionText);
      const ruledMajor = ruled?.route === QUESTION_ROUTE_MAP.pastSlide
        ? contextStore.resolveSlideNumber(ruled.spokenNumber) : null;
      const isRuledUsable = ruled && (ruled.route !== QUESTION_ROUTE_MAP.pastSlide || ruledMajor !== null);
      const routed = isRuledUsable
        ? { route: ruled.route, slideMajorList: ruledMajor === null ? [] : [ruledMajor], source: 'rule', reason: '' }
        : await questionRouter.route({
          questionText, currentSlideMajor, index: contextStore.buildIndex(), qaList,
          startedAt: contextStore.getSessionInfo().startedAt,
        });
      markDebug({
        stage: DEBUG_STAGE_MAP.question, verdict: DEBUG_VERDICT_MAP.info, ts,
        narrationType: NARRATION_TYPE_MAP.userCommand,
        reason: `질문 갈래 ${routed.route} (${routed.source})`,
        detail: `"${questionText}" 입력=${inputSource} 대상=[${routed.slideMajorList.join(', ')}]`
          + `${qaList.length ? ` 앞 질문 ${qaList.length}개` : ''}${routed.reason ? ` · ${routed.reason}` : ''}`,
      });

      const result = routed.route === QUESTION_ROUTE_MAP.currentScreen
        ? await agentFieldMap[NARRATION_TYPE_MAP.userCommand].generate({
          jpegBuffer: Buffer.from(buffer), questionText,
          contextText: buildCurrentScreenContextText({ contextStore, major: currentSlideMajor }),
          qaHistoryText: formatQaHistory({ qaList, startedAt: contextStore.getSessionInfo().startedAt }),
          minWordCount: wordBudget?.minWordCount, maxWordCount: wordBudget?.maxWordCount,
        })
        : await questionAnswerer.answer({
          route: routed.route, slideMajorList: routed.slideMajorList, questionText, wordBudget, speakerHintNow,
          heardWallTs, heardVideoTimeMs,
        });
      const text = result.isGrounded && result.text
        ? result.text : readAnswerText({ key: ANSWER_TEXT_KEY_MAP.notFound, language: getCaptionLanguage() });
      contextStore.addQa({
        ts, question: questionText, answer: text, route: routed.route, slideMajorList: routed.slideMajorList,
      });
      await appendRecord({
        kind: RECORD_KIND_MAP.deixis, ts, utterance: questionText, caption: text,
        isGrounded: Boolean(result.isGrounded), narrationType: NARRATION_TYPE_MAP.userCommand,
        subKind: `question:${routed.route}`,
      });
      console.log(`[pipeline] 질문 답 (${Date.now() - startedAt}ms) [${routed.route}] "${truncateForLog(questionText)}" → "${truncateForLog(text)}"`);
      await sendCaption({
        ts, text, source: NARRATION_TYPE_MAP.userCommand, isDedupeExempt: true,
        narrationClass: NARRATION_CLASS_MAP.userCommand, eventVideoTimeMs,
        rationale: { subKind: `question:${routed.route}`, summary: '사용자가 직접 물은 질문' },
      });
      return { isOk: true, isGrounded: Boolean(result.isGrounded), route: routed.route };
    } catch (error) {
      console.error(`[pipeline] ✖ 질문 처리 실패 ts=${ts}: ${error.message}`);
      markDebug({
        stage: DEBUG_STAGE_MAP.question, verdict: DEBUG_VERDICT_MAP.fail, ts,
        narrationType: NARRATION_TYPE_MAP.userCommand, reason: '질문 처리 실패', detail: error.message,
      });
      await appendErrorRecordSafely({
        appendRecord, record: { kind: RECORD_KIND_MAP.error, ts, stage: 'question', message: error.message },
      });
      return { isOk: false, message: error.message };
    }
  });

  // 질문 음성은 pipeline-audio 를 쓰지 않는다. 그 경로는 asr 기록을 남겨 회의 전사·지시 탐지·저장소에 섞인다.
  ipcMain.handle('pipeline-question-audio', async (_event, { buffer, startTs }) => {
    try {
      const result = await asrLanguageSession.transcribeQuestionSegment({ webmBuffer: Buffer.from(buffer), startTs });
      const text = (result.text || '').trim();
      markDebug({
        stage: DEBUG_STAGE_MAP.question, verdict: text ? DEBUG_VERDICT_MAP.info : DEBUG_VERDICT_MAP.skip,
        reason: text ? '마이크 질문 전사' : '마이크 질문 전사 비어 있음',
        detail: text ? `"${text}"` : (result.hallucinationText ? `환각 문구 폐기 "${result.hallucinationText}"` : ''),
      });
      return { isOk: true, text };
    } catch (error) {
      markDebug({
        stage: DEBUG_STAGE_MAP.question, verdict: DEBUG_VERDICT_MAP.fail,
        reason: '마이크 질문 전사 실패', detail: error.message,
      });
      return { isOk: false, text: '', message: error.message };
    }
  });

  ipcMain.handle('pipeline-gap', async (_event, { mode, ts, narrationText, narrationType, subKind,
    rationale, screenSummary, beforeTranscript, gapList }) => {
    const startedAt = Date.now();
    const result = await gapAgent.infer({
      mode, narrationText, narrationType, subKind, rationale, screenSummary, beforeTranscript,
      gapList: gapList || [],
    });
    const chosen = Number.isInteger(result.gapIndex) ? gapList[result.gapIndex] : null;
    const candidateSourceCount = countGapCandidateSource({ gapList: gapList || [] });
    await appendRecord({
      kind: RECORD_KIND_MAP.gap, ts, narrationType, narration: narrationText,
      gapIndex: result.gapIndex, source: result.source, reason: result.reason,
      mode: mode || null, modelId: result.modelId || null,
      chosenOffsetMs: chosen?.offsetMs ?? null, candidateCount: (gapList || []).length,
      candidateSourceCount, chosenKind: chosen?.kind ?? null, chosenCandidateSource: chosen?.source ?? null,
    });
    markDebug({
      stage: DEBUG_STAGE_MAP.gap, ts, narrationType,
      verdict: chosen ? DEBUG_VERDICT_MAP.pass : DEBUG_VERDICT_MAP.skip,
      reason: chosen
        ? `틈 선택 (트리거 ${chosen.offsetMs >= 0 ? '+' : ''}${(chosen.offsetMs / 1000).toFixed(1)}초, ${result.source})`
        : `틈 미선택 → 트리거 지점 삽입 (${result.source})`,
      detail: `"${truncateForLog(narrationText)}" · 후보 ${(gapList || []).length}개`
        + ` (소리 ${candidateSourceCount.audio} · ASR ${candidateSourceCount.asr})`
        + ` · 사유="${result.reason || '-'}"`
        + (result.modelId ? ` · 모델=${result.modelId}` : '')
        + (chosen ? ` · 앞 발화="${truncateForLog(chosen.beforeText, 30)}" 끝맺음=${chosen.kind}` : '')
        + ` (${Date.now() - startedAt}ms)`,
    });
    return { isOk: true, gapIndex: result.gapIndex, reason: result.reason, source: result.source };
  });

  ipcMain.on('pipeline-debug', (_event, entry) => {
    appendRecord({ kind: RECORD_KIND_MAP.debug, ...entry }).catch(() => {});
    devFlow.recorder.addDebug(entry);
  });

  // 렌더러 재생기가 해설을 실제로 틀기 시작한 순간. 개발자 모드 흐름 창이 '재생됨'을 정할 때 쓴다.
  ipcMain.on('pipeline-narration-playback', (_event, info) => {
    devFlow.recorder.addPlayback(flattenPlaybackReport(info));
  });

  ipcMain.on('pipeline-boundary', (_event, entry) => {
    appendRecord({
      kind: RECORD_KIND_MAP.boundary, ts: entry.captureTs,
      ending: entry.ending, emitted: entry.emitted, boundaryKind: entry.kind,
      silenceMsAfter: entry.silenceMsAfter, text: entry.text,
      segmentCount: entry.segmentCount, candidateCount: entry.candidateCount,
    }).catch(() => {});
  });

  return {
    config,
    ttsClient,
    // 회의 음성 전사 언어(ko·en·auto). 마이크 질문 언어(config.questionAsrLanguage)는 바꾸지 않는다.
    setAsrLanguage: (language) => asrLanguageSession.setMeetingLanguage(language),
    getAsrLanguage: () => asrLanguageSession.getMeetingLanguage(),
    consumeLastSession() {
      const session = lastSession;
      lastSession = null;
      return session;
    },
    consumeLastContext() {
      const snapshot = lastContextSnapshot;
      lastContextSnapshot = null;
      return snapshot;
    },
    // 캡처 세션이 열려 있는 동안이 회의 중이다. 회의 뒤 요약 음성은 회의 중이 아닐 때만 만든다.
    isMeetingLive: () => sessionStore.getCurrentSessionId() !== null,
  };
}

module.exports = { registerPipeline, DEBUG_STAGE_MAP, DEBUG_VERDICT_MAP };
