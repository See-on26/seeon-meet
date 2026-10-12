const { TRIGGER_TYPE_MAP, TRIGGER_TYPE_LABEL_MAP } = require('../trigger/speech-trigger');

// 탐지 Layer 2단계(판단 LLM). 트리거가 뽑은 후보 구마다 앞뒤 발화만 보고 정보 공백(O)인지 가린다.
// 기준은 「성능 평가 방식」 1.2·1.3 이다. 화면은 보지 않는다 — 화면에 근거가 있는지는 다음 단계(AD 생성)가 본다.

const GAP_VERDICT_MAP = { gap: 'O', noGap: 'X' };

const ROUTER_BLOCKED_REASON_MAP = {
  noCandidate: 'no_candidate',
  noGap: 'no_gap',
  judgeUnavailable: 'judge_unavailable',
  judgeError: 'judge_error',
};

const ROUTER_SYSTEM_PROMPT = [
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
  `· ${TRIGGER_TYPE_LABEL_MAP[TRIGGER_TYPE_MAP.demonstrative]}(이·그·저, 이것·여기·저기, 이렇게, this·that·here·there):`,
  '  무엇을 가리키는지 앞뒤 발화로 알 수 없다.',
  `· ${TRIGGER_TYPE_LABEL_MAP[TRIGGER_TYPE_MAP.adjectiveNoun]}(빨간 쪽, 싼 거, 어두운 부분, the red one):`,
  '  어느 것을 말하는지 앞뒤 발화로 알 수 없다.',
  `· ${TRIGGER_TYPE_LABEL_MAP[TRIGGER_TYPE_MAP.number]}(30%, 12.5톤, 64 people): 무엇의 수치인지 밝히지 않았다.`,
  `· ${TRIGGER_TYPE_LABEL_MAP[TRIGGER_TYPE_MAP.change]}(올랐다, 더 높다, ~보다 낫다, 결국 감소했다, went down):`,
  '  무엇이 얼마에서 얼마로 바뀌었는지(비교면 양쪽 값이) 발화에 없다. 대상의 이름만 있고 값이 없으면 O 다.',
  '  값이 나와야 X 다.',
  `· ${TRIGGER_TYPE_LABEL_MAP[TRIGGER_TYPE_MAP.scale]}(꽤 넓죠, 정말 크죠, really big): 화면에 보이는 대상(사진 속 물체, 지도 위 지역,`,
  '  그래프의 막대, 사람 수)의 정도를 "크다·넓다"로만 말했고 실제 정도가 발화에 없다.',
  '  시간·부담·느낌·소리·난이도처럼 화면으로 볼 수 없는 성질이 주어면 정도가 없어도 X 다.',
  '',
  `── ${TRIGGER_TYPE_LABEL_MAP[TRIGGER_TYPE_MAP.number]}·${TRIGGER_TYPE_LABEL_MAP[TRIGGER_TYPE_MAP.change]}의 근거 인용 ──`,
  '이 두 유형을 X 로 판단하려면 근거 구절을 "evidence" 에 발화에서 글자 그대로 옮겨 적는다. 옮길 구절이 없으면 O 다.',
  `· ${TRIGGER_TYPE_LABEL_MAP[TRIGGER_TYPE_MAP.number]}: 그 수치가 무엇의 수치인지 밝힌 구절. 여럿 가운데 어느 것인지 모르면("세 지점 중 하나") 근거가 아니다.`,
  `· ${TRIGGER_TYPE_LABEL_MAP[TRIGGER_TYPE_MAP.change]}: 바뀐 값이나 비교한 양쪽 값을 밝힌 구절(숫자·수량이 들어 있다). 비교 대상의 이름만 있으면 근거가 아니다.`,
  '후보 구 자체는 근거가 아니다. 다른 유형이나 O 판단은 evidence 를 빈 문자열로 둔다.',
  '',
  '── 지시 대상 원칙 (가장 자주 틀린다) ──',
  '지시 표현이나 수치가 앞뒤 발화에 언급된 것 **하나**와 이어지면, 그것의 이름·내용을 밝히지 않았어도 X 다.',
  '  예) "워크숍 장소는 어제 정했다고 들었어요. … 거기가 주차가 안 돼서" → X (워크숍 장소)',
  '  예) "지난달 실적은 … 총 12.5톤입니다" → X (지난달 실적의 값)',
  'O 는 이을 만한 언급이 전혀 없거나, 후보가 여럿인데 어느 것인지 말하지 않을 때만이다.',
  '  예) 세 지역을 나란히 말한 뒤 "그 지역만큼은" → O',
  '"이렇게"가 앞에서 자기가 한 말을 되짚으면 X 다. 뒤 발화가 곧바로 풀어 주는 지시("방법은 이렇게 하면 돼요. 먼저 …")도 X 다.',
  '"보시는 것처럼", "화면에" 같은 말이 있다는 것만으로 O 로 판단하지 마라. 발화로 대상·값을 알 수 있는지만 본다.',
  '',
  '── 문맥 범위 ──',
  '앞 문맥은 마지막 화면 전환 뒤의 발화(최대 60초), 뒤 문맥은 후보 뒤 몇 초 동안의 발화다.',
  '뒤 문맥 안에서 풀리면 X, 뒤 문맥이 끝날 때까지 풀리지 않으면 O 다.',
  '',
  '출력: JSON 한 줄만. 후보 id 마다 하나씩, 근거(evidence)와 이유(한국어 한 문장)를 적는다.',
  '{"judgeList":[{"id":1,"gap":"X","evidence":"…","reason":"…"}]}',
].join('\n');

const FEW_SHOT_LIST = [
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
      before: '두 업체 견적을 받았는데요, 동양물산은 840만 원, 한빛은 1,020만 원입니다.',
      utterance: '저는 싼 쪽으로 가고 싶어요.',
      after: '납기는 둘 다 같거든요.',
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.adjectiveNoun, phrase: '싼 쪽' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'X', evidence: '', reason: '앞 발화의 견적으로 동양물산임을 알 수 있다' }] },
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
      before: 'We tested three packaging options with the night crew.',
      utterance: 'Honestly, that one held up the best.',
      after: "So that's what I'd order for the spring run.",
      candidateList: [
        { id: 1, type: TRIGGER_TYPE_MAP.demonstrative, phrase: 'that one' },
      ],
    },
    output: { judgeList: [{ id: 1, gap: 'O', evidence: '', reason: '세 포장 중 어느 것인지 말하지 않았다' }] },
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

function buildFewShotMessageList() {
  return FEW_SHOT_LIST.flatMap((example) => [
    { role: 'user', content: [{ text: buildRouterInput(example.input) }] },
    { role: 'assistant', content: [{ text: JSON.stringify(example.output) }] },
  ]);
}

module.exports = {
  ROUTER_BLOCKED_REASON_MAP, ROUTER_SYSTEM_PROMPT, FEW_SHOT_LIST, GAP_VERDICT_MAP,
  buildRouterInput, buildFewShotMessageList,
};
