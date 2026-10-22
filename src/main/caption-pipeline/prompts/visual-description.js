const { NARRATION_TYPE_MAP, VISUAL_DESCRIPTION_KIND_MAP } = require('../contracts/narration-types');
const { NARRATION_ORIGIN_MAP } = require('../contracts/narration-class');
const {
  GROUNDING_NONE_TOKEN, computeMaxChars, buildSlotOutputInstruction,
} = require('../agents/shared/caption-parser');
const { DEFAULT_CAPTION_LANGUAGE } = require('../contracts/caption-language');
const { buildOutputLanguageRuleList } = require('./output-language-rule');
const { buildScreenTextBlock, isStatLine, SCREEN_TEXT_USAGE_MAP } = require('./screen-text-block');
const { resolveContentSwitch } = require('../agents/shared/content-switch');
const { extractApproximateValueList, isNearApproximateValue, buildApproximateValueLine } = require('./approximate-value');
const { buildFactCardBlock, FACT_CARD_USAGE_MAP } = require('./fact-card-block');

const DEFAULT_VISUAL_WORD_RANGE_MAP = {
  [VISUAL_DESCRIPTION_KIND_MAP.reaction]: { minWordCount: 5, maxWordCount: 12 },
  [VISUAL_DESCRIPTION_KIND_MAP.scale]: { minWordCount: 4, maxWordCount: 8 },
};

const ENGLISH_IMAGE_PREFIX_RULE = '머리말 "Image:"(이미지 제시)는 시스템이 붙이므로 description 에 넣지 마라.';
const ENGLISH_MATERIAL_TAIL_RULE = 'description 은 자료 종류를 나타내는 영어 낱말(photo·chart·table·diagram·flowchart 등)로 끝맺는다.';

// 척도 해설에 넣을 같은 화면 OCR 덩어리. 줄 고르기는 발화와 지시 구의 낱말을 본다. 줄이 없으면 빈 덩어리다.
// 척도 값 먼저(켜짐)면 통계 낱말(합계·평균·최대 등)이 든 줄을, 화면 값 먼저(켜짐)면 발화의 어림 값에 가까운 수가 든 줄을 먼저 넣는다.
function buildScaleScreenTextBlock({ screenLineList = [], utterance = '', mergedAnchorList = [], contentSwitch = null }) {
  const { isScaleValueFirstEnabled, isScreenValueFirstEnabled } = resolveContentSwitch(contentSwitch);
  const approximateValueList = isScreenValueFirstEnabled ? extractApproximateValueList(utterance) : [];
  const isPriorityLine = (text) => (isScaleValueFirstEnabled && isStatLine(text))
    || isNearApproximateValue({ text, approximateValueList });
  return buildScreenTextBlock({
    lineList: screenLineList,
    keywordSourceList: [utterance || '', ...mergedAnchorList],
    usage: isScaleValueFirstEnabled ? SCREEN_TEXT_USAGE_MAP.scaleValue : SCREEN_TEXT_USAGE_MAP.scale,
    isPriorityLine: isScaleValueFirstEnabled || approximateValueList.length ? isPriorityLine : null,
  });
}

// 척도 값 먼저(SEEON_SCALE_VALUE_FIRST_ENABLED). 견줄 사물만 찾게 하면 그래프·지도·표에서 "비교 대상 없음"으로 거절했다.
// 대상에 글자로 적힌 값 → 화면 속 다른 대상 → 일반 사물 순으로 근거를 찾고, 대상이 보이면 거절하지 않는다.
// 화면에 없는 값을 지어내지 않게, 막대·선 높이를 눈금으로 어림해 새 수치를 만드는 것은 막는다.
const SCALE_VALUE_FIRST_INTRO_LIST = [
  '청자는 화면을 볼 수 없다. 발표자는 화면에 보이는 대상의 정도(크기·넓이·높이·길이·개수·양)를 "크다·많다·짧다" 같은 말로만 말했다.',
  '그 정도를 청자가 가늠할 수 있게, 대상과 함께 아래 순서로 근거를 찾아 말하라.',
  '  ① 그 대상에 글자로 적힌 값 — 통계 패널·요약 카드·툴팁·말풍선·범례·데이터 라벨·표 칸·축 눈금의 수치(합계·평균·최댓값·개수·넓이·길이 등).'
    + ' reading 칸에 먼저 옮겨 적는다.',
  '  ② 같은 화면의 다른 대상(다른 막대·지역·사물)과 견준 크기.',
  '  ③ 사진 속 사물이면 누구나 크기를 아는 일반 사물과 견준 크기.',
  '  예) "이 막대 정말 길죠" + 막대 끝 라벨 "1,240건", 옆 막대 라벨 "310건" → "옆 막대 310건보다 긴 1,240건 막대"',
  '  예) "이 호수 꽤 크죠" + 툴팁 "둘레 12.4km" → "둘레 12.4km인 호수"',
  '  예) "이 불상 보시면 정말 크죠?" + 사진에 소나무가 함께 있음 → "소나무보다 4배 정도 큰 불상"',
  '',
  '형식(참고): caption 한 구에 (그 대상) + (적힌 값 또는 견준 크기)를 담는다.',
  '  "○○인 △△", "○○보다 N배 큰 △△", "○○만 한 △△", "○○의 절반쯤 되는 △△"처럼 자연스럽게 말한다.',
];
const SCALE_VALUE_FIRST_RULE_LIST = [
  '· 화면에 글자로 적힌 값과 보이는 것만 쓴다. 값을 지어내거나, 막대·선 높이를 눈금으로 어림해 새 수치를 만들지 않는다.'
    + ' 배수를 모르면 "○○보다 큰 △△"처럼 배수 없이 쓴다.',
  `· 발표자가 말한 대상이 화면에 보이면 "${GROUNDING_NONE_TOKEN}"을 내지 않는다 — 적힌 값이 없으면 ②·③으로 견준다.`,
  `· "${GROUNDING_NONE_TOKEN}"은 발표자가 말한 대상을 화면에서 찾을 수 없을 때, 또는 대상은 보이지만 적힌 값도 견줄 다른 대상도`
    + ' 전혀 없을 때뿐이다.',
];

function buildVisualDescriptionPrompt({ subKind = VISUAL_DESCRIPTION_KIND_MAP.reaction,
  utterance = '', recentTranscript = '', minWordCount, maxWordCount, maxChars = null,
  describedElementList = [], mergedAnchorList = [], origin = null, screenLineList = [], factCardList = [],
  language = DEFAULT_CAPTION_LANGUAGE, contentSwitch = null }) {
  const resolvedSwitch = resolveContentSwitch(contentSwitch);
  const defaultRange = DEFAULT_VISUAL_WORD_RANGE_MAP[subKind]
    || DEFAULT_VISUAL_WORD_RANGE_MAP[VISUAL_DESCRIPTION_KIND_MAP.reaction];
  const effectiveMinWordCount = Number.isFinite(minWordCount) ? minWordCount : defaultRange.minWordCount;
  const effectiveMaxWordCount = Number.isFinite(maxWordCount) ? maxWordCount : defaultRange.maxWordCount;
  const effectiveMaxChars = Number.isFinite(maxChars)
    ? maxChars : computeMaxChars({ maxWordCount: effectiveMaxWordCount, language });
  const isScale = subKind === VISUAL_DESCRIPTION_KIND_MAP.scale;

  const isSilence = origin === NARRATION_ORIGIN_MAP.silence;
  // 무발화는 같은 장의 전환 해설이 자료 종류·주제("…비교 그래프")를 이미 말한 뒤에 오는 일이 많다.
  // 대상이 같다는 이유로 NONE 을 내면 보라고 한 자료가 무엇을 보여 주는지 끝내 전하지 못하므로, 무발화는 값·변화를 보충한다.
  // 척도 값 먼저(켜짐)도 같다 — 전환 해설이 자료 이름만 말했다고 거절하면 발표자가 "크다"고 한 정도를 전하지 못한다.
  const isScaleValueFirst = isScale && resolvedSwitch.isScaleValueFirstEnabled;
  const describedRule = (isSilence && `· 이미 안내된 내용: ${describedElementList.join(' / ')}. 자료의 종류·주제만 안내됐다면 반복하지 말고`
      + ` 그 자료가 보여 주는 값·변화·차이를 묘사한다. 값·변화까지 이미 안내됐을 때만 "${GROUNDING_NONE_TOKEN}"만 출력한다.`)
    || (isScaleValueFirst && `· 이미 안내된 내용: ${describedElementList.join(' / ')}. 대상의 이름·자료 종류만 안내됐다면 반복하지 말고`
      + ` 그 정도(적힌 값·견준 크기)를 말한다. 정도까지 이미 안내됐을 때만 "${GROUNDING_NONE_TOKEN}"만 출력한다.`)
    || `· 이미 안내된 요소(${describedElementList.join(', ')})면 반복하지 말고 "${GROUNDING_NONE_TOKEN}"만 출력한다.`;
  const commonTailList = [
    '',
    buildSlotOutputInstruction({
      narrationType: NARRATION_TYPE_MAP.visualDescription, subKind, origin, language, contentSwitch: resolvedSwitch,
    }),
    '',
    '규칙:',
    describedElementList.length ? describedRule : '',
    `(참고: 조립 후 총 ${effectiveMinWordCount}~${effectiveMaxWordCount}어절, 최대 ${effectiveMaxChars}자 분량이다.)`,
  ].filter(Boolean);

  if (isScaleValueFirst) {
    const screenTextBlock = buildScaleScreenTextBlock({ screenLineList, utterance, mergedAnchorList, contentSwitch: resolvedSwitch });
    // 척도 해설에 넣을 화면 사실 카드(발화와 가까운 카드 1장). 카드가 없으면 빈 덩어리다.
    const factCardBlock = buildFactCardBlock({ cardList: factCardList, usage: FACT_CARD_USAGE_MAP.scale });
    return [
      '이 이미지는 회의에서 공유 중인 화면이다.',
      `발표자가 방금 이렇게 말했다: "${(utterance || '').trim()}"`,
      recentTranscript ? `참고로 최근 발화 맥락은 다음과 같다: ${recentTranscript}` : '',
      mergedAnchorList.length
        ? `발표자가 지시한 표현: ${mergedAnchorList.join(', ')}. 이 대상이 무엇인지도 함께 밝혀라.`
        : '',
      resolvedSwitch.isScreenValueFirstEnabled ? buildApproximateValueLine(extractApproximateValueList(utterance)) : '',
      // 사실 카드 덩어리는 화면 글자 덩어리 바로 앞에 빈 줄 하나를 두고 넣는다. 카드가 없으면 프롬프트는 글자 하나까지 그대로다.
      factCardBlock.text ? `${factCardBlock.text}\n` : '',
      // 화면 글자 덩어리는 예전 척도 프롬프트처럼 청자 줄 바로 앞에 빈 줄 하나를 두고 넣는다.
      screenTextBlock.text ? `${screenTextBlock.text}\n` : '',
      '',
      ...SCALE_VALUE_FIRST_INTRO_LIST,
      ...commonTailList,
      ...SCALE_VALUE_FIRST_RULE_LIST,
      ...buildOutputLanguageRuleList({
        language,
        detailLineList: ['caption 은 대상과 그 적힌 값 또는 견준 크기를 담은 자연스러운 영어 명사구로 쓴다'
          + '(예: "a lake 12.4 km around", "a Buddha statue about four times taller than the pine tree"). 시스템은 caption 만 읽는다.'],
      }),
    ].filter(Boolean).join('\n');
  }

  if (isScale) {
    const screenTextBlock = buildScaleScreenTextBlock({ screenLineList, utterance, mergedAnchorList, contentSwitch: resolvedSwitch });
    // 척도 해설에 넣을 화면 사실 카드(발화와 가까운 카드 1장). 카드가 없으면 빈 덩어리다.
    const factCardBlock = buildFactCardBlock({ cardList: factCardList, usage: FACT_CARD_USAGE_MAP.scale });
    return [
      '이 이미지는 회의에서 공유 중인 화면이다.',
      `발표자가 방금 이렇게 말했다: "${(utterance || '').trim()}"`,
      recentTranscript ? `참고로 최근 발화 맥락은 다음과 같다: ${recentTranscript}` : '',
      mergedAnchorList.length
        ? `발표자가 지시한 표현: ${mergedAnchorList.join(', ')}. 이 대상이 무엇인지도 함께 밝혀라.`
        : '',
      resolvedSwitch.isScreenValueFirstEnabled ? buildApproximateValueLine(extractApproximateValueList(utterance)) : '',
      // 사실 카드 덩어리는 화면 글자 덩어리 바로 앞에 빈 줄 하나를 두고 넣는다. 카드가 없으면 프롬프트는 글자 하나까지 그대로다.
      factCardBlock.text ? `${factCardBlock.text}\n` : '',
      // 화면 글자 덩어리는 청자 줄 바로 앞에 빈 줄 하나를 두고 넣는다. 덩어리가 없으면 프롬프트는 글자 하나까지 그대로다.
      screenTextBlock.text ? `${screenTextBlock.text}\n` : '',
      '',
      '청자는 화면을 볼 수 없다. 발표자는 크기·길이 등의 정도를 "크다·짧다" 같은 추상적 표현으로만 말했다.',
      '화면에서 **비교 대상**을 찾아 그 정도를 가늠할 수 있게 묘사하라.',
      '  · 비교 대상은 **같은 이미지 안의 다른 객체를 우선** 택한다. 없으면 누구나 크기를 아는 일반 객체와 비교한다.',
      '  · 좋은 비교 대상 = 듣기만 해도 크기·길이가 가늠되는 것.',
      '  예) "이 불상 보시면 정말 크죠?" + 사진에 소나무가 함께 있음 → "소나무보다 4배 정도 큰 불상"',
      '',
      '형식(참고): caption 한 구에 (비교 대상과 견준 크기) + (그 대상)을 담는다.',
      '  "○○보다 N배 큰 △△", "○○만 한 △△", "○○의 절반쯤 되는 △△"처럼 자연스럽게 견준다.',
      ...commonTailList,
      '· 화면에 실제로 보이는 것만 쓴다. 크기를 지어내지 않는다.',
      `· **비교 대상을 찾을 수 없으면 "${GROUNDING_NONE_TOKEN}"만 출력한다.** 배수를 모르면 "○○보다 큰 △△"처럼 배수 없이 쓴다.`,
      ...buildOutputLanguageRuleList({
        language,
        detailLineList: ['caption 은 대상과 비교 대상을 견준 크기를 담은 자연스러운 영어 명사구로 쓴다'
          + '(예: "a Buddha statue about four times taller than the pine tree"). 시스템은 caption 만 읽는다.'],
      }),
    ].filter(Boolean).join('\n');
  }

  // 무발화는 사진 전환이 아니라 "화면을 보라"고 한 뒤의 침묵이다. 보라고 한 대상을 자료 종류로 끝맺어 묘사한다.
  if (isSilence) {
    return [
      '이 이미지는 회의에서 공유 중인 화면이다.',
      '발표자가 화면을 보라고 한 뒤 말없이 기다리고 있다. 청중은 지금 이 화면을 보고 있다.',
      recentTranscript ? `발표자의 침묵 직전 발화: ${recentTranscript}` : '',
      '',
      '청자는 화면을 볼 수 없어 발표자가 보여 주는 것을 함께 볼 수 없다.',
      '발표자가 보라고 한 대상(사진·영상·그래프·표·구조도 등)이 무엇이고 무엇을 보여 주는지 묘사하라.',
      '  예) "이 사진 한번 보시죠" + 침묵 → "이미지 제시, 뼈가 앙상하게 야윈 어린아이 사진"',
      '  예) "이 그래프 잠깐 보시죠" + 침묵 → "이미지 제시, 3년간 두 배로 늘어난 매출 막대그래프"',
      '  예) 전환 해설이 "분기별 매출 막대그래프"만 말함 + "그래프 보시죠" + 침묵 → "이미지 제시, 1분기 120억에서 4분기 182억으로 늘어난 매출 막대그래프"',
      '  예) "흐름도를 잠시 보시죠" + 침묵 → "이미지 제시, 물류 센터를 가운데 두고 공장과 매장, 고객이 화살표로 이어진 흐름도"',
      '',
      '형식(참고): "이미지 제시" + (묘사).',
      ...commonTailList,
      '· 화면에 실제로 있는 것만 쓴다. **없는 사물이나 수치를 지어내지 않는다.**',
      '· 화면의 제목·본문 문장을 그대로 옮기지 않는다. 그림 속 구성 요소의 이름표는 써도 된다.',
      '· 그림이 있으면(사진·그래프·표·구조도·과정 그림·아이콘 그림 모음 등) 반드시 묘사한다. 자료 종류마다 이것을 말한다:',
      '  - 구조도·흐름도·다이어그램: 제목만 말하지 않는다("○○ 시스템 구조도"만으로는 청자가 무엇을 보는지 모른다).'
        + ' 주요 구성 요소 3~4개가 무엇을 가운데 두고 어떻게 연결·흐르는지를 묘사한다.',
      '  - 사진: 사진마다 찍힌 사물·장면을 2~4개. 예) description="시장 좌판, 골목 식당, 빵집 진열대를 찍은 사진 세 장"',
      '  - 그래프·표: 가장 큰 값과 가장 작은 값(또는 처음과 끝 값)을 항목 이름과 함께.'
        + ' 예) 전환 해설이 "요일별 방문자 수 막대그래프"만 말함 → description="토요일 340명으로 가장 많고 화요일 90명으로 가장 적은 막대그래프"',
      '  - 단계·과정 그림: 과정 이름·부제·용어("○○ 과정", "나누고 합치기")를 되풀이하지 말고, 처음 모습이 어떻게 바뀌어 끝 모습이 되는지를'
        + ' 그림 속 개수·값으로 같은 낱말을 두 번 쓰지 않고 짧게. 예) description="반죽 한 덩이를 여덟 조각으로 나눠 한 판에 구운 그림"',
      '  - 여러 장면을 모은 그림: 장면 수와 장면 이름 두셋. 예) description="숙박 예약, 맛집 지도, 축제 일정 등 세 가지 기능 그림"',
      '· 이미 안내된 문구나 화면 제목을 말만 바꿔 되풀이하면 실패다 — 청자는 새로 알게 되는 것이 없다.',
      '· 묘사는 12어절을 넘기지 않는다(넘치면 잘려 버려진다). 값·연결을 담느라 길어지면 화면 제목 낱말과 "과정·모습" 같은 군말부터 빼고,'
        + ' 자료 종류 한 낱말(막대그래프·구조도·사진·그림 등)로 끝맺는다.',
      '· 묘사는 "…사진", "…그래프", "…표", "…구조도"처럼 자료 종류로 끝맺는다.',
      `· 보라고 한 대상을 화면에서 찾을 수 없거나 글만 있는 화면(그림이 하나도 없음)이면 "${GROUNDING_NONE_TOKEN}"만 출력한다. 그림이 있으면 거절하지 않는다.`,
      ...buildOutputLanguageRuleList({ language, detailLineList: [ENGLISH_IMAGE_PREFIX_RULE, ENGLISH_MATERIAL_TAIL_RULE] }),
    ].filter(Boolean).join('\n');
  }

  return [
    '이 이미지는 회의에서 방금 단독으로 제시된 사진이다.',
    '발표자는 이 사진의 의미를 말로 설명하지 않았다. 사진 자체로 웃음·감탄·충격 같은 반응을 노린 것이다.',
    recentTranscript ? `참고로 최근 발화 맥락은 다음과 같다: ${recentTranscript}` : '',
    '',
    '청자는 화면을 볼 수 없어 다른 사람들과 같이 반응할 수 없다.',
    '**반응을 일으키는 요소를 포함해서** 이 사진을 묘사하라.',
    '  예) 사진 전환 + 발화 없음 + 청중 충격 → "이미지 제시, 뼈가 앙상할 정도로 야윈 어린아이가 지쳐 쓰러져있다"',
    '',
    '형식(참고): "이미지 제시" + (이미지 묘사).',
    ...commonTailList,
    '· 화면에 실제로 있는 사물·장면만 쓴다. **없는 사물이나 사건을 지어내지 않는다.**',
    '· 다만 객관적 묘사만으로는 반응을 이해하기 어려울 때,',
    '    "잔인한"·"귀여운"·"앙상한"처럼 **보이는 것에 대한 감각적 수식은 허용한다.**',
    '    (수식은 허용, 사실 조작은 금지 — 이 구분을 지켜라.)',
    `· 반응을 일으킬 만한 요소가 없는 평범한 화면이면 "${GROUNDING_NONE_TOKEN}"만 출력한다.`,
    ...buildOutputLanguageRuleList({ language, detailLineList: [ENGLISH_IMAGE_PREFIX_RULE] }),
  ].filter(Boolean).join('\n');
}

module.exports = { buildVisualDescriptionPrompt, buildScaleScreenTextBlock, DEFAULT_VISUAL_WORD_RANGE_MAP };
