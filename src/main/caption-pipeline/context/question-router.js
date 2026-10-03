const { parseJsonObject } = require('./parse-json-response');
const { formatElapsed } = require('./clock-format');
const { QUESTION_ROUTE_MAP } = require('./question-classifier');

const FOLLOW_UP_WINDOW_MS = 60000;
const MAX_TARGET_SLIDE_COUNT = 3;
const ROUTER_MAX_TOKENS = 120;
const AGENT_LABEL = '질문 라우터';

const ROUTER_ROUTE_LIST = [
  QUESTION_ROUTE_MAP.currentScreen, QUESTION_ROUTE_MAP.pastSlide, QUESTION_ROUTE_MAP.speaker,
  QUESTION_ROUTE_MAP.narrationReplay, QUESTION_ROUTE_MAP.meetingFlow, QUESTION_ROUTE_MAP.none,
];

// 되묻기는 1턴만 받는다. 되묻기에 대한 답(isFollowUp)에는 다시 붙이지 않는다.
function selectFollowUpQa({ lastQa, now }) {
  if (!lastQa || lastQa.isFollowUp) return null;
  return now - lastQa.ts <= FOLLOW_UP_WINDOW_MS ? lastQa : null;
}

function formatIndexLine({ entry, startedAt }) {
  const fieldList = [
    entry.major,
    `슬라이드 ${entry.displayNumber ?? entry.major}`,
    entry.title || '(제목 없음)',
    entry.keywordList.length ? entry.keywordList.join(', ') : '-',
    formatElapsed({ ts: entry.firstSeenTs, startedAt }),
  ];
  if (entry.isCurrent) fieldList.push('현재');
  return fieldList.join(' | ');
}

function buildRouterPrompt({ questionText, currentSlideMajor, index, followUpQa, startedAt }) {
  const followUpLineList = followUpQa ? [
    '',
    '직전 질문과 답 (되묻는 질문이면 직전 대상 슬라이드를 그대로 쓴다):',
    `질문: ${followUpQa.question}`,
    `답: ${followUpQa.answer}`,
    `대상 슬라이드: ${followUpQa.slideMajorList.join(', ') || '없음'}`,
  ] : [];
  return [
    '시각장애인 사용자가 회의 중에 질문했다. 답을 어디서 찾을지 고른다.',
    'JSON 하나만 출력한다. 형식: {"route": "<갈래>", "slideMajorList": [슬라이드 번호]}',
    '갈래:',
    '- current_screen: 지금 화면에 대한 질문',
    '- past_slide: 지나간 슬라이드의 내용 (색인의 제목·키워드로 찾는다)',
    '- speaker: 누가 무슨 말을 했는지',
    '- narration_replay: 앞서 들려준 화면 해설을 다시 듣고 싶음',
    '- meeting_flow: 지금까지의 회의 흐름이나 여러 슬라이드에 걸친 내용',
    '- none: 회의와 관계없는 질문',
    `slideMajorList 에는 근거가 될 슬라이드의 id 를 최대 ${MAX_TARGET_SLIDE_COUNT}개 넣는다. 지금 화면 질문이면 현재 슬라이드 id 를 넣는다.`,
    '사용자가 말하는 "N번 슬라이드"는 색인의 "슬라이드 N"(사용자가 들은 번호)이다.',
    '"아까·방금·이전"은 처음 나온 시각과 현재 슬라이드를 보고 판단한다.',
    '',
    `현재 슬라이드 id: ${currentSlideMajor ?? '없음'}`,
    '슬라이드 색인 (id | 들은 번호 | 제목 | 키워드 | 처음 나온 시각):',
    ...(index.length ? index.map((entry) => formatIndexLine({ entry, startedAt })) : ['(아직 없음)']),
    ...followUpLineList,
    '',
    `질문: ${questionText}`,
  ].join('\n');
}

function parseRouterResponse({ text, index }) {
  const parsed = parseJsonObject(text);
  if (!parsed || !ROUTER_ROUTE_LIST.includes(parsed.route)) return null;
  const knownMajorSet = new Set(index.map((entry) => entry.major));
  const slideMajorList = [...new Set((Array.isArray(parsed.slideMajorList) ? parsed.slideMajorList : [])
    .map(Number)
    .filter((major) => knownMajorSet.has(major)))].slice(0, MAX_TARGET_SLIDE_COUNT);
  if (parsed.route === QUESTION_ROUTE_MAP.pastSlide && !slideMajorList.length) return null;
  return { route: parsed.route, slideMajorList };
}

function createQuestionRouter({ requestText }) {
  async function route(args) {
    // 라우터가 실패하면 지금 화면으로 답한다. 이 기능 이전의 동작과 같다.
    const fallback = (reason) => ({
      route: QUESTION_ROUTE_MAP.currentScreen,
      slideMajorList: args.currentSlideMajor === null || args.currentSlideMajor === undefined
        ? [] : [args.currentSlideMajor],
      source: 'fallback',
      reason,
    });
    try {
      const text = await requestText({
        prompt: buildRouterPrompt(args), label: AGENT_LABEL, maxTokens: ROUTER_MAX_TOKENS,
      });
      const parsed = parseRouterResponse({ text, index: args.index });
      return parsed ? { ...parsed, source: 'llm', reason: '' } : fallback(`해석 실패: ${String(text).slice(0, 60)}`);
    } catch (error) {
      return fallback(error.message);
    }
  }
  return { route };
}

module.exports = {
  createQuestionRouter, buildRouterPrompt, parseRouterResponse, selectFollowUpQa, FOLLOW_UP_WINDOW_MS,
};
