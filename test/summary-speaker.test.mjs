import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildSummaryInput } = require('../src/main/caption-pipeline/output/meeting-summary-agent.js');
const { buildSummarySystemPrompt } = require('../src/main/caption-pipeline/prompts/meeting-summary.js');
const { assignAsrToSlideList } = require('../src/main/summary/slide-timeline.js');

const slideSection = {
  major: '3', title: '분기 매출', bodyText: '막대그래프',
  utteranceList: [
    { ts: 1000, text: '매출이 두 배로 늘었습니다', speakerHint: '김지오' },
    { ts: 2000, text: '비용은 어떻게 됐나요', speakerHint: null },
  ],
};

test('요약 입력의 발화에 화자 이름이 있으면 "이름: 발화"로 적는다', () => {
  const input = buildSummaryInput({ slideSectionList: [slideSection] });
  assert.match(input, /^ {2}김지오: 매출이 두 배로 늘었습니다$/m);
});

test('화자 이름이 없는 발화는 발화만 적는다', () => {
  const input = buildSummaryInput({ slideSectionList: [slideSection] });
  assert.match(input, /^ {2}비용은 어떻게 됐나요$/m);
});

test('요약 프롬프트는 이름이 붙은 발화만 누가 말했는지 쓰게 한다', () => {
  const prompt = buildSummarySystemPrompt();
  assert.doesNotMatch(prompt, /발화자를 구분할 정보는 없다/);
  assert.match(prompt, /이름:/);
  assert.match(prompt, /이름이 없는 발화/);
});

test('세션 기록으로 요약할 때도 발화에 화자 이름을 넘긴다', () => {
  const slideList = assignAsrToSlideList({
    asrEntryList: [
      { ts: 1000, text: '첫 발화', segmentList: [], speakerHint: '김지오' },
      { ts: 3000, text: '둘째 발화', segmentList: [{ startSec: 0, endSec: 1, text: '둘째 발화' }], speakerHint: null },
    ],
    slideIntervalList: [{ major: '1', intervalList: [{ startTs: 0, endTs: 10000 }] }],
  });
  assert.deepEqual(slideList[0].utteranceList.map(({ text, speakerHint }) => ({ text, speakerHint })), [
    { text: '첫 발화', speakerHint: '김지오' },
    { text: '둘째 발화', speakerHint: null },
  ]);
});
