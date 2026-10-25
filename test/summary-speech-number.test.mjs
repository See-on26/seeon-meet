import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readSinoKoreanNumber, readNumbersForSpeech } = require('../src/main/summary/speech-number.js');
const { sanitizeMultilineForSpeech } = require('../src/main/caption-pipeline/output/tts-client.js');
const { createSummaryGenerator } = require('../src/main/summary/summary-generator.js');

// 요약 글은 아라비아 숫자로 두고(모델이 한글로 풀면 값을 틀린다), 음성 합성 직전에만 읽는 말로 바꾼다.
// 음성 서버(MeloTTS)는 "16.1을"·"4,043포인트"·"238억"·"12를" 같은 꼴을 잘못 읽는다(합성 → 받아쓰기로 확인).

test('한자어 수 읽기: 만 단위로 끊어 읽고, 십·백·천·만 앞의 일은 읽지 않는다', () => {
  const caseList = [
    [0, '영'], [7, '칠'], [10, '십'], [12, '십이'], [16, '십육'], [100, '백'], [238, '이백삼십팔'],
    [1000, '천'], [4043, '사천사십삼'], [10000, '만'], [15000, '만 오천'], [25300, '이만 오천삼백'],
    [100000000, '일억'], [120000000, '일억 이천만'], [1180000000000, '일조 천팔백억'], [118000000000000, '백십팔조'],
  ];
  for (const [value, expected] of caseList) assert.equal(readSinoKoreanNumber(BigInt(value)), expected, String(value));
});

test('음성용 숫자: 음성 서버가 잘못 읽는 꼴을 읽는 말로 바꾼다', () => {
  const caseList = [
    ['지수는 16.1을 기록했습니다.', '지수는 십육 점 일을 기록했습니다.'],
    ['주의 수준인 12를 넘었습니다.', '주의 수준인 십이를 넘었습니다.'],
    ['코스피는 4,043포인트입니다.', '코스피는 사천사십삼포인트입니다.'],
    ['매출은 238억 원입니다.', '매출은 이백삼십팔억 원입니다.'],
    ['천식은 3.31퍼센트에서 5.86퍼센트로 늘었습니다.', '천식은 삼 점 삼일퍼센트에서 오 점 팔육퍼센트로 늘었습니다.'],
    ['R 제곱은 0.933입니다.', 'R 제곱은 영 점 구삼삼입니다.'],
    ['수익률은 -0.11퍼센트입니다.', '수익률은 마이너스 영 점 일일퍼센트입니다.'],
    ['비중은 42%입니다.', '비중은 사십이 퍼센트입니다.'],
    ['초과분은 0.7%p입니다.', '초과분은 영 점 칠 퍼센트포인트입니다.'],
    ['8.2배 높습니다.', '팔 점 이배 높습니다.'],
    ['25,300백만 달러', '이만 오천삼백백만 달러'],
    ['15분기 만에', '십오분기 만에'],
    ['슬라이드 54장 · 발화 830건', '슬라이드 54장 · 발화 팔백삼십건'],
    ['3개월 뒤 20개국에서 150달러로 판매합니다.', '삼개월 뒤 이십개국에서 백오십달러로 판매합니다.'],
    ['10~20퍼센트 늘었습니다.', '십~이십퍼센트 늘었습니다.'],
    ['항목은 1, 2, 3입니다.', '항목은 일, 이, 삼입니다.'],
    ['전년 대비 -3.2%입니다. (-3)', '전년 대비 마이너스 삼 점 이 퍼센트입니다. (마이너스 삼)'],
    ['12 를 넘었습니다.', '십이 를 넘었습니다.'],
  ];
  for (const [input, expected] of caseList) assert.equal(readNumbersForSpeech({ text: input }), expected, input);
});

test('음성용 숫자: 음성 서버가 맞게 읽는 날짜와 고유어로 세는 말 앞의 정수, 낱말 속 숫자는 그대로 둔다', () => {
  const keptList = [
    '2025년 9월 기준입니다.', '6월 이후 감소했습니다.', '7월 21일부터', '63개 제품이 통과했습니다.',
    '3명이 참석했습니다.', '슬라이드 54장', '2시간 동안', '5가지 과제',
    '기업의 RE100 이행', 'V18 구간', '5G 통신', '8배 늘었습니다.', '3 명이 맡습니다.',
  ];
  for (const text of keptList) assert.equal(readNumbersForSpeech({ text }), text, text);
});

test('음성용 숫자: 범위·나열은 마지막 수 뒤의 말로 판정해 앞뒤 수를 같이 두거나 같이 바꾼다', () => {
  const keptList = ['2~3개 과제가 남았습니다.', '3~4명이 맡습니다.', '1~2시간', '6~7월', '10~12월', '2-3개', '1, 2, 3번 슬라이드', '2, 3개'];
  for (const text of keptList) assert.equal(readNumbersForSpeech({ text }), text, text);
});

test('음성용 숫자: 한글·영문 뒤 하이픈은 음수가 아니고, 이름에 붙은 숫자는 그대로 둔다', () => {
  assert.equal(readNumbersForSpeech({ text: '3월-6월 사이' }), '3월-6월 사이');
  assert.equal(readNumbersForSpeech({ text: '1분기-3분기' }), '일분기-삼분기');
  assert.equal(readNumbersForSpeech({ text: 'GPT-4를 씁니다. COVID-19 이후' }), 'GPT-4를 씁니다. COVID-19 이후');
});

test('음성용 숫자: 점·쉼표로 더 이어지는 수, 시각, 앞자리 0, 너무 큰 수는 건드리지 않는다', () => {
  const keptList = [
    '12.5km 구간', '2.5GHz', '1,000km', '버전 1.2.3을 배포합니다.', '2024.3.15 발표', '40:02 지점', '00:30부터',
    '010-1234-5678', '007 요원', '1,000,000,000,000,000,000,000원',
  ];
  for (const text of keptList) assert.equal(readNumbersForSpeech({ text }), text, text);
});

test('음성용 숫자: $ 금액은 기존 음성 정리를 거친 뒤에도 달러로 읽힌다', () => {
  assert.equal(sanitizeMultilineForSpeech({ text: readNumbersForSpeech({ text: '$100입니다. $4,043를 기록' }) }), '백달러입니다. 사천사십삼달러를 기록');
});

test('음성용 숫자: 영어 요약은 건드리지 않는다', () => {
  assert.equal(readNumbersForSpeech({ text: 'The index was 16.1 and 4,043 points.', language: 'en' }), 'The index was 16.1 and 4,043 points.');
});

test('요약 생성기: 요약 글 파일은 그대로 두고 음성 합성에만 읽는 말로 바꾼 글을 보낸다', async (context) => {
  context.mock.method(console, 'log', () => {});
  const summariesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-speech-number-'));
  const spokenList = [];
  const generator = createSummaryGenerator({
    config: {},
    summariesDir,
    segmentSummaryAgent: { summarize: async () => ({ text: '지수는 16.1이다.' }) },
    summaryAgent: { summarize: async () => ({ text: '지수는 16.1입니다.', isTruncated: false }) },
    rewriteAgent: { rewrite: async ({ draftText }) => ({ text: draftText, isTruncated: false }) },
    ttsClient: { synthesizeLong: async ({ text, language }) => { spokenList.push({ text, language }); return Buffer.from('mp3'); } },
  });
  const result = await generator.generateText({
    session: { sessionId: 'session-1', startedAt: 0, endedAt: 60_000, captionLanguage: 'ko', asrEntryList: [{ ts: 1000, text: '16.1', speakerHint: null }], slideMarkList: [] },
  });
  assert.match(result.documentText, /지수는 16\.1입니다\./, '글은 아라비아 숫자 그대로');
  await generator.generateAudio({ sessionId: 'session-1', documentText: result.documentText, language: 'ko' });
  assert.equal(spokenList.length, 1);
  assert.match(spokenList[0].text, /지수는 십육 점 일입니다\./);
  assert.ok(!/16\.1/.test(spokenList[0].text));
  fs.rmSync(summariesDir, { recursive: true, force: true });
});
