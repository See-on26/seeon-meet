import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildTranscriptScript, buildScriptFileName } = require('../src/main/caption-pipeline/context/transcript-script.js');

const snapshot = {
  sessionId: 'session-1', startedAt: 0,
  slideList: [
    { major: 3, label: { title: '반기 연봉 조정', keywordList: [], summary: '' }, pageTopic: '연봉' },
    { major: 4, label: null, pageTopic: '복지 제도' },
    { major: 5, label: null, pageTopic: '' },
  ],
  utteranceList: [
    { ts: 1000, text: '시작하겠습니다', speakerHint: null, slideMajor: null },
    { ts: 151000, text: '보시는 것처럼', speakerHint: '김지오', slideMajor: 3 },
    { ts: 154000, text: '500만원이 추가됩니다', speakerHint: null, slideMajor: 3 },
    { ts: 3_700_000, text: '복지 얘기', speakerHint: '이수민', slideMajor: 4 },
    { ts: 3_800_000, text: '끝', speakerHint: null, slideMajor: 5 },
  ],
};

test('발화를 시간순으로 쓰고 슬라이드가 바뀌는 곳에 제목 줄을 넣는다', () => {
  assert.equal(buildTranscriptScript({ snapshot }), [
    '[00:01] 시작하겠습니다',
    '── 슬라이드 3: 반기 연봉 조정 ──',
    '[02:31] 김지오: 보시는 것처럼',
    '[02:34] 500만원이 추가됩니다',
    '── 슬라이드 4: 복지 제도 ──',
    '[1:01:40] 이수민: 복지 얘기',
    '── 슬라이드 5 ──',
    '[1:03:20] 끝',
  ].join('\n'));
});

test('발화가 없으면 안내 한 줄', () => {
  assert.equal(buildTranscriptScript({ snapshot: { ...snapshot, utteranceList: [] } }), '(기록된 발화가 없습니다)');
});

test('스크립트 파일 이름', () => {
  assert.equal(buildScriptFileName({ sessionId: 'session-1' }), 'session-1-script.txt');
});
