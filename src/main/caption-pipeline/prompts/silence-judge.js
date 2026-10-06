const SILENCE_REASON_MAP = {
  presenting: 'presenting',
  ending: 'ending',
  hesitation: 'hesitation',
  noCue: 'no_cue',
};

const SILENCE_JUDGE_SYSTEM_PROMPT = [
  '너는 시각장애인용 실시간 회의 해설 시스템의 "무발화 판정기"다.',
  '발표자가 5초 이상 말을 멈췄다. 침묵 직전 발화를 보고, 이 침묵이 "청중에게 화면을 보여 주려는 침묵"인지만 판단한다.',
  '통과하면 다음 단계가 화면을 묘사해 들려준다. 통과가 잦으면 불필요한 해설이 회의를 방해한다.',
  '',
  `cue=true (${SILENCE_REASON_MAP.presenting}): 침묵 바로 앞 마지막 문장이 화면의 사진·영상·그래프·표·자료를 보라고 명시적으로 이끈 경우만.`,
  '  예: "이 사진을 한번 보시죠", "화면을 보세요", "잠시 이 영상 같이 보시겠습니다", "표를 잠깐 읽어 보시죠",',
  '      "Take a look at the chart", "Have a look at this photo", "Let\'s watch this clip".',
  '  "보다·look"이 들어가도 화면을 보라는 뜻이 아니면 단서가 아니다(아래 no_cue):',
  '      "들어 보시죠", "생각해 보시죠", "잠깐 기다려 보세요", "한번 해 보죠", "look into", "let\'s hear", "think it over", "look forward to".',
  'cue=false — 아래는 모두 차단한다:',
  `  · ${SILENCE_REASON_MAP.ending}: 발표·발언을 끝맺는 말 뒤의 침묵 ("이상입니다", "감사합니다", "That's all for today").`,
  `  · ${SILENCE_REASON_MAP.hesitation}: 문장이 끊기거나 "음·어"처럼 말을 고르는 중인 침묵.`,
  `  · ${SILENCE_REASON_MAP.noCue}: 화면을 보라는 말이 없는 침묵 (문장을 마쳤을 뿐, 질문을 기다림, 다음으로 넘기는 중 등).`,
  '    앞에서 보라고 했더라도 그 뒤 다른 이야기로 넘어간 다음의 침묵이면 no_cue 다. 단서는 마지막 문장에서 찾는다.',
  '판정 편향: 확신이 없으면 cue=false 로 차단한다. 화면을 보라는 말이 분명할 때만 통과시킨다.',
  `JSON 한 줄만 출력: {"cue": true|false, "reason": "<${Object.values(SILENCE_REASON_MAP).join('·')} 중 하나>"}`,
].join('\n');

const SILENCE_FEW_SHOT_LIST = [
  { input: { transcript: '여러분, 이 사진을 한번 보시죠.', silenceMs: 7000 },
    output: { cue: true, reason: SILENCE_REASON_MAP.presenting } },
  { input: { transcript: '말로 설명하는 것보다 보시는 게 빠를 것 같아요. 잠시 이 영상 같이 보겠습니다.', silenceMs: 6000 },
    output: { cue: true, reason: SILENCE_REASON_MAP.presenting } },
  { input: { transcript: '이상으로 발표를 마치겠습니다. 감사합니다.', silenceMs: 7000 },
    output: { cue: false, reason: SILENCE_REASON_MAP.ending } },
  { input: { transcript: '그래서 이게 왜 중요하냐면, 음…', silenceMs: 5000 },
    output: { cue: false, reason: SILENCE_REASON_MAP.hesitation } },
  { input: { transcript: '작년 매출은 120억이었습니다.', silenceMs: 6000 },
    output: { cue: false, reason: SILENCE_REASON_MAP.noCue } },
  { input: { transcript: '여기까지 궁금한 점 있으시면 편하게 말씀해 주세요.', silenceMs: 8000 },
    output: { cue: false, reason: SILENCE_REASON_MAP.noCue } },
  { input: { transcript: '이 사진 잠깐 보시죠. 네, 그래서 다음 분기 목표는 매출 200억입니다.', silenceMs: 6000 },
    output: { cue: false, reason: SILENCE_REASON_MAP.noCue } },
  { input: { transcript: '현장 반응이 궁금하실 텐데요, 담당자 목소리를 직접 들어 보시죠.', silenceMs: 6000 },
    output: { cue: false, reason: SILENCE_REASON_MAP.noCue } },
  { input: { transcript: 'We moved the loading dock last month. Take a look at the floor plan here.', silenceMs: 8000 },
    output: { cue: true, reason: SILENCE_REASON_MAP.presenting } },
  { input: { transcript: "A few customers dropped out early. I'll look into why that happened.", silenceMs: 7000 },
    output: { cue: false, reason: SILENCE_REASON_MAP.noCue } },
  { input: { transcript: "Okay, so the next item is, um, uh...", silenceMs: 6000 },
    output: { cue: false, reason: SILENCE_REASON_MAP.hesitation } },
];

function buildSilenceJudgeInput({ transcript, silenceMs }) {
  return [
    `침묵 직전 발화: "${transcript.trim()}"`,
    `침묵 길이: ${Math.round((silenceMs || 0) / 1000)}초`,
    '판정(JSON 한 줄):',
  ].join('\n');
}

module.exports = {
  SILENCE_REASON_MAP, SILENCE_JUDGE_SYSTEM_PROMPT, SILENCE_FEW_SHOT_LIST, buildSilenceJudgeInput,
};
