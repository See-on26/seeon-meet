import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpeakerTimeline } from '../src/renderer/core/trigger/speaker-timeline.js';

test('전사 조각 구간에 가장 오래 말한 사람을 고른다 (조각 끝의 화자가 아니라)', () => {
  const timeline = new SpeakerTimeline();
  timeline.record({ wallTs: 1000, name: '김지오' });
  timeline.record({ wallTs: 4500, name: '이수민' });
  assert.equal(timeline.resolveDominant({ startTs: 1000, endTs: 5000 }), '김지오');
  assert.equal(timeline.resolveDominant({ startTs: 4000, endTs: 8000 }), '이수민');
});

test('아무도 한 사람으로 정해지지 않은 구간은 null', () => {
  const timeline = new SpeakerTimeline();
  timeline.record({ wallTs: 1000, name: null });
  assert.equal(timeline.resolveDominant({ startTs: 1000, endTs: 3000 }), null);
  timeline.record({ wallTs: 2000, name: '김지오' });
  assert.equal(timeline.resolveDominant({ startTs: 1000, endTs: 3000 }), '김지오');
});

test('같은 이름이 이어지면 표본을 늘리지 않고, 오래된 표본은 보관 시간 뒤에 버린다', () => {
  const timeline = new SpeakerTimeline({ retentionMs: 10000 });
  timeline.record({ wallTs: 0, name: '김지오' });
  timeline.record({ wallTs: 500, name: '김지오' });
  assert.equal(timeline.sampleList.length, 1);
  timeline.record({ wallTs: 1000, name: '이수민' });
  timeline.record({ wallTs: 20000, name: null });
  assert.deepEqual(timeline.sampleList.map((sample) => sample.name), ['이수민', null]);
});

test('잘못된 구간이나 초기화 뒤에는 null', () => {
  const timeline = new SpeakerTimeline();
  timeline.record({ wallTs: 1000, name: '김지오' });
  assert.equal(timeline.resolveDominant({ startTs: 5000, endTs: 1000 }), null);
  timeline.reset();
  assert.equal(timeline.resolveDominant({ startTs: 1000, endTs: 5000 }), null);
});

test('화자 식별을 끈 동안 이름 없음으로 기록하면 그 구간에는 화자가 붙지 않는다', () => {
  const timeline = new SpeakerTimeline();
  timeline.record({ wallTs: 1000, name: '김지오' });
  timeline.record({ wallTs: 2000, name: null });
  assert.equal(timeline.resolveDominant({ startTs: 2000, endTs: 6000 }), null);
});
