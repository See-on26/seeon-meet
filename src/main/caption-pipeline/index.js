const fs = require('fs');
const { ipcMain } = require('electron');
const { readPipelineConfig } = require('./config');
const {
  NARRATION_TYPE_MAP, VISUAL_DESCRIPTION_KIND_MAP, SPEAKER_SOURCE_MAP, NARRATION_CLASS_MAP,
  INTERPRETATION_KIND_MAP,
} = require('./contracts/narration-types');
const { toNarrationClass, NARRATION_ORIGIN_MAP } = require('./contracts/narration-class');
const { buildSpeakerIdentityFromDom } = require('./agents/speaker-identity-agent');
const { DEBUG_STAGE_MAP, DEBUG_VERDICT_MAP } = require('./contracts/debug-events');
const { createAgentFieldMap } = require('./agents');
const { createUnifiedRouter, ROUTER_MODE_MAP } = require('./router/unified-router');
const { createSpeechTrigger, TRIGGER_TYPE_LABEL_MAP } = require('./trigger/speech-trigger');
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
const { createScreenRegistry } = require('./orchestrator/screen-registry');
const { createSlideTopicRegistry, SLIDE_TOPIC_VERDICT_MAP } = require('./orchestrator/slide-topic-registry');
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
const { requestVlmContent, setVlmFallbackListener } = require('./agents/shared/vlm-gateway');
const { createSlideTextAgent } = require('./agents/slide-text-agent');
const { createOcrClient } = require('./agents/shared/ocr-client');
const { createSlideTextStore } = require('./orchestrator/slide-text-store');
const { verifyValuePresence, VALUE_PRESENCE_VERDICT_MAP } = require('./orchestrator/value-presence');
const { createContextStore, toSlideMajor, LABEL_STATUS_MAP } = require('./context/context-store');
const { createSlideLabeler } = require('./context/slide-labeler');
const { createContextFileWriter } = require('./context/context-file');
const { buildTranscriptScript, buildScriptFileName } = require('./context/transcript-script');
const { pickMeetingTitle } = require('../archive/meeting-archive');
const { classifyQuestion, QUESTION_ROUTE_MAP } = require('./context/question-classifier');
const { createQuestionRouter, selectFollowUpQa } = require('./context/question-router');
const { createQuestionAnswerer, NOT_FOUND_TEXT } = require('./context/question-answerer');
const { buildSlideEvidence } = require('./prompts/question-answer');
const { OUT_DIR, CONTEXT_DIR } = require('../paths');

const ASR_DRAIN_TIMEOUT_MS = 8000;
const ASR_DRAIN_POLL_MS = 100;

const PIPELINE_STAGE_MAP = { frame: 'frame', judge: 'judge', vlm: 'vlm', caption: 'caption', tts: 'tts', asr: 'asr' };

const RECENT_NARRATION_LIMIT = 4;

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
  const recordStore = createRecordStore({ outDir: OUT_DIR });
  const sessionStore = createSessionStore();
  let pendingAsrCount = 0;
  let lastSession = null;
  const agentFieldMap = createAgentFieldMap({ config });
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
  const narrationHistory = createNarrationHistory();
  const silenceGate = createSilenceNarrationGate();
  const featureGate = createFeatureGate();
  const silenceNarrator = createSilenceNarrator({ gate: silenceGate, judge: createSilenceJudge({ config }) });
  console.log(`[pipeline] 발화 축 판정 경로: ${config.routerMode}`);
  console.log(`[pipeline] 탐지 판정 LLM: ${config.judgeBackend === 'gpu'
    ? `GPU ${config.judgeGpuModel} → 실패하면 Bedrock ${config.judgeModelId}` : `Bedrock ${config.judgeModelId}`}`);
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
  // 라벨링·질문 라우팅은 이미지 없이 GPU VLM 을 부르고, GPU 가 실패하면 Haiku 로 폴백한다.
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
  });

  function buildCurrentSlideContextText(major) {
    const slide = major === null ? null : contextStore.getSlide(major);
    if (!slide) return '';
    return buildSlideEvidence({
      slide, utteranceList: [], narrationList: [], startedAt: contextStore.getSessionInfo().startedAt,
    });
  }

  function appendRecord(record) {
    try {
      if (contextStore.applyRecord(record)) labelReadySlides();
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
    getViewerView()?.webContents.send('pipeline-event', { type: 'debug', ...entry });
  }

  setVlmFallbackListener(({ label, reason, isBypass, isSucceeded, elapsedMs, errorMessage }) => {
    const situation = isBypass ? 'GPU 우회 중' : reason;
    console.warn(`[pipeline] VLM 폴백(${config.vlmFallbackModelId}) [${label}] ${situation}`
      + ` → ${isSucceeded ? '성공' : `실패: ${errorMessage}`} (${elapsedMs}ms)`);
    markDebug({
      stage: DEBUG_STAGE_MAP.vlmFallback,
      verdict: isSucceeded ? DEBUG_VERDICT_MAP.info : DEBUG_VERDICT_MAP.fail,
      reason: `${isBypass ? 'GPU 우회 중' : 'GPU VLM 실패'} — Bedrock 폴백 ${isSucceeded ? '성공' : '실패'}`,
      detail: `${label} · ${situation}${isSucceeded ? '' : ` · ${errorMessage}`}`
        + ` · ${elapsedMs}ms · 모델=${config.vlmFallbackModelId}`,
    });
  });

  const slideTextAgent = createSlideTextAgent({ config, ocrClient: createOcrClient({ config }) });
  const slideTextStore = createSlideTextStore({
    transcribe: ({ jpegBuffer }) => slideTextAgent.transcribe({ jpegBuffer }),
    onSettled: ({ slideLabel, status, textLength, errorMessage, source, fallbackReason, lineCount, elapsedMs }) => {
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
      return { isEmitted: false };
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
      return { isEmitted: false };
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
      return { isEmitted: false };
    }
    narrationHistory.remember({ text, source, ts, slotMap, slideLabel, narrationClass: resolvedClass });
    // Orchestrator 의 main 단계는 여기까지다(기능 끄기 → 차단 규칙 → 중복). 렌더러의 우선순위 대기 줄이 재생할 해설을 고르면
    // 그때 pipeline-tts 로 합성한다(Orchestrator → TTS → 전달 Layer). 대기 줄에서 버려지는 해설은 합성하지 않는다.
    await appendRecord({
      kind: RECORD_KIND_MAP.narration, ts, source, text, slideLabel, isEmitted: true,
      narrationClass: resolvedClass,
      eventVideoTimeMs: Number.isFinite(eventVideoTimeMs) ? eventVideoTimeMs : null,
    });
    getViewerView()?.webContents.send('pipeline-event', {
      type: 'caption', ts, text, source, slideLabel, rationale,
      narrationClass: resolvedClass,
      eventVideoTimeMs: Number.isFinite(eventVideoTimeMs) ? eventVideoTimeMs : null,
    });
    return { isEmitted: true };
  }

  // 전달 Layer 앞의 TTS. 렌더러 대기 줄이 이번에 재생할 해설로 고른 것만 합성한다.
  ipcMain.handle('pipeline-tts', async (_event, { ts = Date.now(), text = '', source = null } = {}) => {
    try {
      const wavData = await ttsClient.synthesize({ text });
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

  ipcMain.handle('pipeline-session-start', async (_event, { mode = '', asrLanguage } = {}) => {
    describedStore.reset();
    captionDescribed.reset();
    screenRegistry.reset();
    slideTopicRegistry.reset();
    speakerRegistry.reset();
    narrationHistory.reset();
    silenceGate.reset();
    slideTextStore.reset();
    const meetingLanguage = applySessionMeetingLanguage({ asrLanguageSession, asrLanguage });
    const { sessionId } = sessionStore.startSession({ mode, asrLanguage: meetingLanguage });
    contextGeneration += 1;
    contextStore.start({ sessionId, startedAt: Date.now() });
    console.log(`[pipeline] ■ 캡처 세션 시작 (모드=${mode}, 회의 언어=${meetingLanguage}, ${sessionId}) — 중복 이력·화면 레지스트리 초기화`);
    markDebug({
      stage: DEBUG_STAGE_MAP.session, verdict: DEBUG_VERDICT_MAP.info,
      reason: '세션 시작', detail: `모드=${mode} · 회의 언어=${meetingLanguage} · ${sessionId} · 기록=${recordStore.filePath}`,
    });

    return { isOk: true, sessionId, recordPath: recordStore.filePath, gapSource: config.gapSource };
  });

  ipcMain.handle('pipeline-session-end', async () => {
    const sessionId = sessionStore.getCurrentSessionId();
    if (!sessionId) return { isOk: false, message: '진행 중인 세션이 없습니다' };
    const drainedCount = await drainPendingAsr();

    await appendRecord({
      kind: RECORD_KIND_MAP.debug, ts: Date.now(),
      stage: DEBUG_STAGE_MAP.session, verdict: DEBUG_VERDICT_MAP.info,
      reason: '세션 종료', detail: `${sessionId} · ASR 드레인 ${drainedCount}건`, narrationType: null,
    });

    lastSession = sessionStore.endSession({ endedAt: Date.now() });
    lastContextSnapshot = contextStore.snapshot();
    const contextFilePath = await contextFile.flush();
    console.log(`[context] 컨텍스트 저장 ${contextFilePath || '(실패)'} — 슬라이드 ${lastContextSnapshot.slideList.length}장 · 발화 ${lastContextSnapshot.utteranceList.length}건`);
    const scriptFilePath = await contextFile.writeText({
      fileName: buildScriptFileName({ sessionId }), text: buildTranscriptScript({ snapshot: lastContextSnapshot }),
    });
    console.log(`[context] 대화 스크립트 ${scriptFilePath || '(실패)'}`);
    // 사용자 문서 폴더의 회의 기록. 실패해도 회의 종료는 계속한다.
    const archiveDir = await meetingArchive?.saveScript({
      sessionId, startedAt: lastSession.startedAt, endedAt: lastSession.endedAt,
      title: pickMeetingTitle({ snapshot: lastContextSnapshot }),
      slideCount: lastContextSnapshot.slideList.length, utteranceCount: lastContextSnapshot.utteranceList.length,
      scriptText: buildTranscriptScript({ snapshot: lastContextSnapshot }),
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
      const slideMajor = String(slideLabel ?? '').split('-')[0];

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
      });
      const displayNumber = slideTopicRegistry.resolveDisplayNumber({ entry: slideEntry })
        || visiblePageNumber || slideMajor;
      markDebug({
        stage: DEBUG_STAGE_MAP.slide, verdict: DEBUG_VERDICT_MAP.info, ts,
        narrationType: NARRATION_TYPE_MAP.pageTransition,
        reason: `주제 판정 ${topicVerdict.kind}`,
        detail: `${topicDetail} 번호=${displayNumber}`
          + `(${visiblePageNumber ? '화면표기' : '안내순서'}) 임베딩라벨=${slideLabel}`
          + (isRevisit && !isRevisitFinal ? ' · 임베딩 복귀 판정을 주제로 뒤집음' : ''),
      });

      if (isRevisitFinal) {
        const revisitNarration = `이전 슬라이드 ${displayNumber}: ${result.pageTopic || result.narration}`;
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
          narration: '', skipReason: 'incomplete_description',
          rejectedDescription: result.rejectedDescription,
          rejectedRawDescription: result.rejectedRawDescription,
          displayNumber, pageNumber: result.pageNumber, pageTopic: result.pageTopic,
        });
        console.log(`[pipeline]   묘사 미완결 드롭 [${result.screenType}] 절삭후="${result.rejectedDescription}" 원문="${result.rejectedRawDescription}"`);
        markDebug({
          stage: DEBUG_STAGE_MAP.vlm, verdict: DEBUG_VERDICT_MAP.skip, ts,
          narrationType: NARRATION_TYPE_MAP.pageTransition,
          reason: '묘사가 완결되지 않아 고지하지 않음',
          detail: `화면유형=${result.screenType} 슬라이드=${slideLabel} 절삭후="${result.rejectedDescription}" 원문="${result.rejectedRawDescription}"`,
        });
        return { isOk: true, narration: '', isEmitted: false };
      }
      // 고지를 끈 상태면 사용자가 듣지 못한 요소이므로 지시 해설이 "이미 설명함"으로 건너뛰지 않게 등록하지 않는다.
      const isTransitionEnabled = featureGate.isEnabled(NARRATION_CLASS_MAP.pageTransition);
      const narration = result.screenType === 'ppt' && displayNumber
        ? `슬라이드 ${displayNumber}: ${result.narration}`
        : result.narration;
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
        reason: '전환 내레이션 생성',
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
            console.log(`[pipeline]   2-4A 반응 묘사 "${truncateForLog(visual.text)}"`);
            markDebug({
              stage: DEBUG_STAGE_MAP.vlm, verdict: DEBUG_VERDICT_MAP.pass, ts,
              narrationType: NARRATION_TYPE_MAP.visualDescription,
              reason: '2-4A 반응 묘사 생성 (사진 단독 제시)', detail: `"${visual.text}"`,
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
              reason: '2-4A NONE (묘사할 것 없음)', detail: `슬라이드=${slideLabel}`,
            });
          }
        } catch (visualError) {
          console.warn(`[pipeline]   2-4A 반응 묘사 실패(무시): ${visualError.message}`);
          markDebug({
            stage: DEBUG_STAGE_MAP.vlm, verdict: DEBUG_VERDICT_MAP.fail, ts,
            narrationType: NARRATION_TYPE_MAP.visualDescription,
            reason: '2-4A 생성 실패(무시)', detail: visualError.message,
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

  ipcMain.handle('pipeline-slide-text', async (_event, { slideLabel, buffer }) => {
    const isStarted = slideTextStore.ensure({ slideLabel, jpegBuffer: Buffer.from(buffer) });
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
        ? buildSpeakerIdentityFromDom({ speakerName, position, participantId })
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

  // 무발화(4-1): 발표자가 화면을 보라고 한 뒤 5초 이상 침묵하면 화면을 묘사한다. 애매하면 내지 않는다.
  // 렌더러 재생 대기 줄이 버리거나 질문 답이 끊은 해설. 듣지 못했으므로 중복 억제·재설명 금지 기록을 되돌린다.
  ipcMain.on('pipeline-narration-dropped', (_event, {
    ts, text, slideLabel = null, narrationClass = null, reason = '',
  } = {}) => {
    const isForgotten = narrationHistory.forget({ ts, text });
    const described = captionDescribed.revert({ ts, text });
    const isContextForgotten = contextStore.forgetNarration({ ts, text });
    // 듣지 못한 화자 안내면 같은 화자를 다음 폴링에서 다시 안내하게 한다.
    if (narrationClass === NARRATION_CLASS_MAP.speakerIdentity) speakerRegistry.reset();
    // 듣지 못한 무발화 해설이면 그 슬라이드의 "이미 냄" 기록을 지운다(슬라이드당 1회·분당 1회).
    if (narrationClass === NARRATION_CLASS_MAP.silenceBased) silenceGate.revert({ slideLabel });
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
    const transcriptLog = `직전 발화="${truncateForLog(recentTranscript, 80)}" 무음=${silenceSec}초 슬라이드=${slideLabel}`;
    const debugByStatusMap = {
      [SILENCE_RESULT_MAP.gated]: {
        verdict: DEBUG_VERDICT_MAP.skip, reason: SILENCE_GATE_LABEL_MAP[result.reason] || result.reason,
      },
      [SILENCE_RESULT_MAP.blocked]: {
        verdict: DEBUG_VERDICT_MAP.skip, reason: `화면 제시 단서 없음 → 차단 (${result.reason || result.source})`,
      },
      [SILENCE_RESULT_MAP.none]: {
        verdict: DEBUG_VERDICT_MAP.skip,
        reason: result.rawText ? `끝이 흐린 묘사 폐기 ("${result.rawText}")` : '묘사할 것 없음 (NONE)',
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
        const trigger = speechTrigger.detect({ text: result.text });
        if (trigger.candidateList.length) {
          markDebug({
            stage: DEBUG_STAGE_MAP.router, verdict: DEBUG_VERDICT_MAP.info, ts: startTs,
            reason: `트리거 후보 ${trigger.candidateList.length}개 (${trigger.analyzer})`,
            detail: `${formatTriggerCandidateList(trigger.candidateList)} · 전사="${truncateForLog(result.text, 80)}"`,
          });
        }
        getViewerView()?.webContents.send('pipeline-event', {
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

  ipcMain.handle('pipeline-deixis', async (_event, { ts, buffer, utterance, recentTranscript, beforeTranscript, afterTranscript, hasPointingRegion, pointingOrderHint, slideLabel, wordBudgetMap, eventVideoTimeMs = null, triggerCandidateList = [] }) => {
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
      let judgeReason = null;
      let selectedCandidate = null;
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

      const wordBudget = wordBudgetMap?.[narrationType] || null;
      const generatorArgs = {
        jpegBuffer: Buffer.from(buffer), utterance, recentTranscript, describedElementList,
        minWordCount: wordBudget?.minWordCount, maxWordCount: wordBudget?.maxWordCount,
        subKind: selectedCandidate?.subKind || null,
        mergedAnchorList: selectedCandidate?.mergedAnchorList || [],
      };

      const extraArgByTypeMap = {
        [NARRATION_TYPE_MAP.visualDescription]: {
          subKind: selectedCandidate?.subKind || VISUAL_DESCRIPTION_KIND_MAP.scale,
        },
        [NARRATION_TYPE_MAP.deixis]: { hasPointingRegion, pointingOrderHint },
      };
      const agent = agentFieldMap[narrationType] || agentFieldMap[NARRATION_TYPE_MAP.deixis];
      const { text, isGrounded, slotMap } = await agent.generate({
        ...generatorArgs, ...(extraArgByTypeMap[narrationType] || {}),
      });
      await appendRecord({
        kind: RECORD_KIND_MAP.deixis, ts, utterance, caption: text, isGrounded, judgeReason, slideLabel,
        routerMode: config.routerMode, narrationType, subKind: selectedCandidate?.subKind || null,
      });
      if (!isGrounded || !text) {
        console.log(`[pipeline] ${narrationType} 스킵 (${Date.now() - startedAt}ms) "${truncateForLog(utterance, 30)}" → 특정 불가/중복/근거없음`);
        markDebug({
          stage: DEBUG_STAGE_MAP.vlm, verdict: DEBUG_VERDICT_MAP.skip, ts, narrationType,
          reason: 'NONE — 특정 불가/이미 설명됨/근거 없음',
          detail: `발화="${utterance}" 세부=${selectedCandidate?.subKind || '-'} (${Date.now() - startedAt}ms)`,
        });
        return { isOk: true, isGrounded: false };
      }
      if (narrationType === NARRATION_TYPE_MAP.interpretation && slotMap?.value) {
        const slideText = slideTextStore.get(slideLabel);
        const valueVerdict = await verifyValuePresence({
          value: slotMap.value, slideText: slideText.text, slideTextStatus: slideText.status,
          utterance, contextText: [beforeText, afterText].filter(Boolean).join(' '),
          subKind: selectedCandidate?.subKind || INTERPRETATION_KIND_MAP.valueToMeaning,
          // 값이 없다고 나오면 지금 화면을 OCR 과 다른 엔진(VLM)으로 다시 읽어, 클릭으로 나타난 값과 OCR 오독을 함께 거른다.
          retranscribe: () => slideTextAgent.transcribeWithVlm({ jpegBuffer: Buffer.from(buffer) }),
        });
        const verdictByValueMap = {
          [VALUE_PRESENCE_VERDICT_MAP.present]: DEBUG_VERDICT_MAP.pass,
          [VALUE_PRESENCE_VERDICT_MAP.absent]: DEBUG_VERDICT_MAP.skip,
          [VALUE_PRESENCE_VERDICT_MAP.unchecked]: DEBUG_VERDICT_MAP.info,
        };
        markDebug({
          stage: DEBUG_STAGE_MAP.valueCheck, verdict: verdictByValueMap[valueVerdict.verdict], ts, narrationType,
          reason: `값 존재 검사 ${valueVerdict.verdict}`,
          detail: `값="${slotMap.value}" 슬라이드=${slideLabel || '-'} 전사=${slideText.status}`
            + `${valueVerdict.reason ? ` · ${valueVerdict.reason}` : ''} → "${text}"`,
        });
        if (valueVerdict.verdict === VALUE_PRESENCE_VERDICT_MAP.absent) {
          await appendRecord({
            kind: RECORD_KIND_MAP.deixis, ts, utterance, caption: text, isGrounded: false, slideLabel,
            narrationType, subKind: selectedCandidate?.subKind || null, skipReason: 'value-absent',
          });
          return { isOk: true, isGrounded: false };
        }
      }
      markDebug({
        stage: DEBUG_STAGE_MAP.vlm, verdict: DEBUG_VERDICT_MAP.pass, ts, narrationType,
        reason: `생성 ${narrationType}/${selectedCandidate?.subKind || '-'}`,
        detail: `발화="${utterance}" → "${text}" (${Date.now() - startedAt}ms, 예산 ${wordBudget?.minWordCount ?? '-'}~${wordBudget?.maxWordCount ?? '-'}어절)`,
      });

      captionDescribed.add({ ts, text, slideLabel, elementList: [text] });
      console.log(`[pipeline] ${narrationType} 캡션 (${Date.now() - startedAt}ms) "${truncateForLog(utterance, 20)}" → "${truncateForLog(text)}"`);

      stage = PIPELINE_STAGE_MAP.tts;
      const sent = await sendCaption({
        ts, text, source: narrationType, slideLabel, slotMap,
        hasPointingRegion,
        narrationClass: toNarrationClass({ narrationType }), eventVideoTimeMs,
        rationale: {
          utterance,
          subKind: selectedCandidate?.subKind || null,
          summary: `근거 표현=${[selectedCandidate?.anchor, ...(selectedCandidate?.mergedAnchorList || [])].filter(Boolean).join(', ') || '(없음)'}`
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
    questionText = null, recentTranscript = '', wordBudget, eventVideoTimeMs = null }) => {
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

  ipcMain.handle('pipeline-question', async (_event, { ts, buffer, questionText, recentTranscript = '',
    wordBudget, currentSlideLabel = null, speakerHintNow = null, inputSource = 'typed',
    eventVideoTimeMs = null, heardWallTs = null, heardVideoTimeMs = null }) => {
    const startedAt = Date.now();
    const currentSlideMajor = toSlideMajor(currentSlideLabel) ?? contextStore.getCurrentSlideMajor();
    const followUpQa = selectFollowUpQa({ lastQa: contextStore.getLastQa(), now: Date.now() });
    try {
      const ruled = classifyQuestion(questionText);
      const ruledMajor = ruled?.route === QUESTION_ROUTE_MAP.pastSlide
        ? contextStore.resolveSlideNumber(ruled.spokenNumber) : null;
      const isRuledUsable = ruled && (ruled.route !== QUESTION_ROUTE_MAP.pastSlide || ruledMajor !== null);
      const routed = isRuledUsable
        ? { route: ruled.route, slideMajorList: ruledMajor === null ? [] : [ruledMajor], source: 'rule', reason: '' }
        : await questionRouter.route({
          questionText, currentSlideMajor, index: contextStore.buildIndex(), followUpQa,
          startedAt: contextStore.getSessionInfo().startedAt,
        });
      markDebug({
        stage: DEBUG_STAGE_MAP.question, verdict: DEBUG_VERDICT_MAP.info, ts,
        narrationType: NARRATION_TYPE_MAP.userCommand,
        reason: `질문 갈래 ${routed.route} (${routed.source})`,
        detail: `"${questionText}" 입력=${inputSource} 대상=[${routed.slideMajorList.join(', ')}]`
          + `${followUpQa ? ` 직전질문="${followUpQa.question}"` : ''}${routed.reason ? ` · ${routed.reason}` : ''}`,
      });

      const result = routed.route === QUESTION_ROUTE_MAP.currentScreen
        ? await agentFieldMap[NARRATION_TYPE_MAP.userCommand].generate({
          jpegBuffer: Buffer.from(buffer), questionText, recentTranscript,
          contextText: buildCurrentSlideContextText(currentSlideMajor),
          minWordCount: wordBudget?.minWordCount, maxWordCount: wordBudget?.maxWordCount,
        })
        : await questionAnswerer.answer({
          route: routed.route, slideMajorList: routed.slideMajorList, questionText, wordBudget, speakerHintNow,
          heardWallTs, heardVideoTimeMs,
        });
      const text = result.isGrounded && result.text ? result.text : NOT_FOUND_TEXT;
      // 직전 Q&A 를 실제로 라우터에 넣었을 때만 되묻기로 친다. 규칙으로 처리한 질문은 다음 되묻기를 막지 않는다.
      contextStore.addQa({
        ts, question: questionText, answer: text, route: routed.route,
        slideMajorList: routed.slideMajorList, isFollowUp: Boolean(followUpQa) && routed.source !== 'rule',
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
  };
}

module.exports = { registerPipeline, DEBUG_STAGE_MAP, DEBUG_VERDICT_MAP };
