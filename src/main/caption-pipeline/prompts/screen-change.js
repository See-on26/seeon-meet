// 같은 슬라이드 안 화면 변화 해설 프롬프트. 새로 나타난 것 중 발화로 듣지 못한 사실 하나를 값 위주로 짧게 알린다.
const { NARRATION_TYPE_MAP, SCREEN_CHANGE_KIND_MAP } = require('../contracts/narration-types');
const { GROUNDING_NONE_TOKEN, buildSlotOutputInstruction } = require('../agents/shared/caption-parser');
const { DEFAULT_CAPTION_LANGUAGE } = require('../contracts/caption-language');
const { buildOutputLanguageRuleList } = require('./output-language-rule');

const SCREEN_CHANGE_LINE_MAX_COUNT = 6;
const SCREEN_CHANGE_LINE_MAX_CHARS = 200;
const RECENT_TRANSCRIPT_MAX_CHARS = 150;
const QUOTE_FENCE = '"""';

const IMAGE_INTRO_MAP = {
  outline: '이미지에 그려진 빨간 테두리는 시스템이 그린 표시이고, 같은 화면에서 방금 새로 나타나거나 바뀐 곳이다.'
    + ' 테두리 자체는 화면 내용이 아니다.',
  crop: '이 이미지는 같은 화면에서 방금 새로 나타나거나 바뀐 곳을 잘라 낸 것이다.',
  full: '이 화면의 일부가 방금 새로 나타나거나 바뀌었다. 아래 새로 읽힌 글자가 그 내용이다.',
};

const KIND_RULE_MAP = {
  [SCREEN_CHANGE_KIND_MAP.newText]: [
    '새로 나타난 것 중 발화로 듣지 못한 사실 하나를 값 위주로 짧게 알린다.',
    '"target"에는 그 값이 무엇의 값인지(화면의 라벨·항목 이름), "value"에는 화면에 적힌 값을 쓴다.',
  ],
  [SCREEN_CHANGE_KIND_MAP.highlight]: [
    '새 글자는 없고 기존 글자가 새로 강조됐다(색칠·테두리·체크 표시 등).',
    '무엇이 새로 강조됐는지 그 항목 이름만 "target"에 쓴다.',
  ],
  [SCREEN_CHANGE_KIND_MAP.visual]: [
    '글자 변화 없이 그림·도형이 새로 나타나거나 바뀌었다. 무엇이 새로 나타났는지 이름만 "target"에 쓴다.',
  ],
};

// 숫자 줄이 먼저 오게 넘겨받은 줄을 상한(줄 수·글자 수) 안에서 앞에서부터 담는다.
function selectLineList(lineList) {
  const selectedList = [];
  let charCount = 0;
  for (const text of lineList.map((line) => String(line || '').trim()).filter(Boolean)) {
    if (selectedList.length >= SCREEN_CHANGE_LINE_MAX_COUNT || charCount + text.length > SCREEN_CHANGE_LINE_MAX_CHARS) break;
    selectedList.push(text);
    charCount += text.length;
  }
  return selectedList;
}

// 최근 발화는 가장 최근 쪽을 남긴다.
function trimRecentTranscript(text) {
  const trimmed = String(text || '').trim();
  return trimmed.length > RECENT_TRANSCRIPT_MAX_CHARS ? trimmed.slice(-RECENT_TRANSCRIPT_MAX_CHARS) : trimmed;
}

function buildScreenChangePrompt({ eventKind = SCREEN_CHANGE_KIND_MAP.newText, lineList = [], recentTranscript = '',
  describedElementList = [], imageMode = 'outline', language = DEFAULT_CAPTION_LANGUAGE }) {
  const selectedLineList = selectLineList(lineList);
  const transcript = trimRecentTranscript(recentTranscript);
  return [
    '이 이미지는 회의에서 공유 중인 화면이다.',
    IMAGE_INTRO_MAP[imageMode] || IMAGE_INTRO_MAP.outline,
    '청자는 화면을 볼 수 없다.',
    ...(KIND_RULE_MAP[eventKind] || KIND_RULE_MAP[SCREEN_CHANGE_KIND_MAP.newText]),
    selectedLineList.length
      ? [
        '새로 읽힌 글자(글자 인식기 OCR, 숫자가 있는 줄 먼저). 철자 확인용이고, 어느 값이 어느 항목의 것인지는 이미지에서 확인한다:',
        QUOTE_FENCE, ...selectedLineList, QUOTE_FENCE,
      ].join('\n')
      : null,
    transcript ? `최근 발화(청자가 이미 들은 말): "${transcript}"` : null,
    describedElementList.length ? `이 화면에서 이미 안내한 것(되풀이 금지): ${describedElementList.join(', ')}` : null,
    '',
    '규칙:',
    '- 값은 반올림·어림하지 않고 화면 글자 그대로 쓴다. 단위·보기 번호도 그대로 쓴다.',
    `- 다음이면 "${GROUNDING_NONE_TOKEN}"이다.`,
    '  · 바뀐 곳이 커서·메뉴·알림 창·재생 조작 버튼·도구 막대·장식이다.',
    '  · 최근 발화가 같은 값을 이미 말했다.',
    '  · 바뀐 내용이 발표 내용과 관계없다.',
    '',
    buildSlotOutputInstruction({ narrationType: NARRATION_TYPE_MAP.screenChange, subKind: eventKind, language }),
    ...buildOutputLanguageRuleList({
      language, detailLineList: ['고정 문구("Now shown:"·"Highlighted:")는 시스템이 붙이므로 넣지 마라.'],
    }),
  ].filter((line) => line !== null).join('\n');
}

module.exports = {
  buildScreenChangePrompt, SCREEN_CHANGE_LINE_MAX_COUNT, SCREEN_CHANGE_LINE_MAX_CHARS, RECENT_TRANSCRIPT_MAX_CHARS,
};
