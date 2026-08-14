import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildIntegrationInput } = require('../src/main/summary/integration-input.js');
const { buildSummarySystemPrompt } = require('../src/main/caption-pipeline/prompts/meeting-summary.js');
const { buildTranscriptScript } = require('../src/main/caption-pipeline/context/transcript-script.js');
const { toScreenFillText, buildSnapshotFromSession } = require('../src/main/summary/summary-generator.js');

const snapshot = {
  startedAt: 0,
  slideList: [{ major: 3, displayNumber: 3, hasTransition: true, visitList: [{ startTs: 500, endTs: null }] }],
  transitionList: [{ ts: 800, slideMajor: 3, text: '슬라이드 3: 분기 매출 막대그래프' }],
  utteranceList: [{ ts: 1000, text: '매출이 두 배로 늘었습니다', speakerHint: '김지오' }],
};

// 요약은 구간 요약을 모은 통합 입력을 바탕으로 하고, 화자 정보는 쓰지 않는다.
test('요약 입력은 화자 이름 없이 화면 설명 머리 줄과 구간 요약이다', () => {
  const input = buildIntegrationInput({
    snapshot,
    segmentSummaryList: [{ key: '3@500', slideMajor: 3, startTs: 500, endTs: 60500, isRevisit: false, text: '매출이 두 배로 늘었다.', status: 'ready' }],
  });
  assert.equal(input, '[00:00~01:00] 슬라이드 3 — 슬라이드 3: 분기 매출 막대그래프\n매출이 두 배로 늘었다.');
  assert.doesNotMatch(input, /김지오/);
});

test('화면 공유가 없던 회의는 대화만 오간 회의로 알려 준다', () => {
  const input = buildIntegrationInput({
    snapshot: { startedAt: 0, slideList: [], transitionList: [] },
    segmentSummaryList: [{ key: 'none@0', slideMajor: null, startTs: 0, endTs: 60000, isRevisit: false, text: '인사를 나눴다.', status: 'ready' }],
  });
  assert.equal(input, '이 회의에서는 공유 화면 전환이 감지되지 않았다. 화면 자료 없이 대화만 오갔다.\n\n[00:00~01:00] 화면 없음\n인사를 나눴다.');
});

test('요약 프롬프트는 구간 요약 목록을 재료로 하고 누가 말했는지 쓰지 않게 한다', () => {
  const prompt = buildSummarySystemPrompt();
  assert.match(prompt, /구간 요약 목록/);
  assert.match(prompt, /"누가 말했다"고 쓰지 마라/);
});

test('화면 정보 텍스트화 결과는 제목, 없으면 서술 첫 문장으로 한 줄이 된다', () => {
  assert.equal(toScreenFillText({ title: '분기 매출', bodyText: '막대그래프. 3분기가 가장 높다.' }), '분기 매출');
  assert.equal(toScreenFillText({ title: '', bodyText: '막대그래프다. 3분기가 가장 높다.' }), '막대그래프다.');
  assert.equal(toScreenFillText(null), '');
});

test('맥락 스냅숏이 없으면 세션 전사로 스크립트 재료를 만든다', () => {
  const built = buildSnapshotFromSession({ session: {
    startedAt: 0,
    asrEntryList: [{ ts: 2000, text: '안녕하세요 반갑습니다', speakerHint: '이수민',
      segmentList: [{ startSec: 0, endSec: 1, text: '안녕하세요' }, { startSec: 1, endSec: 2, text: '반갑습니다' }] }],
  } });
  assert.equal(buildTranscriptScript({ snapshot: built }), '[00:02] 이수민: 안녕하세요\n[00:03] 이수민: 반갑습니다');
});
