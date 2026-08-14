import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createContextStore, toSlideMajor, LABEL_STATUS_MAP, SEGMENT_STATUS_MAP,
} = require('../src/main/caption-pipeline/context/context-store.js');

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

test('질문·답을 쌓고 이번 회의 것을 모두 돌려준다', () => {
  const store = createContextStore();
  assert.deepEqual(store.getQaList(), []);
  store.addQa({ ts: 1, question: 'q1', answer: 'a1', route: 'past_slide', slideMajorList: [3] });
  store.addQa({ ts: 2, question: 'q2', answer: 'a2', route: 'speaker', slideMajorList: [] });
  const qaList = store.getQaList();
  assert.deepEqual(qaList.map((qa) => qa.question), ['q1', 'q2']);
  qaList[0].slideMajorList.push(9);
  assert.deepEqual(store.getQaList()[0].slideMajorList, [3], '돌려준 목록을 고쳐도 저장소는 그대로다');
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

test('전환 고지 문장은 스크립트용 화면 전환 AD 로 모은다 (주제 대체·고지 없는 사유 구분)', () => {
  const store = createContextStore();
  store.applyRecord(baseMark({ ts: 1000, slideLabel: '1' }));
  store.applyRecord({ kind: 'page_transition', ts: 1100, slideLabel: '1', narration: '슬라이드 1: 표지', displayNumber: 1 });
  store.applyRecord({ kind: 'page_transition', ts: 2100, slideLabel: '2', narration: '',
    skipReason: 'incomplete_description', pageTopic: '분기 매출', displayNumber: 2 });
  store.applyRecord({ kind: 'page_transition', ts: 3100, slideLabel: '3', narration: '', skipReason: 'same_topic', pageTopic: '분기 매출' });
  store.applyRecord({ kind: 'page_transition', ts: 4100, slideLabel: '1', narration: '이전 슬라이드 1: 표지', isRevisit: true });
  assert.deepEqual(store.snapshot().transitionList.map(({ ts, slideMajor, text, isRevisit }) => [ts, slideMajor, text, isRevisit]), [
    [1100, 1, '슬라이드 1: 표지', false],
    [2100, 2, '슬라이드 2: 분기 매출', false],
    [4100, 1, '이전 슬라이드 1: 표지', true],
  ]);
});

test('체류 미달로 취소된 전환은 스냅숏에 남겨 스크립트가 뺄 수 있게 하고, 새 세션에서는 비운다', () => {
  const store = createContextStore();
  assert.equal(store.cancelTransition({ slideLabel: '4-2', requestTs: 5100, transitionTs: 5000 }), true);
  assert.equal(store.cancelTransition({ slideLabel: '' }), false);
  assert.deepEqual(store.snapshot().cancelledTransitionList, [{ slideMajor: 4, requestTs: 5100, transitionTs: 5000 }]);
  store.start({ sessionId: 's2', startedAt: 0 });
  assert.deepEqual(store.snapshot().cancelledTransitionList, []);
  assert.deepEqual(store.snapshot().transitionList, []);
});

test('ASR 기록의 화자 식별 여부를 발화에 남긴다(값이 없던 예전 기록은 켜진 것으로 본다)', () => {
  const store = createContextStore();
  store.applyRecord({ kind: 'asr', ts: 1000, text: '켜짐', speakerHint: '김지오', isSpeakerTracked: true });
  store.applyRecord({ kind: 'asr', ts: 2000, text: '꺼짐', speakerHint: null, isSpeakerTracked: false });
  store.applyRecord({ kind: 'asr', ts: 3000, text: '예전 기록', speakerHint: null });
  assert.deepEqual(store.snapshot().utteranceList.map((utterance) => [utterance.text, utterance.isSpeakerTracked]), [
    ['켜짐', true], ['꺼짐', false], ['예전 기록', true],
  ]);
});

test('듣지 못한 해설은 해설 목록에서 뺀다', () => {
  const store = createContextStore();
  store.applyRecord({ kind: 'narration', ts: 100, text: '빨간 막대 상승 구간', isEmitted: true, narrationClass: 'deixis' });
  store.applyRecord({ kind: 'narration', ts: 200, text: '다른 해설', isEmitted: true, narrationClass: 'deixis' });
  assert.equal(store.forgetNarration({ ts: 100, text: '빨간 막대 상승 구간' }), true);
  assert.equal(store.forgetNarration({ ts: 100, text: '빨간 막대 상승 구간' }), false);
  assert.deepEqual(store.getNarrationList().map((narration) => narration.text), ['다른 해설']);
});

test('구간 요약: 요청 표시·결과·스냅숏·reset', () => {
  let changeCount = 0;
  const store = createContextStore({ onChange: () => { changeCount += 1; } });
  store.start({ sessionId: 's1', startedAt: 0 });
  assert.deepEqual(SEGMENT_STATUS_MAP, { requested: 'requested', ready: 'ready', failed: 'failed' });
  store.markSegmentRequested({ key: '2@60000', slideMajor: 2, startTs: 60000, endTs: 120000, isRevisit: false });
  store.markSegmentRequested({ key: '1@0', slideMajor: 1, startTs: 0, endTs: 60000, isRevisit: false });
  assert.deepEqual(store.getSegmentSummaryList(), [
    { key: '1@0', slideMajor: 1, startTs: 0, endTs: 60000, isRevisit: false, text: '', status: 'requested' },
    { key: '2@60000', slideMajor: 2, startTs: 60000, endTs: 120000, isRevisit: false, text: '', status: 'requested' },
  ], '시작 시각순');

  assert.equal(store.setSegmentSummary({ key: '1@0', text: ' 분기 매출이 12% 늘었다. ', status: SEGMENT_STATUS_MAP.ready }), true);
  assert.equal(store.setSegmentSummary({ key: '2@60000', status: SEGMENT_STATUS_MAP.failed }), true);
  assert.equal(store.setSegmentSummary({ key: '9@0', text: '요청하지 않은 구간', status: SEGMENT_STATUS_MAP.ready }), false);
  assert.equal(changeCount, 2, '결과를 넣을 때 알린다');
  const expectedList = [
    { key: '1@0', slideMajor: 1, startTs: 0, endTs: 60000, isRevisit: false, text: '분기 매출이 12% 늘었다.', status: 'ready' },
    { key: '2@60000', slideMajor: 2, startTs: 60000, endTs: 120000, isRevisit: false, text: '', status: 'failed' },
  ];
  assert.deepEqual(store.getSegmentSummaryList(), expectedList);
  assert.deepEqual(store.snapshot().segmentSummaryList, expectedList);

  // 실패한 구간을 다시 요청하면 요청 상태로 돌아간다.
  store.markSegmentRequested({ key: '2@60000', slideMajor: 2, startTs: 60000, endTs: 120000, isRevisit: false });
  assert.equal(store.getSegmentSummaryList()[1].status, 'requested');

  const copiedList = store.getSegmentSummaryList();
  copiedList[0].text = '고친 글';
  store.snapshot().segmentSummaryList.pop();
  assert.equal(store.getSegmentSummaryList()[0].text, '분기 매출이 12% 늘었다.', '돌려준 목록을 고쳐도 저장소는 그대로다');
  assert.equal(store.getSegmentSummaryList().length, 2);

  store.reset();
  assert.deepEqual(store.getSegmentSummaryList(), []);
  store.markSegmentRequested({ key: '1@0', slideMajor: 1, startTs: 0, endTs: 60000, isRevisit: false });
  store.start({ sessionId: 's2', startedAt: 0 });
  assert.deepEqual(store.snapshot().segmentSummaryList, []);
});
