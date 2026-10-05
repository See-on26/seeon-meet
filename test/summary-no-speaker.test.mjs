import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildSummaryInput } = require('../src/main/caption-pipeline/output/meeting-summary-agent.js');
const { buildSummarySystemPrompt } = require('../src/main/caption-pipeline/prompts/meeting-summary.js');

// 화자 정보는 회의 요약에 쓰지 않는다. 발화에 이름이 붙어 있어도 요약 입력에는 발화만 적는다.
test('요약 입력에는 발화에 붙은 화자 이름을 적지 않는다', () => {
  const input = buildSummaryInput({ slideSectionList: [{
    major: '3', title: '분기 매출', bodyText: '막대그래프',
    utteranceList: [{ ts: 1000, text: '매출이 두 배로 늘었습니다', speakerHint: '김지오' }],
  }] });
  assert.match(input, /^ {2}매출이 두 배로 늘었습니다$/m);
  assert.doesNotMatch(input, /김지오/);
});

test('요약 프롬프트는 누가 말했는지 쓰지 않게 한다', () => {
  assert.match(buildSummarySystemPrompt(), /"누가 말했다"고 쓰지 마라/);
});
