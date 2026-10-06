const { formatElapsed } = require('./clock-format');

const EMPTY_SCRIPT_TEXT = '(기록된 발화가 없습니다)';
// Meet 화면 표시로 누가 말했는지 알 수 없던 발화. 화자를 빠짐없이 적되 지어내지 않는다.
const UNKNOWN_SPEAKER_LABEL = '화자 미상';
const NO_SCREEN_TEXT_LINE = '화면이 바뀌었습니다 (화면 설명 없음)';
// 전환 고지 요청은 방문을 연 뒤에 나간다(교차 모드는 체류 3초 뒤). 그 사이의 시각 차를 이만큼까지 같은 전환으로 본다.
const VISIT_MATCH_SLACK_MS = 15000;

function isCancelledTransition({ transition, cancelledList }) {
  return cancelledList.some((cancelled) => cancelled.slideMajor === transition.slideMajor
    && cancelled.requestTs !== null && cancelled.requestTs === transition.ts);
}

function isFlashVisit({ slideMajor, visit, cancelledList }) {
  return cancelledList.some((cancelled) => cancelled.slideMajor === slideMajor
    && cancelled.transitionTs !== null && cancelled.transitionTs === visit.startTs);
}

function listLiveVisit({ slide, cancelledList }) {
  return (slide.visitList || [])
    .filter((visit) => !isFlashVisit({ slideMajor: slide.major, visit, cancelledList }));
}

// 전환 줄은 그 화면이 실제로 바뀐 시각(방문 시작)에 둔다. 고지가 늦게 만들어져도 그 화면에서 오간 말보다 앞에 온다.
function resolveTransitionLineTs({ transition, slideByMajorMap }) {
  const slide = slideByMajorMap.get(transition.slideMajor);
  const startTsList = (slide?.visitList || [])
    .map((visit) => visit.startTs)
    .filter((startTs) => startTs <= transition.ts && transition.ts - startTs <= VISIT_MATCH_SLACK_MS);
  return startTsList.length ? Math.max(...startTsList) : transition.ts;
}

function readFillText({ slide, screenFillByMajorMap }) {
  const fill = screenFillByMajorMap?.get(String(slide.major)) || '';
  const title = fill || slide.label?.title || slide.pageTopic || '';
  if (!title) return NO_SCREEN_TEXT_LINE;
  return slide.displayNumber ? `슬라이드 ${slide.displayNumber}: ${title}` : title;
}

// 전환 고지가 한 번도 만들어지지 않은 화면(생성 실패·예산 부족)은 회의 후 화면 정보 텍스트화 결과나 라벨로 한 줄을 채운다.
// 무관한 화면·같은 화면 재검출처럼 일부러 고지하지 않은 화면은 hasTransition 이 참이라 채우지 않는다.
function buildFillEventList({ slideList, transitionList, cancelledList, screenFillByMajorMap }) {
  const transitionMajorSet = new Set(transitionList.map((transition) => transition.slideMajor));
  const eventList = [];
  for (const slide of slideList) {
    if (slide.hasTransition || transitionMajorSet.has(slide.major)) continue;
    const firstVisit = listLiveVisit({ slide, cancelledList })[0];
    if (!firstVisit) continue;
    eventList.push({ ts: firstVisit.startTs, order: 0, line: `── ${readFillText({ slide, screenFillByMajorMap })} ──` });
  }
  return eventList;
}

function formatUtteranceLine({ utterance, isSpeakerHidden }) {
  if (isSpeakerHidden) return utterance.text;
  return `${utterance.speakerHint || UNKNOWN_SPEAKER_LABEL}: ${utterance.text}`;
}

// 회의 한 건의 대화 전문. 발화마다 화자를 적고, 화면이 바뀔 때마다 페이지 전환 설명 에이전트가 만든 AD 를 한 줄로 끼운다.
// isSpeakerHidden 은 회의 요약 입력용이다 — 요약은 누가 말했는지 쓰지 않는다.
function buildTranscriptScript({ snapshot, screenFillByMajorMap = null, isSpeakerHidden = false }) {
  const slideList = snapshot.slideList || [];
  const slideByMajorMap = new Map(slideList.map((slide) => [slide.major, slide]));
  const cancelledList = snapshot.cancelledTransitionList || [];
  const transitionList = (snapshot.transitionList || [])
    .filter((transition) => !isCancelledTransition({ transition, cancelledList }));
  const utteranceList = snapshot.utteranceList || [];
  if (!utteranceList.length && !transitionList.length) return EMPTY_SCRIPT_TEXT;

  const eventList = [
    ...transitionList.map((transition) => ({
      ts: resolveTransitionLineTs({ transition, slideByMajorMap }), order: 0, line: `── ${transition.text} ──`,
    })),
    ...buildFillEventList({ slideList, transitionList, cancelledList, screenFillByMajorMap }),
    ...utteranceList.map((utterance) => ({
      ts: utterance.ts, order: 1, line: formatUtteranceLine({ utterance, isSpeakerHidden }),
    })),
  ].sort((left, right) => (left.ts - right.ts) || (left.order - right.order));
  return eventList
    .map((event) => `[${formatElapsed({ ts: event.ts, startedAt: snapshot.startedAt })}] ${event.line}`)
    .join('\n');
}

// 회의 후 화면 정보 텍스트화가 필요한 슬라이드 — 전환 고지가 한 번도 없었던 실제 화면이다.
function listSlideMajorWithoutTransitionLine({ snapshot }) {
  const cancelledList = snapshot.cancelledTransitionList || [];
  const transitionMajorSet = new Set((snapshot.transitionList || [])
    .filter((transition) => !isCancelledTransition({ transition, cancelledList }))
    .map((transition) => transition.slideMajor));
  return (snapshot.slideList || [])
    .filter((slide) => !slide.hasTransition && !transitionMajorSet.has(slide.major))
    .filter((slide) => listLiveVisit({ slide, cancelledList }).length > 0)
    .map((slide) => String(slide.major));
}

function buildScriptFileName({ sessionId }) {
  return `${String(sessionId ?? '').replace(/[^a-zA-Z0-9_-]/g, '')}-script.txt`;
}

module.exports = {
  buildTranscriptScript, buildScriptFileName, listSlideMajorWithoutTransitionLine,
  UNKNOWN_SPEAKER_LABEL, EMPTY_SCRIPT_TEXT,
};
