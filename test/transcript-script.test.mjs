import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildTranscriptScript, buildFullTranscript, buildScriptFileName, listSlideMajorWithoutTransitionLine,
} = require('../src/main/caption-pipeline/context/transcript-script.js');

const readSource = (relativePath) => fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

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

const meetingSnapshot = {
  sessionId: 'session-2', startedAt: 0,
  slideList: [
    { major: 1, displayNumber: 1, hasTransition: true, visitList: [{ startTs: 3000, endTs: 18000 }],
      label: { title: '매출 표', keywordList: [], summary: '' }, pageTopic: '매출' },
    // 전환 고지가 없던 화면 — 개발용 스크립트라면 화면 채움 줄이 들어갈 자리다.
    { major: 2, displayNumber: 2, hasTransition: false, visitList: [{ startTs: 18000, endTs: null }],
      label: { title: '비용 표', keywordList: [], summary: '' }, pageTopic: '비용' },
  ],
  transitionList: [{ ts: 3000, slideMajor: 1, text: '슬라이드 1: 매출 표', isRevisit: false }],
  utteranceList: [
    { ts: 1000, text: '시작하겠습니다', speakerHint: null, isSpeakerTracked: true },
    { ts: 5000, text: '매출이 늘었습니다', speakerHint: '김지오', isSpeakerTracked: true },
    { ts: 15000, text: '다음 장으로 넘기겠습니다', speakerHint: '김지오', isSpeakerTracked: true },
    { ts: 25000, text: '화자 식별을 끈 동안의 발화', speakerHint: null, isSpeakerTracked: false },
  ],
  qaList: [
    { ts: 12000, question: '몇 퍼센트야?', answer: '12퍼센트입니다', route: 'current_screen', slideMajorList: [1] },
    { ts: 22000, question: '지금 화면 뭐야?', answer: '', route: 'current_screen', slideMajorList: [2] },
  ],
};

test('스크립트 전문: 발화는 화자와 함께, 질문·답은 그 시각에, 화면 설명 줄은 없다', () => {
  const script = buildFullTranscript({ snapshot: meetingSnapshot });
  assert.equal(script, [
    '[00:01] 화자 미상: 시작하겠습니다',
    '[00:05] 김지오: 매출이 늘었습니다',
    '[00:12] 사용자 질문: 몇 퍼센트야?',
    '[00:12] SEEON 답: 12퍼센트입니다',
    '[00:15] 김지오: 다음 장으로 넘기겠습니다',
    '[00:22] 사용자 질문: 지금 화면 뭐야?',
    '[00:25] 화자 식별을 끈 동안의 발화',
  ].join('\n'));
  assert.doesNotMatch(script, /──|매출 표|비용 표|화면 설명 없음/);
});

test('스크립트 전문: 같은 시각에 발화가 있어도 답은 질문 바로 다음 줄이다', () => {
  const tieSnapshot = {
    ...meetingSnapshot,
    utteranceList: [{ ts: 12000, text: '같은 순간의 발화', speakerHint: '이수민', isSpeakerTracked: true }],
    qaList: [meetingSnapshot.qaList[0]],
  };
  const lineList = buildFullTranscript({ snapshot: tieSnapshot }).split('\n');
  const questionIndex = lineList.indexOf('[00:12] 사용자 질문: 몇 퍼센트야?');
  assert.ok(questionIndex >= 0);
  assert.equal(lineList[questionIndex + 1], '[00:12] SEEON 답: 12퍼센트입니다');
  assert.ok(lineList.includes('[00:12] 이수민: 같은 순간의 발화'));
});

test('스크립트 전문: 영어 캡션이면 User question·SEEON answer', () => {
  const script = buildFullTranscript({ snapshot: meetingSnapshot, language: 'en' });
  assert.match(script, /^\[00:12\] User question: 몇 퍼센트야\?\n\[00:12\] SEEON answer: 12퍼센트입니다$/m);
  assert.match(script, /^\[00:22\] User question: 지금 화면 뭐야\?$/m);
  assert.doesNotMatch(script, /사용자 질문|SEEON 답/);
  assert.match(script, /^\[00:05\] 김지오: 매출이 늘었습니다$/m);
  // 화자를 모르는 발화의 이름표도 영어다. 화자 식별을 끈 동안의 발화는 여전히 이름표가 없다.
  assert.match(script, /^\[00:01\] Unknown speaker: 시작하겠습니다$/m);
  assert.match(script, /^\[00:25\] 화자 식별을 끈 동안의 발화$/m);
  assert.doesNotMatch(script, /화자 미상/);
  assert.match(buildFullTranscript({ snapshot: meetingSnapshot, language: 'ko' }), /^\[00:01\] 화자 미상: 시작하겠습니다$/m);
});

test('스크립트 전문: 발화도 질문도 없으면 빈 기록 문구', () => {
  // 화면 전환만 있던 회의도 전문에는 적을 것이 없다.
  const emptySnapshot = { ...meetingSnapshot, utteranceList: [], qaList: [] };
  assert.equal(buildFullTranscript({ snapshot: emptySnapshot }), '(기록된 발화가 없습니다)');
  assert.equal(buildFullTranscript({ snapshot: emptySnapshot, language: 'en' }), '(No utterances were recorded)');
  assert.equal(buildFullTranscript({ snapshot: { startedAt: 0 } }), '(기록된 발화가 없습니다)');
});

test('스크립트 전문: 질문만 있던 회의도 질문·답을 적는다', () => {
  const qaOnlySnapshot = { ...meetingSnapshot, utteranceList: [], qaList: [meetingSnapshot.qaList[0]] };
  assert.equal(buildFullTranscript({ snapshot: qaOnlySnapshot }),
    '[00:12] 사용자 질문: 몇 퍼센트야?\n[00:12] SEEON 답: 12퍼센트입니다');
});

test('세션 종료: 회의 기록에는 그 회의 캡션 언어의 스크립트 전문을, 개발용 스크립트 파일에는 화면 설명 줄이 있는 스크립트를 쓴다', () => {
  const source = readSource('src/main/caption-pipeline/index.js');
  const endBody = source.slice(source.indexOf("ipcMain.handle('pipeline-session-end'"), source.indexOf("ipcMain.on('pipeline-slide-mark'"));
  assert.match(endBody, /fileName: buildScriptFileName\(\{ sessionId \}\), text: buildTranscriptScript\(\{ snapshot: lastContextSnapshot \}\)/);
  const archiveBody = endBody.slice(endBody.indexOf('meetingArchive?.saveScript('));
  assert.match(archiveBody, /scriptText: buildFullTranscript\(\{ snapshot: lastContextSnapshot, language: lastSession\.captionLanguage \}\)/);
  assert.doesNotMatch(archiveBody.slice(0, archiveBody.indexOf('.catch(')), /buildTranscriptScript/);
});
