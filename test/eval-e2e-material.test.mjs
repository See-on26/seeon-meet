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
