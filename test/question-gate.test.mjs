import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readQuestionBlockedTextKey } from '../src/renderer/core/command/question-gate.js';
import { UI_TEXT_MAP } from '../src/renderer/core/i18n/ui-text.js';

// 일시정지하면 캡처·해설을 바로 멈추므로 그사이 질문(화면을 찍어 GPU 로 보내는 일)도 받지 않는다.
test('질문을 막는 까닭: 캡처 전이면 캡처 안내, 일시정지 중이면 일시정지 안내, 아니면 없음', () => {
  assert.equal(readQuestionBlockedTextKey({ isCapturing: false, isPaused: false }), 'question.notCapturing');
  assert.equal(readQuestionBlockedTextKey({ isCapturing: false, isPaused: true }), 'question.notCapturing');
  assert.equal(readQuestionBlockedTextKey({ isCapturing: true, isPaused: true }), 'question.paused');
  assert.equal(readQuestionBlockedTextKey({ isCapturing: true, isPaused: false }), null);
  assert.equal(UI_TEXT_MAP.ko['question.paused'], '일시정지 중에는 질문할 수 없어요');
  assert.equal(UI_TEXT_MAP.en['question.paused'], "You can't ask questions while paused");
});

const mainSource = fs.readFileSync(new URL('../src/renderer/app/main.js', import.meta.url), 'utf8');

function readFunctionBody({ source, start, end }) {
  const startIndex = source.indexOf(start);
  return source.slice(startIndex, source.indexOf(end, startIndex + start.length));
}

test('연결: 입력창·프리셋 질문과 음성 질문이 같은 판단으로 막는다', () => {
  const nowBody = readFunctionBody({ source: mainSource, start: 'function readQuestionBlockedTextKeyNow(', end: '\n}' });
  assert.match(nowBody, /readQuestionBlockedTextKey\(\{ isCapturing: captureSource\.isActive, isPaused: isExperimentPaused \}\)/);
  const askBody = readFunctionBody({ source: mainSource, start: 'async function askQuestion(', end: 'async function requestAnswer(' });
  assert.match(askBody, /readQuestionBlockedTextKeyNow\(\)/);
  assert.match(mainSource, /readStartBlockedTextKey: readQuestionBlockedTextKeyNow,/);
});

test('연결: 막힌 입력창 질문은 적은 글을 지우지 않고 남겨 둔다', () => {
  const submitBody = readFunctionBody({ source: mainSource, start: 'function submitTypedQuestion(', end: '\n}' });
  const blockIndex = submitBody.indexOf('readQuestionBlockedTextKeyNow()');
  assert.ok(blockIndex >= 0);
  assert.ok(blockIndex < submitBody.indexOf("input.value = ''"));
});

test('연결: 녹음 중에 일시정지하면 녹음을 버린다(일시정지 중 질문을 GPU 로 보내지 않는다)', () => {
  const pauseBody = readFunctionBody({ source: mainSource, start: 'function pauseExperiment(', end: '\n}' });
  assert.match(pauseBody, /micQuestionController\.cancel\(\)/);
});

test('연결: 녹음을 마친 뒤 일시정지했으면 받아쓰기 전에 막아 소리를 GPU 로 보내지 않는다', () => {
  const audioBody = readFunctionBody({ source: mainSource, start: 'async function askQuestionFromAudio(', end: '\n}' });
  const blockIndex = audioBody.indexOf('readQuestionBlockedTextKeyNow()');
  assert.ok(blockIndex >= 0);
  assert.ok(blockIndex < audioBody.indexOf('sendQuestionAudio('));
});
