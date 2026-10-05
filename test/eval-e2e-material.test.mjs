import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readRunMaterial, selectSlideList, buildMaterialBlockList, buildHumanAdText, MATERIAL_SKIP_REASON_MAP,
} from '../tools/eval/lib/e2e-material.mjs';
import { buildAnswerRequest, buildChoiceList, SYSTEM_PROMPT_MAP, INSTRUCTION_KIND_MAP } from '../tools/eval/lib/e2e-prompt.mjs';
import { parseAnswerText, scoreAnswer } from '../tools/eval/lib/answer-parse.mjs';

function writeRunDir() {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-run-'));
  fs.writeFileSync(path.join(runDir, 'transcript.txt'), '[00:01] 이 부분이요\n[00:05] 30%예요\n');
  fs.writeFileSync(path.join(runDir, 'transcript.json'), JSON.stringify({
    utteranceList: [{ startMs: 1000, endMs: 3000, text: '이 부분이요' }, { startMs: 5000, endMs: 6000, text: '30%예요' }],
  }));
  fs.writeFileSync(path.join(runDir, 's-condition.txt'), '[00:01] 이 부분이요\n[00:03] (화면 해설) 재구매율 막대 30%\n[00:05] 30%예요\n');
  fs.mkdirSync(path.join(runDir, 'slides'));
  fs.writeFileSync(path.join(runDir, 'slides', 'slide-1.jpg'), 'jpg-bytes');
  fs.writeFileSync(path.join(runDir, 'slides.json'), JSON.stringify({ slideList: [{ label: '1', startMediaMs: 0, file: 'slides/slide-1.jpg' }] }));
  return runDir;
}

const question = {
  id: 'q-1', videoId: 'v1', category: '조각', subcategory: '수치 의미 파악',
  question: '30%는 무엇의 수치인가?', choiceList: ['재구매율', '이탈률', '전환율', '응답률'], answerIndex: 0,
};

test('조건별 자료: A 전사, S 전사+AD, H 전사+사람 AD, C 슬라이드 이미지+전사, V 이미지만, N 없음', () => {
  const material = readRunMaterial({ runDir: writeRunDir() });
  const textOf = (blockList) => blockList.filter((block) => block.text).map((block) => block.text).join('\n');
  assert.match(textOf(buildMaterialBlockList({ kind: 'A', material }).blockList), /^\[발표 전사\]\n\[00:01\] 이 부분이요/);
  assert.match(textOf(buildMaterialBlockList({ kind: 'S', material }).blockList), /\(화면 해설\) 재구매율 막대 30%/);
  assert.deepEqual(buildMaterialBlockList({ kind: 'H', material, humanAdList: [] }), { blockList: null, skipReason: MATERIAL_SKIP_REASON_MAP.noHumanAd });
  assert.match(textOf(buildMaterialBlockList({ kind: 'H', material, humanAdList: [{ startMs: 4000, text: '막대: 재구매율 30%' }] }).blockList),
    /\[00:04\] \(화면 해설\) 막대: 재구매율 30%/);
  const screen = buildMaterialBlockList({ kind: 'C', material }).blockList;
  assert.deepEqual(screen.map((block) => Object.keys(block)[0]), ['text', 'image', 'text']);
  assert.equal(screen[1].image.format, 'jpeg');
  assert.equal(Buffer.from(screen[1].image.source.bytes, 'base64').toString(), 'jpg-bytes');
  assert.deepEqual(buildMaterialBlockList({ kind: 'V', material }).blockList.map((block) => Object.keys(block)[0]), ['text', 'image']);
  assert.deepEqual(buildMaterialBlockList({ kind: 'N', material: null }), { blockList: [], skipReason: null });
  assert.deepEqual(buildMaterialBlockList({ kind: 'A', material: null }), { blockList: null, skipReason: MATERIAL_SKIP_REASON_MAP.noRunDir });
  assert.deepEqual(buildMaterialBlockList({ kind: 'C', material: { ...material, slideList: [] } }).skipReason, MATERIAL_SKIP_REASON_MAP.noSlide);
});

test('슬라이드가 최대 장수보다 많으면 처음·끝을 포함해 고르게 고른다', () => {
  const slideList = Array.from({ length: 10 }, (_unused, index) => ({ label: String(index + 1) }));
  assert.deepEqual(selectSlideList({ slideList, maxSlideCount: 4 }).map((slide) => slide.label), ['1', '4', '7', '10']);
  assert.equal(selectSlideList({ slideList, maxSlideCount: 20 }).length, 10);
});

test('사람 작성 AD 는 S 조건과 같은 표기로 전사에 끼운다', () => {
  assert.equal(buildHumanAdText({
    utteranceList: [{ startMs: 1000, endMs: 2000, text: '말' }], humanAdList: [{ startMs: 500, text: '그림' }],
  }), '[00:00] (화면 해설) 그림\n[00:01] 말');
});

test('평가 프롬프트에만 "제공된 자료만 근거로 답하라"가 있고 보기 5번은 알 수 없음이다', () => {
  assert.match(SYSTEM_PROMPT_MAP[INSTRUCTION_KIND_MAP.eval], /제공된 자료만 근거로 답하라/);
  assert.doesNotMatch(SYSTEM_PROMPT_MAP[INSTRUCTION_KIND_MAP.filter], /제공된 자료만/);
  assert.deepEqual(buildChoiceList({ question }), ['재구매율', '이탈률', '전환율', '응답률', '알 수 없음']);
  const request = buildAnswerRequest({ instructionKind: INSTRUCTION_KIND_MAP.eval, materialBlockList: [{ text: '자료' }], question });
  assert.equal(request.messageList[0].content.length, 2);
  assert.match(request.messageList[0].content[1].text, /5\. 알 수 없음/);
});

test('답 번호는 JSON 을 먼저 읽고 아니면 느슨하게 찾으며 못 읽으면 응답 오류다', () => {
  assert.deepEqual(parseAnswerText('```json\n{"answer": 1, "reason": "전사에 있음"}\n```'), { choiceNumber: 1, reason: '전사에 있음' });
  assert.equal(parseAnswerText('정답: 3번입니다').choiceNumber, 3);
  assert.equal(parseAnswerText('5').choiceNumber, 5);
  assert.equal(parseAnswerText('{"answer": 7}').choiceNumber, null);
  assert.equal(parseAnswerText('잘 모르겠습니다').choiceNumber, null);
  assert.deepEqual(scoreAnswer({ question, choiceNumber: 1 }), { chosenIndex: 0, isUnknown: false, isCorrect: true, isResponseError: false });
  assert.deepEqual(scoreAnswer({ question, choiceNumber: 5 }), { chosenIndex: 4, isUnknown: true, isCorrect: false, isResponseError: false });
  assert.deepEqual(scoreAnswer({ question, choiceNumber: null }), { chosenIndex: null, isUnknown: false, isCorrect: false, isResponseError: true });
});

const choiceTextList = buildChoiceList({ question });

test('읽을 수 없는 답에서 보기를 지어내지 않는다', () => {
  const rowList = [
    ['{"answer": 12}', null],
    ['{"answer": true}', null],
    ['{"answer": "2번 같아요"}', null],
    ['1번은 오답이고 정답은 3번입니다', 3],
    ['3개의 막대 중 두 번째가 맞으므로 2번', 2],
    ['정답은 2번입니다. 아니, 보기 3번이 맞습니다', null],
    ['3번이 아니라 2번입니다', 2],
    ['정답: 7', null],
    ['보기 13번이 맞습니다', null],
    ['2. 재구매율', null],
  ];
  for (const [text, expected] of rowList) {
    assert.equal(parseAnswerText(text, { choiceTextList }).choiceNumber, expected, text);
  }
  assert.deepEqual(parseAnswerText('{"answer": "2번", "reason": "보기 1번은 오답 1개를 포함"}', { choiceTextList }),
    { choiceNumber: 2, reason: '보기 1번은 오답 1개를 포함' });
});

test('흔한 답 꼴과 보기 글 그대로의 답을 읽는다', () => {
  const rowList = [
    ['정답은 2번', 2],
    ['정답은 2번입니다.', 2],
    ['보기 3번이 맞습니다', 3],
    ['{"answer": "3번"}', 3],
    ['{"answer": "3"}', 3],
    ['답: "3"', 3],
    ['The answer is 3', 3],
    ['알 수 없음', 5],
    ['정답: 알 수 없음', 5],
    ['{"answer": "알 수 없음"}', 5],
    ['{"answer": "5. 알 수 없음"}', 5],
    ['전환율', 3],
    ['{"answer": "이탈률"}', 2],
    ['1. 재구매율', 1],
  ];
  for (const [text, expected] of rowList) {
    assert.equal(parseAnswerText(text, { choiceTextList }).choiceNumber, expected, text);
  }
  // 보기 목록을 안 줘도 "알 수 없음"은 늘 5번이다.
  assert.equal(parseAnswerText('알 수 없음').choiceNumber, 5);
  assert.equal(parseAnswerText('{"answer": "5. 알 수 없음"}').choiceNumber, 5);
  assert.equal(parseAnswerText('전환율').choiceNumber, null);
});

const choiceTextListOf = (choiceList) => buildChoiceList({ question: { ...question, choiceList } });
const percentChoiceTextList = choiceTextListOf(['1%', '2%', '4%', '5%']);
const timesChoiceTextList = choiceTextListOf(['1.2배', '1.5배', '2배', '3배']);

test('답 뒤에 값·단위가 붙으면 보기 번호로 읽지 않는다 (보기 글과 같을 때만 그 보기)', () => {
  const rowList = [
    ['정답은 3%입니다', percentChoiceTextList, null],
    ['정답은 1.5 배입니다', timesChoiceTextList, null],
    ['정답은 3배 증가', timesChoiceTextList, null],
    ['정답은 3개 막대 중 두 번째', choiceTextList, null],
    ['The answer is 2.5', timesChoiceTextList, null],
    ['답: 2.5배', timesChoiceTextList, null],
    ['정답은 30%', choiceTextList, null],
    ['정답은 3번째 막대', choiceTextList, null],
    ['정답은 3%입니다', choiceTextListOf(['1%', '3%', '4%', '5%']), 2],
    ['정답은 3배', timesChoiceTextList, 4],
    ['The answer is 2.5', choiceTextListOf(['1.5', '2.5', '3.5', '4.5']), 2],
    ['정답은 3입니다', choiceTextList, 3],
    ['정답: 3\n근거: 전사에 있음', choiceTextList, 3],
    ['정답은 3, 전환율', choiceTextList, 3],
    ['Answer: 5 (알 수 없음)', choiceTextList, 5],
  ];
  for (const [text, rowChoiceTextList, expected] of rowList) {
    assert.equal(parseAnswerText(text, { choiceTextList: rowChoiceTextList }).choiceNumber, expected, text);
  }
});

test('"N번이"는 맞다·정답이라고 할 때만 답으로 센다', () => {
  const rowList = [
    ['1번 이탈률', null],
    ['2번 이탈률', 2],
    ['정답은 2번입니다. 1번이 틀린 이유는 자료에 없기 때문입니다', 2],
    ['정답은 2번입니다. 3번이 아닌 이유는 자료에 없기 때문입니다', 2],
    ['3번이 맞지 않고 정답은 2번', 2],
    ['보기 4번이 정답입니다', 4],
  ];
  for (const [text, expected] of rowList) {
    assert.equal(parseAnswerText(text, { choiceTextList }).choiceNumber, expected, text);
  }
});

test('1~5 정수가 아닌 답 번호는 모두 응답 오류다', () => {
  const responseError = { chosenIndex: null, isUnknown: false, isCorrect: false, isResponseError: true };
  for (const choiceNumber of [undefined, Number.NaN, 7, 0, 2.5, '1']) {
    assert.deepEqual(scoreAnswer({ question, choiceNumber }), responseError, String(choiceNumber));
  }
});
