const { NARRATION_TYPE_MAP, INTERPRETATION_KIND_MAP } = require('../contracts/narration-types');
const {
  GROUNDING_NONE_TOKEN, computeMaxChars, buildSlotOutputInstruction, SPEECH_GAP_DECIDED_RULE,
} = require('../agents/shared/caption-parser');
const { DEFAULT_CAPTION_LANGUAGE } = require('../contracts/caption-language');
const { buildOutputLanguageRuleList } = require('./output-language-rule');
const { buildScreenTextBlock } = require('./screen-text-block');

const DEFAULT_INTERPRETATION_MIN_WORD_COUNT = 6;
const DEFAULT_INTERPRETATION_MAX_WORD_COUNT = 12;

const INTERPRETATION_RULE_MAP = {
  // 2번 판(2026-10-19): 10/15 이해도 평가의 값→의미 오답은 발화가 붙인 이름을 되풀이하거나("200mm는 많은 곳의 예상 강수량"),
  // 강조된 다른 숫자를 고르거나, 날짜 라벨을 값으로 읽거나, 비교 기준값을 빠뜨린 것이었다. 화면 값 찾기 → 해석틀 → 비교 값 순서로 정한다.
  [INTERPRETATION_KIND_MAP.valueToMeaning]: [
    '발표자는 수치만 말하고 그 수치가 무엇을 뜻하는지는 말하지 않았다.',
    '1) 화면에서 발화의 그 숫자를 찾는다. 같은 숫자가 없으면 발화가 말한 연도·항목·지역의 칸을 찾아 그 화면 값을 value 에 함께 쓴다.',
    '   발표자가 말한 연도·항목과 다른 칸의 숫자(강조색으로 눈에 띄는 숫자라도)로 바꾸지 않는다.',
    '2) frame 에는 그 숫자가 무엇을 세거나 잰 값인지(대상·기준 시점·단위)를 화면에서 읽어 쓴다. 발화가 이미 붙인 이름만 되풀이하지 않는다.',
    '3) 화면에 그 값과 견줄 값(다른 해·다른 항목·평균·범위의 다른 끝)이 함께 있으면 frame 끝에 하나 덧붙인다.',
    '4) 날짜·축 눈금·쪽 번호는 값이 아니다. 화면에 없는 값을 지어내지 않는다.',
    '  예) "이 73%라는 숫자가 예사 숫자가 아닙니다" + 표 "A사 73%, B사 41%" → value="73%", frame="작년 대비 A사 기업가치 성장률, B사 41%"',
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
    // 2번 판: 10/15 주장→값 오답 대부분은 영어 선 그래프·표에서 적힌 숫자가 없거나 흐리다며 NONE 을 낸 것, 날짜 라벨만 읽은 것이었다.
    '그래프에 적힌 숫자가 없으면 축 눈금·격자로 어림해 "약"을 붙여서라도 값을 쓴다. 툴팁·데이터 라벨이 있으면 그 숫자를 그대로 쓴다.',
    '값에는 그 값의 시점(연도·월·주)이나 집단 이름을 붙인다. 날짜 라벨만 쓰고 값을 빠뜨리지 않는다.',
    `  이전 값이 없다는 이유로 "${GROUNDING_NONE_TOKEN}"을 내지 않는다.`,
    '  예) "가입자가 크게 늘었습니다" + 화면 "누적 가입자 120만 명" → "누적 가입자, 120만 명"',
    `**화면에 수치도 눈금도 없으면 "${GROUNDING_NONE_TOKEN}"이다.** 값 칸은 "80%", "25세", "약 450"처럼`,
    '  실제 수치여야 한다. 항목 이름·제목·라벨("시장점유율", "G(즉, LLM)")은 값이 아니다.',
    '  화면이 글머리 기호와 문장뿐이라면 이 유형은 성립하지 않는다 — 억지로 만들지 마라.',
  ],
};

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

// 주장→값(A 대상 고정, 발화 기반 16자리 10/18): 지금 발화의 대상·조건·부분을 먼저 고정하고 그 항목 값을 읽어 잇게 한다.
// 같은 항목의 시간 변화만 "전 값에서 뒤 값", 다른 집단은 나란히, 셋 이상은 조건 이름을 target 에 순서대로 둔다.
// 화면 글자(OCR) 덩어리·둘째 변화(target2) 줄은 운영 판 그대로 더한다. 예시는 평가 영상과 겹치지 않는 내용으로 둔다.
function buildClaimToValuePrompt({ utterance, recentTranscript, minWordCount, maxWordCount, maxChars,
  mergedAnchorList, mergedClaimList, screenTextBlock, language }) {
  return [
    '이 이미지는 회의에서 공유 중인 화면이다.',
    `발표자가 방금 이렇게 말했다: "${(utterance || '').trim()}"`,
    recentTranscript ? `앞 발화(지금 발화에서 빠진 대상·조건을 채울 때만 쓴다): ${recentTranscript}` : null,
    mergedAnchorList.length
      ? `발표자가 지시한 표현: ${mergedAnchorList.join(', ')}. 이 대상이 무엇인지도 함께 밝혀라.`
      : null,
    mergedClaimList.length
      ? `발표자는 변화를 또 말했다: ${mergedClaimList.map((phrase) => `"${phrase}"`).join(', ')}.`
        + ' 그 대상이 첫 변화의 대상과 다르면(예: 매출과 방문자 수) "target2"·"value2"에 그 대상과 화면의 값을 쓴다.'
        + ' 같은 대상·같은 값을 다시 말한 것이면 "target2"·"value2"는 빈 문자열로 둔다.'
      : null,
    screenTextBlock.text || null,
    '',
    '청자는 화면을 볼 수 없다. 발표자는 변화·비교·결론만 말하고 근거 값은 말하지 않았다. 정보 공백 판단은 끝났으니 다시 따지지 않는다.',
    '할 일: 발표자가 지금 말한 그 대상의 근거 값을 화면에서 읽어 준다.',
    '',
    '1단계 — 무엇에 대한 말인지 먼저 고정한다.',
    ' · 대상: 지금 발화가 말한 양.',
    ' · 조건: 지금 발화(빠졌으면 앞 발화)에 나온 집단·기간·방법 이름. 화면 항목이 여럿이면 그 조건의 항목만 고른다. 결론이 대조에서 나오면 대조 항목도 고른다.',
    ' · 부분: 그래프면 발표자가 말한 부분(치솟은 곳, 평평한 구간, 마지막 값).',
    '2단계 — 그 항목의 값을 읽는다.',
    ' · 적힌 숫자는 그대로(툴팁·데이터 라벨 포함). 적힌 숫자가 없으면 축 눈금으로 어림해 "약"을 붙인다. 그림을 센 개수는 "N번·N개"로 쓴다.',
    ' · 값에는 그 값의 시점(연도·월·주)이나 집단 이름을 붙인다. 날짜 라벨만 쓰고 값을 빠뜨리지 않는다.',
    ' · 앞 발화에 나온 숫자를 화면 값처럼 옮기지 않는다. 다른 양·단위의 라벨(합계·누적 등)은 쓰지 않는다.',
    '3단계 — 잇는다.',
    ' · 같은 항목이 시간에 따라 바뀐 것만 "전 값에서 뒤 값".',
    ' · 서로 다른 집단·구간은 "이름 값, 이름 값"으로 나란히.',
    ' · 같은 모양이 되풀이되면 대표 높이와 횟수.',
    ' · 항목이 셋 이상이면 조건 이름을 target에 순서대로 모두 쓰고(범위로 줄이지 않는다) value에는 값만 같은 순서로.',
    '예) "3년 차부터 확 줄었습니다" + 표 "1년 차 40%, 2년 차 35%, 3년 차 22%" → {"target": "연차별 이직률", "value": "2년 차 35%, 3년 차 22%"}',
    '예) "점점 짧아졌죠" + 막대 1월 12분, 2월 9분, 3월 7분, 4월 5분 → {"target": "1·2·3·4월 대기 시간", "value": "12, 9, 7, 5분"}',
    '',
    buildSlotOutputInstruction({
      narrationType: NARRATION_TYPE_MAP.interpretation,
      subKind: INTERPRETATION_KIND_MAP.claimToValue,
      hasSecondClaim: mergedClaimList.length > 0,
      language,
    }),
    '',
    '규칙:',
    '(1) 화면에 보이는 값만 쓴다. 지어내지 않는다.',
    `(2) 그 대상·조건의 값이나 눈금을 화면에서 찾지 못할 때만 ${GROUNDING_NONE_TOKEN}이다. 그래프·표가 보이면 어림해서라도 쓴다.`,
    '(3) 발화를 옮기지 않는다. 지시어("이·그·저·여기")를 넣지 않는다.',
    `(참고: 조립 후 총 ${minWordCount}~${maxWordCount}어절, 최대 ${maxChars}자.)`,
    ...buildOutputLanguageRuleList({
      language,
      detailLineList: ['수치는 화면 그대로 아라비아 숫자로 쓴다(예: 9.2 hours). 시스템이 "대상, 값" 꼴로 조립한다.'],
    }),
  ].filter((line) => line !== null).join('\n');
}

function buildInterpretationPrompt({ utterance, recentTranscript = '', subKind = null,
  minWordCount = DEFAULT_INTERPRETATION_MIN_WORD_COUNT,
  maxWordCount = DEFAULT_INTERPRETATION_MAX_WORD_COUNT,
  maxChars = null, describedElementList = [], mergedAnchorList = [], mergedClaimList = [],
  screenLineList = [], language = DEFAULT_CAPTION_LANGUAGE }) {
  const effectiveMaxChars = Number.isFinite(maxChars) ? maxChars : computeMaxChars({ maxWordCount, language });
  const screenTextBlock = buildInterpretationScreenTextBlock({
    screenLineList, utterance, subKind, mergedAnchorList, mergedClaimList,
  });
  if (subKind === INTERPRETATION_KIND_MAP.claimToValue) {
    return buildClaimToValuePrompt({
      utterance, recentTranscript, minWordCount, maxWordCount, maxChars: effectiveMaxChars,
      mergedAnchorList, mergedClaimList, screenTextBlock, language,
    });
  }
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
    }),
    '',
    '규칙:',
    '(1) 화면에 실제로 보이는 값·문구만 쓴다. **추정하거나 지어내지 않는다.**',
    `(2) 화면에서 근거를 찾을 수 없으면 "${GROUNDING_NONE_TOKEN}"만 출력한다.`,
    '(3) 발화 문장을 그대로 옮기지 마라. **핵심만 짧은 명사구로 간추린다.**',
    '    "이 상태가 달라집니다" → "준비 상태에 따른 차이"',
    '    지시어("이·그·저·여기·이런")는 넣지 않는다 — 청자는 그것을 볼 수 없다.',
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
