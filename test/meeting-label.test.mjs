import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMeetingLabel } from '../src/renderer/core/archive/meeting-label.js';

const startedAt = new Date(2026, 9, 5, 14, 30).getTime();

test('지난 회의 항목은 날짜·시각·제목·길이·요약 여부를 한 줄로 읽는다', () => {
  assert.equal(formatMeetingLabel({ meeting: {
    startedAt, endedAt: startedAt + 42 * 60_000, title: '분기 매출 · 채용 계획', hasSummary: true,
  } }), '10월 5일 오후 2시 30분 회의, 분기 매출 · 채용 계획, 42분, 요약 있음');
});

test('제목·끝난 시각이 없고 요약이 없으면 그만큼 줄여 읽는다', () => {
  assert.equal(formatMeetingLabel({ meeting: { startedAt: new Date(2026, 9, 5, 9, 5).getTime(), hasSummary: false } }),
    '10월 5일 오전 9시 5분 회의, 요약 없음');
});

test('요약 글이 없으면 요약 상태로 만드는 중·실패·없음을 읽는다', () => {
  const meeting = { startedAt: new Date(2026, 9, 5, 9, 5).getTime(), hasSummary: false };
  assert.equal(formatMeetingLabel({ meeting: { ...meeting, summaryStatus: 'pending' } }), '10월 5일 오전 9시 5분 회의, 요약 만드는 중');
  assert.equal(formatMeetingLabel({ meeting: { ...meeting, summaryStatus: 'failed' } }), '10월 5일 오전 9시 5분 회의, 요약 실패');
  for (const summaryStatus of [null, undefined, 'done', 'toString']) {
    assert.equal(formatMeetingLabel({ meeting: { ...meeting, summaryStatus } }), '10월 5일 오전 9시 5분 회의, 요약 없음', String(summaryStatus));
  }
  assert.equal(formatMeetingLabel({ meeting: { ...meeting, hasSummary: true, summaryStatus: 'pending' } }),
    '10월 5일 오전 9시 5분 회의, 요약 있음', '요약 글이 있으면 글이 먼저다');
});
