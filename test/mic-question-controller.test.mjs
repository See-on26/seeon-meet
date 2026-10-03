import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MicQuestionController, MIC_PHASE_MAP } from '../src/renderer/core/command/mic-question-controller.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function makeController({ startResult = true, canStart = true, beginBlock = null, endBlock = null } = {}) {
  const log = [];
  const recorder = {
    startCount: 0, toggleCount: 0, cancelCount: 0,
    async start() { this.startCount += 1; return startResult; },
    toggle() { this.toggleCount += 1; },
    cancel() { this.cancelCount += 1; },
  };
  const controller = new MicQuestionController({
    recorder,
    canStart: () => canStart,
    beginSession: async () => { log.push('begin'); if (beginBlock) await beginBlock.promise; },
    endSession: async () => { log.push('end'); if (endBlock) await endBlock.promise; },
    announce: (text) => log.push(`announce:${text}`),
    setUi: (isRecording) => log.push(`ui:${isRecording}`),
    onQuestionAudio: async ({ buffer }) => log.push(`audio:${buffer}`),
  });
  return { controller, recorder, log };
}

test('시작하는 동안 다시 누르면 무시해 세션이 겹치지 않는다', async () => {
  const beginBlock = deferred();
  const { controller, recorder, log } = makeController({ beginBlock });
  const first = controller.toggle();
  assert.equal(controller.phase, MIC_PHASE_MAP.starting);
  assert.equal(await controller.toggle(), false);
  beginBlock.resolve();
  assert.equal(await first, true);
  assert.equal(controller.phase, MIC_PHASE_MAP.recording);
  assert.equal(recorder.startCount, 1);
  assert.deepEqual(log.filter((entry) => entry === 'begin'), ['begin']);
});

test('안내를 녹음 시작 전에 하고, 녹음 중 누르면 녹음기를 멈춘다', async () => {
  const { controller, recorder, log } = makeController();
  await controller.toggle();
  assert.ok(log.indexOf('announce:질문을 말씀하세요') < log.indexOf('ui:true'));
  await controller.toggle();
  assert.equal(recorder.toggleCount, 1);
});

test('마무리하는 동안 누르면 무시하고, 끝나면 다시 시작할 수 있다', async () => {
  const endBlock = deferred();
  const { controller, recorder, log } = makeController({ endBlock });
  await controller.toggle();
  const finishing = controller.handleFinish({ buffer: 'b1', startTs: 1 });
  assert.equal(controller.phase, MIC_PHASE_MAP.finishing);
  assert.equal(await controller.toggle(), false);
  endBlock.resolve();
  await finishing;
  assert.equal(controller.phase, MIC_PHASE_MAP.idle);
  assert.ok(log.includes('audio:b1'));
  await controller.toggle();
  assert.equal(recorder.startCount, 2);
  assert.deepEqual(log.filter((entry) => entry === 'begin').length, log.filter((entry) => entry === 'end').length + 1);
});

test('캡처 중이 아니면 안내만 하고 세션을 열지 않는다', async () => {
  const { controller, recorder, log } = makeController({ canStart: false });
  assert.equal(await controller.toggle(), false);
  assert.equal(recorder.startCount, 0);
  assert.deepEqual(log, ['announce:회의 캡처를 시작해야 질문할 수 있어요']);
});

test('녹음기가 시작하지 못하고 취소를 알리면 세션을 닫고 안내한다', async () => {
  const { controller, log } = makeController({ startResult: false });
  await controller.toggle();
  await controller.handleCancel({ reason: 'permission' });
  assert.equal(controller.phase, MIC_PHASE_MAP.idle);
  assert.ok(log.includes('end'));
  assert.ok(log.includes('announce:마이크 권한이 필요해요'));
  assert.ok(!log.includes('ui:true'));
});

test('정지 요청은 녹음 중이면 바로, 시작 중이면 시작 직후 녹음을 취소한다', async () => {
  const { controller, recorder } = makeController();
  await controller.toggle();
  controller.cancel();
  assert.equal(recorder.cancelCount, 1);

  const beginBlock = deferred();
  const second = makeController({ beginBlock });
  const starting = second.controller.toggle();
  second.controller.cancel();
  beginBlock.resolve();
  await starting;
  assert.equal(second.recorder.cancelCount, 1);
});
