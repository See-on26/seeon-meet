const { ipcMain } = require('electron');
const { readPipelineConfig } = require('./config');
const {
  NARRATION_TYPE_MAP, VISUAL_DESCRIPTION_KIND_MAP, SPEAKER_SOURCE_MAP,
} = require('./contracts/narration-types');
const { buildSpeakerIdentityFromDom } = require('./agents/speaker-identity-agent');
const { DEBUG_STAGE_MAP, DEBUG_VERDICT_MAP } = require('./contracts/debug-events');
const { createAgentFieldMap } = require('./agents');
const { createUnifiedRouter, ROUTER_MODE_MAP } = require('./router/unified-router');
const { createDeixisJudgeClient } = require('./router/deixis-judge');
const { resolveCandidateList } = require('./orchestrator/arbiter');
const { createDescribedStore } = require('./orchestrator/described-store');
const { createScreenRegistry } = require('./orchestrator/screen-registry');
const { createSlideTopicRegistry, SLIDE_TOPIC_VERDICT_MAP } = require('./orchestrator/slide-topic-registry');
const { createSpeakerRegistry } = require('./orchestrator/speaker-registry');
const { createNarrationHistory } = require('./orchestrator/narration-history');
const { createAsrClient } = require('./perception/asr-client');
const { createEmbedClient } = require('./perception/embed-client');
const { createTtsClient } = require('./output/tts-client');
const { createGapInferenceAgent } = require('./output/gap-inference-agent');
const { createRecordStore, RECORD_KIND_MAP } = require('./instrumentation/record-store');
const { createSessionStore } = require('./instrumentation/session-store');
const { OUT_DIR } = require('../paths');

const ASR_DRAIN_TIMEOUT_MS = 8000;
const ASR_DRAIN_POLL_MS = 100;

const PIPELINE_STAGE_MAP = { frame: 'frame', judge: 'judge', vlm: 'vlm', caption: 'caption', tts: 'tts', asr: 'asr' };

const GENERATABLE_TYPE_LIST = [
  NARRATION_TYPE_MAP.deixis, NARRATION_TYPE_MAP.interpretation, NARRATION_TYPE_MAP.visualDescription,
];

const RECENT_NARRATION_LIMIT = 8;

const SPEECH_AXIS_SOURCE_LIST = [
  NARRATION_TYPE_MAP.deixis,
  NARRATION_TYPE_MAP.interpretation,
  NARRATION_TYPE_MAP.visualDescription,
];

function selectGeneratableCandidate({ candidateList }) {
  const generatableList = candidateList.filter(
    (candidate) => GENERATABLE_TYPE_LIST.includes(candidate.type),
  );
  if (!generatableList.length) return null;
  const { resolvedList } = resolveCandidateList({ candidateList: generatableList });
  return resolvedList[0] || null;
}

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

function registerPipeline({ getViewerView }) {
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
  const judgeClient = createDeixisJudgeClient({ config });
  const routerClient = createUnifiedRouter({ config });
  const isRouterMode = config.routerMode === ROUTER_MODE_MAP.unified;
  const describedStore = createDescribedStore();
  const screenRegistry = createScreenRegistry();
  const slideTopicRegistry = createSlideTopicRegistry();
  const speakerRegistry = createSpeakerRegistry();
  const narrationHistory = createNarrationHistory();
  console.log(`[pipeline] 발화 축 판정 경로: ${config.routerMode}`);

  function appendRecord(record) {
    return recordStore.append(sessionStore.addRecord({ record }));
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

  async function sendCaption({ ts, text, source, slideLabel = null, isDedupeExempt = false,
    rationale = null, slotMap = null, hasPointingRegion = false, isRateLimitExempt = true }) {
    if (!isRateLimitExempt) {
      const rate = narrationHistory.findRateLimited({
        source, ts, hasPointingRegion, sourceGroupList: SPEECH_AXIS_SOURCE_LIST,
      });
      if (rate.isRateLimited) {
        await appendRecord({
          kind: RECORD_KIND_MAP.narration, ts, source, text, slideLabel, isEmitted: false,
          skipReason: 'rate-limited', sinceMs: rate.sinceMs, minIntervalMs: rate.minIntervalMs,
        });
        console.log(`[pipeline]   간격 억제 [${source}] "${truncateForLog(text)}" (직전 ${Math.round(rate.sinceMs / 1000)}초 < ${rate.minIntervalMs / 1000}초)`);
        markDebug({
          stage: DEBUG_STAGE_MAP.dedupe, verdict: DEBUG_VERDICT_MAP.skip, narrationType: source, ts,
          reason: '간격 억제',
          detail: `"${text}" — 직전 같은 축 캡션과 ${Math.round(rate.sinceMs / 1000)}초 간격`
            + ` (최소 ${rate.minIntervalMs / 1000}초${hasPointingRegion ? ', 필기 있음' : ', 발화만'})`,
        });
        return { isEmitted: false };
      }
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
    narrationHistory.remember({ text, source, ts, slotMap, slideLabel });
    let wavData = null;
    try {
      wavData = await ttsClient.synthesize({ text });
      await appendRecord({ kind: RECORD_KIND_MAP.tts, ts, byteLength: wavData.byteLength });
      markDebug({
        stage: DEBUG_STAGE_MAP.tts, verdict: DEBUG_VERDICT_MAP.pass, narrationType: source, ts,
        reason: '합성 완료', detail: `${Math.round(wavData.byteLength / 1024)}KB · "${text}"`,
      });
    } catch (ttsError) {
      console.warn(`[pipeline]   TTS 실패(텍스트만 전송) [${source}]: ${ttsError.message}`);
      markDebug({
        stage: DEBUG_STAGE_MAP.tts, verdict: DEBUG_VERDICT_MAP.fail, narrationType: source, ts,
        reason: 'TTS 실패(텍스트만)', detail: ttsError.message,
      });
    }
    await appendRecord({
      kind: RECORD_KIND_MAP.narration, ts, source, text, slideLabel, isEmitted: true,
      hasAudio: Boolean(wavData),
    });
    getViewerView()?.webContents.send('pipeline-event', {
      type: 'caption', ts, text, source, slideLabel, wavData, rationale,
    });
    return { isEmitted: true };
  }

  ipcMain.handle('pipeline-session-start', async (_event, { mode = '' } = {}) => {
    describedStore.reset();
    screenRegistry.reset();
    slideTopicRegistry.reset();
    speakerRegistry.reset();
    narrationHistory.reset();
    const { sessionId } = sessionStore.startSession({ mode });
    console.log(`[pipeline] ■ 캡처 세션 시작 (모드=${mode}, ${sessionId}) — 중복 이력·화면 레지스트리 초기화`);
    markDebug({
      stage: DEBUG_STAGE_MAP.session, verdict: DEBUG_VERDICT_MAP.info,
      reason: '세션 시작', detail: `모드=${mode} · ${sessionId} · 기록=${recordStore.filePath}`,
    });

    return { isOk: true, sessionId, recordPath: recordStore.filePath };
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
    console.log(`[pipeline] ■ 캡처 세션 종료 (${sessionId}) — 발화 ${lastSession.asrEntryList.length}건 · 슬라이드 마크 ${lastSession.slideMarkList.length}건`);
    return {
      isOk: true,
      sessionId,
      asrCount: lastSession.asrEntryList.length,
      slideMarkCount: lastSession.slideMarkList.length,
    };
  });

  ipcMain.on('pipeline-slide-mark', (_event, { ts, slideLabel, frameKind, filePath }) => {
    appendRecord({
      kind: RECORD_KIND_MAP.slideMark, ts, slideLabel, frameKind, filePath,
    }).catch(() => {});
  });

  ipcMain.handle('pipeline-frame', async (_event, { ts, buffer, slideLabel, wordBudget, isRevisit }) => {
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
          narration: revisitNarration, isRevisit: true,
        });
        console.log(`[pipeline]   복귀 축약 고지 (${Date.now() - startedAt}ms) "${truncateForLog(revisitNarration)}"`);
        const revisitSent = await sendCaption({
          ts, text: revisitNarration, source: 'page-transition', slideLabel,
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
      describedStore.addDescribed(slideLabel, result.describedElementList);

      const narration = result.screenType === 'ppt' && displayNumber
        ? `슬라이드 ${displayNumber}: ${result.narration}`
        : result.narration;
      await appendRecord({
        kind: RECORD_KIND_MAP.pageTransition, ts, slideLabel, screenType: result.screenType,
        narration, describedElementList: result.describedElementList,
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
            describedStore.addDescribed(slideLabel, [visual.text]);
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
    speakerName = '', position = '', participantId = '',
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

  ipcMain.handle('pipeline-audio', async (_event, { startTs, endTs, buffer, speakerHint }) => {
    const stage = PIPELINE_STAGE_MAP.asr;
    const startedAt = Date.now();
    pendingAsrCount += 1;
    try {
      const result = await asrClient.transcribeSegment({ webmBuffer: Buffer.from(buffer), startTs });
      const textReadyAt = Date.now();
      await appendRecord({
        kind: RECORD_KIND_MAP.asr, ts: startTs,
        text: result.text, segmentList: result.segmentList, speakerHint,
        ...(result.hallucinationText
          ? { skipReason: 'hallucination', hallucinationText: result.hallucinationText } : {}),
      });
      if (result.hallucinationText) {
        console.log(`[pipeline] ASR 환각 차단 "${result.hallucinationText}"`);
      }

      if (result.text) {
        getViewerView()?.webContents.send('pipeline-event', {
          type: 'asr', ts: startTs, endTs, text: result.text, segmentList: result.segmentList,
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

  ipcMain.handle('pipeline-deixis', async (_event, { ts, buffer, utterance, recentTranscript, beforeTranscript, afterTranscript, hasPointingRegion, pointingOrderHint, slideLabel, wordBudgetMap }) => {
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
        stage: DEBUG_STAGE_MAP.judge, verdict: DEBUG_VERDICT_MAP.skip, ts,
        narrationType: NARRATION_TYPE_MAP.deixis,
        reason: '트리거 발화도 인접 맥락도 없다 — 모사할 말이 없다',
        detail: '2-2는 상황 슬롯을 발화 모사로 채우는 형식이라, 말이 하나도 없으면 상투구밖에 나오지 않는다',
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
          const routed = await routerClient.route({ utterance, before: beforeText, after: afterText });
          judgeReason = routed.blockedReason;
          selectedCandidate = selectGeneratableCandidate({ candidateList: routed.candidateList });
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
      markDebug({
        stage: DEBUG_STAGE_MAP.vlm, verdict: DEBUG_VERDICT_MAP.pass, ts, narrationType,
        reason: `생성 ${narrationType}/${selectedCandidate?.subKind || '-'}`,
        detail: `발화="${utterance}" → "${text}" (${Date.now() - startedAt}ms, 예산 ${wordBudget?.minWordCount ?? '-'}~${wordBudget?.maxWordCount ?? '-'}어절)`,
      });

      describedStore.addDescribed(slideLabel, [text]);
      console.log(`[pipeline] ${narrationType} 캡션 (${Date.now() - startedAt}ms) "${truncateForLog(utterance, 20)}" → "${truncateForLog(text)}"`);

      stage = PIPELINE_STAGE_MAP.tts;
      const sent = await sendCaption({
        ts, text, source: narrationType, slideLabel, slotMap,
        hasPointingRegion, isRateLimitExempt: false,
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
    questionText = null, recentTranscript = '', wordBudget }) => {
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

  ipcMain.handle('pipeline-gap', async (_event, { mode, ts, narrationText, narrationType, subKind,
    rationale, screenSummary, beforeTranscript, gapList }) => {
    const startedAt = Date.now();
    const result = await gapAgent.infer({
      mode, narrationText, narrationType, subKind, rationale, screenSummary, beforeTranscript,
      gapList: gapList || [],
    });
    const chosen = Number.isInteger(result.gapIndex) ? gapList[result.gapIndex] : null;
    await appendRecord({
      kind: RECORD_KIND_MAP.gap, ts, narrationType, narration: narrationText,
      gapIndex: result.gapIndex, source: result.source, reason: result.reason,
      mode: mode || null, modelId: result.modelId || null,
      chosenOffsetMs: chosen?.offsetMs ?? null, candidateCount: (gapList || []).length,
    });
    markDebug({
      stage: DEBUG_STAGE_MAP.gap, ts, narrationType,
      verdict: chosen ? DEBUG_VERDICT_MAP.pass : DEBUG_VERDICT_MAP.skip,
      reason: chosen
        ? `틈 선택 (트리거 ${chosen.offsetMs >= 0 ? '+' : ''}${(chosen.offsetMs / 1000).toFixed(1)}초, ${result.source})`
        : `틈 미선택 → 트리거 지점 삽입 (${result.source})`,
      detail: `"${truncateForLog(narrationText)}" · 후보 ${(gapList || []).length}개`
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
    consumeLastSession() {
      const session = lastSession;
      lastSession = null;
      return session;
    },
  };
}

module.exports = { registerPipeline, DEBUG_STAGE_MAP, DEBUG_VERDICT_MAP };
