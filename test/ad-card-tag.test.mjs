import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveAdCardTag, DEFAULT_AD_CARD_TAG } from '../src/renderer/core/ui/ad-card-tag.js';
import { NARRATION_CLASS_MAP } from '../src/renderer/core/constants.js';
import { UI_TEXT_MAP } from '../src/renderer/core/i18n/ui-text.js';

const readSource = (relativePath) => fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('카드 코드와 라벨은 재생 분류로 정한다', () => {
  assert.deepEqual(resolveAdCardTag({ narrationClass: 'page_transition', source: 'page-transition' }), { aid: 'A1', labelKey: 'card.pageTransition' });
  assert.deepEqual(resolveAdCardTag({ narrationClass: 'deixis', source: 'deixis' }), { aid: 'A2', labelKey: 'card.deixis' });
  assert.deepEqual(resolveAdCardTag({ narrationClass: 'speech_based', source: 'interpretation' }), { aid: 'A3', labelKey: 'card.speechBased' });
  assert.deepEqual(resolveAdCardTag({ narrationClass: 'silence_based', source: 'visual_description' }), { aid: 'A4', labelKey: 'card.silenceBased' });
  assert.deepEqual(resolveAdCardTag({ narrationClass: 'speaker_identity', source: 'speaker_identity' }), { aid: 'A5', labelKey: 'card.speakerIdentity' });
  assert.deepEqual(resolveAdCardTag({ narrationClass: 'user_command', source: 'user_command' }), { aid: 'Q', labelKey: 'card.userCommand' });
});

test('시각 묘사는 경로의 재생 분류를 따라 척도는 A3, 무발화는 A4, 사진 단독 화면은 A1 이다', () => {
  assert.equal(resolveAdCardTag({ narrationClass: 'speech_based', source: 'visual_description' }).aid, 'A3');
  assert.equal(resolveAdCardTag({ narrationClass: 'silence_based', source: 'visual_description' }).aid, 'A4');
  assert.deepEqual(resolveAdCardTag({ narrationClass: 'page_transition', source: 'visual_description' }), { aid: 'A1', labelKey: 'card.pageTransition' });
});

test('재생 분류가 없을 때만 source 로 찾는다', () => {
  assert.equal(resolveAdCardTag({ source: 'page-transition' }).aid, 'A1');
  assert.equal(resolveAdCardTag({ source: 'page_transition' }).aid, 'A1');
  assert.equal(resolveAdCardTag({ source: 'deixis' }).aid, 'A2');
  assert.equal(resolveAdCardTag({ narrationClass: null, source: 'interpretation' }).aid, 'A3');
  assert.equal(resolveAdCardTag({ source: 'speaker_identity' }).aid, 'A5');
  assert.equal(resolveAdCardTag({ source: 'user_command' }).aid, 'Q');
});

test('경로를 알 수 없는 시각 묘사와 모르는 값은 기본 카드다', () => {
  assert.deepEqual(DEFAULT_AD_CARD_TAG, { aid: '·', labelKey: 'card.default' });
  assert.deepEqual(resolveAdCardTag({ source: 'visual_description' }), DEFAULT_AD_CARD_TAG);
  assert.deepEqual(resolveAdCardTag({ narrationClass: 'unknown', source: 'deixis' }), DEFAULT_AD_CARD_TAG);
  assert.deepEqual(resolveAdCardTag({}), DEFAULT_AD_CARD_TAG);
});

test('재생 분류 7종의 카드 라벨은 아키텍처 이름이고 영어 라벨도 있다', () => {
  const labelOf = (language, narrationClass) => UI_TEXT_MAP[language][resolveAdCardTag({ narrationClass }).labelKey];
  const classList = Object.values(NARRATION_CLASS_MAP);
  assert.deepEqual(classList.map((narrationClass) => labelOf('ko', narrationClass)), [
    '질문 답', '페이지 전환', '지시 대상', '발화 기반', '무발화 기반', '화자 식별', '화면 변화',
  ]);
  assert.deepEqual(classList.map((narrationClass) => labelOf('en', narrationClass)), [
    'Answer', 'Page change', 'Pointed item', 'Speech-based', 'Silence-based', 'Speaker', 'Screen change',
  ]);
});

test('옛 카드 라벨 키(수치 의미·시각 정보)는 없다', () => {
  for (const language of ['ko', 'en']) {
    assert.equal(UI_TEXT_MAP[language]['card.interpretation'], undefined, language);
    assert.equal(UI_TEXT_MAP[language]['card.visualDescription'], undefined, language);
  }
});

test('main.js 카드는 payload 의 재생 분류를 넘겨 공용 표로 코드를 고른다', () => {
  const source = readSource('src/renderer/app/main.js');
  assert.doesNotMatch(source, /LOG_TAG_MAP/);
  assert.match(source, /function appendLogCard\(\{ narrationClass = null, source, text, ts = Date\.now\(\) \}\)/);
  assert.match(source, /const tag = resolveAdCardTag\(\{ narrationClass, source \}\);/);
  assert.match(source, /function handleCaption\(\{ text, source, narrationClass = null, eventVideoTimeMs = null \}\) \{\n {2}appendLogCard\(\{ narrationClass, source, text \}\);/);
});
