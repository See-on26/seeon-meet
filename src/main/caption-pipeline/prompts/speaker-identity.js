const { NARRATION_TYPE_MAP } = require('../contracts/narration-types');
const { GROUNDING_NONE_TOKEN, buildSlotOutputInstruction } = require('../agents/shared/caption-parser');

const DEFAULT_SPEAKER_MIN_WORD_COUNT = 2;
const DEFAULT_SPEAKER_MAX_WORD_COUNT = 5;

const CONFIDENCE_MAP = { high: 'high', low: 'low' };

function buildSpeakerIdentityPrompt({
  minWordCount = DEFAULT_SPEAKER_MIN_WORD_COUNT,
  maxWordCount = DEFAULT_SPEAKER_MAX_WORD_COUNT,
} = {}) {
  return [
    '이 이미지는 화상회의 화면의 참가자 타일(프로필) 영역이다.',
    '청자는 시각장애인이라 화면을 볼 수 없어 지금 누가 말하고 있는지 알 수 없다.',
    '',
    '화상회의 앱은 **말하는 사람의 타일 테두리를 강조**한다.',
    '  · 파란색·흰색 등의 굵은 윤곽선, 발광하는 테두리 링, 타일 둘레의 색 테두리가 그 신호다.',
    '  · 카메라를 끈 참가자도 아바타(이니셜) 타일 둘레에 같은 강조가 뜬다.',
    '',
    '판정 규칙 — **애매하면 말하지 않는다**:',
    '  · 테두리가 강조된 타일이 **정확히 하나**일 때만 발화자로 본다.',
    '    강조된 타일이 하나도 없거나 둘 이상이면 NONE.',
    '  · 마우스 호버 하이라이트, 고정(핀) 표시, 선택 테두리는 발화 강조가 아니다.',
    '  · 강조 여부가 확실하지 않으면 추측하지 말고 NONE을 출력하라.',
    '',
    '발화자를 찾았으면 그 타일에서 다음을 읽는다:',
    '  · speakerName: 타일에 적힌 참가자 이름. **호칭("님")·직함은 빼고 이름만.**',
    '    이름표가 없거나 글자를 실제로 읽지 못했으면 **지어내지 말고 빈 문자열**로 둔다.',
    '  · position: 그 타일이 화면에서 어디에 있는지 1~2어절. 예) "왼쪽 위", "가운데", "오른쪽 아래"',
    '    (이름을 읽었더라도 항상 채운다 — 이름이 비었을 때 이 값으로 안내한다.)',
    '  · confidence: 강조 판정에 확신이 있으면 "high", 아니면 "low".',
    '',
    `고지는 시스템이 "…님이 말합니다" 형태로 조립한다(${minWordCount}~${maxWordCount}어절).`,
    '**문장을 만들지 말고 아래 JSON 한 줄만 출력한다**(다른 텍스트 금지):',
    `{ "speakerName": "이름 또는 빈 문자열", "position": "타일 위치", "confidence": "${CONFIDENCE_MAP.high}|${CONFIDENCE_MAP.low}" }`,
    `발화자를 특정할 수 없으면 JSON 대신 정확히 "${GROUNDING_NONE_TOKEN}"만 출력한다.`,
  ].join('\n');
}

module.exports = { buildSpeakerIdentityPrompt, CONFIDENCE_MAP, DEFAULT_SPEAKER_MIN_WORD_COUNT, DEFAULT_SPEAKER_MAX_WORD_COUNT };
