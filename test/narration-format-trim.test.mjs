import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  assembleNarration, trimToCompletePhrase, pairTargetItemListWithValueList,
} = require('../src/main/caption-pipeline/agents/shared/narration-format.js');
const { parseSlotCaption } = require('../src/main/caption-pipeline/agents/shared/caption-parser.js');

// 해설 칸을 상한에 맞춰 자를 때 생기던 결함: 숫자에 붙은 기한을 덜 끝난 말로 지움, 숫자 안의 쉼표에서 항목을 나눔,
// 값 목록을 항목 가운데에서 자름, 대상 칸·값 칸에 나눠 쓴 짝이 어긋남, 조립한 해설에 전체 예산이 적용되지 않음.
const claim = ({ target, value, ...option }) => assembleNarration({
  narrationType: 'interpretation', subKind: 'claim_to_value', rawSlotMap: { target, value }, ...option,
})?.text ?? null;

test('기한: 숫자에 붙은 "까지·부터"는 덜 끝난 말이 아니라 남긴다(숫자 없는 꼬리는 지금처럼 뗀다)', () => {
  assert.equal(trimToCompletePhrase({ text: '신청 마감 20일까지', isConservative: true }), '신청 마감 20일까지');
  assert.equal(trimToCompletePhrase({ text: '할인 기간 오후 3시부터', isConservative: true }), '할인 기간 오후 3시부터');
  assert.equal(trimToCompletePhrase({ text: '접수 기간 2026년부터', isConservative: true }), '접수 기간 2026년부터');
  assert.equal(trimToCompletePhrase({ text: '제출 마감 오후까지', isConservative: true }), '제출 마감');
});

test('쉼표: 숫자 안의 쉼표("1,250명")에서는 항목을 나누지 않는다', () => {
  assert.equal(
    claim({ target: '지점별 방문객', value: '서울 지점 1,250명, 부산 지점 980명, 대구 지점' }),
    '지점별 방문객, 서울 1,250명, 부산 980명',
  );
  assert.equal(claim({ target: '주말 방문객', value: '1,250명에서 1,830명' }), '주말 방문객, 1,250명에서 1,830명');
});

test('목록: 값 칸 상한을 넘으면 쉼표로 나뉜 항목을 통째로 넣고 빼며, 항목마다 되풀이된 낱말을 먼저 뺀다', () => {
  // 항목 가운데에서 자르면 "2분기 신규"처럼 숫자가 든 이름만 남아 값처럼 읽힌다.
  assert.equal(
    claim({ target: '신규 고객', value: '1분기 신규 고객 120명, 2분기 신규 고객 150명' }),
    '신규 고객, 1분기 120명, 2분기 150명',
  );
  assert.equal(
    claim({ target: '시험 점수', value: '1차 시험 82점, 2차 시험 88점, 3차 시험 91점, 4차 시험 95점' }),
    '시험 점수, 1차 82점, 2차 88점, 3차 91점',
  );
});

test('목록: 첫 항목부터 상한을 넘으면 예전처럼 어절에서 자른다', () => {
  assert.equal(
    claim({ target: '처리 기간', value: '3일에서 1일로 줄어든 평균 처리 기간과 그 밖의 지표' }),
    '처리 기간, 3일에서 1일로 줄어든 평균 처리',
  );
});

test('짝짓기: 대상 칸의 조건 목록과 값 칸의 이름 없는 값 목록은 순서대로 짝지어 값 칸으로 옮긴다', () => {
  assert.deepEqual(
    pairTargetItemListWithValueList({ target: '본관 방문객 수, 별관 방문객 수', value: '320명, 140명' }),
    { target: '방문객 수', value: '본관 320명, 별관 140명' },
  );
  assert.equal(claim({ target: '본관 방문객 수, 별관 방문객 수', value: '320명, 140명' }), '방문객 수, 본관 320명, 별관 140명');
  // 끝말 앞의 기능어("후")는 끝말로 묶지 않는다.
  assert.deepEqual(
    pairTargetItemListWithValueList({ target: '운동 후 맥박, 휴식 후 맥박', value: '120, 72' }),
    { target: '맥박', value: '운동 후 120, 휴식 후 72' },
  );
});

test('짝짓기: 항목 수가 다르거나, 값에 이름이 붙어 있거나, 같은 끝말이 없으면 그대로 둔다', () => {
  assert.equal(pairTargetItemListWithValueList({ target: '본관 방문객 수, 별관 방문객 수', value: '320명' }), null);
  assert.equal(pairTargetItemListWithValueList({ target: '본관 방문객 수, 별관 방문객 수', value: '본관 320명, 별관 140명' }), null);
  assert.equal(pairTargetItemListWithValueList({ target: '식사 전, 식사 후', value: '90, 140' }), null);
  assert.equal(pairTargetItemListWithValueList({ target: '방문객 수', value: '320명' }), null);
});

test('짝짓기: 영어 캡션도 같은 규칙으로 짝짓는다', () => {
  assert.equal(
    claim({ target: 'downtown visitors, suburb visitors', value: '320, 140', language: 'en' }),
    'Visitors, downtown 320, suburb 140',
  );
});

test('전체 예산: 조립한 해설이 어절 예산을 넘으면 되풀이 낱말 → 대상 앞 꾸밈말(끝 2어절은 남김) → 값 뒤 항목 순으로 줄인다', () => {
  assert.equal(
    claim({ target: '올해 상반기 신규 가입자', value: '서울 1,200명, 부산 800명, 대구 500명', maxWordCount: 6 }),
    '신규 가입자, 서울 1,200명, 부산 800명',
  );
  assert.equal(
    claim({ target: '올해 상반기 신규 가입자', value: '서울 1,200명, 부산 800명, 대구 500명' }),
    '올해 상반기 신규 가입자, 서울 1,200명, 부산 800명, 대구 500명',
    '예산을 주지 않으면 칸 상한만 쓴다',
  );
});

test('전체 예산: 칸 해설 파싱은 글자 상한(maxChars)도 조립에 넘긴다', () => {
  const content = JSON.stringify({ target: '신규 가입자', value: '서울 1,200명, 부산 800명, 대구 500명' });
  const option = { content, narrationType: 'interpretation', subKind: 'claim_to_value', maxWordCount: 12 };
  assert.equal(parseSlotCaption({ ...option, maxChars: 60 }).text, '신규 가입자, 서울 1,200명, 부산 800명, 대구 500명');
  const fitted = parseSlotCaption({ ...option, maxChars: 30 });
  assert.equal(fitted.isGrounded, true);
  assert.equal(fitted.text, '신규 가입자, 서울 1,200명, 부산 800명');
  assert.ok(fitted.text.length <= 30, fitted.text);
});
