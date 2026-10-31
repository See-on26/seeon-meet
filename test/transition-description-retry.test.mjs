import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hasCompleteTailNoun } = require('../src/main/caption-pipeline/agents/shared/narration-format.js');
const { createPageTransitionAgent, parsePageTransitionText } = require('../src/main/caption-pipeline/agents/page-transition-agent.js');

// 실험실 전환 351개 중 14개가 "묘사가 완결되지 않아" 버려졌다. 3개는 끝 마침표 때문("…막대 그래프."),
// 11개는 묘사가 12~19어절로 길어 자료 명사 앞에서 잘렸다(시나리오 D 첫 장 4번).
test('끝 문장부호가 붙어도 자료 명사로 끝난 묘사는 완결로 본다', () => {
  assert.equal(hasCompleteTailNoun({ text: '지역별 수익을 비교한 막대 그래프.' }), true);
  assert.equal(hasCompleteTailNoun({ text: '평가 구조를 설명하는 문서."' }), true);
  const parsed = parsePageTransitionText(JSON.stringify({ screenType: 'ppt', description: '지역별 수익을 북쪽 42%, 남쪽 31%, 서쪽 27%로 비교한 막대 그래프.' }));
  assert.equal(parsed.narration, '지역별 수익을 북쪽 42%, 남쪽 31%, 서쪽 27%로 비교한 막대 그래프');
});

const vlmConfig = { vlmUrl: 'http://x', vlmModel: 'm' };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const LONG = '2014년부터 인프라 구축을 위한 시범 사업 및 실증 사업 시행 중 현황을 정리한 슬라이드';

function mockVlmSequence(descriptionList) {
  const promptList = [];
  globalThis.fetch = async (_url, option) => {
    const body = JSON.parse(option.body);
    promptList.push(JSON.stringify(body.messages));
    const description = descriptionList[Math.min(promptList.length - 1, descriptionList.length - 1)];
    const content = JSON.stringify({ screenType: 'ppt', pageTopic: '국내 개발 현황', description });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  return promptList;
}

test('묘사가 길어 완결되지 않으면 한 번만 짧게 다시 묻고, 쓸 만하면 그것을 고지한다', async () => {
  const promptList = mockVlmSequence([LONG, '국내 C-ITS 시범 사업 현황을 정리한 지도']);
  const result = await createPageTransitionAgent({ config: vlmConfig }).generate({ jpegBuffer: Buffer.from('x'), ts: 1, minWordCount: 6, maxWordCount: 9 });
  assert.equal(promptList.length, 2);
  assert.match(promptList[1], /14어절로 길다/);
  assert.match(promptList[1], /9어절 이내/);
  assert.equal(result.narration, '국내 C-ITS 시범 사업 현황을 정리한 지도');
  assert.equal(result.isRetried, true);
});

test('다시 물어도 완결되지 않으면 처음 답으로 버린다', async () => {
  const promptList = mockVlmSequence([LONG, LONG]);
  const result = await createPageTransitionAgent({ config: vlmConfig }).generate({ jpegBuffer: Buffer.from('x'), ts: 1, minWordCount: 6, maxWordCount: 9 });
  assert.equal(promptList.length, 2);
  assert.equal(result.narration, '');
  assert.equal(result.rejectedReason, 'incomplete');
  assert.equal(result.rejectedRawDescription, LONG);
});

test('처음 답이 쓸 만하면 다시 묻지 않는다', async () => {
  const promptList = mockVlmSequence(['국내 개발 현황을 설명하는 지도']);
  const result = await createPageTransitionAgent({ config: vlmConfig }).generate({ jpegBuffer: Buffer.from('x'), ts: 1, minWordCount: 6, maxWordCount: 9 });
  assert.equal(promptList.length, 1);
  assert.equal(result.narration, '국내 개발 현황을 설명하는 지도');
  assert.equal(result.isRetried, false);
});
