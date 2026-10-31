import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { verifyFactCardValues } = require('../src/main/caption-pipeline/orchestrator/fact-card-store.js');

// 카드의 숫자는 같은 장의 슬라이드 전사 글자에 있을 때만 남긴다. 막대 높이를 어림한 값은 전사에 나오지 않아 여기서 걸린다.
const card = (extra = {}) => ({
  id: '3:1', kind: 'chart', title: '지역별 판매량', position: '왼쪽', period: '', unit: '천 대',
  axisList: [], legendList: [], headerList: [], itemList: [], count: 0, ...extra,
});
const item = (label, value, note = '') => ({ label, value, note });
const ready = (text) => ({ status: 'ready', text });

test('전사에 없는 숫자를 가진 값은 비우고 항목 이름은 남긴다. 있으면 확인됨으로 표시한다', () => {
  const result = verifyFactCardValues({
    cardList: [card({ itemList: [item('서울', '2023 410, 2024 520'), item('부산', '2023 300, 2024 280')] })],
    slideText: ready('지역별 판매량\n서울 410 520\n부산 300\n2023 2024'),
  });
  assert.deepEqual(result.cardList[0].itemList, [
    { label: '서울', value: '2023 410, 2024 520', note: '', isValueVerified: true },
    { label: '부산', value: '', note: '', isValueVerified: false },
  ]);
  assert.equal(result.cardList[0].droppedValueCount, 1);
  assert.equal(result.checkedValueCount, 2);
  assert.equal(result.droppedValueCount, 1);
});

test('천 단위 쉼표는 같은 수로 본다("2,318" ↔ "2318")', () => {
  const result = verifyFactCardValues({
    cardList: [card({ itemList: [item('체험 계정', '2,318건'), item('누적', '10450명')] })],
    slideText: ready('체험 계정 2318건\n누적 10,450명'),
  });
  assert.deepEqual(result.cardList[0].itemList.map((entry) => entry.isValueVerified), [true, true]);
});

test('"73" 은 "173"·"73.5" 에 맞지 않는다', () => {
  const result = verifyFactCardValues({
    cardList: [card({ itemList: [item('만족도', '73%')] })],
    slideText: ready('만족도 173%\n재구매 73.5%'),
  });
  assert.equal(result.cardList[0].itemList[0].value, '');
  assert.equal(result.cardList[0].itemList[0].isValueVerified, false);
});

test('전사가 "글자 없음"(none)인데 카드에 숫자 값이 있으면 그림만 보고 지어낸 값이라 모두 비운다', () => {
  const result = verifyFactCardValues({
    cardList: [card({ itemList: [item('서울', '410'), item('등급', '높음')], axisList: [{ name: '판매량', from: '0', to: '800' }] })],
    slideText: { status: 'none', text: '' },
  });
  assert.deepEqual(result.cardList[0].itemList.map((entry) => [entry.value, entry.isValueVerified]), [['', false], ['높음', null]]);
  assert.deepEqual(result.cardList[0].axisList, [{ name: '판매량', from: '', to: '' }]);
  assert.equal(result.droppedValueCount, 3);
});

test('전사가 실패했으면 값을 두고 확인 안 됨(null)으로 둔다(해설 순간 같은 프레임 OCR 이 한 번 더 거른다)', () => {
  for (const slideText of [{ status: 'failed', text: '' }, { status: 'missing', text: '' }, { status: 'pending', text: '' }, undefined]) {
    const result = verifyFactCardValues({
      cardList: [card({ period: '2023~2024', itemList: [item('서울', '410')], axisList: [{ name: '판매량', from: '0', to: '800' }] })],
      slideText,
    });
    assert.deepEqual(result.cardList[0].itemList[0], { label: '서울', value: '410', note: '', isValueVerified: null }, JSON.stringify(slideText));
    assert.equal(result.cardList[0].period, '2023~2024');
    assert.deepEqual(result.cardList[0].axisList[0], { name: '판매량', from: '0', to: '800' });
    assert.equal(result.checkedValueCount, 0);
    assert.equal(result.droppedValueCount, 0);
  }
});

test('숫자가 없는 값과 빈 값은 검사하지 않고 그대로 둔다', () => {
  const result = verifyFactCardValues({
    cardList: [card({ itemList: [item('위험도', '높음'), item('신용', 'A등급'), item('비고', '')] })],
    slideText: ready('위험도 높음'),
  });
  assert.deepEqual(result.cardList[0].itemList.map((entry) => [entry.value, entry.isValueVerified]), [['높음', null], ['A등급', null], ['', null]]);
  assert.equal(result.checkedValueCount, 0);
});

test('축 눈금과 기간의 숫자도 검사한다', () => {
  const result = verifyFactCardValues({
    cardList: [card({
      period: '2023~2024',
      axisList: [{ name: '판매량', from: '0', to: '800' }, { name: '지역', from: '서울', to: '강원' }],
    })],
    slideText: ready('판매량(천 대) 0 200 400 600\n서울 강원\n2023년 실적'),
  });
  const [verified] = result.cardList;
  assert.equal(verified.period, '', '2024 가 전사에 없다');
  assert.deepEqual(verified.axisList, [{ name: '판매량', from: '0', to: '' }, { name: '지역', from: '서울', to: '강원' }]);
  assert.equal(result.checkedValueCount, 3);
  assert.equal(result.droppedValueCount, 2);
});

test('입력 카드를 바꾸지 않는다', () => {
  const cardList = [card({ itemList: [item('서울', '999')] })];
  const snapshot = JSON.stringify(cardList);
  verifyFactCardValues({ cardList, slideText: ready('서울 410') });
  assert.equal(JSON.stringify(cardList), snapshot);
});
