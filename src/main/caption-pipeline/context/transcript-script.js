const { formatElapsed } = require('./clock-format');
const { isCancelledTransition, listLiveVisit } = require('./cancelled-transition');
const { CAPTION_LANGUAGE_MAP, DEFAULT_CAPTION_LANGUAGE } = require('../contracts/caption-language');

const EMPTY_SCRIPT_TEXT = '(기록된 발화가 없습니다)';
// 화자 식별이 켜져 있었는데 Meet 화면 표시로 누가 말했는지 알 수 없던 발화. 화자를 빠짐없이 적되 지어내지 않는다.
const UNKNOWN_SPEAKER_LABEL = '화자 미상';
// 지난 회의 스크립트 전문의 이름표와 빈 기록 문구. 캡션 언어가 영어면 영어로 낸다.
const FULL_TRANSCRIPT_TEXT_MAP = {
  [CAPTION_LANGUAGE_MAP.ko]: {
    question: '사용자 질문', answer: 'SEEON 답', unknownSpeaker: UNKNOWN_SPEAKER_LABEL, empty: EMPTY_SCRIPT_TEXT,
  },
  [CAPTION_LANGUAGE_MAP.en]: {
    question: 'User question', answer: 'SEEON answer', unknownSpeaker: 'Unknown speaker', empty: '(No utterances were recorded)',
  },
};
const NO_SCREEN_TEXT_LINE = '화면이 바뀌었습니다 (화면 설명 없음)';
// 전환 고지 요청은 방문을 연 뒤에 나간다(교차 모드는 체류 3초 뒤). 그 사이의 시각 차를 이만큼까지 같은 전환으로 본다.
const VISIT_MATCH_SLACK_MS = 15000;

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

// 화자 식별을 끈 동안의 발화(isSpeakerTracked=false)는 화자를 구분하지 않고 발화만 적는다.
function formatUtteranceLine({ utterance, isSpeakerHidden, unknownSpeakerLabel = UNKNOWN_SPEAKER_LABEL }) {
  if (isSpeakerHidden || utterance.isSpeakerTracked === false) return utterance.text;
  return `${utterance.speakerHint || unknownSpeakerLabel}: ${utterance.text}`;
}

// 회의 한 건의 대화 전문. 발화마다 화자를 적고(화자 식별을 켠 동안), 화면이 바뀔 때마다 페이지 전환 설명 에이전트가 만든 AD 를 한 줄로 끼운다.
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

function formatQaLineList({ qa, textMap }) {
  return [`${textMap.question}: ${qa.question}`, ...(qa.answer ? [`${textMap.answer}: ${qa.answer}`] : [])];
}

// 지난 회의에 남기는 대화 전문. 받아쓴 발화를 화자와 함께 적고, 사용자 질문과 SEEON 의 답을 질문 시각에 넣는다.
// 질문과 답은 한 묶음으로 정렬해 같은 시각의 발화가 있어도 답이 질문 바로 다음 줄에 온다.
// 화면 설명 줄은 넣지 않는다 — 화면 설명은 회의 요약의 재료로만 쓴다.
function buildFullTranscript({ snapshot, language = DEFAULT_CAPTION_LANGUAGE }) {
  const textMap = FULL_TRANSCRIPT_TEXT_MAP[language] || FULL_TRANSCRIPT_TEXT_MAP[DEFAULT_CAPTION_LANGUAGE];
  const utteranceList = snapshot.utteranceList || [];
  const qaList = snapshot.qaList || [];
  if (!utteranceList.length && !qaList.length) return textMap.empty;

  const eventList = [
    ...utteranceList.map((utterance) => ({
      ts: utterance.ts, order: 0,
      lineList: [formatUtteranceLine({ utterance, unknownSpeakerLabel: textMap.unknownSpeaker })],
    })),
    ...qaList.map((qa) => ({ ts: qa.ts, order: 1, lineList: formatQaLineList({ qa, textMap }) })),
  ].sort((left, right) => (left.ts - right.ts) || (left.order - right.order));
  return eventList
    .flatMap((event) => {
      const timeText = formatElapsed({ ts: event.ts, startedAt: snapshot.startedAt });
      return event.lineList.map((line) => `[${timeText}] ${line}`);
    })
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
  buildTranscriptScript, buildFullTranscript, buildScriptFileName, listSlideMajorWithoutTransitionLine,
  UNKNOWN_SPEAKER_LABEL, EMPTY_SCRIPT_TEXT,
};
