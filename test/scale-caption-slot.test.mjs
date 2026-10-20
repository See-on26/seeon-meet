import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assembleNarration, getSlotList } = require('../src/main/caption-pipeline/agents/shared/narration-format.js');
const { buildVisualDescriptionPrompt } = require('../src/main/caption-pipeline/prompts/visual-description.js');
const { parseSlotCaption } = require('../src/main/caption-pipeline/agents/shared/caption-parser.js');

// 척도 해설은 크기 묘사 한 구(caption)로 받는다. "○○보다 N배 큰 ○○" 네 칸으로는 "○○만 한", "○○의 절반쯤"을
// 말할 수 없고, 칸을 잇다 "보다보다"처럼 말이 겹쳤다.
const scale = (rawSlotMap, option = {}) => assembleNarration({
  narrationType: 'visual_description', subKind: 'scale', rawSlotMap, ...option,
});

test('척도 칸은 caption 하나이고 상한은 척도 어절 예산(8어절)이다', () => {
  const slotList = getSlotList({ narrationType: 'visual_description', subKind: 'scale' });
  assert.deepEqual(slotList.map((slot) => slot.key), ['caption']);
  assert.equal(slotList[0].minWordCount, 3);
  assert.equal(slotList[0].maxWordCount, 8);
  assert.equal(slotList[0].isPhrase, true);
});

test('척도 해설은 caption 을 그대로 읽는다(배수·"만 한"·"절반쯤" 꼴 모두)', () => {
  for (const caption of ['소나무보다 4배 정도 큰 불상', '탁구공만 한 우박 알갱이', '축구장 절반쯤 되는 주차장', '버스보다 작은 트럭']) {
    assert.equal(scale({ caption }).text, caption, caption);
  }
  assert.equal(scale({ caption: '' }), null);
  assert.equal(scale({ comparison: '소나무', scale: '4', direction: '큰', target: '불상' }), null, '옛 네 칸 답은 만들지 않는다');
});

test('척도 caption 이 상한을 넘으면 끝을 맺을 수 있는 데서 자른다', () => {
  const caption = '오른쪽에 함께 찍힌 3층짜리 학교 건물보다 두 배쯤 높은 시계탑';
  const text = scale({ caption }).text;
  assert.ok(text.split(' ').length <= 8, text);
  assert.ok(caption.startsWith(text), text);
});

test('영어 척도 해설도 caption 한 구를 읽고 첫 글자만 대문자로 바꾼다', () => {
  assert.equal(
    scale({ caption: 'a Buddha statue about four times taller than the pine tree' }, { language: 'en' }).text,
    'A Buddha statue about four times taller than the pine tree',
  );
});

test('척도 프롬프트는 caption 한 칸을 안내하고 옛 칸(comparison·direction·scale)과 옛 조립 꼴을 말하지 않는다', () => {
  for (const language of ['ko', 'en']) {
    const prompt = buildVisualDescriptionPrompt({ subKind: 'scale', utterance: '정말 크죠', language });
    assert.match(prompt, /"caption":/, language);
    assert.doesNotMatch(prompt, /"comparison"|"direction"|scale을 빈 문자열|times larger than \(comparison\)/, language);
  }
  const korean = buildVisualDescriptionPrompt({ subKind: 'scale', utterance: '정말 크죠' });
  assert.match(korean, /만 한/);
  assert.match(korean, /소나무보다 4배 정도 큰 불상/);
});

test('척도 칸 해설 파싱: JSON caption 을 읽고, 칸을 못 채우면 형식 오류다', () => {
  const option = { narrationType: 'visual_description', subKind: 'scale', maxChars: 36, maxWordCount: 8 };
  assert.equal(parseSlotCaption({ ...option, content: '{"caption":"소나무보다 4배 정도 큰 불상"}' }).text, '소나무보다 4배 정도 큰 불상');
  assert.equal(parseSlotCaption({ ...option, content: '{"caption":""}' }).rejectKind, 'format');
});
