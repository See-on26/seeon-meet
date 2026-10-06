import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readAutorunOption } = require('../src/main/lab/autorun-option.js');

test('확인 실행 옵션: 영상이 없으면 끄고, 있으면 평가 설정 켬·끝나면 종료가 기본이다', () => {
  assert.equal(readAutorunOption({}), null);
  assert.deepEqual(readAutorunOption({ SEEON_LAB_AUTORUN: 'out/a.mp4' }), {
    videoPath: path.resolve('out/a.mp4'), mode: null, isEvalPreset: true, isExitOnDone: true, asrLanguage: 'ko',
  });
  assert.deepEqual(readAutorunOption({
    SEEON_LAB_AUTORUN: '/v.mp4', SEEON_LAB_MODE: 'listening', SEEON_LAB_EVAL_PRESET: 'false', SEEON_LAB_EXIT_ON_DONE: 'false',
    SEEON_LAB_ASR_LANGUAGE: 'en',
  }), { videoPath: '/v.mp4', mode: 'listening', isEvalPreset: false, isExitOnDone: false, asrLanguage: 'en' });
});

test('실험 진입점은 파이프라인 등록 전에 세션 결과 엿보기를 설치하고 Meet 전용 등록은 하지 않는다', () => {
  const source = fs.readFileSync(new URL('../src/main/lab/index.js', import.meta.url), 'utf8');
  assert.ok(source.indexOf('observeIpcHandleList(') < source.indexOf('registerPipeline('));
  assert.match(source, /registerPipeline\(\{ getViewerView: labWindow\.getViewerView, meetingArchive: null \}\)/);
  assert.match(source, /registerSummary\(\{ getViewerView: labWindow\.getViewerView, pipelineHandle, meetingArchive: null \}\)/);
  for (const meetOnly of ['registerMeetReload', 'registerMeetMicControl', 'registerViewerDisplayMedia', 'registerMeetingArchive']) {
    assert.doesNotMatch(source, new RegExp(meetOnly), meetOnly);
  }
});

test('실험 진입점도 제품 앱처럼 파이프라인 등록 전에 GPU 서버 터널을 연다', () => {
  const source = fs.readFileSync(new URL('../src/main/lab/index.js', import.meta.url), 'utf8');
  assert.match(source, /require\('\.\.\/gpu-tunnel'\)/);
  assert.match(source, /registerGpuTunnel\(\{ app, ipcMain, getViewerView: labWindow\.getViewerView \}\)/);
  assert.ok(source.indexOf('registerGpuTunnel({') < source.indexOf('registerPipeline({'));
});

test('실험 창은 viewer·재생 화면 세션을 나누고 서로를 캡처하며 viewer 녹음은 로컬 소리를 살린다', () => {
  const source = fs.readFileSync(new URL('../src/main/lab/window.js', import.meta.url), 'utf8');
  assert.match(source, /'persist:lab-viewer'/);
  assert.match(source, /'persist:lab-player'/);
  assert.match(source, /video: playerView\.webContents\.mainFrame, audio: playerView\.webContents\.mainFrame \}/);
  assert.match(source, /audio: viewerView\.webContents\.mainFrame, enableLocalEcho: true/);
  assert.match(source, /'app', 'index\.html'/);
});

test('npm run lab 은 실험 진입점으로 Electron 을 띄운다', () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.scripts.lab, 'electron src/main/lab/index.js');
  assert.equal(packageJson.scripts['lab:debug'], 'electron src/main/lab/index.js --remote-debugging-port=9223');
});
