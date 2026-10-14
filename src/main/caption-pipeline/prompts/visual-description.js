const { NARRATION_TYPE_MAP, VISUAL_DESCRIPTION_KIND_MAP } = require('../contracts/narration-types');
const { NARRATION_ORIGIN_MAP } = require('../contracts/narration-class');
const {
  GROUNDING_NONE_TOKEN, computeMaxChars, buildSlotOutputInstruction,
} = require('../agents/shared/caption-parser');

const DEFAULT_VISUAL_WORD_RANGE_MAP = {
  [VISUAL_DESCRIPTION_KIND_MAP.reaction]: { minWordCount: 5, maxWordCount: 12 },
  [VISUAL_DESCRIPTION_KIND_MAP.scale]: { minWordCount: 4, maxWordCount: 8 },
};

function buildVisualDescriptionPrompt({ subKind = VISUAL_DESCRIPTION_KIND_MAP.reaction,
  utterance = '', recentTranscript = '', minWordCount, maxWordCount, maxChars = null,
  describedElementList = [], mergedAnchorList = [], origin = null }) {
  const defaultRange = DEFAULT_VISUAL_WORD_RANGE_MAP[subKind]
    || DEFAULT_VISUAL_WORD_RANGE_MAP[VISUAL_DESCRIPTION_KIND_MAP.reaction];
  const effectiveMinWordCount = Number.isFinite(minWordCount) ? minWordCount : defaultRange.minWordCount;
  const effectiveMaxWordCount = Number.isFinite(maxWordCount) ? maxWordCount : defaultRange.maxWordCount;
  const effectiveMaxChars = Number.isFinite(maxChars)
    ? maxChars : computeMaxChars({ maxWordCount: effectiveMaxWordCount });
  const isScale = subKind === VISUAL_DESCRIPTION_KIND_MAP.scale;

  const isSilence = origin === NARRATION_ORIGIN_MAP.silence;
  // 무발화는 같은 장의 전환 해설이 자료 종류·주제("…비교 그래프")를 이미 말한 뒤에 오는 일이 많다.
  // 대상이 같다는 이유로 NONE 을 내면 보라고 한 자료가 무엇을 보여 주는지 끝내 전하지 못하므로, 무발화는 값·변화를 보충한다.
  const describedRule = isSilence
    ? `· 이미 안내된 내용: ${describedElementList.join(' / ')}. 자료의 종류·주제만 안내됐다면 반복하지 말고`
      + ` 그 자료가 보여 주는 값·변화·차이를 묘사한다. 값·변화까지 이미 안내됐을 때만 "${GROUNDING_NONE_TOKEN}"만 출력한다.`
    : `· 이미 안내된 요소(${describedElementList.join(', ')})면 반복하지 말고 "${GROUNDING_NONE_TOKEN}"만 출력한다.`;
  const commonTailList = [
    '',
    buildSlotOutputInstruction({ narrationType: NARRATION_TYPE_MAP.visualDescription, subKind, origin }),
    '',
    '규칙:',
    describedElementList.length ? describedRule : '',
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
      '· 구조도·흐름도·다이어그램이면 제목만 말하지 않는다("○○ 시스템 구조도"만으로는 청자가 무엇을 보는지 모른다).'
        + ' 주요 구성 요소 3~4개가 무엇을 가운데 두고 어떻게 연결·흐르는지를 묘사한다.',
      '· 묘사는 "…사진", "…그래프", "…표", "…구조도"처럼 자료 종류로 끝맺는다.',
      `· 보라고 한 대상을 화면에서 찾을 수 없거나 글만 있는 화면이면 "${GROUNDING_NONE_TOKEN}"만 출력한다.`,
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
