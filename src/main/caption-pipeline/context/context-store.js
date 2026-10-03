const { RECORD_KIND_MAP } = require('../instrumentation/record-store');

// 회의 중 슬라이드·발화·해설·질문을 슬라이드 단위로 모은다. 질문 검색과 회의 후 스크립트·요약의 근거다.
const SLIDE_TEXT_DONE_STATUS_LIST = ['ready', 'none', 'failed'];

const LABEL_STATUS_MAP = {
  pending: 'pending',
  requested: 'requested',
  ready: 'ready',
  failed: 'failed',
};

const SLIDE_FRAME_KIND_BASE = 'base';
const USER_COMMAND_CLASS = 'user_command';

function toSlideMajor(slideLabel) {
  const major = Number.parseInt(String(slideLabel ?? '').split('-')[0], 10);
  return Number.isFinite(major) ? major : null;
}

function createSlideEntry(major) {
  return {
    major,
    visitList: [],
    imagePath: null,
    hasTransition: false,
    hasLeft: false,
    pageNumber: null,
    pageTopic: '',
    description: '',
    describedElementList: [],
    slideText: '',
    slideTextStatus: 'missing',
    label: null,
    labelStatus: LABEL_STATUS_MAP.pending,
  };
}

function copySlide(slide) {
  return {
    ...slide,
    visitList: slide.visitList.map((visit) => ({ ...visit })),
    describedElementList: [...slide.describedElementList],
    label: slide.label ? { ...slide.label, keywordList: [...slide.label.keywordList] } : null,
  };
}

function createContextStore({ onChange = () => {} } = {}) {
  let sessionId = null;
  let startedAt = null;
  let slideMap = new Map();
  let utteranceList = [];
  let narrationList = [];
  let qaList = [];
  let currentMajor = null;

  // 파일 쓰기 같은 후속 처리가 실패해도 저장소 반영은 계속한다.
  function notifyChange() {
    try {
      onChange();
    } catch (error) {
      console.warn(`[context] 변경 알림 오류(무시): ${error.message}`);
    }
  }

  function ensureSlide(major) {
    if (!slideMap.has(major)) slideMap.set(major, createSlideEntry(major));
    return slideMap.get(major);
  }

  // 방문은 다음 슬라이드가 열릴 때 닫히므로, ts 이전에 시작한 방문 중 가장 늦은 것이 그때의 슬라이드다.
  function findSlideMajorAt(ts) {
    let foundMajor = null;
    let foundStartTs = -Infinity;
    for (const slide of slideMap.values()) {
      for (const visit of slide.visitList) {
        if (visit.startTs <= ts && visit.startTs > foundStartTs) {
          foundMajor = slide.major;
          foundStartTs = visit.startTs;
        }
      }
    }
    return foundMajor;
  }

  function applySlideMark({ ts, slideLabel, frameKind, filePath }) {
    const major = toSlideMajor(slideLabel);
    if (major === null) return false;
    const slide = ensureSlide(major);
    if (frameKind !== SLIDE_FRAME_KIND_BASE) return true;
    if (!slide.imagePath && filePath) slide.imagePath = filePath;
    if (currentMajor === major) return true;
    const previous = currentMajor === null ? null : slideMap.get(currentMajor);
    const openVisit = previous?.visitList[previous.visitList.length - 1];
    if (openVisit && openVisit.endTs === null) openVisit.endTs = ts;
    if (previous) previous.hasLeft = true;
    slide.visitList.push({ startTs: ts, endTs: null });
    currentMajor = major;
    return true;
  }

  function applyPageTransition(record) {
    const major = toSlideMajor(record.slideLabel);
    if (major === null) return false;
    const slide = ensureSlide(major);
    slide.hasTransition = true;
    if (Number.isFinite(record.pageNumber)) slide.pageNumber = record.pageNumber;
    if (typeof record.pageTopic === 'string' && record.pageTopic.trim()) slide.pageTopic = record.pageTopic.trim();
    if (typeof record.description === 'string' && record.description.trim()) {
      slide.description = record.description.trim();
    }
    if (Array.isArray(record.describedElementList) && record.describedElementList.length) {
      slide.describedElementList = record.describedElementList
        .filter((element) => typeof element === 'string' && element.trim());
    }
    return true;
  }

  // ASR 응답은 늦게·순서가 바뀌어 올 수 있어 넣을 때마다 시각순으로 정렬한다.
  function applyAsr(record) {
    const baseTs = Number(record.ts);
    if (!Number.isFinite(baseTs)) return false;
    const segmentList = Array.isArray(record.segmentList) && record.segmentList.length
      ? record.segmentList
      : [{ startSec: 0, endSec: 0, text: record.text }];
    let isAdded = false;
    for (const segment of segmentList) {
      const text = String(segment?.text ?? '').trim();
      if (!text) continue;
      const ts = baseTs + Math.round((Number(segment.startSec) || 0) * 1000);
      const endTs = baseTs + Math.round((Number(segment.endSec) || 0) * 1000);
      utteranceList.push({
        ts, endTs: Math.max(ts, endTs), text,
        speakerHint: record.speakerHint || null, slideMajor: findSlideMajorAt(ts),
      });
      isAdded = true;
    }
    if (isAdded) utteranceList.sort((left, right) => left.ts - right.ts);
    return isAdded;
  }

  // 질문의 답은 qaList 에 따로 남는다. 해설 목록에 섞이면 "해설 다시"가 답을 되읽는다.
  function applyNarration(record) {
    if (!record.isEmitted || typeof record.text !== 'string' || !record.text.trim()) return false;
    if (record.narrationClass === USER_COMMAND_CLASS) return false;
    const labelMajor = toSlideMajor(record.slideLabel);
    narrationList.push({
      ts: record.ts,
      source: record.source || null,
      narrationClass: record.narrationClass || null,
      text: record.text.trim(),
      slideMajor: labelMajor ?? findSlideMajorAt(record.ts),
    });
    return true;
  }

  const APPLIER_BY_KIND_MAP = {
    [RECORD_KIND_MAP.slideMark]: applySlideMark,
    [RECORD_KIND_MAP.pageTransition]: applyPageTransition,
    [RECORD_KIND_MAP.asr]: applyAsr,
    [RECORD_KIND_MAP.narration]: applyNarration,
  };

  function applyRecord(record) {
    const applier = record ? APPLIER_BY_KIND_MAP[record.kind] : null;
    if (!applier) return false;
    const isChanged = applier(record);
    if (isChanged) notifyChange();
    return isChanged;
  }

  function applySlideText({ slideLabel, status, text = '' }) {
    const major = toSlideMajor(slideLabel);
    if (major === null) return null;
    const slide = ensureSlide(major);
    slide.slideTextStatus = status;
    slide.slideText = typeof text === 'string' ? text.trim() : '';
    notifyChange();
    return major;
  }

  // 전환 고지가 오지 않는 슬라이드(체류 미달·예산 부족)도 다음 슬라이드로 넘어가면 라벨을 붙인다.
  function isReadyForLabel(slide) {
    if (slide.labelStatus !== LABEL_STATUS_MAP.pending) return false;
    if (!SLIDE_TEXT_DONE_STATUS_LIST.includes(slide.slideTextStatus)) return false;
    return slide.hasTransition || slide.hasLeft;
  }

  function listReadyForLabelMajors() {
    return [...slideMap.values()].filter(isReadyForLabel).map((slide) => slide.major);
  }

  function markLabelRequested(major) {
    const slide = slideMap.get(major);
    if (slide) slide.labelStatus = LABEL_STATUS_MAP.requested;
  }

  function setLabel({ major, label = null, status }) {
    const slide = slideMap.get(major);
    if (!slide) return;
    slide.label = label;
    slide.labelStatus = status;
    notifyChange();
  }

  function addQa({ ts, question, answer = '', route, slideMajorList = [], isFollowUp = false }) {
    qaList.push({ ts, question, answer, route, slideMajorList: [...slideMajorList], isFollowUp });
    notifyChange();
  }

  function getSlide(major) {
    return slideMap.get(major) || null;
  }

  function getSlideList() {
    const firstSeenOf = (slide) => slide.visitList[0]?.startTs ?? Infinity;
    return [...slideMap.values()]
      .sort((left, right) => (firstSeenOf(left) - firstSeenOf(right)) || (left.major - right.major));
  }

  function getUtteranceList({ fromTs = -Infinity, toTs = Infinity, slideMajor = null, speakerHint = null } = {}) {
    return utteranceList.filter((utterance) => utterance.ts >= fromTs && utterance.ts <= toTs
      && (slideMajor === null || utterance.slideMajor === slideMajor)
      && (speakerHint === null || utterance.speakerHint === speakerHint));
  }

  function getNarrationList({ limit = 10 } = {}) {
    return narrationList.slice(-limit);
  }

  function buildIndex() {
    return getSlideList().map((slide) => ({
      major: slide.major,
      title: slide.label?.title || slide.pageTopic || '',
      keywordList: slide.label?.keywordList ? [...slide.label.keywordList] : [],
      summary: slide.label?.summary || slide.description || '',
      firstSeenTs: slide.visitList[0]?.startTs ?? null,
      isCurrent: slide.major === currentMajor,
    }));
  }

  function reset() {
    sessionId = null;
    startedAt = null;
    slideMap = new Map();
    utteranceList = [];
    narrationList = [];
    qaList = [];
    currentMajor = null;
  }

  function start({ sessionId: nextSessionId, startedAt: nextStartedAt }) {
    reset();
    sessionId = nextSessionId;
    startedAt = nextStartedAt;
  }

  function snapshot() {
    return {
      sessionId,
      startedAt,
      currentSlideMajor: currentMajor,
      slideList: getSlideList().map(copySlide),
      utteranceList: utteranceList.map((utterance) => ({ ...utterance })),
      narrationList: narrationList.map((narration) => ({ ...narration })),
      qaList: qaList.map((qa) => ({ ...qa, slideMajorList: [...qa.slideMajorList] })),
    };
  }

  return {
    start, reset,
    getSessionInfo: () => ({ sessionId, startedAt }),
    applyRecord, applySlideText, listReadyForLabelMajors, markLabelRequested, setLabel, addQa,
    getSlide, getSlideList, getCurrentSlideMajor: () => currentMajor,
    getUtteranceList, getNarrationList, getLastQa: () => qaList[qaList.length - 1] || null,
    buildIndex, snapshot,
  };
}

module.exports = { createContextStore, toSlideMajor, LABEL_STATUS_MAP };
