import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createContextStore, toSlideMajor, LABEL_STATUS_MAP } = require('../src/main/caption-pipeline/context/context-store.js');

function baseMark({ ts, slideLabel, filePath = `/tmp/${slideLabel}.jpg` }) {
  return { kind: 'slide_mark', ts, slideLabel, frameKind: 'base', filePath };
}

test('슬라이드 라벨에서 major 번호를 뽑는다', () => {
  assert.equal(toSlideMajor('3'), 3);
  assert.equal(toSlideMajor('3-27'), 3);
  assert.equal(toSlideMajor(''), null);
  assert.equal(toSlideMajor(null), null);
});

test('base 슬라이드 마크가 방문을 열고 이전 방문을 닫는다', () => {
  const store = createContextStore();
  store.applyRecord(baseMark({ ts: 1000, slideLabel: '1' }));
  store.applyRecord(baseMark({ ts: 5000, slideLabel: '2' }));
  assert.deepEqual(store.getSlide(1).visitList, [{ startTs: 1000, endTs: 5000 }]);
  assert.deepEqual(store.getSlide(2).visitList, [{ startTs: 5000, endTs: null }]);
  assert.equal(store.getCurrentSlideMajor(), 2);
  assert.equal(store.getSlide(1).imagePath, '/tmp/1.jpg');
});

test('재방문은 같은 항목에 방문을 더하고 첫 이미지를 유지한다', () => {
  const store = createContextStore();
  store.applyRecord(baseMark({ ts: 1000, slideLabel: '1' }));
  store.applyRecord(baseMark({ ts: 2000, slideLabel: '2' }));
  store.applyRecord(baseMark({ ts: 3000, slideLabel: '1', filePath: '/tmp/1-again.jpg' }));
  assert.equal(store.getSlide(1).visitList.length, 2);
  assert.equal(store.getSlide(1).imagePath, '/tmp/1.jpg');
});

test('주석 마크는 방문을 바꾸지 않는다', () => {
  const store = createContextStore();
  store.applyRecord(baseMark({ ts: 1000, slideLabel: '1' }));
  store.applyRecord({ kind: 'slide_mark', ts: 1500, slideLabel: '1-3', frameKind: 'annotation', filePath: '/tmp/a.jpg' });
  assert.equal(store.getSlide(1).visitList.length, 1);
  assert.equal(store.getCurrentSlideMajor(), 1);
});

test('페이지 전환 기록이 주제·묘사·번호를 채운다', () => {
  const store = createContextStore();
  store.applyRecord({
    kind: 'page_transition', ts: 1000, slideLabel: '3', pageNumber: 171,
    pageTopic: '반기 연봉 조정', description: '연봉 변화 그래프', describedElementList: ['계단 그래프'],
  });
  const slide = store.getSlide(3);
  assert.equal(slide.pageNumber, 171);
  assert.equal(slide.pageTopic, '반기 연봉 조정');
  assert.equal(slide.description, '연봉 변화 그래프');
  assert.deepEqual(slide.describedElementList, ['계단 그래프']);
  assert.equal(slide.hasTransition, true);
});

test('ASR 세그먼트를 시각 기준으로 그때 슬라이드에 배정하고 시각순으로 정렬한다', () => {
  const store = createContextStore();
  store.applyRecord(baseMark({ ts: 10000, slideLabel: '1' }));
  store.applyRecord(baseMark({ ts: 20000, slideLabel: '2' }));
  store.applyRecord({
    kind: 'asr', ts: 21000, text: '둘째', speakerHint: '김지오',
    segmentList: [{ startSec: 0.5, endSec: 1.5, text: '둘째' }],
  });
  store.applyRecord({
    kind: 'asr', ts: 12000, text: '첫째', speakerHint: null,
    segmentList: [{ startSec: 0, endSec: 2, text: '첫째' }],
  });
  store.applyRecord({ kind: 'asr', ts: 5000, text: '시작 전', segmentList: [] });
  const list = store.getUtteranceList();
  assert.deepEqual(list.map((u) => [u.text, u.slideMajor, u.speakerHint]), [
    ['시작 전', null, null], ['첫째', 1, null], ['둘째', 2, '김지오'],
  ]);
  assert.equal(list[2].ts, 21500);
  assert.equal(list[2].endTs, 22500);
});

test('발화 조회는 시각·슬라이드·화자로 거른다', () => {
  const store = createContextStore();
  store.applyRecord(baseMark({ ts: 0, slideLabel: '1' }));
  store.applyRecord({ kind: 'asr', ts: 1000, text: 'a', speakerHint: 'A', segmentList: [{ startSec: 0, endSec: 1, text: 'a' }] });
  store.applyRecord({ kind: 'asr', ts: 3000, text: 'b', speakerHint: 'B', segmentList: [{ startSec: 0, endSec: 1, text: 'b' }] });
  assert.deepEqual(store.getUtteranceList({ fromTs: 2000 }).map((u) => u.text), ['b']);
  assert.deepEqual(store.getUtteranceList({ speakerHint: 'A' }).map((u) => u.text), ['a']);
  assert.deepEqual(store.getUtteranceList({ slideMajor: 2 }), []);
});

test('내보낸 자동 해설만 저장하고 슬라이드 번호를 붙인다(질문 답은 해설이 아니다)', () => {
  const store = createContextStore();
  store.applyRecord({ kind: 'narration', ts: 1000, source: 'deixis', narrationClass: 'deixis', text: '표 보는 중', slideLabel: '2', isEmitted: true });
  store.applyRecord({ kind: 'narration', ts: 2000, source: 'deixis', text: '버린 해설', slideLabel: '2', isEmitted: false });
  store.applyRecord({ kind: 'narration', ts: 3000, source: 'user-command', narrationClass: 'user_command', text: '질문 답', isEmitted: true });
  assert.deepEqual(store.getNarrationList().map((n) => [n.text, n.slideMajor, n.narrationClass]), [['표 보는 중', 2, 'deixis']]);
});

test('라벨 준비: 글자 전사가 끝나고 전환 기록이 있거나 슬라이드를 떠났을 때', () => {
  const store = createContextStore();
  store.applyRecord(baseMark({ ts: 0, slideLabel: '1' }));
  store.applySlideText({ slideLabel: '1', status: 'ready', text: '본문' });
  assert.deepEqual(store.listReadyForLabelMajors(), []);
  store.applyRecord({ kind: 'page_transition', ts: 10, slideLabel: '1', pageTopic: '주제' });
  assert.deepEqual(store.listReadyForLabelMajors(), [1]);
  store.markLabelRequested(1);
  assert.deepEqual(store.listReadyForLabelMajors(), []);

  store.applyRecord(baseMark({ ts: 100, slideLabel: '2' }));
  store.applySlideText({ slideLabel: '2', status: 'none', text: '' });
  assert.deepEqual(store.listReadyForLabelMajors(), []);
  store.applyRecord(baseMark({ ts: 200, slideLabel: '3' }));
  assert.deepEqual(store.listReadyForLabelMajors(), [2]);
});

test('라벨을 붙이면 색인이 라벨을 쓰고, 없으면 주제·묘사로 대신한다', () => {
  const store = createContextStore();
  store.applyRecord(baseMark({ ts: 0, slideLabel: '1' }));
  store.applyRecord({ kind: 'page_transition', ts: 10, slideLabel: '1', pageTopic: '회사 소개', description: '미션 문구' });
  store.applyRecord(baseMark({ ts: 100, slideLabel: '2' }));
  store.setLabel({ major: 2, status: LABEL_STATUS_MAP.ready, label: { title: '임금', keywordList: ['기본급'], summary: '임금 체계' } });
  assert.deepEqual(store.buildIndex(), [
    { major: 1, displayNumber: null, title: '회사 소개', keywordList: [], summary: '미션 문구', firstSeenTs: 0, isCurrent: false },
    { major: 2, displayNumber: null, title: '임금', keywordList: ['기본급'], summary: '임금 체계', firstSeenTs: 100, isCurrent: true },
  ]);
});

test('질문·답을 쌓고 마지막 것을 돌려준다', () => {
  const store = createContextStore();
  assert.equal(store.getLastQa(), null);
  store.addQa({ ts: 1, question: 'q1', answer: 'a1', route: 'past_slide', slideMajorList: [3] });
  store.addQa({ ts: 2, question: 'q2', answer: 'a2', route: 'speaker', slideMajorList: [], isFollowUp: true });
  assert.equal(store.getLastQa().question, 'q2');
  assert.equal(store.getLastQa().isFollowUp, true);
});

test('변경마다 onChange 를 부르고, 알림 오류가 저장을 막지 않는다', () => {
  let count = 0;
  const store = createContextStore({ onChange: () => { count += 1; throw new Error('boom'); } });
  store.applyRecord(baseMark({ ts: 0, slideLabel: '1' }));
  store.applyRecord({ kind: 'debug', ts: 1 });
  assert.equal(count, 1);
  assert.equal(store.getSlide(1).major, 1);
});

test('start 는 이전 세션 데이터를 비우고 스냅샷에 세션 정보를 싣는다', () => {
  const store = createContextStore();
  store.applyRecord(baseMark({ ts: 0, slideLabel: '1' }));
  store.start({ sessionId: 'session-1', startedAt: 500 });
  assert.equal(store.getSlide(1), null);
  const snapshot = store.snapshot();
  assert.equal(snapshot.sessionId, 'session-1');
  assert.equal(snapshot.startedAt, 500);
  assert.deepEqual(snapshot.slideList, []);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
});

test('사용자가 들은 슬라이드 번호(표시 번호)를 저장하고, 말한 번호를 표시 번호 > 쪽번호 > 내부 번호 순으로 찾는다', () => {
  const store = createContextStore();
  store.applyRecord({ kind: 'page_transition', ts: 0, slideLabel: '1', displayNumber: 185, pageNumber: 185, pageTopic: 'a' });
  store.applyRecord({ kind: 'page_transition', ts: 0, slideLabel: '2', displayNumber: 2, pageNumber: null, pageTopic: 'b' });
  store.applyRecord({ kind: 'page_transition', ts: 0, slideLabel: '3', pageNumber: 171, pageTopic: 'c' });
  assert.equal(store.getSlide(1).displayNumber, 185);
  assert.equal(store.resolveSlideNumber(185), 1);
  assert.equal(store.resolveSlideNumber(2), 2);
  assert.equal(store.resolveSlideNumber(171), 3);
  assert.equal(store.resolveSlideNumber(3), 3);
  assert.equal(store.resolveSlideNumber(99), null);
  assert.equal(store.buildIndex().find((entry) => entry.major === 1).displayNumber, 185);
});

test('슬라이드 마크에 실제 전환 시각이 있으면 그 시각으로 방문을 연다', () => {
  const store = createContextStore();
  store.applyRecord({ kind: 'slide_mark', ts: 1000, slideLabel: '1', frameKind: 'base', filePath: '/tmp/1.jpg' });
  store.applyRecord({ kind: 'slide_mark', ts: 9000, transitionTs: 6000, slideLabel: '2', frameKind: 'base', filePath: '/tmp/2.jpg' });
  store.applyRecord({ kind: 'asr', ts: 7000, text: '다음은 복지입니다', segmentList: [{ startSec: 0, endSec: 1, text: '다음은 복지입니다' }] });
  assert.deepEqual(store.getSlide(1).visitList, [{ startTs: 1000, endTs: 6000 }]);
  assert.deepEqual(store.getSlide(2).visitList, [{ startTs: 6000, endTs: null }]);
  assert.equal(store.getUtteranceList()[0].slideMajor, 2);
});
