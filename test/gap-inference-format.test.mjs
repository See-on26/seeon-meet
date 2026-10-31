import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { formatGapLine, selectFallbackGapIndex, BOUNDARY_KIND_MAP, GAP_SYSTEM_PROMPT } = require('../src/main/caption-pipeline/output/gap-inference-agent.js');

const baseGap = { offsetMs: 1200, kind: 'complete', silenceMs: 600, beforeText: '올랐습니다', afterText: '다음은' };

test('ASR 후보 줄은 지금 형식 그대로다', () => {
  assert.equal(formatGapLine({ gap: baseGap, index: 0 }),
    '[0] +1.2초 · 앞 발화 "올랐습니다" · 끝맺음=완결 · 무음 0.6초 · 뒤 발화 "다음은"');
});

test('소리로 잰 후보는 무음에 잰 값 표시, 아직 이어지는 무음은 ≥ 로 적는다', () => {
  assert.equal(formatGapLine({ gap: { ...baseGap, source: 'audio' }, index: 1 }),
    '[1] +1.2초 · 앞 발화 "올랐습니다" · 끝맺음=완결 · 무음 0.6초(잰 값) · 뒤 발화 "다음은"');
  assert.equal(formatGapLine({ gap: { ...baseGap, source: 'audio', isOpen: true, kind: 'unknown', beforeText: '', afterText: '' }, index: 2 }),
    '[2] +1.2초 · 앞 발화 "(없음)" · 끝맺음=미상(받아쓰기 전) · 무음 ≥0.6초(잰 값) · 뒤 발화 "(없음)"');
});

test('잰 무음·미상 설명은 그런 후보가 있을 때만 입력에 붙고, ASR 후보만이면 입력과 시스템 프롬프트가 그대로다', () => {
  const { buildGapInput } = require('../src/main/caption-pipeline/output/gap-inference-agent.js');
  const request = { narrationText: '표를 보는 중', narrationType: 'deixis' };
  const asrInput = buildGapInput({ ...request, gapList: [baseGap] });
  assert.doesNotMatch(asrInput, /참고:/);
  assert.doesNotMatch(GAP_SYSTEM_PROMPT, /잰 값|미상/);
  assert.match(buildGapInput({ ...request, gapList: [{ ...baseGap, source: 'audio' }] }), /참고: 무음에 "\(잰 값\)"/);
  assert.match(buildGapInput({ ...request, gapList: [{ ...baseGap, kind: 'unknown' }] }), /참고: 끝맺음=미상/);
  assert.equal(BOUNDARY_KIND_MAP.unknown, 'unknown');
});

test('규칙 폴백은 미상보다 완결을 고른다', () => {
  const gapList = [
    { ...baseGap, offsetMs: 200, kind: 'unknown' },
    { ...baseGap, offsetMs: 1500, kind: 'complete' },
  ];
  assert.equal(selectFallbackGapIndex({ gapList }), 1);
});

test('후보 출처 수를 센다(출처가 없는 후보는 ASR 로 센다)', () => {
  const { countGapCandidateSource } = require('../src/main/caption-pipeline/output/gap-inference-agent.js');
  assert.deepEqual(countGapCandidateSource({ gapList: [{ source: 'audio' }, { source: 'asr' }, {}, { source: 'audio' }] }),
    { audio: 2, asr: 2 });
});
