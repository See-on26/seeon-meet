import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectDeixis, DeixisDetector, ACTIVE_KIND_LIST, DEIXIS_KIND_MAP,
} from '../src/renderer/core/trigger/deixis-detector.js';

function fire(text) {
  const eventList = [];
  const detector = new DeixisDetector({ onDeixis: (event) => eventList.push(event) });
  detector.handleTranscript({ text, captureTs: 10000 });
  return eventList[0] || null;
}

test('색상지시는 활성 종류다', () => {
  assert.ok(ACTIVE_KIND_LIST.includes(DEIXIS_KIND_MAP.color));
});

test('지시어 없이 색으로만 가리키는 발화를 잡는다', () => {
  assert.equal(fire('빨간 쪽이 저희 회사입니다').kind, DEIXIS_KIND_MAP.color);
  assert.equal(fire('파란색 선을 보면 확실히 다르죠').kind, DEIXIS_KIND_MAP.color);
  assert.equal(fire('노란 거는 작년 수치예요').kind, DEIXIS_KIND_MAP.color);
  assert.equal(fire('붉은 막대가 올해입니다').kind, DEIXIS_KIND_MAP.color);
});

test('지시어가 함께 있으면 지시대명사가 먼저다', () => {
  assert.equal(fire('이 빨간 막대가 올해입니다').kind, DEIXIS_KIND_MAP.demonstrative);
});

test('색 뒤에 지시 대상이 없는 관용 표현은 잡지 않는다', () => {
  assert.equal(fire('요즘 매출에 빨간불이 켜졌어요'), null);
});

test('비활성 종류가 먼저 걸려도 뒤의 활성 종류를 탐지한다', () => {
  const event = fire('가장 많이 늘었습니다');
  assert.equal(event.kind, DEIXIS_KIND_MAP.data);
  assert.equal(event.trigger, '늘었');
});

test('활성 종류가 하나도 안 걸리면 null', () => {
  assert.equal(fire('첫 번째 항목입니다'), null);
});

test('activeKindSet 없이 부르면 모든 종류를 기존 순서로 검사한다', () => {
  assert.equal(detectDeixis('첫 번째 항목입니다').kind, DEIXIS_KIND_MAP.ordinal);
});
