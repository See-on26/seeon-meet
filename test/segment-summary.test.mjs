import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildSegmentMaterial, hasSegmentContent } = require('../src/main/caption-pipeline/context/segment-material.js');
const { buildSegmentSummaryPrompt } = require('../src/main/caption-pipeline/prompts/segment-summary.js');
const { createSegmentSummaryAgent } = require('../src/main/caption-pipeline/output/segment-summary-agent.js');
const { VLM_PRIORITY_MAP } = require('../src/main/caption-pipeline/agents/shared/vlm-gateway.js');
const { OUTPUT_LANGUAGE_RULE_MAP } = require('../src/main/caption-pipeline/prompts/output-language-rule.js');

const SEGMENT_MODULE_PATH_LIST = [
  '../src/main/caption-pipeline/context/segment-material.js',
  '../src/main/caption-pipeline/prompts/segment-summary.js',
  '../src/main/caption-pipeline/output/segment-summary-agent.js',
];

function slide(overrideMap = {}) {
  return {
    major: 3, displayNumber: 3, visitList: [], pageTopic: '', description: '', slideText: '', label: null,
    ...overrideMap,
  };
}

function segment(overrideMap = {}) {
  return { key: '3@60000', slideMajor: 3, startTs: 60000, endTs: 120000, isRevisit: false, isOpenTail: false, ...overrideMap };
}

test('구간 재료: 구간 안의 발화·해설·질문답만 담고 화자 이름은 뺀다', () => {
  const snapshot = {
    startedAt: 0,
    slideList: [slide({ pageTopic: '분기 매출' })],
    utteranceList: [
      { ts: 59999, text: '앞 화면 이야기입니다', speakerHint: '김지오', isSpeakerTracked: true },
      { ts: 60000, text: '매출이 늘었습니다', speakerHint: '김지오', isSpeakerTracked: true },
      { ts: 90000, text: '다음 분기에 출시합니다', speakerHint: '김지오', isSpeakerTracked: true },
      { ts: 120000, text: '다음 장으로 넘어가죠', speakerHint: '김지오', isSpeakerTracked: true },
    ],
    narrationList: [
      { ts: 61000, text: '김지오 님 발언', narrationClass: 'speaker_identity' },
      { ts: 70000, text: '표의 둘째 줄은 12퍼센트입니다', narrationClass: 'deixis' },
      { ts: 80500, text: '질문 답이 해설에 섞인 글', narrationClass: 'user_command' },
      { ts: 150000, text: '구간 밖 해설', narrationClass: 'deixis' },
    ],
    qaList: [
      { ts: 80000, question: '몇 퍼센트야?', answer: '둘째 줄 값은 12퍼센트입니다', route: 'past_slide', slideMajorList: [3] },
      { ts: 200000, question: '구간 밖 질문', answer: '구간 밖 답', route: 'past_slide', slideMajorList: [3] },
    ],
  };
  const material = buildSegmentMaterial({ snapshot, segment: segment() });

  assert.match(material, /\[01:00~02:00\]/);
  assert.match(material, /슬라이드 3/);
  assert.match(material, /화면 주제: 분기 매출/);
  assert.ok(material.includes('매출이 늘었습니다'), '구간 시작 시각의 발화는 담는다');
  assert.ok(material.includes('다음 분기에 출시합니다'));
  assert.ok(!material.includes('앞 화면 이야기입니다'), '구간 앞 발화는 뺀다');
  assert.ok(!material.includes('다음 장으로 넘어가죠'), '구간 끝 시각의 발화는 다음 구간 것이다');
  assert.ok(!material.includes('김지오'), '화자 이름과 화자 안내 해설은 뺀다');
  assert.ok(material.includes('표의 둘째 줄은 12퍼센트입니다'));
  assert.ok(!material.includes('질문 답이 해설에 섞인 글'), '해설 목록의 질문 답은 해설로 담지 않는다');
  assert.ok(!material.includes('구간 밖 해설'));
  assert.ok(material.includes('몇 퍼센트야?'));
  assert.ok(material.includes('둘째 줄 값은 12퍼센트입니다'));
  assert.ok(!material.includes('구간 밖 질문'));
  assert.ok(!material.includes('다시 돌아온'), '처음 온 구간에는 다시 온 표시가 없다');

  const revisitMaterial = buildSegmentMaterial({ snapshot, segment: segment({ isRevisit: true }) });
  assert.match(revisitMaterial, /슬라이드 3 \(앞에서 본 화면으로 다시 돌아온 구간\)/);
});

test('구간 재료: 화면 묘사가 없으면 라벨, 그것도 없으면 screenFillByMajorMap 한 줄', () => {
  const screenFillByMajorMap = new Map([['3', '회의 뒤에 텍스트로 바꾼 화면 한 줄']]);
  const label = { title: '매출 추이', keywordList: ['매출'], summary: '매출이 두 분기 연속 늘었다' };
  const build = (slideOverrideMap) => buildSegmentMaterial({
    snapshot: { startedAt: 0, slideList: [slide(slideOverrideMap)], utteranceList: [], narrationList: [], qaList: [] },
    segment: segment(),
    screenFillByMajorMap,
  });

  const described = build({ description: '막대그래프 두 개가 있다', label });
  assert.match(described, /화면 묘사: 막대그래프 두 개가 있다/);
  assert.match(described, /라벨 제목: 매출 추이/);
  assert.ok(!described.includes('회의 뒤에 텍스트로 바꾼 화면 한 줄'), '묘사가 있으면 채움 줄을 쓰지 않는다');

  const labelled = build({ label });
  assert.ok(!labelled.includes('화면 묘사'));
  assert.match(labelled, /라벨 제목: 매출 추이/);
  assert.match(labelled, /라벨 요약: 매출이 두 분기 연속 늘었다/);
  assert.ok(!labelled.includes('회의 뒤에 텍스트로 바꾼 화면 한 줄'), '라벨이 있으면 채움 줄을 쓰지 않는다');

  const filled = build({ slideText: '가'.repeat(2000) });
  assert.match(filled, /회의 뒤에 텍스트로 바꾼 화면 한 줄/);
  assert.ok(filled.includes(`화면 글자: ${'가'.repeat(1500)}\n`), '화면 글자는 1,500자까지만 담는다');
  assert.ok(!filled.includes('가'.repeat(1501)));

  const bare = buildSegmentMaterial({
    snapshot: { startedAt: 0, slideList: [slide({ displayNumber: null })], utteranceList: [] },
    segment: segment(),
  });
  assert.match(bare, /번호 없는 화면/, '들은 번호가 없으면 내부 번호를 슬라이드 번호처럼 쓰지 않는다');
  assert.match(bare, /화면 정보: \(없음\)/);
  assert.match(bare, /오간 말:\n\(없음\)/);

  const noScreen = buildSegmentMaterial({
    snapshot: { startedAt: 0, slideList: [], utteranceList: [{ ts: 1000, text: '시작하겠습니다' }] },
    segment: segment({ key: 'none@0', slideMajor: null, startTs: 0, endTs: 60000 }),
  });
  assert.match(noScreen, /\[00:00~01:00\]/);
  assert.match(noScreen, /화면: 공유 화면 없음/);
  assert.ok(noScreen.includes('시작하겠습니다'));
});

test('구간 재료 유무: 발화·해설·질문답이 없고 화면 정보도 없으면 재료가 없다', () => {
  const emptySnapshot = { startedAt: 0, slideList: [slide()], utteranceList: [], narrationList: [], qaList: [] };
  assert.equal(hasSegmentContent({ snapshot: emptySnapshot, segment: segment() }), false);
  assert.equal(hasSegmentContent({ snapshot: { startedAt: 0 }, segment: segment() }), false, '목록이 없는 스냅숏도 받는다');
  assert.equal(hasSegmentContent({
    snapshot: { startedAt: 0, slideList: [], utteranceList: [] },
    segment: segment({ key: 'none@0', slideMajor: null, startTs: 0, endTs: 60000 }),
  }), false, '화면 없는 구간에 말이 없으면 재료가 없다');

  // 구간 밖 기록·해설 칸에서 빼는 해설(화자 안내·질문 답)은 재료가 아니다.
  const outsideSnapshot = {
    ...emptySnapshot,
    utteranceList: [{ ts: 59999, text: '앞 구간 말' }, { ts: 120000, text: '다음 구간 말' }],
    narrationList: [
      { ts: 61000, text: '김지오 님 발언', narrationClass: 'speaker_identity' },
      { ts: 62000, text: '질문 답', narrationClass: 'user_command' },
    ],
    qaList: [{ ts: 130000, question: '구간 밖 질문', answer: '' }],
  };
  assert.equal(hasSegmentContent({ snapshot: outsideSnapshot, segment: segment() }), false);

  const withList = [
    ['발화', { utteranceList: [{ ts: 60000, text: '매출이 늘었습니다' }] }],
    ['해설', { narrationList: [{ ts: 70000, text: '표의 둘째 줄은 12퍼센트입니다', narrationClass: 'deixis' }] }],
    ['질문답', { qaList: [{ ts: 80000, question: '몇 퍼센트야?', answer: '' }] }],
    ['화면 주제', { slideList: [slide({ pageTopic: '분기 매출' })] }],
    ['화면 묘사', { slideList: [slide({ description: '막대그래프' })] }],
    ['화면 글자', { slideList: [slide({ slideText: '매출 12%' })] }],
    ['라벨', { slideList: [slide({ label: { title: '매출 추이', keywordList: [], summary: '' } })] }],
  ];
  for (const [label, overrideMap] of withList) {
    assert.equal(hasSegmentContent({ snapshot: { ...emptySnapshot, ...overrideMap }, segment: segment() }), true, label);
  }
  assert.equal(hasSegmentContent({
    snapshot: emptySnapshot, segment: segment(), screenFillByMajorMap: new Map([['3', '회의 뒤 텍스트화 한 줄']]),
  }), true, '회의 뒤 화면 정보 텍스트화 한 줄도 화면 정보다');
});

test('구간 요약 지시문: 지어내지 않기·값과 단위 그대로·NONE 규칙을 담고 영어면 영어 규칙을 붙인다', () => {
  const materialText = '구간: [01:00~02:00]\n오간 말:\n매출이 12퍼센트 늘었습니다';
  const prompt = buildSegmentSummaryPrompt({ materialText });

  assert.ok(prompt.includes(materialText));
  assert.match(prompt, /시각장애인 참석자/);
  assert.match(prompt, /3~5문장/);
  assert.match(prompt, /600자/);
  assert.match(prompt, /결론/);
  assert.match(prompt, /결정/);
  assert.match(prompt, /재료에 없는 내용·숫자를 쓰지 않는다/);
  assert.match(prompt, /값과 단위는 재료에 적힌 그대로/);
  assert.match(prompt, /누가 말했는지 쓰지 않는다/);
  assert.match(prompt, /마크다운/);
  assert.match(prompt, /정확히 NONE/);
  assert.ok(!prompt.includes(OUTPUT_LANGUAGE_RULE_MAP.en), '한국어 캡션에는 영어 규칙이 없다');

  const englishPrompt = buildSegmentSummaryPrompt({ materialText, language: 'en' });
  assert.ok(englishPrompt.includes(OUTPUT_LANGUAGE_RULE_MAP.en));
  assert.match(englishPrompt, /"NONE"은 번역하지 말고/);
  assert.ok(englishPrompt.indexOf(materialText) < englishPrompt.indexOf(OUTPUT_LANGUAGE_RULE_MAP.en));
});

test('구간 요약 에이전트: 배경 순위·maxTokens 400 으로 묻고 NONE 은 빈 글로 돌려준다', async () => {
  const config = { vlmUrl: 'http://gpu.test/v1/chat/completions', vlmModel: 'gemma' };
  const requestList = [];
  let nextContent = 'NONE';
  const agent = createSegmentSummaryAgent({
    config,
    requestCompletion: async (request) => {
      requestList.push(request);
      return { content: nextContent, finishReason: 'stop' };
    },
  });

  assert.deepEqual(await agent.summarize({ materialText: '재료 글', language: 'ko' }), { text: '' });
  const [request] = requestList;
  assert.equal(request.config, config);
  assert.equal(request.priority, VLM_PRIORITY_MAP.background);
  assert.equal(request.maxTokens, 400);
  assert.equal(request.timeoutMs, 60000);
  assert.equal(request.temperature, 0);
  assert.ok(request.prompt.includes('재료 글'));
  assert.equal(typeof request.label, 'string');

  for (const emptyContent of [
    'NONE.', '"NONE"', '`NONE`', '  ', undefined, null,
    '**NONE**', '(NONE)', 'None', 'None.', 'none', 'NONE: 인사만 오갔다', '```\nNONE\n```', '“NONE”',
  ]) {
    nextContent = emptyContent;
    assert.deepEqual(await agent.summarize({ materialText: '재료 글' }), { text: '' }, `${emptyContent} 는 빈 구간이다`);
  }

  // 답 전체를 감싼 따옴표·울타리는 벗기고, 글 안의 따옴표는 그대로 둔다.
  for (const [content, expected] of [
    ['"매출이 두 배로 늘었다."', '매출이 두 배로 늘었다.'],
    ['“매출이 두 배로 늘었다.”', '매출이 두 배로 늘었다.'],
    ["'매출이 두 배로 늘었다.'", '매출이 두 배로 늘었다.'],
    ['```\n매출이 두 배로 늘었다.\n```', '매출이 두 배로 늘었다.'],
    ['"AI 허브" 사업은 다음 분기에 시작한다.', '"AI 허브" 사업은 다음 분기에 시작한다.'],
    ['"A안"과 "B안" 가운데 "B안"', '"A안"과 "B안" 가운데 "B안"'],
  ]) {
    nextContent = content;
    assert.deepEqual(await agent.summarize({ materialText: '재료 글' }), { text: expected }, content);
  }

  nextContent = '  매출은 두 분기 연속 늘었다. 다음 분기에 출시하기로 했다.  ';
  assert.deepEqual(await agent.summarize({ materialText: '재료 글', language: 'en' }), {
    text: '매출은 두 분기 연속 늘었다. 다음 분기에 출시하기로 했다.',
  });
  assert.ok(requestList.at(-1).prompt.includes(OUTPUT_LANGUAGE_RULE_MAP.en), 'language 를 지시문에 넘긴다');

  for (const sentence of ['None of the figures changed.', '결과는 none 이었다.', '"None" was the answer they chose.']) {
    nextContent = sentence;
    assert.deepEqual(await agent.summarize({ materialText: '재료 글', language: 'en' }), {
      text: sentence,
    }, `none 한 단어가 아닌 문장은 요약이다: ${sentence}`);
  }

  const failingAgent = createSegmentSummaryAgent({
    config, requestCompletion: async () => { throw new Error('VLM(구간 요약) HTTP 503'); },
  });
  await assert.rejects(failingAgent.summarize({ materialText: '재료 글' }), /HTTP 503/);
});

test('구간 요약 모듈은 bedrock-converse 를 require 하지 않는다', () => {
  for (const modulePath of SEGMENT_MODULE_PATH_LIST) {
    const source = fs.readFileSync(new URL(modulePath, import.meta.url), 'utf8');
    assert.ok(!source.includes('bedrock-converse'), `${modulePath} 가 bedrock-converse 를 쓴다`);
  }
  const loadedBedrockList = Object.keys(require.cache).filter((modulePath) => modulePath.includes('bedrock-converse'));
  assert.deepEqual(loadedBedrockList, [], '세 모듈을 불러도 bedrock-converse 가 따라 불리지 않는다');
});
