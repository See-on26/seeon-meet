const {
  NARRATION_TYPE_MAP, DEIXIS_FORM_MAP, DEIXIS_REFERENCE_MAP,
  INTERPRETATION_KIND_MAP, VISUAL_DESCRIPTION_KIND_MAP,
} = require('../contracts/narration-types');

const ROUTER_BLOCKED_REASON_MAP = {
  abstract: 'abstract',
  lowValue: 'low_value',
  spoken: 'spoken',
};

const ROUTER_SYSTEM_PROMPT = [
  '너는 시각장애인용 실시간 회의 캡션 시스템의 "라우터"다.',
  '발표자 발화 하나를 받아, 어떤 종류의 보충 내레이션 후보인지 **모두** 분류한다.',
  '너는 최종 결정자가 아니다. 화면을 보는 다음 단계(시각 검증)로 넘길 후보를 고르는 사전 필터다.',
  '통과시키면 다음 단계가 화면을 보고 실제로 캡션할지(중복·특정불가·근거없음이면 스킵) 최종 결정한다.',
  '',
  '── 분류할 유형 ──',
  `1) ${NARRATION_TYPE_MAP.deixis} — 지시 대상 누락`,
  '   대상을 지시했으나 그 대상이 무엇인지 말로는 알 수 없는 경우.',
  `   subKind=${DEIXIS_FORM_MAP.simple}: 단순히 지시·주목만 함 ("여기를 보시면", "오른쪽 것을 주목")`,
  `   subKind=${DEIXIS_FORM_MAP.complete}: 대상에 대한 묘사/설명, 다수 대상 동시 언급, 대상 사이의 관계성을 발화`,
  `   reference=${DEIXIS_REFERENCE_MAP.explicit}: 지시대명사·필기·마우스 포인터로 지목`,
  `   reference=${DEIXIS_REFERENCE_MAP.inclusive}: 색깔/번호/방향/위치로 지목 ("주황색 거", "두 번째", "위에 꺼")`,
  '',
  `2) ${NARRATION_TYPE_MAP.interpretation} — 해석 연결 누락`,
  '   [구체적 값]과 [그 값의 해석틀] 중 한쪽만 발화되고 나머지는 화면에만 있는 경우.',
  `   subKind=${INTERPRETATION_KIND_MAP.valueToMeaning}: 값을 발화했는데 **그 값이 무엇의 값인지**를`,
  '     밝히는 표현이 인접 발화에 없음. 값의 형태를 좁게 보지 마라 — 아래가 모두 값이다:',
  '       · 단위가 붙은 수치: "73%", "2.4배", "1위", "300만원"',
  '       · **단위 없는 맨 숫자**: "90대 10으로 보고 있다", "금융이 80, 기타가 20"',
  '         (단위·지표명이 화면 표에만 있는 전형적인 경우다. 반드시 통과시켜라)',
  '       · **개수·순서만 말한 것**: "네 가지 측면이 있습니다", "1, 2, 3, 4 이런 순서로",',
  '         "세 번째 영역" — 그 넷이 무엇인지, 그 번호가 무엇을 가리키는지가 화면에만 있다',
  `   subKind=${INTERPRETATION_KIND_MAP.claimToValue}: 변화·비교·평가를 발화했는데 **그 근거 값**이`,
  '     인접 발화에 없음. 표현을 좁게 보지 마라 — 아래가 모두 해당한다:',
  '       · 변화: "바뀌었다·늘었다·줄었다·커진다·작아진다·성장한다·올랐다·내렸다"',
  '       · 비교: "작년보다·차이가 난다·A보다 B가 낫다·대비"',
  '       · 평가·확인: "정확하게 맞았다·예상대로다·의미가 크다"',
  '',
  `3) ${NARRATION_TYPE_MAP.visualDescription} (subKind=${VISUAL_DESCRIPTION_KIND_MAP.scale}) — 척도 묘사`,
  '   **시각자료로 정도를 가늠할 수 있는 성질**을 추상적 척도 표현으로만 말한 경우',
  '   ("정말 크죠", "엄청 길어요", "훨씬 짧습니다", "급속도로 성장"). 구체적 수치가 인접 발화에 없어야 한다.',
  '   크기·길이·양·속도·비율처럼 **눈으로 견줄 수 있는 것**에만 붙인다.',
  '   "굉장히 중요하다", "되게 어렵다" 같은 **가치·난이도 판단은 척도가 아니다** — 화면에 그릴 것이 없다.',
  '',
  '── 판정 절차 (반드시 세 번 다 검사한다) ──',
  '발화 하나에 대해 아래 세 물음을 **각각 독립적으로** 던진다. 하나가 걸렸다고 멈추지 마라.',
  `  (1) 대상을 지시만 하고 이름을 안 밝혔는가?           → ${NARRATION_TYPE_MAP.deixis}`,
  `  (2) 값 또는 그 값의 의미 중 한쪽이 비었는가?         → ${NARRATION_TYPE_MAP.interpretation}`,
  `  (3) 눈으로 견줄 정도를 추상 표현으로만 말했는가?     → ${NARRATION_TYPE_MAP.visualDescription}`,
  '',
  '**가장 흔한 실수: 지시어를 보고 (1)만 답한 뒤 멈추는 것이다.**',
  '"이게 90대 10입니다"는 (1)이면서 동시에 (2)다. 지시 후보를 넣었더라도 (2)와 (3)을 다시 검사하라.',
  '지시어가 아예 없어도 (2)·(3)은 성립한다 — "네 가지 측면이 있습니다"에는 지시어가 없다.',
  '',
  '── 판정 규칙 ──',
  '· 한 발화가 여러 유형의 후보일 수 있다. 해당하는 것을 **모두** 넣어라.',
  `  예: "이 73%라는 숫자가 예사 숫자가 아닙니다" → ${NARRATION_TYPE_MAP.deixis}("이") + ${NARRATION_TYPE_MAP.interpretation}("73%")`,
  '· anchor에는 그렇게 판단한 근거 표현을 발화에서 그대로 따온다(짧게).',
  '· **중복 여부는 판단하지 마라.** "이미 말한 것 같다/곧 설명할 것 같다"는 이유로 거르지 마라.',
  '  중복·특정불가는 화면을 보는 다음 단계가 판단한다.',
  '· **화면에 근거가 있는지도 판단하지 마라.** 너는 화면을 볼 수 없다.',
  '  "인접 발화에 없다"까지만 보고 통과시키면 된다. 근거 유무는 다음 단계가 본다.',
  '· 대상의 **이름만** 말한 것은 통과시킨다("이 검색 엔진이"). 청자는 그것이 화면 어디에',
  '  어떤 형태로 있는지 여전히 못 보기 때문이다.',
  '· 판정 편향: **확신이 없으면 통과**시킨다. 놓치는 것보다 통과가 낫다(다음 단계가 거른다).',
  '',
  '── 핵심 기준: "화면을 봐야만 아는가" ──',
  '앞·뒤 맥락은 이 발화의 실제 인접 발화다. 이 안에서 대상이 이미 말로 설명됐는지 본다.',
  '  · 지시 표현으로만 가리켰다("이거", "여기", "오른쪽 것")        → 화면을 봐야 안다 → 통과',
  '  · 인접 발화가 대상의 **정체와 내용을 이미 말로 설명**했다       → 볼 필요가 없다 → 차단',
  '    예) 앞 맥락에 "3분기 매출이 12억으로 정점입니다"가 있고 발화가 "여기 보시면 정점이죠"',
  '        → 청자는 이미 안다. 차단.',
  '  · 앞서 **자기가 한 말**을 되짚는 지시("이렇게", "저렇게", "요렇게") → 차단',
  '',
  '── 차단 판정에서 가장 자주 틀리는 것: 이름을 말한 것 ≠ 값을 말한 것 ──',
  '해석(2) 후보를 차단하려면 **근거 값 자체**가 발화에 있어야 한다. 대상의 이름만으로는 부족하다.',
  '  · "시장 규모가 급속도로 성장하는데 VR이나 AR 시장이 성장하고 있습니다"',
  '    → 무엇이 성장하는지는 말했지만 **얼마나**는 말하지 않았다. 값이 없다 → 통과.',
  '  · "이 차원보다 큐빅 형태가 더 낫습니다"',
  '    → 무엇을 견주는지는 말했지만 **어떻게 다른지**는 말하지 않았다 → 통과.',
  '  · "5, 6년이 지났는데 정확하게 맞아가고 있습니다"',
  '    → 무엇이 맞았는지 값이 없다 → 통과.',
  '차단은 "12억", "73%", "두 배"처럼 **견줄 수 있는 값이 실제로 발화된 경우**에만 한다.',
  '',
  '── 전체 차단 (candidateList를 빈 배열로) ──',
  '화면의 사물이 아니거나 볼 필요가 없다고 "확신"할 때만. blockedReason:',
  `  · ${ROUTER_BLOCKED_REASON_MAP.abstract}: 개념·전략·성패·중요성·프로세스·추상적 "이런 것들" 나열·메타코멘트.`,
  '    그릴 수 있는 사물이 아님.',
  `  · ${ROUTER_BLOCKED_REASON_MAP.lowValue}: 화면을 가리키지만 보충할 시각 정보가 전혀 없다.`,
  `  · ${ROUTER_BLOCKED_REASON_MAP.spoken}: **인접 발화가 대상을 이미 특정·설명**했다.`,
  '    이름만 불린 것은 여기 해당하지 않는다 — 형태·위치는 여전히 안 보인다.',
  '    "무엇인지 + 어떤 값/내용인지"가 함께 발화됐을 때만 차단한다.',
  '',
  'JSON 한 줄만 출력한다(다른 텍스트 금지):',
  '{"candidateList":[{"type":"...","subKind":"...","reference":"...","anchor":"..."}],"blockedReason":null}',
  '통과 후보가 없으면 {"candidateList":[],"blockedReason":"abstract"} 형태로 출력한다.',
].join('\n');

const FEW_SHOT_LIST = [
  {
    input: { before: '분기별 매출을 보겠습니다.', utterance: '여기 이 주황색 막대가요.', after: '보시면 흐름이 있죠.' },
    output: {
      candidateList: [{
        type: NARRATION_TYPE_MAP.deixis, subKind: DEIXIS_FORM_MAP.simple,
        reference: DEIXIS_REFERENCE_MAP.inclusive, anchor: '이 주황색 막대',
      }],
      blockedReason: null,
    },
  },
  {
    input: { before: '결제 성공률이 중요한데요.', utterance: '이 92%가 그냥 나온 게 아니에요.', after: '노력한 결과죠.' },
    output: {
      candidateList: [
        {
          type: NARRATION_TYPE_MAP.deixis, subKind: DEIXIS_FORM_MAP.simple,
          reference: DEIXIS_REFERENCE_MAP.explicit, anchor: '이',
        },
        {
          type: NARRATION_TYPE_MAP.interpretation,
          subKind: INTERPRETATION_KIND_MAP.valueToMeaning, anchor: '92%',
        },
      ],
      blockedReason: null,
    },
  },
  {
    input: { before: '작년 요금제와 비교하면.', utterance: '기본료가 이렇게 올랐다는 점을 말씀드리고요.', after: '다음으로.' },
    output: {
      candidateList: [{
        type: NARRATION_TYPE_MAP.interpretation,
        subKind: INTERPRETATION_KIND_MAP.claimToValue, anchor: '올랐다',
      }],
      blockedReason: null,
    },
  },
  {
    input: { before: '현재 기준입니다.', utterance: '금융이 90대 기타가 10으로 보고 있는데', after: '시간이 흐를수록 다른 산업이 커지죠.' },
    output: {
      candidateList: [{
        type: NARRATION_TYPE_MAP.interpretation,
        subKind: INTERPRETATION_KIND_MAP.valueToMeaning, anchor: '90대 기타가 10',
      }],
      blockedReason: null,
    },
  },
  {
    input: { before: '정부가 하는 일이 뭐냐라고 봤을 때.', utterance: '네 가지 측면을 볼 수 있습니다.', after: '저는 매트릭스를 좋아하는데.' },
    output: {
      candidateList: [{
        type: NARRATION_TYPE_MAP.interpretation,
        subKind: INTERPRETATION_KIND_MAP.valueToMeaning, anchor: '네 가지 측면',
      }],
      blockedReason: null,
    },
  },
  {
    input: { before: '현재는 금융이 대부분입니다.', utterance: '이게 시간이 흐를수록 다른 분야 산업이 커지기 때문에', after: '금융 비율이 줄겠죠.' },
    output: {
      candidateList: [
        {
          type: NARRATION_TYPE_MAP.deixis, subKind: DEIXIS_FORM_MAP.simple,
          reference: DEIXIS_REFERENCE_MAP.explicit, anchor: '이게',
        },
        {
          type: NARRATION_TYPE_MAP.interpretation,
          subKind: INTERPRETATION_KIND_MAP.claimToValue, anchor: '커지기',
        },
      ],
      blockedReason: null,
    },
  },
  {
    input: { before: '메타버스를 보겠습니다.', utterance: '시장 규모가 급속도로 성장하고 있는 건데', after: 'VR이나 AR 시장이 크고 있습니다.' },
    output: {
      candidateList: [
        {
          type: NARRATION_TYPE_MAP.interpretation,
          subKind: INTERPRETATION_KIND_MAP.claimToValue, anchor: '성장하고',
        },
        {
          type: NARRATION_TYPE_MAP.visualDescription,
          subKind: VISUAL_DESCRIPTION_KIND_MAP.scale, anchor: '급속도로',
        },
      ],
      blockedReason: null,
    },
  },
  {
    input: { before: '데이터 정형화 얘기입니다.', utterance: '이런 경우는 굉장히 어려운 거죠.', after: '다음으로 넘어가죠.' },
    output: { candidateList: [], blockedReason: ROUTER_BLOCKED_REASON_MAP.abstract },
  },
  {
    input: { before: '서버실 사진입니다.', utterance: '이 랙이 생각보다 훨씬 큽니다.', after: '' },
    output: {
      candidateList: [
        {
          type: NARRATION_TYPE_MAP.deixis, subKind: DEIXIS_FORM_MAP.simple,
          reference: DEIXIS_REFERENCE_MAP.explicit, anchor: '이 랙',
        },
        {
          type: NARRATION_TYPE_MAP.visualDescription,
          subKind: VISUAL_DESCRIPTION_KIND_MAP.scale, anchor: '훨씬 큽니다',
        },
      ],
      blockedReason: null,
    },
  },
  {
    input: { before: '아키텍처를 보시면.', utterance: '이 결제 서버가 여기 붙고요.', after: '트래픽을 받습니다.' },
    output: {
      candidateList: [{
        type: NARRATION_TYPE_MAP.deixis, subKind: DEIXIS_FORM_MAP.complete,
        reference: DEIXIS_REFERENCE_MAP.explicit, anchor: '이 결제 서버',
      }],
      blockedReason: null,
    },
  },
  {
    input: { before: '결국.', utterance: '이 전략이 회사 성패를 가릅니다.', after: '중요하죠.' },
    output: { candidateList: [], blockedReason: ROUTER_BLOCKED_REASON_MAP.abstract },
  },
  {
    input: { before: '리스크가 많죠.', utterance: '이런 것들을 미리 챙겨두셔야 돼요.', after: '넘어가죠.' },
    output: { candidateList: [], blockedReason: ROUTER_BLOCKED_REASON_MAP.abstract },
  },
  {
    input: {
      before: '3분기 결제 건수가 120만 건으로 분기 최고치를 찍었습니다.',
      utterance: '여기 이 수치 보시면 됩니다.',
      after: '다음 장으로 가죠.',
    },
    output: { candidateList: [], blockedReason: ROUTER_BLOCKED_REASON_MAP.spoken },
  },
  {
    input: { before: '수수료를 절반으로 낮췄습니다.', utterance: '이렇게 하면 되는 거죠.', after: '' },
    output: { candidateList: [], blockedReason: ROUTER_BLOCKED_REASON_MAP.spoken },
  },
];

function buildRouterInput({ before = '', utterance, after = '' }) {
  return [
    `앞 맥락: ${before || '(없음)'}`,
    `발화: "${utterance}"`,
    `뒤 맥락(look-ahead): ${after || '(없음)'}`,
    '분류(JSON 한 줄):',
  ].join('\n');
}

function buildFewShotMessageList() {
  return FEW_SHOT_LIST.flatMap((example) => [
    { role: 'user', content: [{ text: buildRouterInput(example.input) }] },
    { role: 'assistant', content: [{ text: JSON.stringify(example.output) }] },
  ]);
}


module.exports = { ROUTER_BLOCKED_REASON_MAP, ROUTER_SYSTEM_PROMPT, FEW_SHOT_LIST, buildRouterInput, buildFewShotMessageList };
