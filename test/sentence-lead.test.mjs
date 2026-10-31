import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptWindow } from '../src/renderer/core/trigger/transcript-window.js';

function makeWindow(entryList) {
  const transcriptWindow = new TranscriptWindow({});
  for (const [text, ts] of entryList) transcriptWindow.push({ text, ts });
  return transcriptWindow;
}

test('트리거 앞에서 문장이 안 끝난 조각을 순서대로 모으고 종결 어미에서 멈춘다', () => {
  const transcriptWindow = makeWindow([
    ['매출 얘기는 여기까지입니다', 1000],
    ['보시는 것처럼', 3500],
    ['단기 수시 연봉 조정 내용을', 6000],
    ['5배', 8500],
  ]);
  assert.equal(transcriptWindow.getOpenSentenceLead({ nowTs: 8500 }), '보시는 것처럼 단기 수시 연봉 조정 내용을');
});

test('가장 최근 조각은 트리거 자신이라 앞 조각에 넣지 않는다', () => {
  const transcriptWindow = makeWindow([['여기를 보시면', 1000]]);
  assert.equal(transcriptWindow.getOpenSentenceLead({ nowTs: 1000 }), '');
});

test('직전 조각이 문장 끝이면 앞 조각이 없다', () => {
  const transcriptWindow = makeWindow([['다음 장으로 넘어가겠습니다', 1000], ['이 부분이', 3500]]);
  assert.equal(transcriptWindow.getOpenSentenceLead({ nowTs: 3500 }), '');
});

test('앞 조각은 최대 조각 수까지만 모은다', () => {
  const transcriptWindow = makeWindow([
    ['첫째로', 1000], ['둘째로', 2000], ['셋째로', 3000], ['넷째로', 4000], ['이거', 5000],
  ]);
  assert.equal(transcriptWindow.getOpenSentenceLead({ nowTs: 5000, maxEntryCount: 2 }), '셋째로 넷째로');
});

test('시간 창보다 오래된 조각은 같은 문장으로 묶지 않는다', () => {
  const transcriptWindow = makeWindow([['오래전에 하던 말인데', 1000], ['방금 한 말', 9000], ['이거', 10000]]);
  assert.equal(transcriptWindow.getOpenSentenceLead({ nowTs: 10000, windowMs: 8000 }), '방금 한 말');
});

test('nowTs 보다 늦게 들어온 조각은 보지 않는다', () => {
  const transcriptWindow = makeWindow([['보시는 것처럼', 1000], ['이 부분', 2000], ['나중 조각', 5000]]);
  assert.equal(transcriptWindow.getOpenSentenceLead({ nowTs: 2000 }), '보시는 것처럼');
});

test('직전 판정에서 이미 쓴 조각은 다음 트리거의 앞 조각으로 다시 가져오지 않는다', () => {
  const transcriptWindow = makeWindow([
    ['이 부분을 보시면', 1000],
    ['매출이 두 배로 늘었고', 3700],
    ['이게 핵심인데', 5500],
  ]);
  const lastDecidedAt = 4000;
  assert.equal(transcriptWindow.getOpenSentenceLead({ nowTs: 5500, sinceTs: lastDecidedAt }), '');
  assert.equal(transcriptWindow.getOpenSentenceLead({ nowTs: 5500 }), '이 부분을 보시면 매출이 두 배로 늘었고');
});

test('직전 판정 뒤에 들어온 조각만 앞 조각으로 모은다', () => {
  const transcriptWindow = makeWindow([
    ['이 부분을 보시면', 1000], ['매출이 늘었고', 4500], ['이게 핵심인데', 6000],
  ]);
  assert.equal(transcriptWindow.getOpenSentenceLead({ nowTs: 6000, sinceTs: 4000 }), '매출이 늘었고');
});
