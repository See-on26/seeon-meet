const { NARRATION_TYPE_MAP, INTERPRETATION_KIND_MAP } = require('../contracts/narration-types');
const {
  GROUNDING_NONE_TOKEN, computeMaxChars, buildSlotOutputInstruction, parseSlotCaption,
} = require('./shared/caption-parser');
const { requestVlmContent } = require('./shared/vlm-gateway');

const AGENT_LABEL = '해석연결';

const DEFAULT_INTERPRETATION_MIN_WORD_COUNT = 6;
const DEFAULT_INTERPRETATION_MAX_WORD_COUNT = 12;

const INTERPRETATION_RULE_MAP = {
  [INTERPRETATION_KIND_MAP.valueToMeaning]: [
    '발표자는 수치만 말하고 그 수치가 무엇을 뜻하는지는 말하지 않았다.',
    '화면에서 그 수치의 **대상·기준·가치**(해석틀)를 찾아 수치와 연결하라.',
    '  예) "이 73%라는 숫자가 예사 숫자가 아닙니다" → "73%는 작년 대비 A사 기업가치 성장률"',
  ],
  [INTERPRETATION_KIND_MAP.claimToValue]: [
    '발표자는 변화·비교·결론만 말하고 그 근거가 되는 구체적 값은 말하지 않았다.',
    '화면에서 그 **근거 값**(양쪽 수치 등)을 찾아 발표자의 표현과 연결하라.',
    '  예) "나이 제한이 1년 바뀌었다는 점을 말씀드리고요" → "지원 자격 나이 제한, 작년 25세 올해 26세"',
  ],
};

function buildInterpretationPrompt({ utterance, recentTranscript = '', subKind = null,
  minWordCount = DEFAULT_INTERPRETATION_MIN_WORD_COUNT,
  maxWordCount = DEFAULT_INTERPRETATION_MAX_WORD_COUNT,
  maxChars = null, describedElementList = [], mergedAnchorList = [] }) {
  const effectiveMaxChars = Number.isFinite(maxChars) ? maxChars : computeMaxChars({ maxWordCount });
  const ruleList = INTERPRETATION_RULE_MAP[subKind]
    || [...INTERPRETATION_RULE_MAP[INTERPRETATION_KIND_MAP.valueToMeaning],
      ...INTERPRETATION_RULE_MAP[INTERPRETATION_KIND_MAP.claimToValue]];
  return [
    '이 이미지는 회의에서 공유 중인 화면이다.',
    `발표자가 방금 이렇게 말했다: "${(utterance || '').trim()}"`,
    recentTranscript ? `참고로 최근 발화 맥락은 다음과 같다: ${recentTranscript}` : '',
    describedElementList.length
      ? `이 화면에서 다음은 이미 안내되었다(재설명 금지): ${describedElementList.join(', ')}`
      : '',
    mergedAnchorList.length
      ? `발표자가 지시한 표현: ${mergedAnchorList.join(', ')}. 이 대상이 무엇인지도 문장 안에 함께 밝혀라.`
      : '',
    '',
    '청자는 화면을 볼 수 없다.',
    ...ruleList,
    '',
    buildSlotOutputInstruction({
      narrationType: NARRATION_TYPE_MAP.interpretation,
      subKind: subKind || INTERPRETATION_KIND_MAP.valueToMeaning,
    }),
    '',
    '규칙:',
    '(1) 화면에 실제로 보이는 값·문구만 쓴다. **추정하거나 지어내지 않는다.**',
    `(2) 화면에서 근거를 찾을 수 없으면 "${GROUNDING_NONE_TOKEN}"만 출력한다.`,
    `(3) 발표자가 이미 말로 밝힌 내용이면 반복하지 말고 "${GROUNDING_NONE_TOKEN}"만 출력한다.`,
    `(참고: 조립 후 총 ${minWordCount}~${maxWordCount}어절, 최대 ${effectiveMaxChars}자 분량이다.)`,
  ].filter(Boolean).join('\n');
}

function createInterpretiveBridgeAgent({ config }) {
  async function generate({ jpegBuffer, utterance, recentTranscript = '',
    subKind = null, minWordCount = DEFAULT_INTERPRETATION_MIN_WORD_COUNT,
    maxWordCount = DEFAULT_INTERPRETATION_MAX_WORD_COUNT,
    describedElementList = [], mergedAnchorList = [] }) {
    const effectiveMaxChars = computeMaxChars({ maxWordCount });
    const content = await requestVlmContent({
      config, jpegBuffer, label: AGENT_LABEL,
      prompt: buildInterpretationPrompt({
        utterance, recentTranscript, subKind, minWordCount, maxWordCount,
        maxChars: effectiveMaxChars, describedElementList, mergedAnchorList,
      }),
    });
    return parseSlotCaption({
      content,
      narrationType: NARRATION_TYPE_MAP.interpretation,
      subKind: subKind || INTERPRETATION_KIND_MAP.valueToMeaning,
      maxChars: effectiveMaxChars, maxWordCount,
    });
  }

  return { generate };
}

module.exports = {
  createInterpretiveBridgeAgent, buildInterpretationPrompt, INTERPRETATION_RULE_MAP,
};
