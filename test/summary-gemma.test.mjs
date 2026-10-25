import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildIntegrationInput, fitIntegrationInput } = require('../src/main/summary/integration-input.js');
const { createMeetingSummaryAgent } = require('../src/main/caption-pipeline/output/meeting-summary-agent.js');
const { createSummaryRewriteAgent } = require('../src/main/caption-pipeline/output/summary-rewrite-agent.js');
const { buildSummarySystemPrompt } = require('../src/main/caption-pipeline/prompts/meeting-summary.js');
const { buildSummaryRewriteSystemPrompt, buildSummaryRewriteInput } = require('../src/main/caption-pipeline/prompts/summary-rewrite.js');
const { VLM_PRIORITY_MAP } = require('../src/main/caption-pipeline/agents/shared/vlm-gateway.js');
const { readPipelineConfig } = require('../src/main/caption-pipeline/config.js');

const SUMMARY_MODULE_PATH_LIST = [
  '../src/main/summary/integration-input.js',
  '../src/main/caption-pipeline/output/meeting-summary-agent.js',
  '../src/main/caption-pipeline/output/summary-rewrite-agent.js',
  '../src/main/caption-pipeline/prompts/meeting-summary.js',
  '../src/main/caption-pipeline/prompts/summary-rewrite.js',
];

// 회의 스크립트를 재료로 하던 때의 한국어 요약 지시문. 재료 설명 줄 말고는 새 지시문에 그대로 남아야 한다.
const PREVIOUS_SUMMARY_PROMPT_LINE_LIST = [
  '너는 온라인 회의를 요약해 시각장애인 참석자에게 전달하는 역할이다.',
  '독자는 회의에 함께 있었지만 화면을 볼 수 없었다. 발표 자료에 무엇이 있었는지,',
  '그것을 두고 무슨 이야기가 오갔는지를 이어서 알려주는 것이 목적이다.',
  '재료는 회의 스크립트 한 건이다. 오간 말이 시간순으로 있고, 공유 화면이 바뀔 때마다',
  '그 화면을 한 줄로 설명한 줄("── … ──")이 끼어 있다.',
  '',
  '■ 형식 (반드시 지킨다)',
  '이 글은 파일로 저장되는 동시에 음성으로 합성되어 그대로 소리 내 읽힌다.',
  '따라서 눈으로만 이해되는 표현은 쓸 수 없다.',
  '  · 표를 만들지 마라. 세로줄(|)·괘선·칸 맞춤 공백을 쓰지 마라.',
  '  · 막대그래프나 도형 기호(●, ○, ■, ▲ 등)를 쓰지 마라.',
  '  · 마크다운을 쓰지 마라. 제목의 #, 강조의 **, 코드의 백틱 모두 금지다.',
  '    합성음은 이런 기호를 "별표별표"처럼 소리 내 읽는다.',
  '  · 표에 담긴 내용은 문장으로 풀어 쓴다.',
  '    예) "금융 부문이 42퍼센트로 가장 높고, 제조가 28퍼센트로 뒤를 잇는다."',
  '  · 숫자는 읽는 대로 쓴다. 42%보다 42퍼센트가 낫다.',
  '  · **영문 약어·상표는 한글로 음차해 쓴다.** 합성음이 라틴 문자를 어떻게 읽을지 보장되지 않는다.',
  '    NFT→엔에프티 · VR→브이알 · AR→에이알 · KPMG→케이피엠지 · R&D→연구개발',
  '    한글 표기가 어색한 고유명사는 그대로 두되, 약어는 반드시 음차한다.',
  '  · 각 항목은 그냥 줄을 바꿔 쓴다. 항목 앞에 기호를 붙이지 않는다.',
  '',
  '■ 구성 (이 순서대로)',
  '1. 개요 — 이 회의가 무엇에 대한 것이었는지 두세 문장.',
  '2. 다룬 주제 — 회의에서 다뤄진 주제를 세 개에서 다섯 개로.',
  '3. 슬라이드별 내용 — 화면에 나온 순서대로. 화면 설명 줄 하나가 화면 하나의 시작이다.',
  '   그 줄과 뒤이어 오간 말로 그 자료가 무엇을 말하고 있었는지를 적고, 발표자의 설명을 거기에 엮는다.',
  '   화면 묘사와 발화를 따로 늘어놓지 말고 한 이야기로 잇는다.',
  '   같은 슬라이드로 다시 돌아왔다면 그 사실을 밝힌다.',
  '4. 결정된 것과 앞으로 할 일 — 회의에서 정해진 것, 하기로 한 일.',
  '   정해진 것이 없으면 없다고 분명히 적는다.',
  '',
  '■ 설명 방식 (가장 중요하다)',
  '독자는 화면을 볼 수 없다. **자료가 무엇이었는지가 아니라, 그 자료가 말해주는 것을 적어라.**',
  '표·그래프·다이어그램은 그 자체가 아니라 **거기서 읽어낸 결론**이 내용이다.',
  '  · 자료를 목적어로 놓고 시작하지 마라.',
  '    나쁜 예) "시장 규모를 세 개의 그래프로 보여줬다. 첫째 그래프는…"',
  '    좋은 예) "메타버스 시장은 2020년 4787억 달러에서 2024년 7833억 달러로 4년 만에 1.6배가 된다."',
  '  · 화면의 배치·개수·위치를 말하지 마라. 볼 수 없는 사람에게는 쓸모가 없다.',
  '    "화면 왼쪽에", "위쪽은/아래쪽은", "표 두 개와 그림 하나가" 같은 표현을 쓰지 마라.',
  '  · 숫자는 나열하지 말고 **견주어** 말한다. 무엇이 가장 큰지, 얼마나 늘었는지, 몇 배인지.',
  '    나쁜 예) "금융 90퍼센트, 비금융 10퍼센트였다."',
  '    좋은 예) "지금은 금융이 90퍼센트로 사실상 전부지만, 앞으로 비금융이 그 자리를 나눠 갖는다."',
  '  · **단위는 자료에 적힌 그대로 쓴다.** 달러를 원으로, 원을 달러로 바꾸지 마라.',
  '    한 문장 안에서 단위가 달라지면 그 문장은 틀린 것이다. 견주어 말할 때도 단위를 맞춰라.',
  '  · 자료에서 읽어낸 수치를 어림해 바꾸지 마라. 배수·증감은 계산해도 되지만 원래 값은 그대로 둔다.',
  '  · 자료의 종류는 그것이 **의미를 바꿀 때만** 밝힌다.',
  '    (예: "발표자가 그 칸에 별표를 쳤다"는 강조라는 뜻이므로 적을 값어치가 있다.)',
  '  · 발표자가 그 자료로 무엇을 말하려 했는지가 핵심이다. 발화가 그 뜻을 알려주면 함께 엮어라.',
  '',
  '■ 분량 (이 기능의 이름이 "요약"이라는 점을 잊지 마라)',
  '  · 3번 슬라이드별 내용은 **슬라이드 한 장에 두세 문장**이다.',
  '    자료를 그대로 옮겨 적는 것이 아니라, 그 장에서 무엇이 중요했는지를 골라 적는다.',
  '  · **표의 모든 칸을 옮기지 마라.** 표에서는 전체 경향과 가장 중요한 값 한둘만 말한다.',
  '    나쁜 예) "원천기술 개발은 유형1과 유형2가 높고, 응용기술 개발은 유형1과 유형3이 높고, …"',
  '    좋은 예) "정책 우선순위 표에서 블록체인에 해당하는 유형4는 인프라 개선과 법제도 개선에',
  '             집중돼 있었다."',
  '  · 목록도 전부 나열하지 마라. 항목 수를 말하고 대표적인 것 두셋만 든다.',
  '  · 발표자가 강조한 것, 발화로 실제 논의된 것을 우선한다.',
  '    화면에만 있고 아무도 언급하지 않은 세부 항목은 과감히 버린다.',
  '  · 1·2·4번은 지금 길이 그대로가 적당하다. 줄일 곳은 3번이다.',
  '',
  '■ 태도',
  '  · 자료에 없는 내용을 지어내지 마라. 발화가 불분명하면 단정하지 말고 그렇다고 적어라.',
  '  · 전사는 음성인식 결과라 오탈자가 있다. 문맥으로 알아볼 수 있으면 바로잡아 읽어라.',
  '  · 스크립트에서 누가 말했는지는 지웠다. "누가 말했다"고 쓰지 마라.',
  '  · 인사말·잡담처럼 회의 내용이 아닌 것은 넣지 마라.',
  '',
  '요약본 본문만 출력한다. 머리말이나 설명을 덧붙이지 마라.',
];
const PREVIOUS_MATERIAL_LINE_LIST = [
  '재료는 회의 스크립트 한 건이다. 오간 말이 시간순으로 있고, 공유 화면이 바뀔 때마다',
  '그 화면을 한 줄로 설명한 줄("── … ──")이 끼어 있다.',
  '3. 슬라이드별 내용 — 화면에 나온 순서대로. 화면 설명 줄 하나가 화면 하나의 시작이다.',
  '   그 줄과 뒤이어 오간 말로 그 자료가 무엇을 말하고 있었는지를 적고, 발표자의 설명을 거기에 엮는다.',
];
const NEW_MATERIAL_LINE_LIST = [
  '재료는 회의를 시간순으로 나눈 구간 요약 목록이다.',
  '구간마다 머리 줄에 시각·슬라이드와 그 화면 설명이 있다.',
  '3. 슬라이드별 내용 — 화면에 나온 순서대로. 구간 머리 줄 하나가 화면 하나의 시작이다.',
  '   그 화면 설명과 구간 요약으로 그 자료가 무엇을 말하고 있었는지를 적고, 발표자의 설명을 거기에 엮는다.',
];
// 영어 요약 지시문이 빼는 한국어 낭독용 규칙 줄(meeting-summary.js 의 KOREAN_READING_RULE_PATTERN 과 같다).
const KOREAN_READING_RULE_PATTERN = /음차|엔에프티|한글 표기|퍼센트/;

function assertSubsequence({ expectedLineList, actualLineList, label }) {
  let cursor = 0;
  for (const line of expectedLineList) {
    const foundIndex = actualLineList.indexOf(line, cursor);
    assert.ok(foundIndex >= 0, `${label}: 줄이 빠졌거나 순서가 바뀌었다 — ${JSON.stringify(line)}`);
    cursor = foundIndex + 1;
  }
}

function summarySegment({ slideMajor, startTs, endTs, isRevisit = false, text, status = 'ready' }) {
  return { key: `${slideMajor ?? 'none'}@${startTs}`, slideMajor, startTs, endTs, isRevisit, text, status };
}

const meetingSnapshot = {
  startedAt: 0,
  slideList: [
    { major: 3, displayNumber: 3, label: { title: '매출 라벨', summary: '' } },
    { major: 5, displayNumber: 5, label: { title: '출시 일정', summary: '' } },
    { major: 7, displayNumber: null, label: null },
  ],
  transitionList: [
    { ts: 61000, slideMajor: 3, text: '슬라이드 3: 분기 매출 막대그래프', isRevisit: false },
    { ts: 121000, slideMajor: 5, text: '취소된 전환의 해설', isRevisit: false },
    { ts: 241000, slideMajor: 3, text: '이전 슬라이드 3: 분기 매출', isRevisit: true },
  ],
  cancelledTransitionList: [{ slideMajor: 5, requestTs: 121000, transitionTs: 120500 }],
  utteranceList: [{ ts: 1000, text: '시작하겠습니다', speakerHint: '김지오', isSpeakerTracked: true }],
};

test('통합 입력: 구간마다 시각·슬라이드·화면 설명 머리 줄과 요약, 빈 요약은 뺀다', () => {
  const segmentSummaryList = [
    summarySegment({ slideMajor: 3, startTs: 240000, endTs: 300000, isRevisit: true, text: '매출 결론을 다시 짚었다.' }),
    summarySegment({ slideMajor: null, startTs: 0, endTs: 60000, text: '  회의 목적을 나눴다.  ' }),
    summarySegment({ slideMajor: 3, startTs: 60000, endTs: 120000, text: '매출이 두 배로 늘었다.' }),
    summarySegment({ slideMajor: 5, startTs: 120000, endTs: 180000, text: '출시는 다음 분기다.' }),
    summarySegment({ slideMajor: 9, startTs: 180000, endTs: 200000, text: '' }),
    summarySegment({ slideMajor: 7, startTs: 200000, endTs: 220000, text: '   ', status: 'failed' }),
    summarySegment({ slideMajor: 7, startTs: 220000, endTs: 240000, text: '참고 문서를 띄웠다.' }),
  ];

  assert.equal(buildIntegrationInput({ segmentSummaryList, snapshot: meetingSnapshot }), [
    '[00:00~01:00] 화면 없음',
    '회의 목적을 나눴다.',
    '',
    '[01:00~02:00] 슬라이드 3 — 슬라이드 3: 분기 매출 막대그래프',
    '매출이 두 배로 늘었다.',
    '',
    // 취소된 전환의 해설은 쓰지 않고 라벨 제목으로 채운다.
    '[02:00~03:00] 슬라이드 5 — 출시 일정',
    '출시는 다음 분기다.',
    '',
    // 요약이 빈 슬라이드 9 구간은 빠진다. 슬라이드 7 은 빈 조각과 이어진 조각이 한 묶음이라 시각이 빈 조각부터다.
    // 들은 번호가 없는 화면은 내부 번호를 슬라이드 번호처럼 쓰지 않는다. 해설도 라벨도 없으면 머리 줄은 화면까지만이다.
    '[03:20~04:00] 번호 없는 화면',
    '참고 문서를 띄웠다.',
    '',
    // 다시 온 구간도 그 화면을 처음 설명한 해설을 쓴다(복귀 고지는 주제만 짧게 말한다).
    '[04:00~05:00] 슬라이드 3 (다시 봄) — 슬라이드 3: 분기 매출 막대그래프',
    '매출 결론을 다시 짚었다.',
  ].join('\n'));
  assert.equal(buildIntegrationInput({ segmentSummaryList: [summarySegment({ slideMajor: 3, startTs: 0, endTs: 60000, text: '' })], snapshot: meetingSnapshot }), '');
});

const NO_SCREEN_SHARE_NOTICE = '이 회의에서는 공유 화면 전환이 감지되지 않았다. 화면 자료 없이 대화만 오갔다.';

test('통합 입력: 같은 방문을 시간으로 끊은 이어진 조각은 머리 줄 하나에 본문 여러 줄로 합친다', () => {
  const pieceList = [
    summarySegment({ slideMajor: 3, startTs: 60000, endTs: 360000, text: '매출이 두 배로 늘었다.' }),
    summarySegment({ slideMajor: 3, startTs: 360000, endTs: 660000, text: '원인은 해외 판매다.' }),
    summarySegment({ slideMajor: 3, startTs: 660000, endTs: 780000, text: '다음 분기 목표를 정했다.' }),
  ];
  assert.equal(buildIntegrationInput({ segmentSummaryList: pieceList, snapshot: meetingSnapshot }), [
    '[01:00~13:00] 슬라이드 3 — 슬라이드 3: 분기 매출 막대그래프',
    '매출이 두 배로 늘었다.',
    '원인은 해외 판매다.',
    '다음 분기 목표를 정했다.',
  ].join('\n'));

  // 가운데 조각의 요약이 비어도 앞뒤 조각은 한 묶음이고, 빈 조각은 본문에 줄을 남기지 않는다.
  const withEmptyPieceList = [pieceList[0], { ...pieceList[1], text: '', status: 'failed' }, pieceList[2]];
  assert.equal(buildIntegrationInput({ segmentSummaryList: withEmptyPieceList, snapshot: meetingSnapshot }), [
    '[01:00~13:00] 슬라이드 3 — 슬라이드 3: 분기 매출 막대그래프',
    '매출이 두 배로 늘었다.',
    '다음 분기 목표를 정했다.',
  ].join('\n'));
});

test('통합 입력: 사이에 다른 슬라이드가 끼면 합치지 않는다', () => {
  const input = buildIntegrationInput({
    snapshot: meetingSnapshot,
    segmentSummaryList: [
      summarySegment({ slideMajor: 3, startTs: 60000, endTs: 120000, text: '매출이 늘었다.' }),
      summarySegment({ slideMajor: 5, startTs: 120000, endTs: 180000, text: '출시는 다음 분기다.' }),
      summarySegment({ slideMajor: 3, startTs: 180000, endTs: 240000, text: '매출 이야기를 마무리했다.' }),
    ],
  });
  assert.equal(input, [
    '[01:00~02:00] 슬라이드 3 — 슬라이드 3: 분기 매출 막대그래프',
    '매출이 늘었다.',
    '',
    '[02:00~03:00] 슬라이드 5 — 출시 일정',
    '출시는 다음 분기다.',
    '',
    '[03:00~04:00] 슬라이드 3 — 슬라이드 3: 분기 매출 막대그래프',
    '매출 이야기를 마무리했다.',
  ].join('\n'));
});

test('통합 입력: 같은 슬라이드라도 다시 온 방문이나 시각이 이어지지 않는 조각은 합치지 않는다', () => {
  const revisitInput = buildIntegrationInput({
    snapshot: meetingSnapshot,
    segmentSummaryList: [
      summarySegment({ slideMajor: 3, startTs: 60000, endTs: 120000, text: '매출이 늘었다.' }),
      summarySegment({ slideMajor: 3, startTs: 120000, endTs: 180000, isRevisit: true, text: '결론을 다시 짚었다.' }),
    ],
  });
  assert.equal(revisitInput, [
    '[01:00~02:00] 슬라이드 3 — 슬라이드 3: 분기 매출 막대그래프',
    '매출이 늘었다.',
    '',
    '[02:00~03:00] 슬라이드 3 (다시 봄) — 슬라이드 3: 분기 매출 막대그래프',
    '결론을 다시 짚었다.',
  ].join('\n'));

  const gapInput = buildIntegrationInput({
    snapshot: meetingSnapshot,
    segmentSummaryList: [
      summarySegment({ slideMajor: 3, startTs: 60000, endTs: 120000, text: '매출이 늘었다.' }),
      summarySegment({ slideMajor: 3, startTs: 125000, endTs: 180000, text: '결론을 짚었다.' }),
    ],
  });
  assert.equal(gapInput.split('\n').filter((line) => line.startsWith('[')).length, 2, gapInput);
});

test('통합 입력: 슬라이드 구간이 없으면 맨 앞에 화면 공유가 없었다고 알리고 시간 조각을 한 묶음으로 합친다', async () => {
  const segmentSummaryList = [
    summarySegment({ slideMajor: null, startTs: 0, endTs: 300000, text: '회의 목적을 나눴다.' }),
    summarySegment({ slideMajor: null, startTs: 300000, endTs: 600000, text: '일정을 맞췄다.' }),
    summarySegment({ slideMajor: null, startTs: 600000, endTs: 660000, text: '다음 회의 날짜를 정했다.' }),
  ];
  const snapshot = { startedAt: 0, slideList: [], transitionList: [] };
  const expected = [
    NO_SCREEN_SHARE_NOTICE,
    '',
    '[00:00~11:00] 화면 없음',
    '회의 목적을 나눴다.',
    '일정을 맞췄다.',
    '다음 회의 날짜를 정했다.',
  ].join('\n');
  assert.equal(buildIntegrationInput({ segmentSummaryList, snapshot }), expected);
  assert.deepEqual(
    await fitIntegrationInput({ segmentSummaryList, snapshot, language: 'ko', maxChars: expected.length, reduce: async () => assert.fail('줄이지 않는다') }),
    { text: expected, isTruncated: false },
  );

  // 슬라이드 구간이 있었다면 그 요약이 비었어도 안내 줄을 두지 않는다. 요약이 모두 비면 안내 줄도 없다.
  const withEmptySlideList = [...segmentSummaryList, summarySegment({ slideMajor: 3, startTs: 660000, endTs: 720000, text: '' })];
  assert.ok(!buildIntegrationInput({ segmentSummaryList: withEmptySlideList, snapshot }).includes(NO_SCREEN_SHARE_NOTICE));
  assert.equal(buildIntegrationInput({ segmentSummaryList: segmentSummaryList.map((segment) => ({ ...segment, text: '' })), snapshot }), '');

  // 한 시간 동안 화면이 없던 회의: 합친 블록이 묶음 한도보다 길어 조각 단위 묶음으로 나눠 필요한 만큼만 줄인다.
  // 줄인 뒤에도 같은 방문이라 머리 줄은 하나이고, 안내 줄은 맨 앞에 남는다.
  const hourPieceList = Array.from({ length: 12 }, (_, index) => summarySegment({
    slideMajor: null, startTs: index * 300000, endTs: (index + 1) * 300000, text: '가'.repeat(200),
  }));
  const reduceTextList = [];
  const fitted = await fitIntegrationInput({
    segmentSummaryList: hourPieceList, snapshot, language: 'ko', maxChars: 2000,
    reduce: async ({ text }) => {
      reduceTextList.push(text);
      return { text: `십 분 요약 ${reduceTextList.length}.` };
    },
  });
  // 조각 두 개씩이 묶음 재료다. 머리 줄 시각이 가장 긴 마지막 묶음이 가장 길어 먼저 줄이고, 그다음은 맨 앞 묶음이다.
  assert.deepEqual(reduceTextList, [
    `[50:00~1:00:00] 화면 없음\n${'가'.repeat(200)}\n${'가'.repeat(200)}`,
    `[00:00~10:00] 화면 없음\n${'가'.repeat(200)}\n${'가'.repeat(200)}`,
  ]);
  assert.deepEqual(fitted, {
    text: [
      NO_SCREEN_SHARE_NOTICE,
      '',
      '[00:00~1:00:00] 화면 없음',
      '십 분 요약 2.',
      ...Array.from({ length: 8 }, () => '가'.repeat(200)),
      '십 분 요약 1.',
    ].join('\n'),
    isTruncated: false,
  });
});

function buildLongMeeting({ segmentCount }) {
  const slideList = Array.from({ length: segmentCount }, (_, index) => ({ major: index + 1, displayNumber: index + 1, label: null }));
  const segmentSummaryList = slideList.map((slide, index) => summarySegment({
    slideMajor: slide.major, startTs: index * 60000, endTs: (index + 1) * 60000, text: '가'.repeat(40),
  }));
  return { snapshot: { startedAt: 0, slideList, transitionList: [] }, segmentSummaryList };
}

const headLineListOf = (text) => text.split('\n').filter((line) => line.startsWith('['));

test('통합 입력: maxChars 를 넘으면 가장 긴 묶음부터 하나씩, 넘지 않을 만큼만 reduce 로 줄인다', async () => {
  const { snapshot, segmentSummaryList } = buildLongMeeting({ segmentCount: 20 });
  const fullText = buildIntegrationInput({ segmentSummaryList, snapshot });
  const neverReduce = async () => assert.fail('maxChars 안이면 줄이지 않는다');
  assert.deepEqual(
    await fitIntegrationInput({ segmentSummaryList, snapshot, language: 'ko', maxChars: fullText.length, reduce: neverReduce }),
    { text: fullText, isTruncated: false },
  );

  const reduceCallList = [];
  const fitted = await fitIntegrationInput({
    segmentSummaryList, snapshot, language: 'en', maxChars: 800,
    reduce: async ({ text, language }) => {
      reduceCallList.push({ text, language });
      return { text: `줄인 요약 ${reduceCallList.length}` };
    },
  });

  assert.ok(fullText.length > 800);
  assert.equal(fitted.isTruncated, false);
  assert.ok(fitted.text.length <= 800, `${fitted.text.length}자`);
  // 20 구간은 200자 이하 묶음 일곱 개다. 슬라이드 번호가 두 자리인 묶음이 길어 먼저 줄이고, 넷을 줄이면 800자 안이다.
  assert.equal(reduceCallList.length, 4, '모든 묶음을 줄이지 않는다');
  for (const call of reduceCallList) {
    assert.ok(call.text.length <= 200, `묶음 ${call.text.length}자`);
    assert.equal(call.language, 'en');
  }
  assert.ok(reduceCallList[0].text.startsWith('[09:00~10:00] 슬라이드 10\n'), '묶음 재료는 구간 머리 줄과 요약 그대로다');
  assert.ok(reduceCallList[0].text.includes('[11:00~12:00] 슬라이드 12\n'));
  // 줄인 묶음은 묶인 구간 전체의 시각과 슬라이드를 머리 줄로 달고, 줄이지 않은 구간은 그대로 남는다.
  assert.ok(fitted.text.includes('[09:00~12:00] 슬라이드 10, 슬라이드 11, 슬라이드 12\n줄인 요약 1\n\n'), fitted.text);
  assert.ok(fitted.text.includes(`[03:00~04:00] 슬라이드 4\n${'가'.repeat(40)}`), fitted.text);
  assert.ok(fitted.text.endsWith(`[19:00~20:00] 슬라이드 20\n${'가'.repeat(40)}`), fitted.text);
});

test('통합 입력: 24,000자를 조금 넘는 입력은 묶음 한두 개만 줄인다', async () => {
  const slideList = Array.from({ length: 45 }, (_, index) => ({ major: index + 1, displayNumber: index + 1, label: null }));
  const segmentSummaryList = slideList.map((slide, index) => summarySegment({
    slideMajor: slide.major, startTs: index * 60000, endTs: (index + 1) * 60000, text: '가'.repeat(520),
  }));
  const snapshot = { startedAt: 0, slideList, transitionList: [] };
  const fullText = buildIntegrationInput({ segmentSummaryList, snapshot });
  assert.ok(fullText.length > 24000 && fullText.length < 25000, `${fullText.length}자`);

  const reduceTextList = [];
  const fitted = await fitIntegrationInput({
    segmentSummaryList, snapshot, language: 'ko',
    reduce: async ({ text }) => {
      reduceTextList.push(text);
      return { text: '여러 화면을 줄인 요약.' };
    },
  });
  assert.ok(reduceTextList.length >= 1 && reduceTextList.length <= 2, `${reduceTextList.length}번 줄였다`);
  assert.ok(reduceTextList.every((text) => text.length <= 6000));
  assert.equal(fitted.isTruncated, false);
  assert.ok(fitted.text.length <= 24000);
  assert.ok(headLineListOf(fitted.text).length >= 34, '줄이지 않은 구간 머리 줄이 대부분 남는다');
});

test('통합 입력: 한 화면에 아주 오래 머문 방문은 조각 단위 묶음으로 줄이고 머리 줄은 하나로 남긴다', async () => {
  // 슬라이드 3 을 여섯 시간 띄워 둔 회의. 5분 조각 72개가 한 방문이라 블록 하나가 4만 자를 넘는다.
  const pieceList = Array.from({ length: 72 }, (_, index) => summarySegment({
    slideMajor: 3, startTs: 60000 + index * 300000, endTs: 60000 + (index + 1) * 300000, text: '나'.repeat(590),
  }));
  assert.ok(buildIntegrationInput({ segmentSummaryList: pieceList, snapshot: meetingSnapshot }).length > 40000);

  const reduceTextList = [];
  const fitted = await fitIntegrationInput({
    segmentSummaryList: pieceList, snapshot: meetingSnapshot, language: 'ko',
    reduce: async ({ text }) => {
      reduceTextList.push(text);
      return { text: `오십 분 요약 ${reduceTextList.length}.` };
    },
  });
  assert.ok(reduceTextList.length >= 1);
  for (const text of reduceTextList) {
    assert.ok(text.length <= 6000, `한 번 줄이는 입력 ${text.length}자`);
    assert.equal(headLineListOf(text).length, 1, '묶음 재료도 그 방문의 머리 줄 하나다');
    assert.match(headLineListOf(text)[0], / 슬라이드 3 — 슬라이드 3: 분기 매출 막대그래프$/);
  }
  assert.equal(fitted.isTruncated, false);
  assert.ok(fitted.text.length <= 24000, `${fitted.text.length}자`);
  assert.deepEqual(headLineListOf(fitted.text), ['[01:00~6:01:00] 슬라이드 3 — 슬라이드 3: 분기 매출 막대그래프']);
  assert.ok(fitted.text.includes('오십 분 요약 1.'));
});

test('통합 입력: 줄인 묶음에 화면이 하나뿐이면 머리 줄에 그 화면 설명을 남긴다', async () => {
  // 슬라이드 3 과 다시 본 슬라이드 3 이 한 묶음, 나머지는 슬라이드 5·7 이 번갈아 나온다.
  const segmentSummaryList = [
    summarySegment({ slideMajor: 3, startTs: 60000, endTs: 120000, text: 'ㄱ'.repeat(60) }),
    summarySegment({ slideMajor: 3, startTs: 120000, endTs: 180000, isRevisit: true, text: 'ㄴ'.repeat(60) }),
    ...Array.from({ length: 10 }, (_, index) => summarySegment({
      slideMajor: index % 2 ? 7 : 5, startTs: 180000 + index * 60000, endTs: 240000 + index * 60000, text: 'ㄷ'.repeat(60),
    })),
  ];
  const reduceTextList = [];
  const fitted = await fitIntegrationInput({
    segmentSummaryList, snapshot: meetingSnapshot, language: 'ko', maxChars: 880,
    reduce: async ({ text }) => {
      reduceTextList.push(text);
      return { text: `줄인 요약 ${reduceTextList.length}` };
    },
  });
  assert.equal(reduceTextList.length, 2);
  assert.ok(fitted.text.startsWith(
    '[01:00~03:00] 슬라이드 3, 슬라이드 3 (다시 봄) — 슬라이드 3: 분기 매출 막대그래프\n줄인 요약 1\n\n',
  ), fitted.text);
  assert.ok(fitted.text.includes('[03:00~05:00] 슬라이드 5, 번호 없는 화면\n줄인 요약 2\n\n'), '화면이 둘이면 설명을 달지 않는다');
});

test('통합 입력: 줄여도 넘치면 앞에서부터 maxChars 까지 자르고 isTruncated', async () => {
  const { snapshot, segmentSummaryList } = buildLongMeeting({ segmentCount: 20 });
  const fullText = buildIntegrationInput({ segmentSummaryList, snapshot });

  // 줄인 글이 묶음보다 길거나 비면 그 묶음의 구간 요약을 그대로 두고, 묶음마다 한 번씩만 묻는다.
  for (const reducedText of ['나'.repeat(300), '']) {
    let reduceCount = 0;
    const fitted = await fitIntegrationInput({
      segmentSummaryList, snapshot, language: 'ko', maxChars: 800,
      reduce: async () => {
        reduceCount += 1;
        return { text: reducedText };
      },
    });
    assert.equal(reduceCount, 7, JSON.stringify(reducedText.slice(0, 3)));
    assert.deepEqual(fitted, { text: fullText.slice(0, 800), isTruncated: true });
  }

  // 모든 묶음을 줄여도 모자라면 묶음 수의 두 배까지만 묻고 자른다.
  // 150자의 4분의 1(37자)보다 구간 하나가 길어 구간마다 한 묶음(20개)이다.
  let reduceCount = 0;
  const fitted = await fitIntegrationInput({
    segmentSummaryList, snapshot, language: 'ko', maxChars: 150,
    reduce: async () => {
      reduceCount += 1;
      return { text: '줄인 요약' };
    },
  });
  assert.equal(reduceCount, 40);
  assert.equal(fitted.isTruncated, true);
  assert.equal(fitted.text.length, 150);
  assert.ok(fitted.text.startsWith('[00:00~01:00] 슬라이드 1\n줄인 요약\n\n[01:00~02:00] 슬라이드 2\n줄인 요약'), fitted.text);
});

test('요약 에이전트: 배경 순위·maxTokens 6000 으로 묻고 finish_reason length 면 isTruncated', async () => {
  const config = { vlmUrl: 'http://gpu.test/v1/chat/completions', vlmModel: 'gemma' };
  const requestList = [];
  let nextResponse = { content: '```\n개요\n매출이 늘었다.\n```', finishReason: 'length' };
  const agent = createMeetingSummaryAgent({
    config,
    requestCompletion: async (request) => {
      requestList.push(request);
      if (nextResponse instanceof Error) throw nextResponse;
      return nextResponse;
    },
  });
  const integrationText = '[00:00~01:00] 슬라이드 1 — 분기 매출\n매출이 늘었다.';

  assert.deepEqual(await agent.summarize({ integrationText, language: 'ko' }), { text: '개요\n매출이 늘었다.', isTruncated: true });
  const [request] = requestList;
  assert.equal(request.config, config);
  assert.equal(request.priority, VLM_PRIORITY_MAP.background);
  assert.equal(request.maxTokens, 6000);
  assert.equal(request.timeoutMs, 240000);
  assert.equal(request.temperature, 0.2);
  assert.equal(typeof request.label, 'string');
  assert.equal(request.prompt, `${buildSummarySystemPrompt({ language: 'ko' })}\n\n${integrationText}`);

  nextResponse = { content: '  Overview\nRevenue grew.  ', finishReason: 'stop' };
  assert.deepEqual(await agent.summarize({ integrationText, language: 'en' }), { text: 'Overview\nRevenue grew.', isTruncated: false });
  assert.equal(requestList.at(-1).prompt, `${buildSummarySystemPrompt({ language: 'en' })}\n\n${integrationText}`);

  for (const emptyContent of ['   ', '```\n```', undefined, null]) {
    nextResponse = { content: emptyContent, finishReason: 'stop' };
    await assert.rejects(agent.summarize({ integrationText }), /비어 있습니다/, `${emptyContent} 는 오류다`);
  }
  nextResponse = new Error('VLM(회의 요약) HTTP 503');
  await assert.rejects(agent.summarize({ integrationText }), /HTTP 503/);
});

test('재작성 에이전트: 실패하면 초안을 그대로 돌려준다', async (t) => {
  const warnMock = t.mock.method(console, 'warn', () => {});
  const config = { vlmUrl: 'http://gpu.test/v1/chat/completions', vlmModel: 'gemma' };
  const requestList = [];
  let nextResponse = { content: '```\n다듬은 개요\n```', finishReason: 'stop' };
  const agent = createSummaryRewriteAgent({
    config,
    requestCompletion: async (request) => {
      requestList.push(request);
      if (nextResponse instanceof Error) throw nextResponse;
      return nextResponse;
    },
  });
  const draftText = '개요\n매출이 늘었다.';

  assert.deepEqual(await agent.rewrite({ draftText, isTruncated: false, language: 'ko' }), {
    text: '다듬은 개요', isTruncated: false, isRewritten: true,
  });
  const [request] = requestList;
  assert.equal(request.config, config);
  assert.equal(request.priority, VLM_PRIORITY_MAP.background);
  assert.equal(request.maxTokens, 6000);
  assert.equal(request.timeoutMs, 240000);
  assert.equal(request.temperature, 0.2);
  assert.equal(typeof request.label, 'string');
  assert.equal(request.prompt, `${buildSummaryRewriteSystemPrompt({ language: 'ko' })}\n\n${buildSummaryRewriteInput({ draftText, language: 'ko' })}`);

  nextResponse = { content: 'Polished overview', finishReason: 'length' };
  assert.deepEqual(await agent.rewrite({ draftText, isTruncated: false, language: 'en' }), {
    text: 'Polished overview', isTruncated: true, isRewritten: true,
  });
  assert.equal(requestList.at(-1).prompt, `${buildSummaryRewriteSystemPrompt({ language: 'en' })}\n\n${buildSummaryRewriteInput({ draftText, language: 'en' })}`);
  assert.equal(warnMock.mock.callCount(), 0);

  for (const failure of [new Error('VLM(회의 요약 재구성) HTTP 503'), { content: '  ', finishReason: 'stop' }, { content: undefined, finishReason: null }]) {
    nextResponse = failure;
    assert.deepEqual(await agent.rewrite({ draftText, isTruncated: true, language: 'ko' }), {
      text: draftText, isTruncated: true, isRewritten: false,
    });
  }
  assert.equal(warnMock.mock.callCount(), 3, '실패마다 초안을 쓴다고 남긴다');
});

test('요약 지시문: 재료 설명 줄만 바뀌고 형식·구성·설명 방식 줄은 그대로다', () => {
  const keptLineList = PREVIOUS_SUMMARY_PROMPT_LINE_LIST.filter((line) => !PREVIOUS_MATERIAL_LINE_LIST.includes(line));
  assert.equal(keptLineList.length, PREVIOUS_SUMMARY_PROMPT_LINE_LIST.length - PREVIOUS_MATERIAL_LINE_LIST.length);

  const koreanLineList = buildSummarySystemPrompt({ language: 'ko' }).split('\n');
  assertSubsequence({ expectedLineList: keptLineList, actualLineList: koreanLineList, label: '한국어' });
  assert.equal(koreanLineList.length, PREVIOUS_SUMMARY_PROMPT_LINE_LIST.length, '줄을 더하거나 빼지 않는다');
  for (const line of PREVIOUS_MATERIAL_LINE_LIST) assert.ok(!koreanLineList.includes(line), `옛 재료 설명이 남았다 — ${line}`);
  assertSubsequence({ expectedLineList: NEW_MATERIAL_LINE_LIST, actualLineList: koreanLineList, label: '새 재료 설명' });
  // 재료 설명은 옛 줄이 있던 자리에 들어간다.
  for (const [index, line] of NEW_MATERIAL_LINE_LIST.entries()) {
    assert.equal(koreanLineList.indexOf(line), PREVIOUS_SUMMARY_PROMPT_LINE_LIST.indexOf(PREVIOUS_MATERIAL_LINE_LIST[index]));
  }

  const englishLineList = buildSummarySystemPrompt({ language: 'en' }).split('\n');
  assertSubsequence({
    expectedLineList: keptLineList.filter((line) => !KOREAN_READING_RULE_PATTERN.test(line)),
    actualLineList: englishLineList,
    label: '영어',
  });
  assertSubsequence({ expectedLineList: NEW_MATERIAL_LINE_LIST, actualLineList: englishLineList, label: '영어 새 재료 설명' });
  for (const line of PREVIOUS_MATERIAL_LINE_LIST) assert.ok(!englishLineList.includes(line), `영어에 옛 재료 설명이 남았다 — ${line}`);
});

test('요약·재작성 모듈은 bedrock-converse 를 require 하지 않고 config 에 summaryModelId 가 없다', () => {
  for (const modulePath of SUMMARY_MODULE_PATH_LIST) {
    const source = fs.readFileSync(new URL(modulePath, import.meta.url), 'utf8');
    assert.ok(!source.includes('bedrock-converse'), `${modulePath} 가 bedrock-converse 를 쓴다`);
  }
  const loadedBedrockList = Object.keys(require.cache).filter((modulePath) => modulePath.includes('bedrock-converse'));
  assert.deepEqual(loadedBedrockList, [], '요약 모듈을 불러도 bedrock-converse 가 따라 불리지 않는다');

  const config = readPipelineConfig({ SEEON_BEDROCK_SUMMARY_MODEL_ID: 'opus', SEEON_BEDROCK_SUMMARY_REWRITE_MODEL_ID: 'sonnet' });
  assert.ok(!('summaryModelId' in config));
  assert.ok(!('summaryRewriteModelId' in config));
  const configSource = fs.readFileSync(new URL('../src/main/caption-pipeline/config.js', import.meta.url), 'utf8');
  assert.ok(!configSource.includes('DEFAULT_SUMMARY_MODEL_ID'));
  assert.ok(!configSource.includes('SEEON_BEDROCK_SUMMARY'));
});
