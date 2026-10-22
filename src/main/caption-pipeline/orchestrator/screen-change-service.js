// 화면 변화 해설(같은 슬라이드 변화 해설·늦은 근거 재시도)을 파이프라인에 잇는다. 사건 처리 순서는 screen-change-narrator 가 정하고,
// 여기서는 실제 OCR·에이전트·내보내기(sendCaption)·기록을 묶는다. SEEON_SCREEN_CHANGE=off(기본)이면 아무것도 하지 않는다.
const {
  NARRATION_TYPE_MAP, NARRATION_CLASS_MAP, VISUAL_DESCRIPTION_KIND_MAP, INTERPRETATION_KIND_MAP,
} = require('../contracts/narration-types');
const { toNarrationClass } = require('../contracts/narration-class');
const { DEBUG_STAGE_MAP, DEBUG_VERDICT_MAP } = require('../contracts/debug-events');
const { RECORD_KIND_MAP } = require('../instrumentation/record-store');
const { describeAgentRejection } = require('../agents/shared/caption-parser');
const { assembleNarration } = require('../agents/shared/narration-format');
const { isValuePresent, readValueCheckTarget, VALUE_PRESENCE_VERDICT_MAP } = require('./value-presence');
const { checkSpokenValueMatch, SPOKEN_VALUE_VERDICT_MAP } = require('../prompts/approximate-value');
const { SLIDE_TEXT_STATUS_MAP } = require('./slide-text-store');
const { createScreenChangeGate } = require('./screen-change-gate');
const { createPendingEvidence } = require('./pending-evidence');
const { createScreenChangeBaseline } = require('./screen-change-baseline');
const {
  createScreenChangeNarrator, toEmitSkipReason, SCREEN_CHANGE_DECISION_MAP, SCREEN_CHANGE_SKIP_MAP,
} = require('./screen-change-narrator');
const { SCREEN_CHANGE_MODE_MAP } = require('../config');

// 이미 말한 값 거르기에 쓰는 최근 해설 창. 이 안에 낸 해설에 같은 값이 있으면 변화 해설 VLM 을 부르지 않는다.
const RECENT_NARRATION_WINDOW_MS = 20000;
const RECENT_NARRATION_LIMIT = 4;
const RETRY_ORIGIN = 'screen_change_retry';

function toBuffer(value) {
  return value ? Buffer.from(value) : null;
}

const VERDICT_BY_DECISION_MAP = {
  [SCREEN_CHANGE_DECISION_MAP.emitted]: DEBUG_VERDICT_MAP.pass,
  [SCREEN_CHANGE_DECISION_MAP.shadow]: DEBUG_VERDICT_MAP.info,
  [SCREEN_CHANGE_DECISION_MAP.skipped]: DEBUG_VERDICT_MAP.skip,
};

function formatRegion(regionNorm) {
  if (!regionNorm) return '-';
  return ['x', 'y', 'w', 'h'].map((key) => Number(regionNorm[key]).toFixed(2)).join(',');
}

function formatChangeRecord(entry) {
  const ocr = entry.ocr;
  return `슬라이드=${entry.slideLabel ?? '-'} 영역=${formatRegion(entry.regionNorm)} 칸=${entry.cellCount ?? '-'}`
    + (ocr ? ` · OCR ${ocr.ms ?? '-'}ms 줄 ${ocr.lineCount} 새 줄 ${ocr.addedLineCount} 빠진 줄 ${ocr.removedLineCount}`
      + `${ocr.skipReason ? `(${ocr.skipReason})` : ''}` : '')
    + ` · 이미 말함 ${entry.spokenFilteredCount} · VLM ${entry.isVlmCalled ? '부름' : '안 부름'}`
    + `${entry.retryOfTs ? ` · 다시 본 트리거 ts=${entry.retryOfTs}` : ''}`
    + `${entry.wouldRetry ? ' · 다시 부를 트리거 있음' : ''}`
    + `${entry.rejectReason ? ` · 거절="${entry.rejectReason}"` : ''}`;
}

function createScreenChangeService({
  config, agentFieldMap, ocrClient, narrationHistory, describedStore, captionDescribed, slideTextStore,
  sendCaption, appendRecord, markDebug, getCaptionLanguage = () => undefined, now = Date.now,
}) {
  const getMode = () => config.screenChangeMode;

  async function recordChange(entry) {
    await appendRecord(entry);
    markDebug({
      stage: DEBUG_STAGE_MAP.screenChange, verdict: VERDICT_BY_DECISION_MAP[entry.decision] || DEBUG_VERDICT_MAP.info,
      narrationType: NARRATION_TYPE_MAP.screenChange, ts: entry.ts,
      reason: `화면 변화 ${entry.origin}/${entry.eventKind || '-'} → ${entry.decision}${entry.skipReason ? ` (${entry.skipReason})` : ''}`,
      detail: formatChangeRecord(entry),
    });
  }

  function describeChange({ jpegBuffer, eventKind, lineList, recentTranscript, slideLabel, wordBudget, imageMode }) {
    return agentFieldMap[NARRATION_TYPE_MAP.screenChange].generate({
      jpegBuffer, eventKind, lineList, recentTranscript,
      describedElementList: describedStore.getDescribed(slideLabel),
      minWordCount: wordBudget?.minWordCount, maxWordCount: wordBudget?.maxWordCount,
      imageMode: imageMode || config.screenChangeImage,
    });
  }

  async function emitChange({ text, slotMap, eventKind, slideLabel, ts, eventVideoTimeMs, lineList }) {
    const sent = await sendCaption({
      ts, text, source: NARRATION_TYPE_MAP.screenChange, slideLabel, slotMap,
      narrationClass: NARRATION_CLASS_MAP.screenChange, eventVideoTimeMs,
      rationale: {
        subKind: eventKind,
        summary: `같은 슬라이드 화면 변화${lineList.length ? ` · 새 글자="${lineList.slice(0, 2).join(' / ')}"` : ''}`,
      },
    });
    if (sent.isEmitted) captionDescribed.add({ ts, text, slideLabel, elementList: [text] });
    return sent;
  }

  // 값 검사는 새 화면의 OCR 글자로만 한다. 해설 한 건에 VLM 을 두 번 부르지 않으려고 VLM 재전사는 하지 않는다.
  // OCR 글자가 없으면(그 화면 OCR 실패) 슬라이드 전사로 본다.
  function checkRetryValue({ value, subKind, note, frame, slideLabel }) {
    const isFrameChecked = typeof frame.text === 'string';
    const stored = isFrameChecked ? null : slideTextStore.get(slideLabel);
    return isValuePresent({
      value, utterance: note.utterance, contextText: note.contextText, subKind,
      slideText: isFrameChecked ? frame.text : stored.text,
      slideTextStatus: isFrameChecked ? SLIDE_TEXT_STATUS_MAP.ready : stored.status,
    }).verdict !== VALUE_PRESENCE_VERDICT_MAP.absent;
  }

  async function retryAgent({ note, frame, ts, eventVideoTimeMs, slideLabel }) {
    const { narrationType } = note;
    const agent = agentFieldMap[narrationType];
    if (!agent) return { isVlmCalled: false, isEmitted: false, skipReason: 'no_agent' };
    const extraArgByTypeMap = {
      [NARRATION_TYPE_MAP.visualDescription]: {
        subKind: note.subKind || VISUAL_DESCRIPTION_KIND_MAP.scale, screenLineList: frame.lineList,
      },
      [NARRATION_TYPE_MAP.deixis]: { hasPointingRegion: false, pointingOrderHint: '' },
      [NARRATION_TYPE_MAP.interpretation]: { screenLineList: frame.lineList },
    };
    const result = await agent.generate({
      ...note.generatorArgs, jpegBuffer: frame.buffer,
      describedElementList: [
        ...describedStore.getDescribed(slideLabel), ...narrationHistory.getRecentTextList({ limit: RECENT_NARRATION_LIMIT }),
      ],
      ...(extraArgByTypeMap[narrationType] || {}),
    });
    const { isGrounded, slotMap, rejectKind = null, rejectReason = '', rawContent = '' } = result || {};
    let text = result?.text || '';
    const recordBase = {
      kind: RECORD_KIND_MAP.deixis, ts, utterance: note.utterance, slideLabel, narrationType, subKind: note.subKind,
      origin: RETRY_ORIGIN, retryOfTs: note.ts,
    };
    if (!isGrounded || !text) {
      await appendRecord({ ...recordBase, caption: '', isGrounded: false, rejectKind, rejectReason, rawContent });
      markDebug({
        stage: DEBUG_STAGE_MAP.vlm, verdict: DEBUG_VERDICT_MAP.skip, ts, narrationType,
        reason: `화면 변화 뒤 다시 봄 — ${describeAgentRejection({ rejectKind, rejectReason, rawContent }).reason}`,
        detail: `발화="${note.utterance}" 다시 본 트리거 ts=${note.ts}`,
      });
      return { isVlmCalled: true, isEmitted: false, skipReason: SCREEN_CHANGE_SKIP_MAP.vlmNone };
    }
    // 원래 경로(pipeline-deixis)와 같은 값 검사를 한다. 대조할 값은 수치의 값 칸과 척도 값 먼저(켜짐)의 척도 수이고,
    // 화면 값 먼저(켜짐)의 값→의미는 값이 발화의 수(어림 값이면 ±15%)와 멀면 화면에 있어도 읽지 않는다.
    const valueCheckTarget = readValueCheckTarget({
      narrationType, subKind: note.subKind, slotMap, text, contentSwitch: config.contentSwitch,
    });
    const isSpokenValueChecked = config.contentSwitch?.isScreenValueFirstEnabled
      && valueCheckTarget?.checkSubKind === INTERPRETATION_KIND_MAP.valueToMeaning;
    const spokenValueMatch = isSpokenValueChecked
      ? checkSpokenValueMatch({ value: valueCheckTarget.value, utterance: note.utterance }) : null;
    if (spokenValueMatch?.verdict === SPOKEN_VALUE_VERDICT_MAP.far) {
      await appendRecord({ ...recordBase, caption: text, isGrounded: false, skipReason: 'value-far-from-spoken' });
      markDebug({
        stage: DEBUG_STAGE_MAP.valueCheck, verdict: DEBUG_VERDICT_MAP.skip, ts, narrationType,
        reason: '화면 변화 뒤 다시 봄 — 발화 값 대조 far', detail: `값="${valueCheckTarget.value}" · ${spokenValueMatch.reason} → "${text}"`,
      });
      return { isVlmCalled: true, isEmitted: false, skipReason: SCREEN_CHANGE_SKIP_MAP.valueFarFromSpoken };
    }
    if (valueCheckTarget) {
      if (!checkRetryValue({ value: valueCheckTarget.value, subKind: valueCheckTarget.checkSubKind, note, frame, slideLabel })) {
        await appendRecord({ ...recordBase, caption: text, isGrounded: false, skipReason: 'value-absent' });
        markDebug({
          stage: DEBUG_STAGE_MAP.valueCheck, verdict: DEBUG_VERDICT_MAP.skip, ts, narrationType,
          reason: '화면 변화 뒤 다시 봄 — 값 존재 검사 absent', detail: `값="${valueCheckTarget.value}" → "${text}"`,
        });
        return { isVlmCalled: true, isEmitted: false, skipReason: SCREEN_CHANGE_SKIP_MAP.valueAbsent };
      }
      // 둘째 값이 새 화면에 없으면 첫 쌍만 읽는다(원래 경로와 같은 규칙).
      if (slotMap?.value2 && text.includes(slotMap.value2) && !checkRetryValue({
        value: slotMap.value2, subKind: valueCheckTarget.checkSubKind, note, frame, slideLabel,
      })) {
        const firstPair = assembleNarration({
          narrationType, subKind: note.subKind, rawSlotMap: { ...slotMap, target2: '', value2: '' },
          maxWordCount: result.appliedBudget?.maxWordCount, maxChars: result.appliedBudget?.maxChars,
          language: getCaptionLanguage(),
        });
        text = firstPair?.text || text;
      }
    }
    await appendRecord({ ...recordBase, caption: text, isGrounded: true });
    markDebug({
      stage: DEBUG_STAGE_MAP.vlm, verdict: DEBUG_VERDICT_MAP.pass, ts, narrationType,
      reason: `화면 변화 뒤 다시 봄 — 생성 ${narrationType}/${note.subKind || '-'}`,
      detail: `발화="${note.utterance}" → "${text}" 다시 본 트리거 ts=${note.ts}`,
    });
    captionDescribed.add({ ts, text, slideLabel, elementList: [text] });
    const sent = await sendCaption({
      ts, text, source: narrationType, slideLabel, slotMap,
      narrationClass: toNarrationClass({ narrationType }), eventVideoTimeMs,
      rationale: {
        utterance: note.utterance, subKind: note.subKind,
        summary: `화면 변화 뒤 다시 봄(근거가 발화보다 늦게 나타남) · 근거 표현=${note.anchorText || '(없음)'}`,
      },
    });
    return { isVlmCalled: true, isEmitted: sent.isEmitted, skipReason: sent.isEmitted ? null : toEmitSkipReason(sent.reason) };
  }

  const narrator = createScreenChangeNarrator({
    getMode,
    kindList: config.screenChangeKindList,
    gate: createScreenChangeGate({ perSlideMax: config.screenChangePerSlideMax }),
    pendingEvidence: createPendingEvidence({ now }),
    baselineStore: createScreenChangeBaseline(),
    recognize: ({ jpegBuffer }) => ocrClient.recognize({ jpegBuffer }),
    findRateLimited: ({ ts }) => narrationHistory.findRateLimited({ narrationClass: NARRATION_CLASS_MAP.screenChange, ts }),
    getRecentNarrationTextList: () => narrationHistory.getEntryList()
      .filter((entry) => now() - entry.ts <= RECENT_NARRATION_WINDOW_MS).map((entry) => entry.text),
    describe: describeChange,
    retry: retryAgent,
    emit: emitChange,
    record: recordChange,
    now,
  });

  async function handleBaseline(payload = {}) {
    const result = await narrator.handleBaseline({ ...payload, buffer: toBuffer(payload.buffer) });
    if (result) {
      markDebug({
        stage: DEBUG_STAGE_MAP.screenChange, verdict: result.isSeeded ? DEBUG_VERDICT_MAP.info : DEBUG_VERDICT_MAP.skip,
        reason: `화면 변화 기준 화면 ${result.isSeeded ? '잡음' : '못 잡음'}${payload.isSlideStart ? '(슬라이드 시작)' : ''}`,
        detail: `슬라이드=${payload.slideLabel} OCR ${result.ocr.ms ?? '-'}ms 줄 ${result.ocr.lineCount}`
          + `${result.ocr.skipReason ? ` · ${result.ocr.skipReason}` : ''}`,
      });
    }
    return { isOk: true, isSeeded: Boolean(result?.isSeeded) };
  }

  async function handleChange(payload = {}) {
    const entry = await narrator.handleChange({
      ...payload, buffer: toBuffer(payload.buffer), vlmBuffer: toBuffer(payload.vlmBuffer),
    });
    return { isOk: true, decision: entry?.decision ?? null, skipReason: entry?.skipReason ?? null };
  }

  // pipeline-deixis 가 NONE·값 없음으로 끝났을 때 부른다. 원래 에이전트를 다시 부를 인자를 그림 없이 담아 둔다.
  // 발화 ROI 의 확대 그림(zoom…)도 원래 판정 프레임의 일부라 빼 둔다. 새 화면에 옛 확대를 붙이면 두 장이 다른 순간이 된다.
  function noteUnresolved({ ts, frameTs = null, slideLabel, narrationType, selectedCandidate = null, generatorArgs = {},
    rejectKind = null, beforeText = '', afterText = '' }) {
    const {
      jpegBuffer, describedElementList, zoomJpegBuffer, zoomKind, zoomTerm, ...argsWithoutImage
    } = generatorArgs;
    return narrator.noteUnresolved({
      ts, captureTs: Number.isFinite(frameTs) ? frameTs : ts, slideLabel, narrationType,
      subKind: selectedCandidate?.subKind || null, rejectKind,
      utterance: generatorArgs.utterance || '', contextText: [beforeText, afterText].filter(Boolean).join(' '),
      anchorText: [
        selectedCandidate?.anchor, ...(selectedCandidate?.mergedAnchorList || []), ...(selectedCandidate?.mergedClaimList || []),
      ].filter(Boolean).join(', '),
      generatorArgs: argsWithoutImage,
    }).catch((error) => {
      console.warn(`[screen-change] 늦은 근거 재시도 실패(무시): ${error.message}`);
      return false;
    });
  }

  return {
    handleBaseline,
    handleChange,
    noteUnresolved,
    revert: ({ slideLabel }) => narrator.revert({ slideLabel }),
    reset: () => narrator.reset(),
    isEnabled: () => getMode() !== SCREEN_CHANGE_MODE_MAP.off,
    describeSession: () => ({
      mode: config.screenChangeMode, image: config.screenChangeImage, kindList: [...config.screenChangeKindList],
      minIntervalMs: config.screenChangeMinIntervalMs, perSlideMax: config.screenChangePerSlideMax,
    }),
    // 세션 시작 기록(pipeline.jsonl debug)에 남기는 문구. 실험 실행이 env 로 켰는지 결과 폴더에서 확인한다.
    describeSessionText: () => (getMode() === SCREEN_CHANGE_MODE_MAP.off ? SCREEN_CHANGE_MODE_MAP.off
      : `${config.screenChangeMode}(간격 ${Math.round(config.screenChangeMinIntervalMs / 1000)}초`
        + ` · 슬라이드당 ${config.screenChangePerSlideMax}번 · 종류 ${config.screenChangeKindList.join(',')}`
        + ` · 그림 ${config.screenChangeImage})`),
  };
}

module.exports = { createScreenChangeService, RECENT_NARRATION_WINDOW_MS, RETRY_ORIGIN };
