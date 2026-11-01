import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildZoomImageIntroLineList, readPointingZoomKind, ZOOM_KIND_MAP,
} = require('../src/main/caption-pipeline/prompts/zoom-image-intro.js');
const { buildGroundingPrompt } = require('../src/main/caption-pipeline/prompts/deixis-resolution.js');
const { createSpeechRoiResolver } = require('../src/main/caption-pipeline/orchestrator/speech-roi/index.js');
const { SLIDE_LAYOUT_STATUS_MAP } = require('../src/main/caption-pipeline/orchestrator/speech-roi/slide-layout-store.js');

const ON = { isFactCompleteEnabled: true, isTimeMarkEnabled: true, isScreenValueFirstEnabled: true, isScaleValueFirstEnabled: true };
const OFF = { ...ON, isFactCompleteEnabled: false };
const NAME_LINE = '가리킨 대상의 이름(지명·항목명·제품명 등)은 화면에서 읽어 반드시 밝힌다 — 지시어로만 들은 청자는 그것이 어느 것인지 모른다.';
const APPEARED_LINE = '둘째 이미지는 같은 순간 발표자가 방금 화면에 띄운 그림·글을 확대한 것이다.';

const prompt = (option = {}) => buildGroundingPrompt({ utterance: '이거 읽어 보셨어요?', maxChars: 60, contentSwitch: ON, ...option });

// ── 확대 종류: 방금 나타난 그림 ──

test('확대 종류 appeared: 둘째 이미지를 발표자가 방금 화면에 띄운 그림·글의 확대로 안내한다', () => {
  assert.equal(ZOOM_KIND_MAP.appeared, 'appeared');
  const lineList = buildZoomImageIntroLineList({ zoomKind: ZOOM_KIND_MAP.appeared });
  assert.equal(lineList[0], '첫째 이미지는 회의에서 공유 중인 화면 전체다.');
  assert.equal(lineList[1], APPEARED_LINE);
  assert.equal(lineList[lineList.length - 1], '이미지가 두 장이라는 것, 확대했다는 것은 출력에 쓰지 않는다.');
  assert.ok(lineList.every((line) => !line.includes('필기하거나 포인터')));
  // 발화 낱말은 나타난 그림 안내에 넣지 않는다.
  assert.deepEqual(buildZoomImageIntroLineList({ zoomKind: ZOOM_KIND_MAP.appeared, zoomTerm: '서울' }), lineList);
});

test('확대 종류 appeared: 지시 프롬프트 첫 줄이 두 장 안내로 바뀌고 한 장 안내는 없다', () => {
  const appeared = prompt({ subKind: 'simple', zoomKind: ZOOM_KIND_MAP.appeared });
  assert.ok(appeared.startsWith(`첫째 이미지는 회의에서 공유 중인 화면 전체다.\n${APPEARED_LINE}\n`));
  assert.doesNotMatch(appeared, /이 이미지는/);
});

test('기존 확대 종류(발화·가리킴·묶음) 안내는 그대로다', () => {
  assert.equal(buildZoomImageIntroLineList({ zoomKind: ZOOM_KIND_MAP.pointing })[1],
    '둘째 이미지는 같은 순간 그 화면에서 발표자가 방금 필기하거나 포인터로 가리킨 영역을 확대한 것이다.');
  assert.equal(buildZoomImageIntroLineList({ zoomKind: ZOOM_KIND_MAP.speech, zoomTerm: '서울' })[1],
    '둘째 이미지는 같은 순간 그 화면에서 발화에 나온 "서울"에 해당하는 글자가 있는 곳 둘레를 확대한 것이다.');
  assert.deepEqual(buildZoomImageIntroLineList({ zoomKind: 'unknown' }), []);
});

test('렌더러가 보낸 비율 상자의 종류로 가리킴 짝의 확대 종류를 정한다(나타난 그림이 아니면 가리킴)', () => {
  assert.equal(readPointingZoomKind({ x: 0.1, y: 0.2, w: 0.3, h: 0.6, kind: 'appeared' }), ZOOM_KIND_MAP.appeared);
  assert.equal(readPointingZoomKind({ x: 0.1, y: 0.2, w: 0.3, h: 0.6 }), ZOOM_KIND_MAP.pointing);
  assert.equal(readPointingZoomKind({ x: 0.1, y: 0.2, w: 0.3, h: 0.6, kind: 'speech' }), ZOOM_KIND_MAP.pointing);
  assert.equal(readPointingZoomKind(null), ZOOM_KIND_MAP.pointing);
});

test('나타난 그림 비율 상자(종류가 붙음)도 가리킴 짝 경로로 [전체, 렌더러가 자른 그림] 두 장이 된다', () => {
  const regionFrame = Buffer.from('appeared-region');
  const resolver = createSpeechRoiResolver({
    config: { speechRoiMode: 'on', speechRoiTypeList: ['deixis'], isSpeechRoiFrameOcrEnabled: false, isSpeechRoiPointingPairEnabled: true },
    layoutStore: { get: () => ({ status: SLIDE_LAYOUT_STATUS_MAP.missing, layout: null }) },
    imageOps: { readSize: () => ({ width: 1280, height: 720 }), toGrayThumbnail: () => null, cropToJpeg: () => null },
  });
  const result = resolver.resolve({
    narrationType: 'deixis', subKind: 'simple', utterance: '이거 보시면 됩니다', anchor: '이거', slideLabel: '1',
    screenFrame: Buffer.from('screen'), frameLayout: null, regionFrame,
    pointingRect: { x: 0.0638, y: 0.1367, w: 0.2788, h: 0.8378, kind: 'appeared' },
  });
  assert.equal(result.zoomJpegBuffer, regionFrame);
  // 확대 종류는 리졸버가 정한다: 비율 상자의 종류를 readPointingZoomKind 로 읽으면 appeared, 읽지 않으면 pointing 이다.
  assert.ok([ZOOM_KIND_MAP.pointing, ZOOM_KIND_MAP.appeared].includes(result.zoomKind), result.zoomKind);
  assert.equal(result.record.hasPointingRect, true);
});

// ── 상품명 읽기 규칙 ──

const PACKAGE_RULE_PATTERN = /가리킨 대상이 상품 포장·책 표지·간판·로고처럼 그림 안에 이름이 크게 적힌 것이면, 그 그림에서 가장 크게 적힌 이름 글자\(상품명·브랜드·제목·상호\)를 읽어 /;
const LETTER_RULE = '장식 글꼴·기울어진 로고는 한 글자씩 읽는다. 확실히 읽지 못한 글자를 비슷한 낱말로 지어내지 마라 — 못 읽으면 그 이름은 뺀다.';

test('상품명 규칙: 단순형·완전형·형식 미정 모두 이름 줄 바로 뒤에 들어간다', () => {
  for (const subKind of ['simple', 'complete', null]) {
    for (const contentSwitch of [ON, OFF]) {
      const lineList = prompt({ subKind, contentSwitch }).split('\n');
      const nameIndex = lineList.indexOf(NAME_LINE);
      assert.ok(nameIndex > 0, `${subKind}`);
      assert.match(lineList[nameIndex + 1], PACKAGE_RULE_PATTERN, `${subKind}`);
      assert.match(lineList[nameIndex + 1], /그림 바깥의 제목·설명 글만으로 끝내지 않는다\.$/);
      assert.equal(lineList[nameIndex + 2], LETTER_RULE, `${subKind}`);
    }
  }
});

test('상품명 규칙: 이름은 단순형이면 fact 칸에, 완전형이면 대상 이름 곁에, 사실 칸을 끄면 caption 에 쓴다', () => {
  assert.match(prompt({ subKind: 'simple' }), /상호\)를 읽어 fact 칸에 쓴다\./);
  assert.match(prompt({ subKind: 'complete' }), /상호\)를 읽어 대상 이름 곁에 붙인다\./);
  assert.match(prompt({ subKind: null }), /상호\)를 읽어 fact 칸에 쓴다\(완전형은 대상 이름 곁에 붙인다\)\./);
  for (const subKind of ['simple', 'complete', null]) {
    assert.match(prompt({ subKind, contentSwitch: OFF }), /상호\)를 읽어 caption 에 대상 이름과 함께 쓴다\./, `${subKind}`);
  }
});

test('상품명 규칙 예시: 평가 영상과 겹치지 않는 책 표지이고, 칸 구성에 맞춘다', () => {
  const simple = prompt({ subKind: 'simple' });
  assert.match(simple, /예\) "이 책 읽어 보셨어요\?" → seen="이번 달 추천 도서 글, 푸른 등대 제목이 크게 적힌 책 표지", caption="이번 달 추천 도서", fact="푸른 등대"/);
  assert.match(prompt({ subKind: 'simple', contentSwitch: OFF }),
    /예\) "이 책 읽어 보셨어요\?" → seen="이번 달 추천 도서 글, 푸른 등대 제목이 크게 적힌 책 표지", caption="이번 달 추천 도서 푸른 등대"\n/);
  // 완전형은 대상이 여럿이라 한 대상 예시를 붙이지 않는다.
  assert.doesNotMatch(prompt({ subKind: 'complete' }), /푸른 등대/);
  for (const subKind of ['simple', 'complete', null]) {
    for (const contentSwitch of [ON, OFF]) {
      const text = prompt({ subKind, contentSwitch });
      for (const word of ['젤리', '왕꿈틀이', '간식', '최애', '과자']) assert.ok(!text.includes(word), `${subKind}: ${word}`);
    }
  }
});
