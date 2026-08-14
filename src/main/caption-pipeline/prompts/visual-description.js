const { NARRATION_TYPE_MAP, VISUAL_DESCRIPTION_KIND_MAP } = require('../contracts/narration-types');
const {
  GROUNDING_NONE_TOKEN, computeMaxChars, buildSlotOutputInstruction,
} = require('../agents/shared/caption-parser');

const DEFAULT_VISUAL_WORD_RANGE_MAP = {
  [VISUAL_DESCRIPTION_KIND_MAP.reaction]: { minWordCount: 5, maxWordCount: 12 },
  [VISUAL_DESCRIPTION_KIND_MAP.scale]: { minWordCount: 4, maxWordCount: 8 },
};

function buildVisualDescriptionPrompt({ subKind = VISUAL_DESCRIPTION_KIND_MAP.reaction,
  utterance = '', recentTranscript = '', minWordCount, maxWordCount, maxChars = null,
  describedElementList = [], mergedAnchorList = [] }) {
  const defaultRange = DEFAULT_VISUAL_WORD_RANGE_MAP[subKind]
    || DEFAULT_VISUAL_WORD_RANGE_MAP[VISUAL_DESCRIPTION_KIND_MAP.reaction];
  const effectiveMinWordCount = Number.isFinite(minWordCount) ? minWordCount : defaultRange.minWordCount;
  const effectiveMaxWordCount = Number.isFinite(maxWordCount) ? maxWordCount : defaultRange.maxWordCount;
  const effectiveMaxChars = Number.isFinite(maxChars)
    ? maxChars : computeMaxChars({ maxWordCount: effectiveMaxWordCount });
  const isScale = subKind === VISUAL_DESCRIPTION_KIND_MAP.scale;

  const commonTailList = [
    '',
    buildSlotOutputInstruction({ narrationType: NARRATION_TYPE_MAP.visualDescription, subKind }),
    '',
    '규칙:',
    describedElementList.length
      ? `· 이미 안내된 요소(${describedElementList.join(', ')})면 반복하지 말고 "${GROUNDING_NONE_TOKEN}"만 출력한다.`
      : '',
    `(참고: 조립 후 총 ${effectiveMinWordCount}~${effectiveMaxWordCount}어절, 최대 ${effectiveMaxChars}자 분량이다.)`,
  ].filter(Boolean);

  if (isScale) {
    return [
      '이 이미지는 회의에서 공유 중인 화면이다.',
      `발표자가 방금 이렇게 말했다: "${(utterance || '').trim()}"`,
      recentTranscript ? `참고로 최근 발화 맥락은 다음과 같다: ${recentTranscript}` : '',
      mergedAnchorList.length
        ? `발표자가 지시한 표현: ${mergedAnchorList.join(', ')}. 이 대상이 무엇인지도 함께 밝혀라.`
        : '',
      '',
      '청자는 화면을 볼 수 없다. 발표자는 크기·길이 등의 정도를 "크다·짧다" 같은 추상적 표현으로만 말했다.',
      '화면에서 **비교 대상**을 찾아 그 정도를 가늠할 수 있게 묘사하라.',
      '  · 비교 대상은 **같은 이미지 안의 다른 객체를 우선** 택한다. 없으면 누구나 크기를 아는 일반 객체와 비교한다.',
      '  · 좋은 비교 대상 = 듣기만 해도 크기·길이가 가늠되는 것.',
      '  예) "이 불상 보시면 정말 크죠?" + 사진에 소나무가 함께 있음 → "소나무보다 4배 정도 큰 불상"',
      '',
      '형식(참고): (적절한 비교 대상으로 묘사하는 표현) + (그 대상).',
      ...commonTailList,
      '· 화면에 실제로 보이는 것만 쓴다. 크기를 지어내지 않는다.',
      `· **비교 대상을 찾을 수 없으면 "${GROUNDING_NONE_TOKEN}"만 출력한다.** 배수를 모르면 scale을 빈 문자열로 둔다.`,
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
  ].filter(Boolean).join('\n');
}

module.exports = { buildVisualDescriptionPrompt, DEFAULT_VISUAL_WORD_RANGE_MAP };
