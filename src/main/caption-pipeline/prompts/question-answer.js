const { formatElapsed } = require('../context/clock-format');
const { buildAnswerLengthRule } = require('./answer-length-rule');

const NEED_IMAGE_TOKEN = 'NEED_IMAGE';
const SLIDE_TEXT_EVIDENCE_LIMIT = 1500;
const UTTERANCE_PER_SLIDE_LIMIT = 15;

function formatUtteranceLine({ utterance, startedAt }) {
  const speaker = utterance.speakerHint ? `${utterance.speakerHint}: ` : '';
  return `[${formatElapsed({ ts: utterance.ts, startedAt })}] ${speaker}${utterance.text}`;
}

function buildAnswerRuleList({ minWordCount, maxWordCount, notFoundToken = 'NONE' }) {
  return [
    '규칙:',
    '(1) 아래 기록에 근거해서만 답한다. 지어내지 않는다.',
    `(2) 기록에서 답을 찾을 수 없으면 정확히 "${notFoundToken}"만 출력한다. 설명 문장을 붙이지 않는다.`,
    `(3) 답을 찾았으면 ${buildAnswerLengthRule({ minWordCount, maxWordCount })} 머리말 없이 답만 출력한다.`,
  ];
}

function buildSlideEvidence({ slide, utteranceList, narrationList, startedAt }) {
  return [
    `[슬라이드 ${slide.displayNumber ?? slide.major}] ${slide.label?.title || slide.pageTopic || ''}`.trim(),
    slide.pageTopic ? `화면 주제: ${slide.pageTopic}` : '',
    slide.description ? `화면 묘사: ${slide.description}` : '',
    slide.slideText ? `화면 글자: ${slide.slideText.slice(0, SLIDE_TEXT_EVIDENCE_LIMIT)}` : '',
    utteranceList.length ? '이 화면에서 오간 말 (화자는 화면 표시로 추정):' : '',
    ...utteranceList.slice(-UTTERANCE_PER_SLIDE_LIMIT).map((utterance) => formatUtteranceLine({ utterance, startedAt })),
    narrationList.length ? `들려준 해설: ${narrationList.map((narration) => narration.text).join(' / ')}` : '',
  ].filter(Boolean).join('\n');
}

// 저장 이미지가 있으면 글자 기록에서 못 찾은 답을 그림에서 다시 찾는다(텍스트 우선, 모자라면 이미지).
function buildPastSlideAnswerPrompt({ questionText, evidenceText, minWordCount, maxWordCount, hasImage = false }) {
  return [
    '시각장애인 사용자가 회의 중에 지나간 화면에 대해 물었다. 아래는 그 화면에 대해 저장해 둔 기록이다.',
    '',
    evidenceText,
    '',
    `질문: "${questionText}"`,
    '',
    ...buildAnswerRuleList({ minWordCount, maxWordCount, notFoundToken: hasImage ? NEED_IMAGE_TOKEN : 'NONE' }),
    ...(hasImage
      ? [`(4) 색·배치·모양처럼 화면 그림을 봐야 답할 수 있는 질문도 정확히 "${NEED_IMAGE_TOKEN}"만 출력한다.`]
      : []),
  ].join('\n');
}

function buildImageAnswerPrompt({ questionText, evidenceText, minWordCount, maxWordCount }) {
  return [
    '이 이미지는 회의에서 앞서 공유된 화면이다. 시각장애인 사용자가 이 화면에 대해 물었다.',
    '',
    '참고 기록:',
    evidenceText,
    '',
    `질문: "${questionText}"`,
    '',
    ...buildAnswerRuleList({ minWordCount, maxWordCount }).map((line) => line.replace('아래 기록', '이미지와 기록')),
  ].join('\n');
}

function buildSpeakerAnswerPrompt({ questionText, utteranceText, minWordCount, maxWordCount }) {
  return [
    '시각장애인 사용자가 회의에서 누가 무슨 말을 했는지 물었다. 아래는 발언 기록이다.',
    '화자는 회의 화면의 표시로 추정한 것이다. 화자가 적히지 않은 발언은 누가 했는지 말하지 않는다.',
    '',
    utteranceText || '(발언 기록 없음)',
    '',
    `질문: "${questionText}"`,
    '',
    ...buildAnswerRuleList({ minWordCount, maxWordCount }),
  ].join('\n');
}

function buildNarrationReplayPrompt({ questionText, narrationList }) {
  const lastIndex = narrationList.length - 1;
  return [
    '시각장애인 사용자가 앞서 들려준 화면 해설을 다시 듣고 싶어 한다. 아래는 들려준 순서대로 정리한 해설 목록이다.',
    '',
    ...narrationList.map((narration, index) => `${index + 1}. ${narration.text}${index === lastIndex ? ' (가장 최근)' : ''}`),
    '',
    `질문: "${questionText}"`,
    '',
    '질문에 맞는 해설의 번호 하나만 출력한다.',
    '질문이 특정 해설을 가리키지 않거나 "방금·마지막·다시"처럼 최근 해설을 원하면 가장 최근 번호를 출력한다.',
    '질문이 가리키는 해설이 목록에 분명히 없을 때만 정확히 "NONE"을 출력한다.',
  ].join('\n');
}

function buildMeetingFlowPrompt({ questionText, flowText, minWordCount, maxWordCount }) {
  return [
    '시각장애인 사용자가 지금까지의 회의 흐름에 대해 물었다. 아래는 화면에 나온 순서대로 정리한 기록이다.',
    '',
    flowText || '(기록 없음)',
    '',
    `질문: "${questionText}"`,
    '',
    ...buildAnswerRuleList({ minWordCount, maxWordCount }),
  ].join('\n');
}

module.exports = {
  NEED_IMAGE_TOKEN, formatUtteranceLine, buildSlideEvidence, buildPastSlideAnswerPrompt,
  buildImageAnswerPrompt, buildSpeakerAnswerPrompt, buildNarrationReplayPrompt, buildMeetingFlowPrompt,
};
