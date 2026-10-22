// 화면 변화 사건 한 건의 처리: 상한 → OCR → 글자 차이 → 이미 말한 값 거르기 → 늦은 근거 재시도 → 변화 해설 → 값 검사 → 내보내기.
// 사건 하나에 늦은 근거 재시도(원래 에이전트)와 변화 해설 중 하나만 VLM 을 한 번 부른다.
// 사건마다 결과와 상관없이 screen_change 기록을 한 줄 남긴다.
// OCR·VLM·내보내기·기록은 호출부가 넘긴다(Electron 없이 시험한다). 어느 단계에서 끝나든 게이트는 반드시 반납한다.
const { SCREEN_CHANGE_MODE_MAP } = require('../config');
const { SCREEN_CHANGE_KIND_MAP, INTERPRETATION_KIND_MAP } = require('../contracts/narration-types');
const { RECORD_KIND_MAP } = require('../instrumentation/record-store');
const { diffScreenText, isConfidentLine } = require('./screen-text-diff');
const { filterSpokenLines } = require('./spoken-value-filter');
const { evaluateOcrResult, SCREEN_TEXT_SKIP_REASON_MAP } = require('./screen-text-grounding');
const { isValuePresent, VALUE_PRESENCE_VERDICT_MAP } = require('./value-presence');
const { SLIDE_TEXT_STATUS_MAP } = require('./slide-text-store');
const { SCREEN_CHANGE_GATE_REASON_MAP } = require('./screen-change-gate');
const { isRetriableUnresolved } = require('./pending-evidence');

const SCREEN_CHANGE_ORIGIN_MAP = { sameSlide: 'same_slide', newSlide: 'new_slide', retry: 'retry' };
const SCREEN_CHANGE_DECISION_MAP = { emitted: 'emitted', skipped: 'skipped', shadow: 'shadow' };
const SCREEN_CHANGE_SKIP_MAP = {
  gateInterval: `gate:${SCREEN_CHANGE_GATE_REASON_MAP.interval}`,
  ocrError: 'ocr_error',
  ocrUnusable: 'ocr_unusable',
  noTextChange: 'no_text_change',
  kindOff: 'kind_off',
  vlmNone: 'vlm_none',
  valueAbsent: 'value_absent',
  duplicate: 'duplicate',
  rateLimited: 'rate_limited',
  notEmitted: 'not_emitted',
  error: 'error',
};
const DEFAULT_KIND_LIST = [SCREEN_CHANGE_KIND_MAP.newText, SCREEN_CHANGE_KIND_MAP.highlight];

// 내보내기(sendCaption)가 막은 까닭을 기록 값으로 바꾼다.
function toEmitSkipReason(reason) {
  if (typeof reason !== 'string' || !reason) return SCREEN_CHANGE_SKIP_MAP.notEmitted;
  if (reason.startsWith('duplicate')) return SCREEN_CHANGE_SKIP_MAP.duplicate;
  if (reason === 'rate-limited') return SCREEN_CHANGE_SKIP_MAP.rateLimited;
  return reason;
}

// 새로 뜬 글자 해설의 값은 거르기를 통과한 새 줄에 있어야 한다. 아라비아 숫자가 없는 값(낱말)은 검사하지 않는다.
function isValueOnLineList({ value, lineList }) {
  return isValuePresent({
    value, slideText: lineList.join('\n'), slideTextStatus: SLIDE_TEXT_STATUS_MAP.ready,
    subKind: INTERPRETATION_KIND_MAP.claimToValue,
  }).verdict !== VALUE_PRESENCE_VERDICT_MAP.absent;
}

function createScreenChangeNarrator({
  getMode, kindList = DEFAULT_KIND_LIST, gate, pendingEvidence, baselineStore,
  recognize, findRateLimited, getRecentNarrationTextList, describe, retry, emit, record, now = Date.now,
}) {
  async function finish(base, patch) {
    const entry = { ...base, ...patch };
    try {
      await record(entry);
    } catch (error) {
      console.warn(`[screen-change] 기록 실패(무시): ${error.message}`);
    }
    return entry;
  }

  // OCR 은 GPU 서버 임베딩 서비스의 /ocr 이다(VLM 이 아니다). 글자가 하나도 없는 화면도 기준으로 쓸 수 있다.
  async function readScreenText({ jpegBuffer }) {
    const startedAt = now();
    let response;
    try {
      response = await recognize({ jpegBuffer });
    } catch (error) {
      const detail = error?.isBypassed ? SCREEN_TEXT_SKIP_REASON_MAP.bypass : String(error?.message || error);
      return { skipReason: SCREEN_CHANGE_SKIP_MAP.ocrError, skipDetail: detail, ms: now() - startedAt };
    }
    const ms = now() - startedAt;
    if (!response || !Array.isArray(response.lineList)) {
      return { skipReason: SCREEN_CHANGE_SKIP_MAP.ocrError, skipDetail: 'invalid_response', ms };
    }
    const evaluation = evaluateOcrResult(response);
    if (evaluation.skipReason && evaluation.skipReason !== SCREEN_TEXT_SKIP_REASON_MAP.noText) {
      return { skipReason: SCREEN_CHANGE_SKIP_MAP.ocrUnusable, skipDetail: evaluation.skipReason, ms };
    }
    return {
      skipReason: null, skipDetail: null, ms,
      lineList: evaluation.lineList, imageWidth: response.imageWidth, imageHeight: response.imageHeight,
      confidentText: evaluation.lineList.filter(isConfidentLine).map((line) => line.text.trim()).join('\n'),
    };
  }

  function toOcrRecord(screenText, diff = null) {
    return {
      ms: screenText.ms ?? null,
      lineCount: screenText.lineList?.length ?? 0,
      addedLineCount: diff?.addedLineList.length ?? 0,
      removedLineCount: diff?.removedLineCount ?? 0,
      skipReason: screenText.skipDetail ?? null,
    };
  }

  function toFrame({ buffer, slideLabel, screenText }) {
    return {
      buffer, slideLabel, lineList: screenText.lineList || [], text: screenText.confidentText ?? null,
      imageWidth: screenText.imageWidth ?? null, imageHeight: screenText.imageHeight ?? null,
    };
  }

  function buildBase({ ts, slideLabel, origin, eventKind = null, regionNorm = null, changedRatio = null, cellCount = null,
    firstSeenVideoTimeMs = null }) {
    return {
      kind: RECORD_KIND_MAP.screenChange, ts, slideLabel, origin, eventKind, regionNorm, changedRatio, cellCount,
      firstSeenVideoTimeMs, ocr: null, spokenFilteredCount: 0, isVlmCalled: false,
      decision: SCREEN_CHANGE_DECISION_MAP.skipped, skipReason: null, retryOfTs: null,
    };
  }

  // 변화 해설끼리의 간격과 게이트(처리 중·슬라이드당 상한)를 OCR·VLM 전에 본다. GPU 호출을 아끼기 위해서다.
  function acquire({ ts, slideLabel }) {
    if (findRateLimited({ ts }).isRateLimited) return { skipReason: SCREEN_CHANGE_SKIP_MAP.gateInterval };
    const acquired = gate.tryAcquire({ slideLabel });
    if (!acquired.isAllowed) return { skipReason: `gate:${acquired.reason}`, gateReason: acquired.reason };
    return { ticket: acquired.ticket };
  }

  // 원래 에이전트를 새 화면으로 한 번 다시 부른다. 게이트는 호출부가 잡아 둔 표로 반납한다.
  async function runRetry({ base, note, frame, ts, eventVideoTimeMs, slideLabel, ticket }) {
    let isEmitted = false;
    try {
      let readyFrame = frame;
      if (!frame.lineList) {
        const screenText = await readScreenText({ jpegBuffer: frame.buffer });
        readyFrame = toFrame({ buffer: frame.buffer, slideLabel: frame.slideLabel, screenText });
      }
      const retried = await retry({ note, frame: readyFrame, ts, eventVideoTimeMs, slideLabel });
      isEmitted = Boolean(retried?.isEmitted);
      return await finish(base, {
        retryOfTs: note.ts, isVlmCalled: Boolean(retried?.isVlmCalled),
        decision: isEmitted ? SCREEN_CHANGE_DECISION_MAP.emitted : SCREEN_CHANGE_DECISION_MAP.skipped,
        skipReason: isEmitted ? null : (retried?.skipReason || SCREEN_CHANGE_SKIP_MAP.notEmitted),
      });
    } catch (error) {
      return finish(base, { retryOfTs: note.ts, skipReason: SCREEN_CHANGE_SKIP_MAP.error, errorMessage: error.message });
    } finally {
      gate.release({ ticket, slideLabel, isEmitted });
    }
  }

  async function processChange({ payload, isShadow }) {
    const {
      ts, slideLabel, buffer, vlmBuffer = null, regionNorm = null, firstSeenTs = ts, firstSeenVideoTimeMs = null,
      recentTranscript = '', wordBudget = null, imageMode = null,
    } = payload;
    const screenText = await readScreenText({ jpegBuffer: buffer });
    if (screenText.skipReason) return { ocr: toOcrRecord(screenText), skipReason: screenText.skipReason };
    const baseline = baselineStore.get(slideLabel);
    baselineStore.set({
      slideLabel, lineList: screenText.lineList, imageWidth: screenText.imageWidth, imageHeight: screenText.imageHeight, ts,
    });
    const diff = diffScreenText({ baseline, current: screenText, regionNorm });
    const ocr = toOcrRecord(screenText, diff);
    if (diff.skipReason) return { ocr, skipReason: diff.skipReason };
    const eventKind = diff.kind;
    if (!kindList.includes(eventKind)) {
      return {
        ocr, eventKind,
        skipReason: eventKind === SCREEN_CHANGE_KIND_MAP.visual ? SCREEN_CHANGE_SKIP_MAP.noTextChange : SCREEN_CHANGE_SKIP_MAP.kindOff,
      };
    }
    const isNewText = eventKind === SCREEN_CHANGE_KIND_MAP.newText;
    const filtered = isNewText
      ? filterSpokenLines({
        lineList: diff.addedLineList.map((line) => line.text), transcript: recentTranscript,
        narrationTextList: getRecentNarrationTextList(),
      })
      : { keptLineList: [], spokenCount: 0, narratedCount: 0, skipReason: null };
    const spokenFilteredCount = filtered.spokenCount + filtered.narratedCount;
    if (filtered.skipReason) return { ocr, eventKind, spokenFilteredCount, skipReason: filtered.skipReason };

    const frame = toFrame({ buffer, slideLabel, screenText });
    const patch = { ocr, eventKind, spokenFilteredCount };
    if (isShadow) {
      pendingEvidence.rememberChange({ slideLabel, changeTs: firstSeenTs, frame, isRetryEligible: true, eventKind });
      const wouldRetry = Boolean(pendingEvidence.peekForChange({ slideLabel, changeTs: firstSeenTs }));
      return { ...patch, decision: SCREEN_CHANGE_DECISION_MAP.shadow, wouldRetry };
    }
    const note = pendingEvidence.takeForChange({ slideLabel, changeTs: firstSeenTs });
    if (note) {
      const retried = await retry({ note, frame, ts, eventVideoTimeMs: firstSeenVideoTimeMs, slideLabel });
      const isEmitted = Boolean(retried?.isEmitted);
      return {
        ...patch, origin: SCREEN_CHANGE_ORIGIN_MAP.retry, retryOfTs: note.ts, isVlmCalled: Boolean(retried?.isVlmCalled),
        decision: isEmitted ? SCREEN_CHANGE_DECISION_MAP.emitted : SCREEN_CHANGE_DECISION_MAP.skipped,
        skipReason: isEmitted ? null : (retried?.skipReason || SCREEN_CHANGE_SKIP_MAP.notEmitted),
      };
    }
    // 강조는 새 줄이 없어 바뀐 영역에 걸친 줄로 무엇이 강조됐는지 알려 준다.
    const lineList = isNewText ? filtered.keptLineList : diff.regionLineList.map((line) => line.text);
    const described = await describe({
      jpegBuffer: vlmBuffer || buffer, eventKind, lineList, recentTranscript, slideLabel, wordBudget, imageMode,
    });
    const vlmPatch = { ...patch, isVlmCalled: true };
    if (!described?.isGrounded || !described.text || !described.slotMap) {
      return {
        ...vlmPatch, skipReason: SCREEN_CHANGE_SKIP_MAP.vlmNone,
        rejectKind: described?.rejectKind ?? null, rejectReason: described?.rejectReason ?? '',
      };
    }
    if (isNewText && !isValueOnLineList({ value: described.slotMap.value, lineList })) {
      return { ...vlmPatch, skipReason: SCREEN_CHANGE_SKIP_MAP.valueAbsent, value: described.slotMap.value };
    }
    const sent = await emit({
      text: described.text, slotMap: described.slotMap, eventKind, slideLabel, ts,
      eventVideoTimeMs: firstSeenVideoTimeMs, regionNorm, lineList,
    });
    if (!sent?.isEmitted) return { ...vlmPatch, skipReason: toEmitSkipReason(sent?.reason) };
    return { ...vlmPatch, decision: SCREEN_CHANGE_DECISION_MAP.emitted };
  }

  // 같은 슬라이드 변화 사건(렌더러 감지기). payload.firstSeenTs 는 변화를 처음 본 벽시계 시각이다.
  async function handleChange(payload) {
    const mode = getMode();
    if (mode === SCREEN_CHANGE_MODE_MAP.off) return null;
    const { ts, slideLabel, buffer, firstSeenTs = ts } = payload;
    const base = buildBase({ ...payload, origin: SCREEN_CHANGE_ORIGIN_MAP.sameSlide });
    const acquired = acquire({ ts, slideLabel });
    if (!acquired.ticket) {
      // 앞 사건을 처리하느라 밀린 변화는 VLM 을 부르지 않았으므로, 늦게 온 미해결 트리거가 이 화면으로 다시 볼 수 있다.
      if (acquired.gateReason === SCREEN_CHANGE_GATE_REASON_MAP.inFlight) {
        pendingEvidence.rememberChange({
          slideLabel, changeTs: firstSeenTs, frame: { buffer, slideLabel, lineList: null, text: null }, isRetryEligible: true,
          firstSeenVideoTimeMs: payload.firstSeenVideoTimeMs ?? null,
        });
      }
      return finish(base, { skipReason: acquired.skipReason });
    }
    let isEmitted = false;
    try {
      const patch = await processChange({ payload, isShadow: mode === SCREEN_CHANGE_MODE_MAP.shadow });
      isEmitted = patch.decision === SCREEN_CHANGE_DECISION_MAP.emitted;
      return await finish(base, patch);
    } catch (error) {
      return finish(base, { skipReason: SCREEN_CHANGE_SKIP_MAP.error, errorMessage: error.message });
    } finally {
      gate.release({ ticket: acquired.ticket, slideLabel, isEmitted });
    }
  }

  // 슬라이드 시작 조용 구간이 끝난 기준 화면(또는 감지기를 다시 시작한 뒤의 첫 화면). OCR 해 글자 차이의 기준으로 둔다.
  // 새 슬라이드 기준 화면이면 직전 슬라이드에서 미해결로 끝난 트리거를 이 화면으로 다시 부른다.
  async function handleBaseline({ slideLabel, buffer, ts, isSlideStart = false, slideStartTs = null, eventVideoTimeMs = null }) {
    const mode = getMode();
    if (mode === SCREEN_CHANGE_MODE_MAP.off || !slideLabel || !buffer) return null;
    const screenText = await readScreenText({ jpegBuffer: buffer });
    if (screenText.skipReason) baselineStore.remove(slideLabel);
    else {
      baselineStore.set({
        slideLabel, lineList: screenText.lineList, imageWidth: screenText.imageWidth, imageHeight: screenText.imageHeight, ts,
      });
    }
    const result = { isSeeded: !screenText.skipReason, ocr: toOcrRecord(screenText) };
    if (!isSlideStart || !Number.isFinite(slideStartTs)) return result;
    const query = { slideLabel, slideStartTs, baselineTs: ts };
    const note = pendingEvidence.peekForSlideStart(query);
    if (!note) return result;
    const base = {
      ...buildBase({
        ts, slideLabel, origin: SCREEN_CHANGE_ORIGIN_MAP.retry, eventKind: SCREEN_CHANGE_KIND_MAP.newSlide,
        firstSeenVideoTimeMs: eventVideoTimeMs,
      }),
      ocr: result.ocr, retryOfTs: note.ts,
    };
    if (mode === SCREEN_CHANGE_MODE_MAP.shadow) {
      await finish(base, { decision: SCREEN_CHANGE_DECISION_MAP.shadow, wouldRetry: true });
      return result;
    }
    const acquired = acquire({ ts, slideLabel });
    if (!acquired.ticket) {
      await finish(base, { skipReason: acquired.skipReason });
      return result;
    }
    pendingEvidence.takeForSlideStart(query);
    await runRetry({
      base, note, frame: toFrame({ buffer, slideLabel, screenText }), ts, eventVideoTimeMs, slideLabel, ticket: acquired.ticket,
    });
    return result;
  }

  // 발화 트리거 해설이 NONE·값 없음으로 끝났다. 트리거 캡처 뒤의 변화가 이미 와 있으면 그 화면으로 바로 다시 부르고,
  // 아니면 적어 두었다가 10초 안의 변화·다음 슬라이드 기준 화면과 짝짓는다. 바로 다시 부르지 않고 적었으면 참이다.
  async function noteUnresolved(note) {
    const mode = getMode();
    if (mode === SCREEN_CHANGE_MODE_MAP.off || !isRetriableUnresolved(note)) return false;
    const query = { slideLabel: note.slideLabel, captureTs: note.captureTs };
    const change = pendingEvidence.findChangeAfter({ ...query, isConsumed: false });
    if (!change) return pendingEvidence.noteUnresolved(note);
    const ts = now();
    const base = {
      ...buildBase({
        ts, slideLabel: note.slideLabel, origin: SCREEN_CHANGE_ORIGIN_MAP.retry, eventKind: change.eventKind ?? null,
        firstSeenVideoTimeMs: change.firstSeenVideoTimeMs ?? null,
      }),
      retryOfTs: note.ts,
    };
    // shadow 도 짝지은 것으로 보고 적지 않는다. 적으면 같은 트리거가 뒤 변화와 또 짝지어져 두 번 센다.
    if (mode === SCREEN_CHANGE_MODE_MAP.shadow) {
      await finish(base, { decision: SCREEN_CHANGE_DECISION_MAP.shadow, wouldRetry: true });
      return false;
    }
    const acquired = acquire({ ts, slideLabel: note.slideLabel });
    if (!acquired.ticket) {
      await finish(base, { skipReason: acquired.skipReason });
      return pendingEvidence.noteUnresolved(note);
    }
    pendingEvidence.findChangeAfter(query);
    await runRetry({
      base, note, frame: change.frame, ts, eventVideoTimeMs: change.firstSeenVideoTimeMs ?? null,
      slideLabel: note.slideLabel, ticket: acquired.ticket,
    });
    return false;
  }

  return {
    handleChange,
    handleBaseline,
    noteUnresolved,
    revert: ({ slideLabel }) => gate.revert({ slideLabel }),
    reset() {
      gate.reset();
      pendingEvidence.reset();
      baselineStore.reset();
    },
  };
}

module.exports = {
  createScreenChangeNarrator, toEmitSkipReason, SCREEN_CHANGE_ORIGIN_MAP, SCREEN_CHANGE_DECISION_MAP, SCREEN_CHANGE_SKIP_MAP,
};
