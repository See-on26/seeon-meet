// 발화로 ROI 잡기: 발화 명사·숫자+단위·영문 약어를 화면 OCR 줄 위치와 맞춰 그 둘레를 확대하고,
// 해설 VLM 요청 하나에 [화면 전체, 확대] 두 장을 넣게 한다. 해설 순간에는 아무것도 기다리지 않는다(동기).
// 위치 출처: 같은 프레임 OCR 이 이미 끝나 있으면 그것 → 전환 때 뽑아 둔 위치(신선도 확인 뒤) → 없으면 확대하지 않는다.
// 꺼져 있으면(SEEON_SPEECH_ROI=off) 아무것도 하지 않아 해설 요청이 지금과 바이트까지 같다.
const { NARRATION_TYPE_MAP, VISUAL_DESCRIPTION_KIND_MAP, DEIXIS_FORM_MAP } = require('../../contracts/narration-types');
const { ZOOM_KIND_MAP } = require('../../prompts/zoom-image-intro');
const { extractSpeechTermList } = require('./term-extractor');
const { selectRoiTarget, MATCH_KIND_MAP, ROI_SELECT_STATUS_MAP } = require('./label-matcher');
const { estimateSpanRect, buildZoomRect, ZOOM_RECT_STATUS_MAP } = require('./roi-rect');
const { toLayoutLineList, SLIDE_LAYOUT_STATUS_MAP } = require('./slide-layout-store');
const { checkLayoutFreshness } = require('./layout-freshness');

const SPEECH_ROI_MODE_MAP = { on: 'on', off: 'off' };
const SPEECH_ROI_STATUS_MAP = {
  used: 'used',
  typeExcluded: 'type_excluded',
  noTerms: 'no_terms',
  noLayout: 'no_layout',
  layoutPending: 'layout_pending',
  noMatch: ROI_SELECT_STATUS_MAP.noMatch,
  titleOnly: ROI_SELECT_STATUS_MAP.titleOnly,
  ambiguous: ZOOM_RECT_STATUS_MAP.ambiguous,
  tooLarge: ZOOM_RECT_STATUS_MAP.tooLarge,
  cropFailed: 'crop_failed',
  error: 'error',
};
const STALE_STATUS_PREFIX = 'stale:';
const LAYOUT_SOURCE_MAP = { frameOcr: 'frame_ocr', slideOcr: 'slide_ocr' };
const LAYOUT_SOURCE_LABEL_MAP = { [LAYOUT_SOURCE_MAP.frameOcr]: '같은 프레임 OCR', [LAYOUT_SOURCE_MAP.slideOcr]: '전환 때 OCR' };

const ZOOM_NARRATION_TYPE_LIST = [NARRATION_TYPE_MAP.deixis, NARRATION_TYPE_MAP.interpretation, NARRATION_TYPE_MAP.visualDescription];
// 사전·자모 유사로 맞은 낱말은 프롬프트에 "그 낱말"로 쓰지 않는다. 틀린 연결을 문장으로 굳히지 않게 "발화에 나온 대상"으로 쓴다.
const UNCERTAIN_MATCH_KIND_SET = new Set([MATCH_KIND_MAP.alias, MATCH_KIND_MAP.jamo]);
const RECORD_LINE_TEXT_MAX_LENGTH = 80;
const RECORD_TERM_LIST_LIMIT = 8;

const NO_ZOOM_RESULT = Object.freeze({ zoomJpegBuffer: null, zoomKind: null, zoomTerm: null, record: null });

const round = (value, digit = 3) => (Number.isFinite(value) ? Math.round(value * 10 ** digit) / 10 ** digit : null);
const roundRect = (rect) => (rect ? { x: round(rect.x), y: round(rect.y), w: round(rect.w), h: round(rect.h) } : null);
const truncate = (text, maxLength) => (typeof text === 'string' && text.length > maxLength ? `${text.slice(0, maxLength)}…` : text ?? null);

function median(valueList) {
  if (!valueList.length) return null;
  const sorted = [...valueList].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// 렌더러가 보낸 가리킴 비율 상자. 잘린 그림이 없었으면 오지 않는다.
function readPointingRect(rect) {
  if (!rect || ![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) || rect.w <= 0 || rect.h <= 0) return null;
  const x0 = Math.min(Math.max(rect.x, 0), 1);
  const y0 = Math.min(Math.max(rect.y, 0), 1);
  const x1 = Math.min(Math.max(rect.x + rect.w, 0), 1);
  const y1 = Math.min(Math.max(rect.y + rect.h, 0), 1);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

function createSpeechRoiResolver({ config, tokenizer = null, layoutStore = null, imageOps = null, now = Date.now }) {
  const isEnabled = () => config.speechRoiMode === SPEECH_ROI_MODE_MAP.on;
  const readTypeList = () => (Array.isArray(config.speechRoiTypeList) ? config.speechRoiTypeList : []);

  // 척도는 트리거 경로의 scale 만 받는다(무발화·반응 묘사는 발화 명사가 없거나 경로가 다르다). 세부가 없으면 척도로 본다(트리거 경로의 기본).
  function isEligibleType({ narrationType, subKind }) {
    if (!ZOOM_NARRATION_TYPE_LIST.includes(narrationType) || !readTypeList().includes(narrationType)) return false;
    return narrationType !== NARRATION_TYPE_MAP.visualDescription || (subKind || VISUAL_DESCRIPTION_KIND_MAP.scale) === VISUAL_DESCRIPTION_KIND_MAP.scale;
  }

  // 대상이 둘인 해설(지시 완전형, 수치 둘째 주장)은 서로 다른 낱말로 맞은 줄 둘까지 함께 확대한다.
  function readMaxTargetCount({ narrationType, subKind, mergedClaimCount }) {
    const isCompleteDeixis = narrationType === NARRATION_TYPE_MAP.deixis && subKind === DEIXIS_FORM_MAP.complete;
    return isCompleteDeixis || mergedClaimCount > 0 ? 2 : 1;
  }

  // 지시 후보만 있는 요청에도 같은 프레임 OCR 을 판단과 함께 시작할지. 끝나 있을 때만 쓰고 기다리지 않는다.
  function shouldStartFrameOcr() {
    return isEnabled() && Boolean(config.isSpeechRoiFrameOcrEnabled) && readTypeList().includes(NARRATION_TYPE_MAP.deixis);
  }

  function readFrameSize({ frameLayout, screenFrame }) {
    if (frameLayout?.imageWidth > 0 && frameLayout?.imageHeight > 0) return { width: frameLayout.imageWidth, height: frameLayout.imageHeight };
    return imageOps?.readSize(screenFrame) ?? null;
  }

  function pickLayout({ frameLayout, slideLabel, screenFrame }) {
    if (frameLayout) {
      const size = readFrameSize({ frameLayout, screenFrame });
      const lineList = toLayoutLineList({ lineList: frameLayout.lineList, imageWidth: size?.width, imageHeight: size?.height });
      if (lineList.length) return { source: LAYOUT_SOURCE_MAP.frameOcr, lineList, freshness: null };
    }
    const entry = layoutStore?.get(slideLabel) ?? { status: SLIDE_LAYOUT_STATUS_MAP.missing, layout: null };
    if (entry.status === SLIDE_LAYOUT_STATUS_MAP.pending) return { status: SPEECH_ROI_STATUS_MAP.layoutPending };
    if (entry.status !== SLIDE_LAYOUT_STATUS_MAP.ready || !entry.layout) return { status: SPEECH_ROI_STATUS_MAP.noLayout };
    const size = imageOps.readSize(screenFrame);
    const currentThumb = imageOps.toGrayThumbnail(screenFrame);
    const currentAspect = size ? size.width / size.height : null;
    const freshness = checkLayoutFreshness({ layout: entry.layout, currentThumb, currentAspect });
    const base = { source: LAYOUT_SOURCE_MAP.slideOcr, freshness };
    if (!freshness.isFresh) return { ...base, status: `${STALE_STATUS_PREFIX}${freshness.reason}` };
    return { ...base, lineList: entry.layout.lineList, layout: entry.layout, currentThumb, currentAspect };
  }

  function toZoomTarget({ target, medianLineHeight }) {
    if (target.isCluster) return { rect: target.rect, lineHeight: medianLineHeight ?? target.rect.h, spanEstimated: false, role: target.role };
    const spanList = target.spanList.filter((span) => Number.isInteger(span.charStart) && Number.isInteger(span.charEnd));
    const charStart = spanList.length ? Math.min(...spanList.map((span) => span.charStart)) : null;
    const charEnd = spanList.length ? Math.max(...spanList.map((span) => span.charEnd)) : null;
    const { rect, spanEstimated } = estimateSpanRect({ line: target.line, charStart, charEnd });
    return { rect, lineHeight: target.line.rect.h, spanEstimated, role: target.role };
  }

  function resolveSpeechZoom({ narrationType, subKind, utterance, before, after, anchor, slideLabel, screenFrame, frameLayout,
    pointingRect, maxTargetCount }) {
    const termList = extractSpeechTermList({
      tokenize: typeof tokenizer?.tokenize === 'function' ? (text) => tokenizer.tokenize(text) : null,
      utterance, before, after, anchor,
    });
    const outcome = { termList, layoutSource: null, freshness: null, selection: null, zoom: null, zoomTargetList: [] };
    if (!termList.length) return { ...outcome, status: SPEECH_ROI_STATUS_MAP.noTerms };
    const picked = pickLayout({ frameLayout, slideLabel, screenFrame });
    Object.assign(outcome, { layoutSource: picked.source ?? null, freshness: picked.freshness ?? null });
    if (!picked.lineList) return { ...outcome, status: picked.status };
    const selection = selectRoiTarget({ termList, lineList: picked.lineList, maxTargetCount });
    outcome.selection = selection;
    if (selection.status !== ROI_SELECT_STATUS_MAP.selected) return { ...outcome, status: selection.status };
    const medianLineHeight = median(picked.lineList.map((line) => line.rect.h));
    outcome.zoomTargetList = selection.targetList.map((target) => toZoomTarget({ target, medianLineHeight }));
    const zoom = buildZoomRect({ targetList: outcome.zoomTargetList, pointingRect, ambiguity: selection.ambiguity });
    outcome.zoom = zoom;
    if (zoom.status !== ZOOM_RECT_STATUS_MAP.used) return { ...outcome, status: zoom.status };
    if (picked.source === LAYOUT_SOURCE_MAP.slideOcr) {
      const freshness = checkLayoutFreshness({
        layout: picked.layout, currentThumb: picked.currentThumb, currentAspect: picked.currentAspect, targetRect: zoom.targetRect,
      });
      outcome.freshness = freshness;
      if (!freshness.isFresh) return { ...outcome, status: `${STALE_STATUS_PREFIX}${freshness.reason}` };
    }
    const zoomJpegBuffer = imageOps.cropToJpeg({ jpeg: screenFrame, rect: zoom.rect });
    if (!zoomJpegBuffer) return { ...outcome, status: SPEECH_ROI_STATUS_MAP.cropFailed };
    const [primary] = selection.targetList;
    return {
      ...outcome, status: SPEECH_ROI_STATUS_MAP.used, zoomJpegBuffer, zoomKind: zoom.zoomKind,
      zoomTerm: UNCERTAIN_MATCH_KIND_SET.has(primary.match.kind) ? null : primary.term.text,
    };
  }

  function buildRecord({ narrationType, outcome, zoomKind, hasPointingRect, elapsedMs }) {
    const targetList = outcome.selection?.targetList || [];
    const [primary, second] = targetList;
    const zoom = outcome.zoom;
    return {
      mode: SPEECH_ROI_MODE_MAP.on,
      status: outcome.status,
      narrationType,
      layoutSource: outcome.layoutSource ?? null,
      termCount: outcome.termList?.length ?? 0,
      termTextList: (outcome.termList || []).slice(0, RECORD_TERM_LIST_LIMIT).map((term) => term.text),
      term: primary?.term.text ?? null,
      termSource: primary?.term.source ?? null,
      matchKind: primary?.match.kind ?? null,
      score: round(primary?.score),
      secondScore: round(second?.score),
      targetCount: zoom?.targetCount ?? targetList.length,
      isAmbiguous: Boolean(outcome.selection?.ambiguity?.isAmbiguous),
      lineText: truncate(primary?.line.text, RECORD_LINE_TEXT_MAX_LENGTH),
      lineScore: round(primary?.line.score),
      isCluster: Boolean(primary?.isCluster),
      spanEstimated: outcome.zoomTargetList.some((target) => target.spanEstimated),
      targetRect: roundRect(zoom?.targetRect),
      rect: roundRect(zoom?.rect),
      zoomKind,
      pointingConflict: Boolean(zoom?.pointingConflict),
      hasPointingRect,
      freshness: outcome.freshness ?? null,
      elapsedMs,
      ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
    };
  }

  // 해설 유형이 정해진 뒤(판단 뒤) 부른다. 동기로 끝나고 기다리지 않는다.
  // regionFrame: 렌더러가 가리킨 영역으로 잘라 보낸 그림(있을 때만). 발화 확대가 없고 짝 스위치가 켜졌으면 지시 해설의 둘째 장으로 쓴다.
  function resolve({ narrationType, subKind = null, utterance = '', before = '', after = '', anchor = '', slideLabel = null,
    screenFrame, frameLayout = null, pointingRect = null, regionFrame = null, mergedClaimCount = 0 }) {
    if (!isEnabled()) return { ...NO_ZOOM_RESULT };
    const startedAt = now();
    const validPointingRect = readPointingRect(pointingRect);
    const isEligible = isEligibleType({ narrationType, subKind });
    let outcome;
    if (!isEligible) {
      outcome = { status: SPEECH_ROI_STATUS_MAP.typeExcluded, termList: [], zoomTargetList: [] };
    } else {
      try {
        outcome = resolveSpeechZoom({
          narrationType, subKind, utterance, before, after, anchor, slideLabel, screenFrame, frameLayout,
          pointingRect: validPointingRect, maxTargetCount: readMaxTargetCount({ narrationType, subKind, mergedClaimCount }),
        });
      } catch (error) {
        outcome = { status: SPEECH_ROI_STATUS_MAP.error, termList: [], zoomTargetList: [], errorMessage: error?.message || String(error) };
      }
    }
    let zoomJpegBuffer = outcome.zoomJpegBuffer ?? null;
    let zoomKind = zoomJpegBuffer ? outcome.zoomKind : null;
    // 가리킴만 있는 지시 해설: 확대만 보내면 문맥을 잃었으므로 [전체, 가리킴] 두 장으로 준다. 수치·척도는 지금처럼 전체 한 장.
    const isPointingPair = !zoomJpegBuffer && isEligible && outcome.status !== SPEECH_ROI_STATUS_MAP.error
      && narrationType === NARRATION_TYPE_MAP.deixis && Boolean(config.isSpeechRoiPointingPairEnabled)
      && Boolean(regionFrame) && Boolean(validPointingRect);
    if (isPointingPair) {
      zoomJpegBuffer = regionFrame;
      zoomKind = ZOOM_KIND_MAP.pointing;
    }
    const record = buildRecord({
      narrationType, outcome, zoomKind, hasPointingRect: Boolean(validPointingRect), elapsedMs: now() - startedAt,
    });
    return { zoomJpegBuffer, zoomKind, zoomTerm: isPointingPair ? null : outcome.zoomTerm ?? null, record };
  }

  return { isEnabled, shouldStartFrameOcr, resolve };
}

// 에이전트에 넘길 확대 인자. 확대가 없으면 빈 객체라 에이전트 인자·요청이 지금과 같다.
// 확대가 있으면 첫째 장은 늘 화면 전체다(가리킨 영역이 있던 지시 해설도).
function buildZoomAgentArgs({ roiResult, screenFrame }) {
  if (!roiResult?.zoomJpegBuffer) return {};
  return {
    jpegBuffer: screenFrame, zoomJpegBuffer: roiResult.zoomJpegBuffer, zoomKind: roiResult.zoomKind, zoomTerm: roiResult.zoomTerm,
  };
}

function formatRect(rect) {
  return rect ? `(${rect.x.toFixed(2)},${rect.y.toFixed(2)} 변 ${rect.w.toFixed(2)})` : '-';
}

// 흐름 창 한 줄.
function formatSpeechRoiSummary(record) {
  if (!record) return '';
  const partList = [`발화 ROI=${record.status}`];
  if (record.layoutSource) partList.push(`출처=${LAYOUT_SOURCE_LABEL_MAP[record.layoutSource] || record.layoutSource}`);
  if (record.term) partList.push(`낱말="${record.term}"(${record.termSource}, ${record.matchKind} ${record.score?.toFixed(2)})`);
  else if (record.termCount) partList.push(`낱말 ${record.termCount}개=[${record.termTextList.join(', ')}]`);
  if (record.lineText) partList.push(`줄="${record.lineText}"${record.spanEstimated ? '(x 어림)' : ''}`);
  if (record.rect) partList.push(`상자=${formatRect(record.rect)}`);
  partList.push(`확대=${record.zoomKind || '없음'}`);
  if (record.pointingConflict) partList.push('가리킴과 떨어짐(발화 쪽)');
  if (record.freshness && !record.freshness.isFresh) partList.push(`신선도=${record.freshness.reason}`);
  partList.push(`${record.elapsedMs}ms`);
  return partList.join(' ');
}

module.exports = {
  createSpeechRoiResolver, buildZoomAgentArgs, formatSpeechRoiSummary, readPointingRect,
  SPEECH_ROI_MODE_MAP, SPEECH_ROI_STATUS_MAP, LAYOUT_SOURCE_MAP,
};
