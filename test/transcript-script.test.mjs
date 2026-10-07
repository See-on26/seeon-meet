import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildTranscriptScript, buildScriptFileName, listSlideMajorWithoutTransitionLine,
} = require('../src/main/caption-pipeline/context/transcript-script.js');

const snapshot = {
  sessionId: 'session-1', startedAt: 0,
  slideList: [
    { major: 3, displayNumber: 171, hasTransition: true, visitList: [{ startTs: 150000, endTs: 3_690_000 }],
      label: { title: '반기 연봉 조정', keywordList: [], summary: '' }, pageTopic: '연봉' },
    { major: 4, displayNumber: null, hasTransition: true, visitList: [{ startTs: 3_690_000, endTs: 3_790_000 }],
      label: null, pageTopic: '복지 제도' },
  ],
  transitionList: [
    // 교차 모드는 체류 3초 뒤에 고지를 요청하므로 기록 시각이 방문 시작보다 늦다.
    { ts: 153000, slideMajor: 3, text: '슬라이드 171: 반기별 연봉 조정 기준표', isRevisit: false },
    { ts: 3_693_000, slideMajor: 4, text: '복지 제도 항목을 나열한 목록 화면', isRevisit: false },
  ],
  utteranceList: [
    { ts: 1000, text: '시작하겠습니다', speakerHint: null, slideMajor: null },
    { ts: 151000, text: '보시는 것처럼', speakerHint: '김지오', slideMajor: 3 },
    { ts: 154000, text: '500만원이 추가됩니다', speakerHint: '김지오', slideMajor: 3 },
    { ts: 3_700_000, text: '복지 얘기', speakerHint: '이수민', slideMajor: 4 },
  ],
};

test('발화마다 화자를 적고, 화면이 바뀐 시각에 페이지 전환 AD 를 한 줄로 넣는다', () => {
  assert.equal(buildTranscriptScript({ snapshot }), [
    '[00:01] 화자 미상: 시작하겠습니다',
    '[02:30] ── 슬라이드 171: 반기별 연봉 조정 기준표 ──',
    '[02:31] 김지오: 보시는 것처럼',
    '[02:34] 김지오: 500만원이 추가됩니다',
    '[1:01:30] ── 복지 제도 항목을 나열한 목록 화면 ──',
    '[1:01:40] 이수민: 복지 얘기',
  ].join('\n'));
});

test('요약 입력용은 화자 이름을 뺀다', () => {
  const script = buildTranscriptScript({ snapshot, isSpeakerHidden: true });
  assert.doesNotMatch(script, /김지오|이수민|화자 미상/);
  assert.match(script, /^\[02:31\] 보시는 것처럼$/m);
  assert.match(script, /^\[02:30\] ── 슬라이드 171: 반기별 연봉 조정 기준표 ──$/m);
});

test('체류 3초를 못 채워 취소된 전환은 AD 줄도 방문도 넣지 않는다', () => {
  const flashSnapshot = {
    ...snapshot,
    slideList: [...snapshot.slideList, { major: 5, hasTransition: true, visitList: [{ startTs: 200000, endTs: 201500 }] }],
    transitionList: [...snapshot.transitionList, { ts: 200100, slideMajor: 5, text: '스쳐 간 화면' }],
    cancelledTransitionList: [{ slideMajor: 5, requestTs: 200100, transitionTs: 200000 }],
  };
  assert.doesNotMatch(buildTranscriptScript({ snapshot: flashSnapshot }), /스쳐 간 화면/);
  assert.deepEqual(listSlideMajorWithoutTransitionLine({ snapshot: flashSnapshot }), []);
});

test('전환 고지가 한 번도 없던 화면은 회의 후 화면 정보 텍스트화 결과로 채우고, 그것도 없으면 설명 없음으로 남긴다', () => {
  const failedSnapshot = {
    ...snapshot,
    slideList: [...snapshot.slideList,
      { major: 6, displayNumber: null, hasTransition: false, visitList: [{ startTs: 300000, endTs: null }], label: null, pageTopic: '' }],
  };
  assert.deepEqual(listSlideMajorWithoutTransitionLine({ snapshot: failedSnapshot }), ['6']);
  assert.match(buildTranscriptScript({ snapshot: failedSnapshot, screenFillByMajorMap: new Map([['6', '분기별 매출 막대그래프']]) }),
    /^\[05:00\] ── 분기별 매출 막대그래프 ──$/m);
  assert.match(buildTranscriptScript({ snapshot: failedSnapshot }), /^\[05:00\] ── 화면이 바뀌었습니다 \(화면 설명 없음\) ──$/m);
});

test('발화도 전환도 없으면 안내 한 줄', () => {
  assert.equal(buildTranscriptScript({ snapshot: { ...snapshot, utteranceList: [], transitionList: [] } }),
    '(기록된 발화가 없습니다)');
});

test('스크립트 파일 이름', () => {
  assert.equal(buildScriptFileName({ sessionId: 'session-1' }), 'session-1-script.txt');
});

test('화자 식별을 끈 동안의 발화는 화자를 구분하지 않고(화자 미상도 붙이지 않고) 발화만 적는다', () => {
  const offSnapshot = {
    ...snapshot,
    utteranceList: [
      { ts: 1000, text: '켜진 동안 알 수 없는 화자', speakerHint: null, isSpeakerTracked: true },
      { ts: 2000, text: '끈 동안의 발화', speakerHint: null, isSpeakerTracked: false },
      { ts: 3000, text: '다시 켠 뒤', speakerHint: '김지오', isSpeakerTracked: true },
    ],
    transitionList: [],
  };
  assert.equal(buildTranscriptScript({ snapshot: offSnapshot }), [
    '[00:01] 화자 미상: 켜진 동안 알 수 없는 화자',
    '[00:02] 끈 동안의 발화',
    '[00:03] 김지오: 다시 켠 뒤',
  ].join('\n'));
});
