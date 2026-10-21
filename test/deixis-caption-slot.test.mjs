import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assembleNarration, getSlotList } = require('../src/main/caption-pipeline/agents/shared/narration-format.js');
const { buildGroundingPrompt } = require('../src/main/caption-pipeline/prompts/deixis-resolution.js');
const { createDeixisResolutionAgent } = require('../src/main/caption-pipeline/agents/deixis-resolution-agent.js');
const { createNarrationHistory } = require('../src/main/caption-pipeline/orchestrator/narration-history.js');

// 지시 해설은 가리킨 대상의 이름·내용(caption)만 읽는다. "보는 중" 같은 상황 칸은 청자에게 정보가 아니라 두지 않는다.
// seen 은 가리킨 곳에 보이는 것을 먼저 옮겨 적게 하는 근거 칸이고 읽히지 않는다.
const deixis = (subKind, rawSlotMap) => assembleNarration({ narrationType: 'deixis', subKind, rawSlotMap });

test('지시 칸은 단순형·완전형 모두 seen(근거, 읽지 않음) + caption 이고, caption 상한은 예전 칸 합(7·10어절)과 같다', () => {
  for (const [subKind, maxWordCount] of [['simple', 7], ['complete', 10]]) {
    const slotList = getSlotList({ narrationType: 'deixis', subKind });
    assert.deepEqual(slotList.map((slot) => slot.key), ['seen', 'caption'], subKind);
    assert.equal(slotList[0].isDiagnostic, true, subKind);
    assert.equal(slotList[1].minWordCount, 2, subKind);
    assert.equal(slotList[1].maxWordCount, maxWordCount, subKind);
  }
});

test('지시 해설은 caption 만 읽고 동작 말을 붙이지 않으며, caption 이 비면 만들지 않는다', () => {
  for (const subKind of ['simple', 'complete']) {
    assert.equal(deixis(subKind, { seen: '분기별 매출 비교 표, 1분기 120억', caption: '분기별 매출 비교 표' }).text, '분기별 매출 비교 표', subKind);
    assert.equal(deixis(subKind, { seen: '빈 배경', caption: '' }), null, subKind);
  }
  const result = deixis('simple', { seen: '신청 마감 20일까지', caption: '신청 마감 20일까지' });
  assert.equal(result.text, '신청 마감 20일까지');
  assert.equal(result.slotMap.situation, undefined);
});

// 상황 칸("보는 중")이 빠진 뒤 caption 끝에 목적격 조사가 남으면 "…추이 표를"처럼 말이 끊겨 들린다.
test('지시 caption 끝 어절의 목적격 조사(을/를)는 떼고, 낱말의 일부인 "을"은 남긴다', () => {
  assert.equal(deixis('simple', { seen: '2년간 매출 추이 표', caption: '2년간 매출 추이 표를' }).text, '2년간 매출 추이 표');
  assert.equal(deixis('simple', { seen: '본관 앞 석탑', caption: '본관 앞 삼층 석탑을' }).text, '본관 앞 삼층 석탑');
  assert.equal(deixis('complete', { seen: '매출 표, 인원 그래프', caption: '매출 표, 인원 그래프를' }).text, '매출 표, 인원 그래프');
  for (const caption of ['바닷가 작은 마을', '붉게 물든 저녁노을', '지난해 가을']) {
    assert.equal(deixis('simple', { seen: caption, caption }).text, caption, caption);
  }
});

test('지시 caption 이 상한을 넘으면 끝을 맺을 수 있는 데서 자른다', () => {
  const caption = '본관 1층 안내 데스크, 2층 회의실, 3층 강당과 4층 식당이 표시된 층별 안내도';
  const text = deixis('simple', { seen: '층별 안내도', caption }).text;
  assert.ok(text.split(' ').length <= 7, text);
  assert.ok(caption.startsWith(text), text);
});

test('지시 프롬프트는 이미 안내된 해설 목록을 모델에 보이지 않는다', () => {
  for (const subKind of ['simple', 'complete']) {
    const describedElementList = ['슬라이드 2: 지점별 매출 현황', '북부 지점 막대'];
    const prompt = buildGroundingPrompt({ utterance: '여기 보시면', maxChars: 60, subKind, describedElementList });
    assert.equal(prompt, buildGroundingPrompt({ utterance: '여기 보시면', maxChars: 60, subKind }), subKind);
    assert.doesNotMatch(prompt, /이미 안내|지점별 매출 현황|북부 지점 막대/, subKind);
  }
});

test('지시 프롬프트에는 상황 칸·발화 모사·문장 칸이 없고 seen·caption 출력 칸을 안내한다', () => {
  for (const subKind of ['simple', 'complete']) {
    for (const language of ['ko', 'en']) {
      const prompt = buildGroundingPrompt({ utterance: '여기 보시면', maxChars: 60, subKind, language });
      assert.doesNotMatch(prompt, /situation|mimicry|"sentence"|explanation|상황 슬롯|상황 묘사|발화 모사/, `${subKind}/${language}`);
      assert.match(prompt, /"seen":/, `${subKind}/${language}`);
      assert.match(prompt, /"caption":/, `${subKind}/${language}`);
    }
  }
  assert.match(buildGroundingPrompt({ utterance: '이거랑 이거', maxChars: 60, subKind: 'complete' }), /대상을 둘 이상 가리켰다/);
  assert.doesNotMatch(buildGroundingPrompt({ utterance: '여기 보시면', maxChars: 60, subKind: 'simple' }), /대상을 둘 이상 가리켰다/);
  assert.match(buildGroundingPrompt({ utterance: '여기 보시면', maxChars: 60, subKind: 'simple' }), /보는 중.*같은 동작 말을 붙이지 않는다/);
});

// 규칙 (4)는 화면 문구를 그대로 쓰고 새 낱말을 만들지 말라고 한다. 형식 예시의 caption 도 seen 에 있는 낱말로만 쓴다.
test('지시 형식 예시의 caption 은 seen 에 있는 낱말로만 쓴다', () => {
  const { DEIXIS_FORM_RULE_MAP } = require('../src/main/caption-pipeline/prompts/deixis-resolution.js');
  const exampleList = Object.values(DEIXIS_FORM_RULE_MAP).flat()
    .map((line) => line.match(/seen="([^"]*)", caption="([^"]*)"/)).filter(Boolean);
  assert.ok(exampleList.length >= 3);
  const toWordList = (text) => text.split(/[\s,·]+/).filter(Boolean);
  for (const [, seen, caption] of exampleList) {
    const seenWordSet = new Set(toWordList(seen));
    for (const word of toWordList(caption)) assert.ok(seenWordSet.has(word), `caption 낱말 "${word}" 이 seen("${seen}")에 없다`);
  }
});

test('지시 에이전트는 이미 안내된 해설 목록을 받아도 요청 프롬프트에 넣지 않는다', async () => {
  const originalFetch = globalThis.fetch;
  const promptList = [];
  globalThis.fetch = async (_url, option) => {
    promptList.push(JSON.parse(option.body).messages[0].content.find((item) => item.type === 'text').text);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"seen":"북부 지점 막대","caption":"북부 지점 매출 막대"}' } }] }) };
  };
  try {
    const result = await createDeixisResolutionAgent({ config: { vlmUrl: 'http://x', vlmModel: 'm' } }).generate({
      jpegBuffer: Buffer.from('x'), utterance: '여기 보시면', subKind: 'simple', describedElementList: ['슬라이드 2: 지점별 매출 현황'],
    });
    assert.equal(result.text, '북부 지점 매출 막대');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.doesNotMatch(promptList[0], /지점별 매출 현황/);
});

// 목록을 모델에 주지 않으므로 같은 대상의 겹친 해설은 재생 전 중복 거르기가 맡는다. 지시 해설은 caption 이 대상 칸이다.
test('중복 거르기: 지시 해설은 caption 의 낱말로 같은 슬라이드의 같은 대상을 거른다', () => {
  const history = createNarrationHistory({});
  history.remember({
    text: '북부 지점 매출 막대', source: 'deixis', ts: 100, slideLabel: '3', slotMap: { seen: '북부 지점', caption: '북부 지점 매출 막대' },
  });
  const incoming = { text: '북부 지점 1분기 실적과 2분기 실적 비교 막대그래프 자료', source: 'deixis' };
  const sameSlide = history.findDuplicate({ ...incoming, slideLabel: '3', slotMap: { caption: '북부 지점 실적 막대그래프' } });
  assert.equal(sameSlide.isDuplicate, true);
  assert.equal(sameSlide.reason, 'same-target');
  assert.equal(history.findDuplicate({ ...incoming, slideLabel: '4', slotMap: { caption: '북부 지점 실적 막대그래프' } }).isDuplicate, false);
});
