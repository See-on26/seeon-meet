import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createContextFileWriter } = require('../src/main/caption-pipeline/context/context-file.js');

function makeWriter({ writeFile } = {}) {
  const writeList = [];
  const timerList = [];
  const writer = createContextFileWriter({
    outDir: '/out/context',
    writeFile: writeFile || (async (filePath, text) => { writeList.push({ filePath, text }); }),
    mkdir: async () => {},
    debounceMs: 2000,
    setTimer: (fn, ms) => { timerList.push({ fn, ms, isCleared: false }); return timerList.length - 1; },
    clearTimer: (handle) => { timerList[handle].isCleared = true; },
  });
  return { writer, writeList, timerList };
}

test('여러 번 예약해도 디바운스 창 안에서는 한 번만 쓴다', async () => {
  const { writer, writeList, timerList } = makeWriter();
  let version = 0;
  writer.schedule({ sessionId: 'session-1', getSnapshot: () => ({ version: (version += 1) }) });
  writer.schedule({ sessionId: 'session-1', getSnapshot: () => ({ version: (version += 1) }) });
  assert.equal(timerList.length, 1);
  assert.equal(timerList[0].ms, 2000);
  await timerList[0].fn();
  assert.equal(writeList.length, 1);
  assert.equal(writeList[0].filePath, '/out/context/session-1.json');
  assert.deepEqual(JSON.parse(writeList[0].text), { version: 1 });
});

test('flush 는 예약을 풀고 바로 쓴다', async () => {
  const { writer, writeList, timerList } = makeWriter();
  writer.schedule({ sessionId: 'session-2', getSnapshot: () => ({ ok: true }) });
  const filePath = await writer.flush();
  assert.equal(filePath, '/out/context/session-2.json');
  assert.equal(timerList[0].isCleared, true);
  assert.equal(writeList.length, 1);
  assert.equal(await writer.flush(), null);
});

test('세션 ID 가 없으면 쓰지 않는다', async () => {
  const { writer, writeList } = makeWriter();
  writer.schedule({ sessionId: null, getSnapshot: () => ({}) });
  assert.equal(await writer.flush(), null);
  assert.equal(writeList.length, 0);
});

test('쓰기 실패는 null 을 돌려주고 던지지 않는다', async () => {
  const { writer } = makeWriter({ writeFile: async () => { throw new Error('disk full'); } });
  writer.schedule({ sessionId: 'session-3', getSnapshot: () => ({}) });
  assert.equal(await writer.flush(), null);
});

test('파일 이름에서 경로 문자를 지운다', () => {
  const { writer } = makeWriter();
  assert.equal(writer.filePathFor('../evil/session'), '/out/context/evilsession.json');
});

test('텍스트 파일을 같은 폴더에 쓴다', async () => {
  const { writer, writeList } = makeWriter();
  const filePath = await writer.writeText({ fileName: 'session-1-script.txt', text: '본문' });
  assert.equal(filePath, '/out/context/session-1-script.txt');
  assert.equal(writeList[0].text, '본문');
});
