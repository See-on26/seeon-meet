const { NARRATION_TYPE_MAP, VISUAL_DESCRIPTION_KIND_MAP } = require('../contracts/narration-types');
const { NARRATION_ORIGIN_MAP } = require('../contracts/narration-class');
const {
  GROUNDING_NONE_TOKEN, computeMaxChars, buildSlotOutputInstruction,
} = require('../agents/shared/caption-parser');
const { DEFAULT_CAPTION_LANGUAGE } = require('../contracts/caption-language');
const { buildOutputLanguageRuleList } = require('./output-language-rule');

const DEFAULT_VISUAL_WORD_RANGE_MAP = {
  [VISUAL_DESCRIPTION_KIND_MAP.reaction]: { minWordCount: 5, maxWordCount: 12 },
  [VISUAL_DESCRIPTION_KIND_MAP.scale]: { minWordCount: 3, maxWordCount: 12 },
};

const ENGLISH_IMAGE_PREFIX_RULE = '머리말 "Image:"(이미지 제시)는 시스템이 붙이므로 description 에 넣지 마라.';
const ENGLISH_MATERIAL_TAIL_RULE = 'description 은 자료 종류를 나타내는 영어 낱말(photo·chart·table·diagram·flowchart 등)로 끝맺는다.';

function buildVisualDescriptionPrompt({ subKind = VISUAL_DESCRIPTION_KIND_MAP.reaction,
  utterance = '', recentTranscript = '', minWordCount, maxWordCount, maxChars = null,
  describedElementList = [], mergedAnchorList = [], origin = null, language = DEFAULT_CAPTION_LANGUAGE }) {
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
  const describedRule = isSilence
    ? `· 이미 안내된 내용: ${describedElementList.join(' / ')}. 자료의 종류·주제만 안내됐다면 반복하지 말고`
      + ` 그 자료가 보여 주는 값·변화·차이를 묘사한다. 값·변화까지 이미 안내됐을 때만 "${GROUNDING_NONE_TOKEN}"만 출력한다.`
    : `· 이미 안내된 요소(${describedElementList.join(', ')})면 반복하지 말고 "${GROUNDING_NONE_TOKEN}"만 출력한다.`;
  const commonTailList = [
    '',
    buildSlotOutputInstruction({ narrationType: NARRATION_TYPE_MAP.visualDescription, subKind, origin, language }),
    '',
    '규칙:',
    describedElementList.length ? describedRule : '',
    `(참고: 조립 후 총 ${effectiveMinWordCount}~${effectiveMaxWordCount}어절, 최대 ${effectiveMaxChars}자 분량이다.)`,
  ].filter(Boolean);

  // 척도: 발화 기반 척도 6자리(10/18)에서 고른 예시 중심 판(척도_B). 동등·겹침·배수·측정값 꼴을 예시로 보이고
  // 크기 묘사를 caption 한 구로 받는다. 예시는 평가 영상과 겹치지 않는 내용으로 둔다.
  if (isScale) {
    return [
      '이 이미지는 회의에서 공유 중인 화면이다.',
      `발표자가 방금 이렇게 말했다: "${(utterance || '').trim()}"`,
      recentTranscript ? `앞 발화(빠진 대상을 채울 때만 쓴다): ${recentTranscript}` : null,
      mergedAnchorList.length
        ? `발표자가 지시한 표현: ${mergedAnchorList.join(', ')}. 이 대상이 무엇인지도 함께 밝혀라.`
        : null,
      '',
      '청자는 화면을 볼 수 없다. 발표자는 크기·양을 "크다·엄청 많다" 같은 말로만 했다. 정보 공백 판단은 끝났다.',
      '할 일: 그 대상의 크기를 화면 속 기준과 견주거나, 측정값이면 값으로 한 구에 담는다.',
      '· 대상은 지금 발화가 크다고 한 것이다. 앞 발화에 마지막으로 나온 다른 이름을 새 대상으로 바꾸지 않는다.',
      '· 그래프·표의 양이면 견줄 물체를 찾지 않고 값을 쓴다.',
      // v5(10/19, 다섯 판 S 오답 판정): 통계 패널·툴팁의 개수·값이 있는데 범주로 말하거나 어림했다. 4번 판의 "전체 N 중 n"을 더한다.
      '· 통계 패널·툴팁·막대 위에 적힌 정확한 값·개수가 있으면 어림하지 말고 라벨과 짝지어 그대로 쓴다.',
      '· 전체가 보이면 기준을 붙인다: "전체 N 중 n", "[대상] [값], [비교 대상] [값]". 격자·배치는 칸 수(가로 N칸·세로 M칸)로.',
      '· 사진·지도처럼 숫자가 없는 화면은 함께 보이는 물체·지역과 견준다. 숫자가 없다는 이유로 NONE 을 내지 않는다.',
      '',
      '예시 (발화 + 화면 → caption):',
      '동등) "이 사과 크죠" + 손에 든 사과가 손바닥을 다 가림',
      '→ "어른 손바닥만 한 사과"',
      '겹침) "공장 부지가 이렇게 커요" + 부지 윤곽을 공항 위에 겹침, 공항 절반쯤 덮음',
      '→ "공항 절반쯤을 덮는 공장 부지"',
      '겹침) 앞 발화 "공원을 저쪽으로 옮겨 볼게요" + "이 정도라니까요" + 옮긴 윤곽이 옆 동네를 다 덮음',
      '→ "옆 동네를 다 덮는 공원"',
      '배수) "고래 모형 장난 아니죠" + 옆에 세운 버스보다 두 배쯤 김',
      '→ "버스 길이의 두 배쯤 되는 고래 모형"',
      '측정값) "방문객이 엄청 많죠" + 월별 막대에서 3월이 눈금 3만 근처',
      '→ "약 3만 명으로 가장 많은 3월 방문객"',
      '측정값) "처음엔 시간이 상당히 걸렸어요" + 구간 막대 "준비 단계 48분"',
      '→ "준비 단계에만 걸린 48분"',
      '개수) "지원자가 꽤 몰렸죠" + 통계 칸 "지원 1,240명 · 합격 62명"',
      '→ "지원자 1,240명 중 합격 62명"',
      '없음) 대상도 견줄 기준도 읽을 값도 화면에 없음',
      `→ ${GROUNDING_NONE_TOKEN}: 대상과 기준이 화면에 없음`,
      '',
      buildSlotOutputInstruction({ narrationType: NARRATION_TYPE_MAP.visualDescription, subKind, origin, language }),
      '',
      '규칙:',
      '(1) 화면에 보이는 것만 쓴다. 크기·값을 지어내지 않는다.',
      '(2) 지시어("이·그·저·여기")를 넣지 않는다.',
      `(참고: 조립 후 총 ${effectiveMinWordCount}~${effectiveMaxWordCount}어절, 최대 ${effectiveMaxChars}자.)`,
      ...buildOutputLanguageRuleList({
        language,
        detailLineList: ['caption 은 대상과 견준 크기(또는 값)를 담은 자연스러운 영어 명사구로 쓴다. 시스템은 caption 만 읽는다.'],
      }),
    ].filter((line) => line !== null).join('\n');
  }

  // 무발화는 사진 전환이 아니라 "화면을 보라"고 한 뒤의 침묵이다. 보라고 한 대상을 자료 종류로 끝맺어 묘사한다.
  if (isSilence) {
    // 무발화 v3(10/18, 무발화 영상 7자리): 카드·수식·퀴즈 그림도 보라고 한 대상으로 읽고, 제목·지시문·이미 말한 규칙은 빼고,
    // 12어절 안에서 자료 종류로 맺는다. 운영 판은 글자 화면을 거절해 7자리 0/35였다(v3 20/35·18/35).
    return [
      '이 이미지는 회의에서 공유 중인 화면이다.',
      '발표자가 화면을 보라고 한 뒤 말없이 기다리고 있다. 청중은 지금 이 화면을 보고 있다.',
      recentTranscript ? `발표자의 침묵 직전 발화: ${recentTranscript}` : null,
      describedElementList.length ? describedRule : null,
      '',
      '청자는 화면을 볼 수 없다. 발표자의 말은 청자도 이미 들었다.',
      '할 일: 청중이 지금 보고 있는 대상을 짧은 한 구로 들려준다. 화면에만 있는 핵심 정보만 담는다.',
      '',
      '1. 보라고 한 대상: 직전 발화가 가리키는 것(문제·답·그림·사진·그래프·표 등)을 화면에서 찾는다.',
      '   · 사진·그래프·표만 대상이 아니다. 수식, 글자·숫자 카드, 퍼즐, 퀴즈 그림처럼 짧은 글자·숫자·기호 자체가 대상이면 그것을 읽어 준다.',
      '2. 담을 것(이것만):',
      '   · 카드·보기: 적힌 글자·숫자를 화면 순서대로.',
      '   · 수식: 기호(+, −, =, ≠)를 화면 그대로. 답 화면이면 바뀐 식 그대로.',
      '   · 퀴즈 그림: 그림마다 무엇인지, 그리고 힌트 칸의 글자(초성 자음 등)를 그대로. 칸 속 ㄱ·ㄴ·ㅇ·ㅁ 같은 모양은 도형이 아니라 한글 자음이다. 정답은 말하지 않는다.',
      '   · 그래프·표는 값·변화, 구조도는 주요 구성 요소와 연결, 사진은 무엇이 어떻게 있는지.',
      '3. 빼는 것: 화면 제목·지시문("…해 보세요"), 발표자가 이미 말한 규칙·설명, 배경색, 구석의 아이콘·타이머·로고.',
      '4. 길이와 끝맺기: 12어절 이내. 넘치면 뒤가 잘려 통째로 버려진다. 맨 끝은 자료 종류("그림", "사진", "수식", "카드", "그래프", "표")로 맺는다. 식·숫자로 끝내지 않는다.',
      '   꼴) "○○ 그림과 △△ 그림, 초성 ㄱㄴ 퀴즈 그림"',
      '   꼴) "□ 더하기 □는 ○인 수식"',
      '   꼴) "1분기 120억에서 4분기 182억으로 늘어난 매출 그래프"',
      '',
      buildSlotOutputInstruction({ narrationType: NARRATION_TYPE_MAP.visualDescription, subKind, origin, language }),
      '',
      '규칙:',
      '(1) 화면에 실제로 있는 것만 쓴다. 없는 사물·숫자·글자를 지어내지 않는다. 위 꼴의 ○○·□·숫자는 자리표시일 뿐이다.',
      `(2) 긴 문장·본문만 있는 화면이거나 보라고 한 대상을 화면에서 찾을 수 없을 때만 ${GROUNDING_NONE_TOKEN}이다.`,
      '(3) 지시어("이·그·저·여기")를 넣지 않는다.',
      `(참고: 조립 후 총 ${effectiveMinWordCount}~${effectiveMaxWordCount}어절, 최대 ${effectiveMaxChars}자 분량이다.)`,
      ...buildOutputLanguageRuleList({ language, detailLineList: [ENGLISH_IMAGE_PREFIX_RULE, ENGLISH_MATERIAL_TAIL_RULE] }),
    ].filter((line) => line !== null).join('\n');
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

module.exports = { buildVisualDescriptionPrompt, DEFAULT_VISUAL_WORD_RANGE_MAP };
