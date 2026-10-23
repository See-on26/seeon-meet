import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createSlideLayoutStore, createSharedOcrClient, toLayoutLineList, SLIDE_LAYOUT_STATUS_MAP,
} = require('../src/main/caption-pipeline/orchestrator/speech-roi/slide-layout-store.js');
const {
  checkLayoutFreshness, FRESHNESS_REASON_MAP, MAX_ASPECT_DIFF, MAX_GLOBAL_DIFF, MAX_BOX_DIFF,
} = require('../src/main/caption-pipeline/orchestrator/speech-roi/layout-freshness.js');
const {
  createFrameImageOps, THUMB_WIDTH, THUMB_HEIGHT, ZOOM_LONG_EDGE, ZOOM_JPEG_QUALITY,
} = require('../src/main/caption-pipeline/orchestrator/speech-roi/frame-image.js');
const { createSlideTextAgent } = require('../src/main/caption-pipeline/agents/slide-text-agent.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveFn, rejectFn) => { resolve = resolveFn; reject = rejectFn; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => { setImmediate(resolve); });
const ocrResult = ({ lineList = [{ text: '서울 182억', score: 0.95, left: 128, top: 360, width: 256, height: 36 }], verticalBoxRatio = 0 } = {}) => ({
  text: lineList.map((line) => line.text).join('\n'), lineList, meanScore: 0.95, verticalBoxRatio, imageWidth: 1280, imageHeight: 720,
});
const grayThumb = (value = 100) => ({ width: THUMB_WIDTH, height: THUMB_HEIGHT, data: new Uint8Array(THUMB_WIDTH * THUMB_HEIGHT).fill(value) });
const fakeImageOps = ({ size = { width: 1280, height: 720 }, thumb = grayThumb() } = {}) => ({
  readSize: () => size, toGrayThumbnail: () => thumb, cropToJpeg: () => Buffer.from('zoom'),
});

test('줄 위치를 화면 비율 좌표로 바꾼다(위치가 없는 줄은 뺀다)', () => {
  const lineList = toLayoutLineList({
    lineList: [{ text: '서울', score: 0.9, left: 128, top: 72, width: 256, height: 36 }, { text: '위치 없음', score: 0.9 }, { text: '  ', left: 0, top: 0, width: 1, height: 1 }],
    imageWidth: 1280, imageHeight: 720,
  });
  assert.deepEqual(lineList, [{ text: '서울', score: 0.9, rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.05 } }]);
  assert.deepEqual(toLayoutLineList({ lineList: [{ text: '서울', left: 1, top: 1, width: 1, height: 1 }], imageWidth: 0, imageHeight: 0 }), []);
});

test('위치 사전: 장마다 한 번만 OCR 하고, 다시 온 장(같은 major)은 저장분을 쓴다', async () => {
  const callList = [];
  const store = createSlideLayoutStore({
    recognize: async ({ jpegBuffer }) => { callList.push(jpegBuffer); return ocrResult(); }, imageOps: fakeImageOps(),
  });
  assert.equal(store.ensure({ slideLabel: '3', jpegBuffer: Buffer.from('a') }), true);
  assert.equal(store.ensure({ slideLabel: '3-2', jpegBuffer: Buffer.from('b') }), false);
  await flush();
  assert.equal(callList.length, 1);
  const entry = store.get('3-2');
  assert.equal(entry.status, SLIDE_LAYOUT_STATUS_MAP.ready);
  assert.equal(entry.layout.lineList[0].text, '서울 182억');
  assert.deepEqual(entry.layout.lineList[0].rect, { x: 0.1, y: 0.5, w: 0.2, h: 0.05 });
  assert.equal(entry.layout.aspect, 1280 / 720);
  assert.equal(entry.layout.thumb.data.length, THUMB_WIDTH * THUMB_HEIGHT);
  assert.equal(store.get('4').status, SLIDE_LAYOUT_STATUS_MAP.missing);
});

test('위치 사전: OCR 이 끝나기 전에는 pending 이고 get 은 기다리지 않는다', async () => {
  const pending = deferred();
  const store = createSlideLayoutStore({ recognize: () => pending.promise, imageOps: fakeImageOps() });
  store.ensure({ slideLabel: '1', jpegBuffer: Buffer.from('a') });
  const entry = store.get('1');
  assert.equal(entry.status, SLIDE_LAYOUT_STATUS_MAP.pending);
  assert.equal(entry.layout, null);
  pending.resolve(ocrResult());
  await flush();
  assert.equal(store.get('1').status, SLIDE_LAYOUT_STATUS_MAP.ready);
});

test('위치 사전: 실패는 failed, 세로 글씨 비율 0.2 이상·글자 없음은 none', async () => {
  const store = createSlideLayoutStore({
    recognize: async ({ jpegBuffer }) => {
      const kind = jpegBuffer.toString();
      if (kind === 'fail') throw new Error('OCR HTTP 500');
      if (kind === 'vertical') return ocrResult({ verticalBoxRatio: 0.2 });
      return ocrResult({ lineList: [] });
    },
    imageOps: fakeImageOps(),
  });
  store.ensure({ slideLabel: '1', jpegBuffer: Buffer.from('fail') });
  store.ensure({ slideLabel: '2', jpegBuffer: Buffer.from('vertical') });
  store.ensure({ slideLabel: '3', jpegBuffer: Buffer.from('empty') });
  await flush();
  assert.equal(store.get('1').status, SLIDE_LAYOUT_STATUS_MAP.failed);
  assert.equal(store.get('2').status, SLIDE_LAYOUT_STATUS_MAP.none);
  assert.equal(store.get('2').reason, 'vertical_text');
  assert.equal(store.get('3').status, SLIDE_LAYOUT_STATUS_MAP.none);
});

test('위치 사전: reset 은 비우고, 그 전에 보낸 OCR 결과가 늦게 와도 되살리지 않는다', async () => {
  const pending = deferred();
  const store = createSlideLayoutStore({ recognize: () => pending.promise, imageOps: fakeImageOps() });
  store.ensure({ slideLabel: '1', jpegBuffer: Buffer.from('a') });
  store.reset();
  pending.resolve(ocrResult());
  await flush();
  assert.equal(store.get('1').status, SLIDE_LAYOUT_STATUS_MAP.missing);
  assert.equal(store.ensure({ slideLabel: '1', jpegBuffer: Buffer.from('b') }), true);
});

test('같은 JPEG 는 /ocr 를 한 번만 보낸다(전사 백엔드 ocr 일 때 전사와 위치가 같은 결과를 쓴다)', async () => {
  const fetchList = [];
  const ocrClient = { recognize: async ({ jpegBuffer }) => { fetchList.push(jpegBuffer); return ocrResult(); }, isBypassed: () => false };
  const sharedOcrClient = createSharedOcrClient({ ocrClient });
  const slideTextAgent = createSlideTextAgent({ config: { slideTextBackend: 'ocr' }, ocrClient: sharedOcrClient });
  const store = createSlideLayoutStore({ recognize: sharedOcrClient.recognize, imageOps: fakeImageOps() });
  const jpegBuffer = Buffer.from('slide');
  const [transcribed] = await Promise.all([
    slideTextAgent.transcribe({ jpegBuffer }),
    (store.ensure({ slideLabel: '1', jpegBuffer }), flush()),
  ]);
  await flush();
  assert.equal(fetchList.length, 1);
  assert.equal(transcribed.text, '서울 182억');
  assert.equal(store.get('1').layout.lineList[0].text, '서울 182억');
  await sharedOcrClient.recognize({ jpegBuffer: Buffer.from('slide') });
  assert.equal(fetchList.length, 2, '다른 Buffer(다른 프레임)는 따로 보낸다');
  assert.equal(sharedOcrClient.isBypassed(), false);
});

// 신선도 — 전환 때 뽑아 둔 위치를 지금 화면에 써도 되는지
const layoutOf = ({ aspect = 16 / 9, thumb = grayThumb() } = {}) => ({ aspect, thumb, lineList: [] });
const targetRect = { x: 0.25, y: 0.25, w: 0.25, h: 0.25 };

test('신선도: 화면 비율이 2% 넘게 다르면 layout_changed', () => {
  assert.equal(MAX_ASPECT_DIFF, 0.02);
  const result = checkLayoutFreshness({ layout: layoutOf(), currentThumb: grayThumb(), currentAspect: (16 / 9) * 1.03, targetRect });
  assert.deepEqual([result.isFresh, result.reason], [false, FRESHNESS_REASON_MAP.layoutChanged]);
  assert.equal(checkLayoutFreshness({ layout: layoutOf(), currentThumb: grayThumb(), currentAspect: (16 / 9) * 1.01, targetRect }).isFresh, true);
});

test('신선도: 축소판 전체 평균 차이가 18/255 를 넘으면 slide_changed', () => {
  assert.equal(MAX_GLOBAL_DIFF, 18);
  const result = checkLayoutFreshness({ layout: layoutOf(), currentThumb: grayThumb(130), currentAspect: 16 / 9, targetRect });
  assert.deepEqual([result.isFresh, result.reason], [false, FRESHNESS_REASON_MAP.slideChanged]);
  assert.equal(result.globalDiff, 30);
});

test('신선도: 대상 상자 안이 바뀌면(평균 22 초과 또는 40단계 넘게 바뀐 화소 25% 초과) content_moved', () => {
  assert.equal(MAX_BOX_DIFF, 22);
  const moved = grayThumb();
  for (let y = 18; y < 36; y += 1) for (let x = 32; x < 64; x += 1) moved.data[y * THUMB_WIDTH + x] = 200;
  const result = checkLayoutFreshness({ layout: layoutOf(), currentThumb: moved, currentAspect: 16 / 9, targetRect });
  assert.deepEqual([result.isFresh, result.reason], [false, FRESHNESS_REASON_MAP.contentMoved]);
  assert.ok(result.globalDiff <= 18, `전체 차이 ${result.globalDiff}`);
});

test('신선도: 레이저 점·커서만한 작은 변화는 신선하다', () => {
  const dotted = grayThumb();
  for (let y = 25; y < 28; y += 1) for (let x = 45; x < 48; x += 1) dotted.data[y * THUMB_WIDTH + x] = 255;
  const result = checkLayoutFreshness({ layout: layoutOf(), currentThumb: dotted, currentAspect: 16 / 9, targetRect });
  assert.equal(result.isFresh, true);
  assert.equal(result.reason, null);
});

// Electron nativeImage 어댑터 — node 시험에서는 가짜 nativeImage 로 화소 계산만 본다.
function fakeNativeImage({ width = 1280, height = 720 } = {}) {
  const callList = [];
  const makeImage = (size) => ({
    isEmpty: () => false,
    getSize: () => size,
    crop: (rect) => { callList.push(['crop', rect]); return makeImage({ width: rect.width, height: rect.height }); },
    resize: (option) => { callList.push(['resize', option]); return makeImage({ width: option.width, height: option.height }); },
    toJPEG: (quality) => { callList.push(['toJPEG', quality]); return Buffer.from('jpeg'); },
    toBitmap: () => {
      const bitmap = Buffer.alloc(size.width * size.height * 4);
      for (let i = 0; i < size.width * size.height; i += 1) bitmap.set([10, 20, 30, 255], i * 4);
      return bitmap;
    },
  });
  return { callList, nativeImage: { createFromBuffer: () => makeImage({ width, height }) } };
}

test('잘라 키우기: 비율 상자를 화소로 바꿔 자르고 긴 변 1280 으로 키워 품질 92 JPEG 로 만든다', () => {
  assert.equal(ZOOM_LONG_EDGE, 1280);
  assert.equal(ZOOM_JPEG_QUALITY, 92);
  const { callList, nativeImage } = fakeNativeImage();
  const imageOps = createFrameImageOps({ nativeImage });
  const output = imageOps.cropToJpeg({ jpeg: Buffer.from('frame'), rect: { x: 0.3, y: 0.3, w: 0.4, h: 0.4 } });
  assert.ok(Buffer.isBuffer(output));
  assert.deepEqual(callList[0], ['crop', { x: 384, y: 216, width: 512, height: 288 }]);
  assert.deepEqual(callList[1][1].width, 1280);
  assert.deepEqual(callList[1][1].height, 720);
  assert.deepEqual(callList[2], ['toJPEG', 92]);
  assert.deepEqual(imageOps.readSize(Buffer.from('frame')), { width: 1280, height: 720 });
});

test('축소판: 128×72 회색(BGRA → 밝기)', () => {
  const { nativeImage } = fakeNativeImage();
  const thumb = createFrameImageOps({ nativeImage }).toGrayThumbnail(Buffer.from('frame'));
  assert.equal(thumb.width, 128);
  assert.equal(thumb.height, 72);
  assert.equal(thumb.data.length, 128 * 72);
  // B=10, G=20, R=30 → 0.299·30 + 0.587·20 + 0.114·10 = 21.85
  assert.equal(thumb.data[0], 22);
});

test('잘라 키우기: 디코드가 안 되면 null(확대 없이 지금 경로)', () => {
  const imageOps = createFrameImageOps({ nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) } });
  assert.equal(imageOps.cropToJpeg({ jpeg: Buffer.from('x'), rect: { x: 0, y: 0, w: 0.5, h: 0.5 } }), null);
  assert.equal(imageOps.readSize(Buffer.from('x')), null);
  assert.equal(imageOps.toGrayThumbnail(Buffer.from('x')), null);
});
