const { TRIGGER_TYPE_MAP, TRIGGER_TYPE_LABEL_MAP } = require('../trigger/speech-trigger');

// 탐지 Layer 2단계(판단 LLM). 트리거가 뽑은 후보 구마다 앞뒤 발화만 보고 정보 공백(O)인지 가린다.
// 기준은 「성능 평가 방식」 1.2·1.3 이다. 화면은 보지 않는다 — 화면에 근거가 있는지는 다음 단계(AD 생성)가 본다.

const GAP_VERDICT_MAP = { gap: 'O', noGap: 'X' };

const ROUTER_BLOCKED_REASON_MAP = {
  noCandidate: 'no_candidate',
  noGap: 'no_gap',
  judgeError: 'judge_error',
};

// 판단 지시문은 공백 기준이 서로 반대로 움직이는 두 묶음으로 나눈다(QA 2-7).
// 지시 대상(지시대명사·형용사+지시 명사)은 잘못 내는 쪽, 발화 기반(단순 수치·변화·척도)은 놓치는 쪽이 약해 따로 맞춘다.
const JUDGE_GROUP_MAP = { deixis: 'deixis', speech: 'speech' };

const JUDGE_GROUP_LABEL_MAP = {
  [JUDGE_GROUP_MAP.deixis]: '지시 대상',
  [JUDGE_GROUP_MAP.speech]: '발화 기반',
};

const JUDGE_GROUP_BY_TRIGGER_TYPE_MAP = {
  [TRIGGER_TYPE_MAP.demonstrative]: JUDGE_GROUP_MAP.deixis,
  [TRIGGER_TYPE_MAP.adjectiveNoun]: JUDGE_GROUP_MAP.deixis,
  [TRIGGER_TYPE_MAP.number]: JUDGE_GROUP_MAP.speech,
  [TRIGGER_TYPE_MAP.change]: JUDGE_GROUP_MAP.speech,
  [TRIGGER_TYPE_MAP.scale]: JUDGE_GROUP_MAP.speech,
};

function readJudgeGroup(type) {
  return JUDGE_GROUP_BY_TRIGGER_TYPE_MAP[type] || null;
}

const HEADER_LINE_LIST = [
  '너는 시각장애인용 실시간 회의 해설 시스템의 "판단기"다.',
  '발표자의 트리거 문장과 그 앞뒤 발화, 그리고 트리거 문장 안에서 뽑은 후보 구 목록을 받는다.',
  '후보마다 **앞뒤 발화만 듣고** 그 후보가 가리키는 대상·값·정도를 알 수 있는지 판단한다.',
  '알 수 없으면 공백 "O"(화면 해설을 만든다), 알 수 있으면 "X"(해설하지 않는다).',
  '너는 화면을 볼 수 없다. 화면에 답이 있는지는 판단하지 마라 — 발화로 알 수 있는지만 본다.',
  '',
  '── 최소 출력 원칙 ──',
  '청자는 시각장애인이다. 해설이 많으면 회의를 따라가기 어렵다. 애매하면 내보내지 않는다(X).',
  '',
  '── 유형별 공백(O) 기준 ──',
];

const CRITERIA_LINE_MAP = {
  [TRIGGER_TYPE_MAP.demonstrative]: [
    `· ${TRIGGER_TYPE_LABEL_MAP[TRIGGER_TYPE_MAP.demonstrative]}(이·그·저, 이것·여기·저기, 이렇게, this·that·here·there):`,
    '  무엇을 가리키는지 앞뒤 발화로 알 수 없다.',
  ],
  [TRIGGER_TYPE_MAP.adjectiveNoun]: [
    `· ${TRIGGER_TYPE_LABEL_MAP[TRIGGER_TYPE_MAP.adjectiveNoun]}(빨간 쪽, 싼 거, 어두운 부분, the red one):`,
    '  어느 것을 말하는지 앞뒤 발화로 알 수 없다.',
    '  후보마다 그 성질의 값(폭·무게·건수·온도·금액 등)을 짝지어 모두 말했으면 값을 비교해 고를 수 있으므로 X 다.',
    '  값 대신 그 성질을 드러내는 말(밝기를 알 수 있는 색 이름 등)을 후보마다 짝지었어도 비교해 고를 수 있으면 X 다.',
    '  값이 일부 후보에만 있거나 어느 후보의 값인지 짝이 없으면("B와 C 중 하나는 90") O 다.',
    '  "두 후보의 크기는 서로 다르다", "색깔을 나눠 칠해 두었다"처럼 다르다는 것·표시 방식만 말하면 어느 것인지 정해지지 않았다. 뒤 발화도 이름을 대지 않으면 O 다.',
    '  뒤 발화에서 그것의 이름·표시를 대면("2번 시안이요", "I mean model K") 그 성질을 다시 말하지 않았어도 X 다.',
    '  앞에서 "두 후보의 그 성질이 서로 다르다"고만 했어도 마찬가지다. 이름이 다른 안내 뒤에 짧게 붙거나, 적어 달라·요청한다는 말에 이름이 붙어 있어도 그것이 발표자가 고른 것이다.',
    '  이름을 댔는데 "그 이름이 그 성질을 가졌다고 말하지 않았다"며 O 로 하지 마라. 다만 "이름을 적어 두세요"처럼 실제 이름 없이 안내만 있으면 근거가 아니다.',
  ],
  [TRIGGER_TYPE_MAP.number]: [
    `· ${TRIGGER_TYPE_LABEL_MAP[TRIGGER_TYPE_MAP.number]}(30%, 12.5톤, 64 people): 무엇의 수치인지 밝히지 않았다.`,
    '  앞에서 항목을 여럿 말했는데 앞에서도 뒤에서도 그중 어느 것의 값인지 말하지 않았으면 O 다.',
    '  "기록·결과·단가·숫자 하나"처럼 값의 종류만 있고 무엇을 세거나 잰 값인지 없으면 O 다. 앞뒤 발화가 항목을 정하지 않았다면 값이 적힌 곳(화이트보드·메모장·칸)만 말한 것도 O 다.',
  ],
  [TRIGGER_TYPE_MAP.change]: [
    `· ${TRIGGER_TYPE_LABEL_MAP[TRIGGER_TYPE_MAP.change]}(올랐다, 더 높다, ~보다 낫다, 결국 감소했다, went down):`,
    '  무엇이 얼마에서 얼마로 바뀌었는지(비교면 양쪽 값이) 발화에 없다. 대상의 이름만 있고 값이 없으면 O 다.',
    '  값이 나와야 X 다.',
    '  그 대상의 바뀌기 전·후 값(비교면 양쪽 값)이 앞 문맥에 이미 나왔으면 트리거 문장이 값을 다시 말하지 않아도 X 다. 값이 다른 대상의 것이거나 한쪽만 있으면 O 다.',
  ],
  [TRIGGER_TYPE_MAP.scale]: [
    `· ${TRIGGER_TYPE_LABEL_MAP[TRIGGER_TYPE_MAP.scale]}(꽤 넓죠, 정말 크죠, really big): 화면에 보이는 대상(사진 속 물체, 지도 위 지역,`,
    '  그래프의 막대, 사람 수)의 정도를 "크다·넓다"로만 말했고 실제 정도가 발화에 없다.',
    '  먼저 "크다·많다·짧다"의 주어(무엇이 큰가·많은가)를 찾는다. 주어가 눈으로 볼 수 있는 사물·구역·사람·막대일 때만 O 가 될 수 있다.',
    '  시간·부담·느낌·소리·난이도처럼 화면으로 볼 수 없는 성질이 주어면 정도가 없어도 X 다.',
    '  기간·남은 시간, 생각·감정(의견·걱정·불만), 가능성·위험, 일의 양·영향처럼 사진에 찍히지 않는 것도 같다.',
    '  범위·폭·다양성은 그 범위를 가진 것이 눈에 보이는지로 가린다. 생각·선택·권한처럼 보이지 않으면 X, 사진·지도에 보이는 것이 퍼진 넓이면 O 가 될 수 있다.',
    '  유형 이름의 "추상적"은 정도를 말로만 했다는 뜻이다. "추상적인 표현이라 수치가 없다"는 O 의 이유가 아니다.',
    '  실제 정도가 앞뒤 발화에 숫자로 나오면("4.8km", "26개") "크다·많다"라고 말했어도 X 다. 앞 문맥 앞쪽에 나온 숫자도 그 대상의 값이면 된다.',
  ],
};

// X 판단에 근거 구절을 옮겨 적게 하는 유형. 코드가 그 구절이 발화에 있는지 확인한다(judge-evidence.js).
const EVIDENCE_LINE_MAP = {
  [TRIGGER_TYPE_MAP.adjectiveNoun]: [
    `· ${TRIGGER_TYPE_LABEL_MAP[TRIGGER_TYPE_MAP.adjectiveNoun]}: 그 성질(색·크기·값 등)을 가진 것이 무엇인지 밝힌 구절(예: 두 견적의 금액), 또는 뒤 발화에서 그것의 이름을 댄 구절(예: "2번 시안이요"). 후보를 나열하기만 하고 어느 것이 그런지 말하지 않으면 근거가 아니다.`,
    '  뒤 발화의 이름으로 X 를 줄 때도 그 구절을 evidence 에 꼭 옮긴다. evidence 가 비면 X 가 아니다.',
    '  영어 발화는 영어 원문 그대로 옮긴다(번역하거나 고쳐 쓰지 않는다).',
  ],
  [TRIGGER_TYPE_MAP.number]: [
    `· ${TRIGGER_TYPE_LABEL_MAP[TRIGGER_TYPE_MAP.number]}: 그 수치가 무엇을 세거나 잰 값인지 밝힌 구절. 여럿 가운데 어느 것인지 모르면("세 지점 중 하나") 근거가 아니다.`,
    '  "요청하신 숫자", "맨 위 숫자", "the number I want to flag"처럼 숫자를 가리키기만 하고 무엇을 센 값인지 말하지 않으면 근거가 아니다.',
    '  발표자가 다룰 항목을 이름으로 고른 구절("오늘은 B만 볼게요")이나 뒤 발화에서 항목 이름을 댄 구절도 근거다.',
  ],
  [TRIGGER_TYPE_MAP.change]: [
    `· ${TRIGGER_TYPE_LABEL_MAP[TRIGGER_TYPE_MAP.change]}: 바뀐 값이나 비교한 양쪽 값을 밝힌 구절(숫자·수량이 들어 있다). 비교 대상의 이름만 있으면 근거가 아니다.`,
  ],
};

const COUNT_WORD_LIST = ['', '', '두 ', '세 '];

function buildEvidenceLineList(typeList) {
  const evidenceTypeList = typeList.filter((type) => EVIDENCE_LINE_MAP[type]);
  if (!evidenceTypeList.length) return [];
  return [
    '',
    `── ${evidenceTypeList.map((type) => TRIGGER_TYPE_LABEL_MAP[type]).join('·')}의 근거 인용 ──`,
    `이 ${COUNT_WORD_LIST[evidenceTypeList.length]}유형을 X 로 판단하려면 근거 구절을 "evidence" 에 발화에서 글자 그대로 옮겨 적는다. 옮길 구절이 없으면 O 다.`,
    // 코드는 근거가 발화에 글자 그대로 있는지 확인한다(judge-evidence.js). 순서를 바꾸거나 두 곳을 합쳐 쓰면 확인에 걸려 O 로 뒤집힌다.
    '근거는 발화의 한 구절을 순서·낱말을 바꾸지 않고 그대로 옮긴다. 떨어진 두 곳이 필요하면 각 구절을 그대로 옮겨 "…"로 잇는다.',
    ...evidenceTypeList.flatMap((type) => EVIDENCE_LINE_MAP[type]),
    '후보 구 자체는 근거가 아니다. 다른 유형이나 O 판단은 evidence 를 빈 문자열로 둔다.',
  ];
}

// 앞뒤 발화에 언급된 것 하나와 이어지면 X 라는 원칙. 지시 대상에서 가장 자주 틀리고, 수치에도 같은 원칙이 선다.
const REFERENCE_LINE_MAP = {
  [JUDGE_GROUP_MAP.deixis]: [
    '',
    '── 지시 대상 원칙 (가장 자주 틀린다) ──',
    '지시 표현이 앞뒤 발화에 언급된 것 **하나**와 이어지면, 그것의 이름·내용을 밝히지 않았어도 X 다.',
    '  예) "워크숍 장소는 어제 정했다고 들었어요. … 거기가 주차가 안 돼서" → X (워크숍 장소)',
    '앞에서 여럿을 말했어도 그중 **하나에만** 붙은 말이 있고("B만 ~다", "B로 정했다", "B는 이미 승인됐다", "오늘은 B를 다룬다", "only B has …", "we will focus on B") 지시 문장이 그 말과 맞으면 지시는 그 하나다 → X. 짚은 것이 둘 이상이면 O 다.',
    '  "만·뿐·only"가 없어도 여럿 중 하나만 결과·상태가 달랐다고 말했으면(하나만 목표를 넘겼다, 하나만 효과가 없었다) 같다. 여럿을 나란히 말하기만 했으면 O 다.',
    '뒤 발화가 대상을 밝히면 앞에 후보가 여럿이었어도 X 다. 머뭇거림·다른 말 뒤에 나오거나 문장 끝에 덧붙여도 된다("…, 어, 평택 공장이요", "…, um, the north lot").',
    'O 는 이을 만한 언급이 전혀 없거나, 후보가 여럿인데 앞에서도 뒤에서도 어느 것인지 말하지 않을 때만이다.',
    '  예) 세 지역을 나란히 말한 뒤 "그 지역만큼은" → O',
    '앞뒤 발화가 하나를 정해 줬는데 "그것을 가리킨다고 명시하지 않았다", "정확한 위치·좌표가 없다"며 O 로 하지 마라. 지시 표현이 그것이라고 다시 말할 필요는 없다.',
    '  여기·거기·here·there 도 앞뒤 발화가 장소·구역·칸·대목 하나를 정해 주면 X 다.',
    '  반대로 "둘 중 하나", "자료(화면·핸드아웃)에 있는 곳"처럼 하나로 정하지 못했으면 O 다. 네가 짐작해 고르거나 지시 문장과 맞지 않는 말(장소를 가리키는데 자료·시간대)에 억지로 잇지 마라.',
    '"이렇게"가 앞에서 자기가 한 말을 되짚으면 X 다. 뒤 발화가 곧바로 풀어 주는 지시("방법은 이렇게 하면 돼요. 먼저 …")도 X 다.',
    '"보시는 것처럼", "화면에" 같은 말이 있다는 것만으로 O 로 판단하지 마라. 발화로 대상·값을 알 수 있는지만 본다.',
  ],
  [JUDGE_GROUP_MAP.speech]: [
    '',
    '── 앞뒤 발화와 이어지는 수치 ──',
    '수치가 앞뒤 발화에 언급된 것 **하나**와 이어지면, 그것의 이름·내용을 밝히지 않았어도 X 다.',
    '  예) "지난달 실적은 … 총 12.5톤입니다" → X (지난달 실적의 값)',
    'O 는 이을 만한 언급이 전혀 없거나, 후보가 여럿인데 어느 것인지 말하지 않을 때만이다.',
    '  예) 세 지역을 나란히 말한 뒤 "거기 매출이 4,200만 원" → O',
    '앞에서 항목을 여럿 나열했어도 아래 둘 중 하나면 그 항목의 값이다 → X.',
    '  · 발표자가 지금 다룰 항목 하나를 이름으로 골랐다("오늘은 B만 볼게요", "B부터 말씀드리겠습니다", "B가 논의 대상입니다").',
    '  · 뒤 발화가 다른 말 뒤에라도 그 수치가 어느 항목의 값인지 이름을 댔다("…, B 건수입니다", "…, it\'s the B figure").',
    '  이름 없이 "셋 중 하나만 보겠다"고 하거나, 뒤 발화가 어떻게 셌는지·어디서 뽑았는지·어느 범위의 값인지만 말하면 어느 항목인지 정해지지 않았다 → O.',
    '"보시는 것처럼", "화면에" 같은 말이 있다는 것만으로 O 로 판단하지 마라. 발화로 대상·값을 알 수 있는지만 본다.',
  ],
};

const FOOTER_LINE_LIST = [
  '',
  '── 문맥 범위 ──',
  '앞 문맥은 마지막 화면 전환 뒤의 발화(최대 60초), 뒤 문맥은 후보 뒤 몇 초 동안의 발화다.',
  '뒤 문맥 안에서 풀리면 X, 뒤 문맥이 끝날 때까지 풀리지 않으면 O 다.',
  '',
  // O/X 를 먼저 쓰면 이유와 어긋난 판단을 그대로 내는 일이 잦다("밝히지 않았다"인데 X). 이유를 먼저 쓰고 판단을 끝에 둔다.
  '출력: JSON 한 줄만. 후보 id 마다 하나씩, 이유(한국어 한 문장)와 근거(evidence)를 먼저 적고 그 이유에 맞는 O/X 를 마지막에 적는다.',
  '{"judgeList":[{"id":1,"reason":"…","evidence":"…","gap":"X"}]}',
];

function buildGroupSystemPrompt(group) {
  const typeList = Object.keys(JUDGE_GROUP_BY_TRIGGER_TYPE_MAP).filter((type) => JUDGE_GROUP_BY_TRIGGER_TYPE_MAP[type] === group);
  return [
    ...HEADER_LINE_LIST,
    ...typeList.flatMap((type) => CRITERIA_LINE_MAP[type]),
    ...buildEvidenceLineList(typeList),
    ...REFERENCE_LINE_MAP[group],
    ...FOOTER_LINE_LIST,
  ].join('\n');
}

const ALL_FEW_SHOT_LIST = [
  {
    input: {
      before: '이번 달 고객센터 지표를 정리했습니다.',
      utterance: '이 부분에서 대기 시간이 제일 길어요.',
      after: '그래서 상담원을 늘리려고 합니다.',
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.demonstrative, phrase: '이 부분' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'O', evidence: '', reason: '"이 부분"이 어느 구간인지 앞뒤 발화에 없다' }] },
  },
  {
    input: {
      before: '야간 상담은 이번 달부터 외주로 돌렸습니다.',
      utterance: '이 부분에서 대기 시간이 제일 길어요.',
      after: '그래서 상담원을 늘리려고 합니다.',
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.demonstrative, phrase: '이 부분' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'X', evidence: '', reason: '앞 발화의 야간 상담을 가리킨다' }] },
  },
  {
    input: {
      before: '이번 달 고객센터 지표를 정리했습니다.',
      utterance: '이 부분에서 대기 시간이 제일 길어요.',
      after: '어, 주말 오후 시간대요. 그래서 상담원을 늘리려고 합니다.',
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.demonstrative, phrase: '이 부분' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'X', evidence: '', reason: '뒤 발화에서 주말 오후 시간대라고 밝혔다' }] },
  },
  {
    input: {
      before: '회의실 후보는 3층 소회의실, 5층 대회의실, 7층 라운지예요. 빔프로젝터가 있는 곳은 5층 대회의실뿐이고요.',
      utterance: '발표 연습은 거기서 하죠.',
      after: '예약은 제가 오늘 걸어 둘게요.',
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.demonstrative, phrase: '거기' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'X', evidence: '', reason: '세 곳 중 빔프로젝터가 있다고 따로 짚은 5층 대회의실을 가리킨다' }] },
  },
  {
    input: {
      before: '회의실 후보는 3층 소회의실, 5층 대회의실, 7층 라운지예요. 빔프로젝터는 5층 대회의실과 7층 라운지에 있고요.',
      utterance: '발표 연습은 거기서 하죠.',
      after: '예약은 제가 오늘 걸어 둘게요.',
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.demonstrative, phrase: '거기' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'O', evidence: '', reason: '빔프로젝터가 있는 곳이 두 곳이라 그중 어느 곳인지 앞뒤 발화에 없다' }] },
  },
  {
    input: {
      before: 'We looked at three rooms for the book fair: the lobby, the atrium, and the side hall. Only the atrium has outlets along the wall.',
      utterance: "Let's set up the charging table there.",
      after: "I'll let the vendor know tomorrow.",
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.demonstrative, phrase: 'there' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'X', evidence: '', reason: '세 곳 중 콘센트가 있다고 따로 짚은 atrium 을 가리킨다' }] },
  },
  {
    input: {
      before: 'The floor plan is in your handout. It shows the lobby, the atrium, and the side hall.',
      utterance: "Let's set up the charging table there.",
      after: "I'll let the vendor know tomorrow.",
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.demonstrative, phrase: 'there' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'O', evidence: '', reason: '세 곳 중 어디인지 말하지 않았고 핸드아웃은 놓을 자리가 아니다' }] },
  },
  {
    input: {
      before: '어제 포장 라인 기계 점검 결과가 나왔는데, 1호기랑 3호기는 기준 안이었고 2호기는 소음이 기준을 넘었어요.',
      utterance: '수리 기사님께는 그 기계부터 봐 달라고 했습니다.',
      after: '부품은 이번 주 안에 들어온대요.',
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.demonstrative, phrase: '그 기계' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'X', evidence: '', reason: '세 대 중 혼자 기준을 넘었다고 짚은 2호기를 가리킨다' }] },
  },
  {
    input: {
      before: '두 업체 견적을 받았는데요, 동양물산은 840만 원, 한빛은 1,020만 원입니다.',
      utterance: '저는 싼 쪽으로 가고 싶어요.',
      after: '납기는 둘 다 같거든요.',
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.adjectiveNoun, phrase: '싼 쪽' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'X', evidence: '동양물산은 840만 원, 한빛은 1,020만 원입니다', reason: '앞 발화의 견적으로 동양물산임을 알 수 있다' }] },
  },
  {
    input: {
      before: '창고 두 곳을 실측했는데요, 북창고가 1,200제곱미터, 남창고가 900제곱미터예요.',
      utterance: '넓은 쪽에 신규 물량을 넣죠.',
      after: '이사는 다음 달 초로 잡겠습니다.',
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.adjectiveNoun, phrase: '넓은 쪽' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'X', evidence: '북창고가 1,200제곱미터, 남창고가 900제곱미터예요', reason: '두 창고의 면적을 비교하면 넓은 쪽은 북창고다' }] },
  },
  {
    input: {
      before: '창고 두 곳을 실측하기로 했는데요, 북창고는 1,200제곱미터가 나왔고 남창고는 아직 못 쟀어요.',
      utterance: '넓은 쪽에 신규 물량을 넣죠.',
      after: '이사는 다음 달 초로 잡겠습니다.',
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.adjectiveNoun, phrase: '넓은 쪽' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'O', evidence: '', reason: '남창고 면적이 없어 어느 쪽이 넓은지 비교할 수 없다' }] },
  },
  {
    input: {
      before: '북창고와 남창고를 실측했는데요, 한 곳은 1,200제곱미터, 다른 곳은 900제곱미터가 나왔어요. 어느 쪽이 어느 쪽인지는 표에 있어요.',
      utterance: '넓은 쪽에 신규 물량을 넣죠.',
      after: '이사는 다음 달 초로 잡겠습니다.',
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.adjectiveNoun, phrase: '넓은 쪽' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'O', evidence: '', reason: '두 면적이 어느 창고의 값인지 짝지어 말하지 않았다' }] },
  },
  {
    input: {
      before: '네, 다음으로 넘어가 볼게요.',
      utterance: '보시는 것처럼 41%예요. 작년이랑 비교하면 많이 올랐습니다.',
      after: '이 추세면 내년 목표도 무난해 보여요.',
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.number, phrase: '41%' },
        { id: 2, type: TRIGGER_TYPE_MAP.change, phrase: '많이 올랐습니다' },
      ],
    },
    output: {
      judgeList: [
        { id: 1, gap: 'O', evidence: '', reason: '무엇의 41%인지 발화에 없다' },
        { id: 2, gap: 'O', evidence: '', reason: '무엇이 얼마에서 얼마로 올랐는지 없다' },
      ],
    },
  },
  {
    input: {
      before: '설치 뒤 석 달을 비교했습니다.',
      utterance: '불량 접수가 확 줄었어요.',
      after: '월 52건에서 19건이 됐거든요.',
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.change, phrase: '확 줄었어요' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'X', evidence: '월 52건에서 19건이 됐거든요', reason: '뒤 발화에서 52건에서 19건으로 값을 밝혔다' }] },
  },
  {
    input: {
      before: 'A팀과 B팀의 지난 분기 처리 시간을 비교했습니다.',
      utterance: 'B팀이 훨씬 빨랐어요.',
      after: '그래서 B팀 방식을 따르기로 했습니다.',
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.change, phrase: '훨씬 빨랐어요' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'O', evidence: '', reason: '비교 대상(두 팀)만 있고 처리 시간 값이 발화에 없다' }] },
  },
  {
    input: {
      before: '성게는 아직 정리 전이라 빼고요, 전복은 한 마리 평균 38그램, 해삼은 52그램이 나왔어요.',
      utterance: '전복 쪽이 해삼보다 가볍네요.',
      after: '키우는 분들 말씀도 그렇더라고요.',
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.change, phrase: '해삼보다 가볍네요' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'X', evidence: '전복은 한 마리 평균 38그램, 해삼은 52그램이 나왔어요', reason: '앞 문맥에서 전복 38그램, 해삼 52그램으로 양쪽 값을 밝혔다' }] },
  },
  {
    input: {
      before: '성게는 아직 정리 전이라 빼고요, 전복은 한 마리 평균 38그램, 해삼은 52그램이 나왔어요.',
      utterance: '성게 쪽이 해삼보다 가볍네요.',
      after: '키우는 분들 말씀도 그렇더라고요.',
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.change, phrase: '해삼보다 가볍네요' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'O', evidence: '', reason: '앞 문맥의 값은 전복·해삼 것이고 성게 무게는 발화에 없다' }] },
  },
  {
    input: {
      before: 'We track three wait times at the clinic: check-in, triage, and the doctor visit.',
      utterance: 'This month it averaged 14 minutes.',
      after: "Let's see if we can bring that down next month.",
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.number, phrase: '14 minutes' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'O', evidence: '', reason: '대기 시간 세 가지 중 어느 것의 평균인지 말하지 않았다' }] },
  },
  {
    input: {
      before: '어제 실험한 걸 표로 정리해 왔어요.',
      utterance: '결과는 0.82가 나왔습니다.',
      after: '다음 주에 한 번 더 재 볼게요.',
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.number, phrase: '0.82' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'O', evidence: '', reason: '"결과"라고만 했고 무엇을 잰 값인지 말하지 않았다' }] },
  },
  {
    input: {
      before: '세 지점의 이번 달 매출을 뽑아 봤어요.',
      utterance: '음, 4,200만 원이 나왔네요.',
      after: '생각보다 괜찮죠.',
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.number, phrase: '4,200만 원' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'O', evidence: '', reason: '세 지점 중 어느 지점의 매출인지 말하지 않았다' }] },
  },
  {
    input: {
      before: '보고서에서 짚고 넘어갈 숫자가 하나 있어요.',
      utterance: '바로 18건입니다.',
      after: '다음 달에 다시 보겠습니다.',
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.number, phrase: '18건' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'O', evidence: '', reason: '"짚고 넘어갈 숫자"라고만 했고 무엇을 센 건수인지 말하지 않았다' }] },
  },
  {
    input: {
      before: '회원 현황부터 보겠습니다.',
      utterance: '올해 신규 가입자는 3,400명입니다.',
      after: '목표는 넘겼습니다.',
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.number, phrase: '3,400명' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'X', evidence: '올해 신규 가입자는', reason: '올해 신규 가입자 수라고 밝혔다' }] },
  },
  {
    input: {
      before: '창고 점검표에 볼트, 너트, 와셔 수량이 다 들어 있는데요.',
      utterance: '모자라는 게 340개예요.',
      after: '와셔 쪽 부족분이고, 나머지 둘은 넉넉합니다.',
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.number, phrase: '340개' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'X', evidence: '와셔 쪽 부족분이고', reason: '세 부품 중 와셔의 부족분이라고 뒤 발화에서 밝혔다' }] },
  },
  {
    input: {
      before: '창고 점검표에 볼트, 너트, 와셔 수량이 다 들어 있는데요.',
      utterance: '모자라는 게 340개예요.',
      after: '두 번 세어서 맞춘 숫자입니다.',
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.number, phrase: '340개' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'O', evidence: '', reason: '세 부품 중 어느 것의 부족분인지 말하지 않았고 뒤 발화는 센 방법만 말했다' }] },
  },
  {
    input: {
      before: 'We agreed at the last meeting to cover just one of the three pilot schools today, Oakhurst.',
      utterance: 'So, 91 percent of their students passed the reading check.',
      after: 'The full table is in the appendix.',
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.number, phrase: '91 percent' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'X', evidence: 'We agreed at the last meeting to cover just one of the three pilot schools today, Oakhurst', reason: '지난 회의에서 정한 대로 세 학교 중 오늘 다룰 곳은 Oakhurst 다' }] },
  },
  {
    input: {
      before: '로고 시안을 두 개 만들었어요.',
      utterance: '저는 파란 쪽이 마음에 들어요.',
      after: '다들 어떠세요?',
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.adjectiveNoun, phrase: '파란 쪽' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'O', evidence: '', reason: '두 시안 중 어느 것이 파란지 말하지 않았다' }] },
  },
  {
    input: {
      before: '로고 시안을 두 개 만들었어요.',
      utterance: '저는 파란 쪽이 마음에 들어요.',
      after: '어, 2번 시안이요. 다들 어떠세요?',
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.adjectiveNoun, phrase: '파란 쪽' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'X', evidence: '2번 시안이요', reason: '뒤 발화에서 파란 쪽이 2번 시안이라고 밝혔다' }] },
  },
  {
    input: {
      before: '시제품 손잡이를 두 가지로 뽑아 봤어요.',
      utterance: '양산은 둥근 쪽으로 가죠.',
      after: '금형 일정도 맞춰야 하니까요. 아, 은색 시제품이요.',
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.adjectiveNoun, phrase: '둥근 쪽' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'X', evidence: '은색 시제품이요', reason: '뒤 발화에서 다른 말 뒤에 은색 시제품이라고 밝혔다' }] },
  },
  {
    input: {
      before: '이번 바자회 때 몬스테라하고 고무나무 중에 하나를 포토존에 두기로 했어요.',
      utterance: '잎이 무성한 쪽을 두면 눈에 잘 띌 것 같아요.',
      after: '아, 고무나무 말이에요, 지난주에 분갈이를 하고 새잎이 많이 났거든요.',
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.adjectiveNoun, phrase: '무성한 쪽' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'X', evidence: '고무나무 말이에요', reason: '어느 쪽 잎이 무성한지 앞에서 말하지 않았지만 뒤 발화에서 고무나무라고 이름을 댔다' }] },
  },
  {
    input: {
      before: '이번 바자회 때 몬스테라하고 고무나무 중에 하나를 포토존에 두기로 했어요.',
      utterance: '잎이 무성한 쪽을 두면 눈에 잘 띌 것 같아요.',
      after: '아, 지난주에 분갈이를 하고 새잎이 많이 났다고 들었거든요.',
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.adjectiveNoun, phrase: '무성한 쪽' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'O', evidence: '', reason: '두 화분 중 어느 쪽 잎이 무성한지 앞뒤 발화에 없다' }] },
  },
  {
    input: {
      before: 'Two desk lamps showed up at the studio this morning, an Arlo and a Bexa.',
      utterance: 'The lighter one should go up on the wall bracket.',
      after: "Bexa's the one I mean, and the other can stay on the desk.",
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.adjectiveNoun, phrase: 'The lighter one' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'X', evidence: "Bexa's the one I mean", reason: '뒤 발화에서 Bexa 라고 이름을 댔다' }] },
  },
  {
    input: {
      before: 'Two desk lamps showed up at the studio this morning, an Arlo and a Bexa.',
      utterance: 'The lighter one should go up on the wall bracket.',
      after: 'The other can stay on the desk for now.',
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.adjectiveNoun, phrase: 'The lighter one' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'O', evidence: '', reason: '두 램프 중 어느 것이 가벼운지 앞뒤 발화에 없다' }] },
  },
  {
    input: {
      before: '현장 사진 한 장 띄워 두었습니다.',
      utterance: '음, 침수된 구역이 꽤 넓죠.',
      after: '복구에만 몇 달이 걸릴 것 같습니다.',
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.scale, phrase: '꽤 넓죠' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'O', evidence: '', reason: '보이는 대상(침수 구역)의 넓이를 가늠할 값이 없다' }] },
  },
  {
    input: {
      before: '현장 사진 한 장 띄워 두었습니다.',
      utterance: '음, 침수된 구역이 꽤 넓죠.',
      after: '약 2만 제곱미터에 달합니다.',
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.scale, phrase: '꽤 넓죠' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'X', evidence: '', reason: '뒤 발화에서 넓이를 약 2만 제곱미터라고 밝혔다' }] },
  },
  {
    input: {
      before: '민원 처리 절차를 바꾼 이유를 말씀드릴게요.',
      utterance: '음, 대기 시간이 꽤 길죠.',
      after: '그래서 온라인 접수를 열었습니다.',
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.scale, phrase: '꽤 길죠' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'X', evidence: '', reason: '대기 시간은 화면으로 볼 수 있는 대상이 아니다' }] },
  },
  {
    input: {
      before: '새 근무 제도 설명회를 지난주에 열었습니다.',
      utterance: '설명회 끝나고 나서 호응이 정말 컸어요.',
      after: '세부 지침은 다음 달에 나옵니다.',
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.scale, phrase: '정말 컸어요' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'X', evidence: '', reason: '호응은 반응·감정이라 화면으로 볼 수 있는 대상이 아니다' }] },
  },
  {
    input: {
      before: 'We just got the schedule for both grant reports.',
      utterance: 'And honestly, there is a really short gap between the two deadlines.',
      after: 'I would start drafting the first one this week.',
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.scale, phrase: 'really short' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'X', evidence: '', reason: '두 마감 사이의 기간은 시간이라 화면으로 볼 수 있는 대상이 아니다' }] },
  },
  {
    input: {
      before: 'We tested three packaging options with the night crew.',
      utterance: 'Honestly, that one held up the best.',
      after: "So that's what I'd order for the spring run.",
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.demonstrative, phrase: 'that one' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'O', evidence: '', reason: '세 포장 중 어느 것인지 말하지 않았다' }] },
  },
  {
    input: {
      before: 'We tested three packaging options with the night crew.',
      utterance: 'Honestly, that one held up the best.',
      after: "So that's what I'd order, um, the kraft paper sleeve.",
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.demonstrative, phrase: 'that one' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'X', evidence: '', reason: '뒤 발화에서 kraft paper sleeve 라고 밝혔다' }] },
  },
];

function formatCandidateLine(candidate) {
  return `${candidate.id}) [${TRIGGER_TYPE_LABEL_MAP[candidate.type] || candidate.type}] "${candidate.phrase}"`;
}

function buildRouterInput({ before = '', utterance, after = '', candidateList = [] }) {
  return [
    `앞 문맥: ${before || '(없음)'}`,
    `트리거 문장: "${utterance}"`,
    `뒤 문맥: ${after || '(없음)'}`,
    '후보:',
    ...candidateList.map(formatCandidateLine),
    '판단(JSON 한 줄):',
  ].join('\n');
}

function isGroupExample({ example, group }) {
  return example.input.candidateList.every((candidate) => readJudgeGroup(candidate.type) === group);
}

const ROUTER_PROMPT_MAP = Object.fromEntries(Object.values(JUDGE_GROUP_MAP).map((group) => [group, {
  systemPrompt: buildGroupSystemPrompt(group),
  fewShotList: ALL_FEW_SHOT_LIST.filter((example) => isGroupExample({ example, group })),
}]));

// 예시 답도 이유 → 근거 → 판단 순서로 적는다.
function toAnswerText({ output }) {
  return JSON.stringify({
    judgeList: output.judgeList.map(({ id, gap, evidence, reason }) => ({ id, reason, evidence, gap })),
  });
}

function buildFewShotMessageList({ group }) {
  return ROUTER_PROMPT_MAP[group].fewShotList.flatMap((example) => [
    { role: 'user', content: [{ text: buildRouterInput(example.input) }] },
    { role: 'assistant', content: [{ text: toAnswerText(example) }] },
  ]);
}

module.exports = {
  ROUTER_BLOCKED_REASON_MAP, ROUTER_PROMPT_MAP, JUDGE_GROUP_MAP, JUDGE_GROUP_LABEL_MAP, GAP_VERDICT_MAP,
  readJudgeGroup, buildRouterInput, buildFewShotMessageList,
};
