const { NARRATION_TYPE_MAP, INTERPRETATION_KIND_MAP } = require('../contracts/narration-types');
const {
  GROUNDING_NONE_TOKEN, computeMaxChars, buildSlotOutputInstruction, SPEECH_GAP_DECIDED_RULE,
} = require('../agents/shared/caption-parser');
const { DEFAULT_CAPTION_LANGUAGE } = require('../contracts/caption-language');
const { buildOutputLanguageRuleList } = require('./output-language-rule');
const { buildScreenTextBlock } = require('./screen-text-block');
const { resolveContentSwitch } = require('../agents/shared/content-switch');

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
    '화면에서 발표자가 말한 대상(또는 그 대상에 속한 항목)의 **숫자**를 찾아 발표자의 표현과 연결하라.',
    '  · 바뀌기 전 값과 바뀐 뒤 값이 둘 다 있으면 둘 다 쓰고, 한 값만 있으면 그 값 하나로 충분하다.',
    '  · 발표자의 낱말과 화면 항목 이름이 달라도 그 대상에 속한 항목이면 관련된 숫자다(예: "인력" ↔ 개발자·디자이너).',
    `  · **화면에 그 대상과 관련된 숫자가 하나라도 있으면 "${GROUNDING_NONE_TOKEN}"을 내지 않는다.**`,
    '  예) "나이 제한이 1년 바뀌었다는 점을 말씀드리고요" → "지원 자격 나이 제한, 작년 25세 올해 26세"',
    '발표자가 말한 대상이 화면의 여러 항목을 묶어 부르는 말이면(인력·시설·제품군 등) 값이 있는 항목을 2개까지',
    '  각자의 값과 함께 쓴다. 대상 칸에는 발표자가 말한 묶음 이름을 쓴다. 하나만 고르면 나머지를 청자가 모른다.',
    '  예) "인력이 크게 늘었습니다" + 화면 "개발자 120명, 디자이너 30명" → "인력, 개발자 120명과 디자이너 30명"',
    '화면에 바뀌기 전 값이 없고 바뀐 뒤 값만 있으면 그 값을 근거로 쓴다(지금 개수·현재 값도 근거다).',
    `  이전 값이 없다는 이유로 "${GROUNDING_NONE_TOKEN}"을 내지 않는다.`,
    '  예) "가입자가 크게 늘었습니다" + 화면 "누적 가입자 120만 명" → "누적 가입자, 120만 명"',
    `**화면에 수치가 없으면 "${GROUNDING_NONE_TOKEN}"이다.** 값 칸은 "80%", "25세", "3단계"처럼`,
    '  실제 수치여야 한다. 항목 이름·제목·라벨("시장점유율", "G(즉, LLM)")은 값이 아니다.',
    '  화면이 글머리 기호와 문장뿐이라면 이 유형은 성립하지 않는다 — 억지로 만들지 마라.',
  ],
};

// 값을 맞혀도 그 값이 언제·무엇과 견준·어떤 조건의 값인지 빠지면 그 세부를 묻는 말에 답할 수 없다.
// 값을 읽은 줄을 근거 칸(source)에 먼저 옮겨 적게 해 그 줄의 머리글·제목에서 가르는 사실을 고르게 한다.
const FACT_COMPLETE_RULE_LIST = [
  '(4) 값이 무엇의 값인지 가르는 사실 — 시점, 비교 상대(작년 대비·평균 대비), 조건(지역·연령·기준), 범위의 끝 — 이'
    + ' 그 값의 줄·머리글·제목에 적혀 있으면 빠뜨리지 않는다.',
  '    source 칸에 값을 읽은 줄을 머리글·제목과 함께 먼저 옮겨 적고, 대상·해석틀은 거기서 고른다. 화면에 없는 사실은 쓰지 않는다.',
];

// 짧은 명사구로 간추리다 연도·분기부터 빼면 변화·비교 값이 언제의 것인지 알 수 없다. 발표자가 말한 시점이어도 남긴다.
const TIME_MARK_RULE = '    시점(연도·분기·월·주)은 지우지 않는다 — 그 값·대상에 적혀 있으면 발표자가 말한 시점이어도 쓰고,'
  + ' 어절이 모자라면 다른 꾸밈말을 먼저 줄인다.';

// 같은 화면을 OCR 로 읽은 줄(screenLineList)로 프롬프트에 넣을 덩어리를 만든다. 줄 고르기는 발화와
// 해설이 함께 다루는 표현(지시 구·둘째 변화 구)의 낱말을 본다. 줄이 없으면 빈 덩어리다.
function buildInterpretationScreenTextBlock({ screenLineList = [], utterance = '', subKind = null,
  mergedAnchorList = [], mergedClaimList = [] }) {
  return buildScreenTextBlock({
    lineList: screenLineList,
    keywordSourceList: [utterance || '', ...mergedAnchorList, ...mergedClaimList],
    isClaimToValue: subKind === INTERPRETATION_KIND_MAP.claimToValue,
  });
}

function buildInterpretationPrompt({ utterance, recentTranscript = '', subKind = null,
  minWordCount = DEFAULT_INTERPRETATION_MIN_WORD_COUNT,
  maxWordCount = DEFAULT_INTERPRETATION_MAX_WORD_COUNT,
  maxChars = null, describedElementList = [], mergedAnchorList = [], mergedClaimList = [],
  screenLineList = [], language = DEFAULT_CAPTION_LANGUAGE, contentSwitch = null }) {
  const resolvedSwitch = resolveContentSwitch(contentSwitch);
  const effectiveMaxChars = Number.isFinite(maxChars) ? maxChars : computeMaxChars({ maxWordCount, language });
  const screenTextBlock = buildInterpretationScreenTextBlock({
    screenLineList, utterance, subKind, mergedAnchorList, mergedClaimList,
  });
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
    mergedClaimList.length
      ? `발표자는 변화를 또 말했다: ${mergedClaimList.map((phrase) => `"${phrase}"`).join(', ')}.`
        + ' 그 대상이 첫 변화의 대상과 다르면(예: 매출과 방문자 수) "target2"·"value2"에 그 대상과 화면의 값을 쓴다.'
        + ' 같은 대상·같은 값을 다시 말한 것이면 "target2"·"value2"는 빈 문자열로 둔다.'
      : '',
    // 화면 글자 덩어리는 규칙 바로 앞에 빈 줄 하나를 두고 넣는다. 덩어리가 없으면 프롬프트는 글자 하나까지 그대로다.
    screenTextBlock.text ? `${screenTextBlock.text}\n` : '',
    '',
    '청자는 화면을 볼 수 없다.',
    SPEECH_GAP_DECIDED_RULE,
    ...ruleList,
    '',
    buildSlotOutputInstruction({
      narrationType: NARRATION_TYPE_MAP.interpretation,
      subKind: subKind || INTERPRETATION_KIND_MAP.valueToMeaning,
      hasSecondClaim: mergedClaimList.length > 0,
      language,
      contentSwitch: resolvedSwitch,
    }),
    '',
    '규칙:',
    '(1) 화면에 실제로 보이는 값·문구만 쓴다. **추정하거나 지어내지 않는다.**',
    `(2) 화면에서 근거를 찾을 수 없으면 "${GROUNDING_NONE_TOKEN}"만 출력한다.`,
    '(3) 발화 문장을 그대로 옮기지 마라. **핵심만 짧은 명사구로 간추린다.**',
    '    "이 상태가 달라집니다" → "준비 상태에 따른 차이"',
    '    지시어("이·그·저·여기·이런")는 넣지 않는다 — 청자는 그것을 볼 수 없다.',
    resolvedSwitch.isTimeMarkEnabled ? TIME_MARK_RULE : '',
    ...(resolvedSwitch.isFactCompleteEnabled ? FACT_COMPLETE_RULE_LIST : []),
    `(참고: 조립 후 총 ${minWordCount}~${maxWordCount}어절, 최대 ${effectiveMaxChars}자 분량이다.)`,
    ...buildOutputLanguageRuleList({
      language,
      detailLineList: ['수치는 화면 그대로 아라비아 숫자로 쓴다(예: 73%, 9.2 hours). 시스템이 "… means …"·"대상, 값" 꼴로 조립한다.'],
    }),
  ].filter(Boolean).join('\n');
}

module.exports = {
  buildInterpretationPrompt, buildInterpretationScreenTextBlock, INTERPRETATION_RULE_MAP,
  DEFAULT_INTERPRETATION_MIN_WORD_COUNT, DEFAULT_INTERPRETATION_MAX_WORD_COUNT,
};
