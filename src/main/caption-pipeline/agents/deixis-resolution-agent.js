const { NARRATION_TYPE_MAP, DEIXIS_FORM_MAP } = require('../contracts/narration-types');
const {
  GROUNDING_NONE_TOKEN, computeMaxChars, buildSlotOutputInstruction, parseSlotCaption,
} = require('./shared/caption-parser');
const { requestVlmContent } = require('./shared/vlm-gateway');

const AGENT_LABEL = '그라운딩';

const DEFAULT_DEIXIS_MIN_WORD_COUNT = 4;
const DEFAULT_DEIXIS_MAX_WORD_COUNT = 8;

const DEIXIS_FORM_RULE_MAP = {
  [DEIXIS_FORM_MAP.simple]: [
    '형식: (지시대상 묘사/내용 — 자료 종류 포함, 2~5어절) + (상황 묘사 — 발화 모사, 2어절).',
    '  · 지시대상 슬롯 하나에 "무엇의 무슨 자료인지"를 함께 담는다. 자료 종류를 따로 쪼개지 마라.',
    '  예) "여기를 보시면" → target="2년간 매출 추이 표를", situation="보는 중"',
    '  예) "오른쪽 것을 주목해 주십쇼" → target="설문 결과 표를", situation="주목 중"',
  ],
  [DEIXIS_FORM_MAP.complete]: [
    '형식: (발화 모사 2~3어절) + (지시대상 1~2어절) + (설명 3~5어절).',
    '  · 세 요소를 각각 내되, **최종 문장(sentence)은 순서를 바꿔 자연스럽게** 만든다.',
    '    셋의 내용은 문장 안에 모두 들어가야 한다. 주어-서술어 순서는 유연히 바꿔도 된다.',
    '  예) "그 중에 가장 으뜸인 게 이거거든요"',
    '      → mimicry="가장 으뜸인", target="E방식", explanation="다섯 방식 중 하나",',
    '        sentence="다섯 방식 중 E방식이 가장 으뜸임"',
    '  예) "이거랑 이게 여기 같이 있는 거거든요"',
    '      → mimicry="같이 있는", target="워드 파일", explanation="텍스트와 텍스트 같은 이미지가",',
    '        sentence="텍스트와 텍스트 같은 이미지가 워드 파일에 같이 있음"',
  ],
};

function buildGroundingPrompt({ utterance, recentTranscript, maxChars,
  hasPointingRegion = false, pointingOrderHint = '', describedElementList = [],
  minWordCount = DEFAULT_DEIXIS_MIN_WORD_COUNT, maxWordCount = DEFAULT_DEIXIS_MAX_WORD_COUNT,
  subKind = null, mergedAnchorList = [] }) {
  const trimmedUtterance = (utterance || '').trim();

  const formRuleList = DEIXIS_FORM_RULE_MAP[subKind]
    || [...DEIXIS_FORM_RULE_MAP.simple, ...DEIXIS_FORM_RULE_MAP.complete];
  return [
    hasPointingRegion
      ? '이 이미지는 회의 공유화면에서 발표자가 방금 필기하거나 포인터로 가리킨 영역을 확대한 것이다.'
      : '이 이미지는 회의에서 공유 중인 화면이다.',
    trimmedUtterance
      ? `발표자가 방금 이렇게 말하며 화면의 무언가를 가리켰다: "${trimmedUtterance}"`
      : '발표자가 발화 없이 필기·포인터로 이 영역을 표시했다.',
    recentTranscript
      ? `발표자의 인접 발화(앞 1분 + 뒤 2초)는 다음과 같다: ${recentTranscript}`
      : '',
    describedElementList.length
      ? `이미 안내된 시각 요소·내레이션이다(재설명 금지): ${describedElementList.join(' / ')}`
      : '',
    pointingOrderHint
      ? `발표자가 화면을 다음 순서로 표시(필기/포인터)했다: ${pointingOrderHint}. 이 선후관계를 반영해 설명하라.`
      : '',
    mergedAnchorList.length
      ? `발표자가 지시한 표현: ${mergedAnchorList.join(', ')}. 이 대상이 무엇인지도 문장 안에 함께 밝혀라.`
      : '',
    '청자는 화면을 볼 수 없다. 발표자가 가리킨 대상 중, 말로는 아직 설명되지 않은 시각 정보를 보충하는 캡션을 만들어라.',
    '',
    '**출력하지 않는 것이 기본값이다.** 아래 하나라도 해당하면 캡션을 만들지 마라:',
    '  · 인접 발화가 그 대상의 정체와 내용을 이미 말했다 (필기·포인터가 있었더라도 마찬가지다 —',
    '    말로 설명된 곳을 가리킨 것뿐이면 청자는 이미 안다)',
    '  · "이미 안내된" 목록과 **내용이 겹친다** (표현이 달라도 같은 대상·같은 내용이면 겹친 것이다)',
    '  · 화면에서 대상을 특정할 수 없다 / 보충할 새 정보가 없다',
    '출력할 것은 **화면을 봐야만 알 수 있고, 내용 이해에 필요한 것**뿐이다.',
    '',
    ...formRuleList,
    '',
    buildSlotOutputInstruction({
      narrationType: NARRATION_TYPE_MAP.deixis,
      subKind: subKind || DEIXIS_FORM_MAP.simple,
    }),
    '',
    '규칙:',
    '(1) 화면에 실제로 보이는 것만 쓴다. 지어내지 않는다.',
    '(2) 발표자 발화의 문장 구성과 어휘를 모사한다. 발화에 없던 어투를 새로 만들지 않는다.',
    '(3) 종결은 "~임", "~음", "~함"처럼 간결한 명사형으로 한다. 존댓말·설명체를 쓰지 않는다.',
    '(4) 지시 대상은 "불상 사진", "2년간 매출 추이 표"처럼 간략한 주제를 덧붙여 밝힌다.',
    '(5) 가리킨 대상에 항목명과 수치가 같이 있으면 둘 다 넣는다.',
    `(6) 위 "출력하지 않는 것" 중 하나라도 해당하면 정확히 "${GROUNDING_NONE_TOKEN}"만 출력한다.`,
    `(참고: 총 ${minWordCount}~${maxWordCount}어절, 최대 ${maxChars}자 분량이다.)`,
  ].filter(Boolean).join('\n');
}

function createDeixisResolutionAgent({ config }) {
  async function generate({ jpegBuffer, utterance, recentTranscript = '',
    maxChars = null, hasPointingRegion = false, pointingOrderHint = '',
    describedElementList = [], minWordCount = DEFAULT_DEIXIS_MIN_WORD_COUNT,
    maxWordCount = DEFAULT_DEIXIS_MAX_WORD_COUNT, subKind = null, mergedAnchorList = [] }) {
    const effectiveMaxChars = Number.isFinite(maxChars) ? maxChars : computeMaxChars({ maxWordCount });
    const content = await requestVlmContent({
      config, jpegBuffer, label: AGENT_LABEL,
      prompt: buildGroundingPrompt({
        utterance, recentTranscript, maxChars: effectiveMaxChars, hasPointingRegion,
        pointingOrderHint, describedElementList, minWordCount, maxWordCount, subKind, mergedAnchorList,
      }),
    });
    return parseSlotCaption({
      content,
      narrationType: NARRATION_TYPE_MAP.deixis, subKind: subKind || DEIXIS_FORM_MAP.simple,
      maxChars: effectiveMaxChars, maxWordCount,
    });
  }

  return { generate };
}

module.exports = { createDeixisResolutionAgent, buildGroundingPrompt, DEIXIS_FORM_RULE_MAP };
