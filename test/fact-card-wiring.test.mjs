import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// main 배선: 새 장 전사 요청과 나란히 카드를 만들고(켰을 때만), 세션 시작에 비우고, 해설 순간 OCR 대기 안에서만 카드를 기다린다.
const source = fs.readFileSync(new URL('../src/main/caption-pipeline/index.js', import.meta.url), 'utf8');
const sliceHandler = (name, nextName) => {
  const start = source.indexOf(`ipcMain.handle('${name}'`);
  assert.ok(start >= 0, name);
  const end = source.indexOf(nextName, start + 1);
  assert.ok(end > start, nextName);
  return source.slice(start, end);
};

test('카드 저장소는 카드 에이전트·전사 저장소·켜짐 설정으로 만들고, 끝나면 fact_sheet 기록을 남긴다', () => {
  assert.match(source, /const factCardAgent = createFactCardAgent\(\{ config \}\);/);
  assert.match(source, /createFactCardStore\(\{[\s\S]*?build: \(\{ jpegBuffer \}\) => factCardAgent\.build\(\{ jpegBuffer \}\),[\s\S]*?slideTextStore,[\s\S]*?isEnabled: \(\) => config\.isFactCardEnabled,/);
  assert.match(source, /kind: RECORD_KIND_MAP\.factSheet,/);
  assert.match(source, /createFactCardTokenizer\(\{ kiwiTokenizer \}\)/);
});

test('pipeline-slide-text: 카드를 켰을 때만 전사와 같은 그림으로 카드를 만든다', () => {
  const body = sliceHandler('pipeline-slide-text', "ipcMain.handle('embed-frame'");
  assert.match(body, /slideTextStore\.ensure\(\{ slideLabel, jpegBuffer \}\)/);
  assert.match(body, /if \(config\.isFactCardEnabled\) factCardStore\.ensure\(\{ slideLabel, jpegBuffer \}\);/);
});

test('pipeline-frame: 복귀했을 때만 실패·건너뛴 카드를 한 번 다시 만들게 건다', () => {
  const body = sliceHandler('pipeline-frame', "ipcMain.handle('pipeline-slide-text'");
  assert.match(body, /if \(isRevisit && config\.isFactCardEnabled\) \{\s*factCardStore\.ensure\(\{ slideLabel, jpegBuffer: Buffer\.from\(buffer\), isRetry: true \}\);/);
});

test('세션 시작에서 카드 저장소를 비운다', () => {
  const body = sliceHandler('pipeline-session-start', "ipcMain.handle('pipeline-session-end'");
  assert.match(body, /slideTextStore\.reset\(\);\s*factCardStore\.reset\(\);/);
});

test('pipeline-deixis: 카드 대기는 같은 프레임 OCR 대기와 함께 걸리고, 고른 카드는 따로 펼쳐 넘긴다', () => {
  const body = sliceHandler('pipeline-deixis', "ipcMain.handle('pipeline-command'");
  assert.match(body, /const screenTextPromise = isScreenTextNarrationType\(narrationType\) && screenTextTask\s*\? screenTextTask\.waitForPrompt\(\)\s*: null;/);
  assert.match(body, /factCardStore\.waitUntil\(\{ slideLabel, untilPromise: screenTextPromise \}\)/);
  assert.match(body, /resolveFactCardUsage\(\{[\s\S]*?isEnabled: config\.isFactCardEnabled, agentList: config\.factCardAgentList,/);
  assert.match(body, /selectFactCards\(\{[\s\S]*?frameLineList: screenText\?\.lineList \|\| \[\], requestTs: ts, tokenizer: factCardTokenizer,/);
  assert.match(body, /\.\.\.generatorArgs, \.\.\.\(extraArgByTypeMap\[narrationType\] \|\| \{\}\), \.\.\.factCardArg,/);
  assert.match(body, /\[NARRATION_TYPE_MAP\.deixis\]: \{ hasPointingRegion, pointingOrderHint \}/);
  assert.match(body, /factCard: factCardRecord/);
  assert.match(body, /formatFactCardSummary\(factCardRecord\)/);
  const waitIndex = body.indexOf('factCardStore.waitUntil');
  const awaitOcrIndex = body.indexOf('await screenTextPromise');
  assert.ok(waitIndex > 0 && awaitOcrIndex > waitIndex, '카드 대기를 건 뒤에 OCR 을 기다린다(둘이 겹친다)');
});

test('해설 순간에는 카드를 만들지 않는다(VLM 추가 호출 없음)', () => {
  const body = sliceHandler('pipeline-deixis', "ipcMain.handle('pipeline-command'");
  assert.doesNotMatch(body, /factCardStore\.ensure|factCardAgent\.build/);
});
