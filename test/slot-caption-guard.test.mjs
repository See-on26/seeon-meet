import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseSlotCaption, stripMathMarkup, REJECT_KIND_MAP } = require('../src/main/caption-pipeline/agents/shared/caption-parser.js');

const deixisOption = { narrationType: 'deixis', subKind: 'simple', maxChars: 80, maxWordCount: 12 };

test('읽어 줄 칸이 NONE 이면 해설로 읽지 않고 거절로 본다(Gemma 가 JSON 칸에 거절을 넣은 실제 사례)', () => {
  for (const caption of ['NONE', 'none', 'NONE: 가리킨 곳에 글자가 없음', '"NONE"']) {
    const result = parseSlotCaption({ ...deixisOption, content: JSON.stringify({ seen: '빈 배경', caption }) });
    assert.equal(result.isGrounded, false, caption);
    assert.equal(result.text, '');
    assert.equal(result.rejectKind, REJECT_KIND_MAP.none);
  }
  const withReason = parseSlotCaption({ ...deixisOption, content: '{"seen":"빈 배경","caption":"NONE: 가리킨 곳에 글자가 없음"}' });
  assert.equal(withReason.rejectReason, '가리킨 곳에 글자가 없음');
});

test('진단 칸 seen 이 NONE 이어도 읽어 줄 칸이 있으면 그대로 낸다', () => {
  const result = parseSlotCaption({ ...deixisOption, content: '{"seen":"NONE","caption":"제출 마감 3월 5일"}' });
  assert.equal(result.isGrounded, true);
  assert.equal(result.text, '제출 마감 3월 5일');
});

test('문장 가운데의 NONE·None 같은 낱말은 거절이 아니다', () => {
  const result = parseSlotCaption({ ...deixisOption, content: '{"seen":"설정 창","caption":"Proxy 설정 값 None, 포트 8080"}' });
  assert.equal(result.isGrounded, true);
  assert.equal(result.text, 'Proxy 설정 값 None, 포트 8080');
});

test('LaTeX 수식은 읽는 글로 바꾼다: 숫자 첨자는 위·아래 첨자 글자로, 나머지 기호는 걷는다', () => {
  assert.equal(stripMathMarkup('$w_{2,1}^3$, $w_{3,1}^3$'), 'w₂,₁³, w₃,₁³');
  assert.equal(stripMathMarkup('$a_{1}^{3}$ 노드'), 'a₁³ 노드');
  assert.equal(stripMathMarkup('$x^2 + y^2$'), 'x² + y²');
  assert.equal(stripMathMarkup('$\\frac{1}{2} \\times n$'), '1/2 × n');
  assert.equal(stripMathMarkup('$h_{\\theta}(x)$'), 'htheta(x)');
});

test('수식 표시가 없으면 밑줄·기호를 건드리지 않는다', () => {
  for (const text of ['a1_diff = 2*mean(error)', 'Test loss 0.522', 'R^2 0.91', '1,250명 중 62명']) {
    assert.equal(stripMathMarkup(text), text);
  }
});

test('해설 칸의 LaTeX 는 내보내기 전에 걷는다', () => {
  const result = parseSlotCaption({ ...deixisOption, content: '{"seen":"화살표","caption":"$w_{2,1}^3$, $w_{3,1}^3$"}' });
  assert.equal(result.isGrounded, true);
  assert.equal(result.text, 'w₂,₁³, w₃,₁³');
});
