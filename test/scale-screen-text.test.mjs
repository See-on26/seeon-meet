import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const {
  createScreenTextGrounding, shouldStartScreenTextGrounding, isScreenTextNarrationType,
} = require('../src/main/caption-pipeline/orchestrator/screen-text-grounding.js');
const { buildScreenTextBlock, SCREEN_TEXT_USAGE_MAP } = require('../src/main/caption-pipeline/prompts/screen-text-block.js');
const { buildVisualDescriptionPrompt } = require('../src/main/caption-pipeline/prompts/visual-description.js');
const { createVisualDescriptionAgent } = require('../src/main/caption-pipeline/agents/visual-description-agent.js');
const { NARRATION_TYPE_MAP, VISUAL_DESCRIPTION_KIND_MAP } = require('../src/main/caption-pipeline/contracts/narration-types.js');
const { NARRATION_ORIGIN_MAP } = require('../src/main/caption-pipeline/contracts/narration-class.js');

// 척도 해설도 같은 프레임 OCR 글자를 근거로 받는다(대상·비교 대상 이름과 적힌 크기 값 확인용, 짝은 이미지에서).
// 지시 해설은 받지 않는다(deixis-claim-prompt-gap.test.mjs).
const SCALE = VISUAL_DESCRIPTION_KIND_MAP.scale;
const LISTENER_LINE_PREFIX = '청자는 화면을 볼 수 없다. 발표자는';
const screenLineList = [
  { text: '전망대 높이 120m', score: 0.95 }, { text: '옆 건물 30층', score: 0.93 }, { text: '관람 시간 안내', score: 0.9 },
];

function insertBeforeListenerLine({ prompt, block }) {
  const index = prompt.indexOf(LISTENER_LINE_PREFIX);
  assert.ok(index > 0, '척도 프롬프트에 청자 줄이 있어야 한다');
  return `${prompt.slice(0, index)}${block}\n\n${prompt.slice(index)}`;
}

test('근거를 받는 해설은 수치와 척도뿐이다(지시는 받지 않는다)', () => {
  assert.equal(isScreenTextNarrationType(NARRATION_TYPE_MAP.interpretation), true);
  assert.equal(isScreenTextNarrationType(NARRATION_TYPE_MAP.visualDescription), true);
  assert.equal(isScreenTextNarrationType(NARRATION_TYPE_MAP.deixis), false);
  assert.equal(isScreenTextNarrationType(null), false);
});

test('척도 트리거가 있으면 근거 OCR 을 시작하고, 척도를 꺼 두었으면 척도 후보만으로는 시작하지 않는다', () => {
  const scaleOnly = [{ type: 'demonstrative', phrase: '여기' }, { type: 'scale', phrase: '정말 크죠' }];
  assert.equal(shouldStartScreenTextGrounding({ triggerCandidateList: scaleOnly }), true);
  assert.equal(shouldStartScreenTextGrounding({ triggerCandidateList: scaleOnly, isScaleEnabled: true }), true);
  assert.equal(shouldStartScreenTextGrounding({ triggerCandidateList: scaleOnly, isScaleEnabled: false }), false);
  assert.equal(shouldStartScreenTextGrounding({
    triggerCandidateList: [...scaleOnly, { type: 'number', phrase: '120미터' }], isScaleEnabled: false,
  }), true);
  assert.equal(shouldStartScreenTextGrounding({ triggerCandidateList: [{ type: 'scale', phrase: '' }] }), false);
  assert.equal(shouldStartScreenTextGrounding({ triggerCandidateList: [{ type: 'demonstrative', phrase: '여기' }] }), false);
});

test('척도용 덩어리: 둘째 안내 줄이 척도용 문구이고, 숫자 줄이 있어도 NONE 막는 문장은 없다', () => {
  const scaleBlock = buildScreenTextBlock({ lineList: screenLineList, keywordSourceList: ['정말 높죠'], usage: SCREEN_TEXT_USAGE_MAP.scale });
  const valueBlock = buildScreenTextBlock({ lineList: screenLineList, keywordSourceList: ['정말 높죠'] });
  const [scaleIntro, scaleUsage] = scaleBlock.text.split('\n');
  const [valueIntro, valueUsage] = valueBlock.text.split('\n');
  assert.equal(scaleIntro, valueIntro, '첫 안내 줄은 같다');
  assert.notEqual(scaleUsage, valueUsage);
  assert.match(scaleUsage, /비교 대상/);
  assert.match(scaleUsage, /반드시 이미지에서 확인한다/);
  assert.match(valueUsage, /값·항목 이름의 철자/);
  assert.doesNotMatch(scaleBlock.text, /NONE/);
  assert.equal(scaleBlock.lineCount, 3);
  assert.equal(scaleBlock.numberLineCount, 2);
});

test('척도 프롬프트: OCR 줄이 있으면 청자 줄 바로 앞에 척도용 덩어리와 빈 줄을 넣는다', () => {
  for (const language of ['ko', 'en']) {
    const option = { subKind: SCALE, utterance: '저 전망대 정말 높죠', mergedAnchorList: ['저 전망대'], language };
    const base = buildVisualDescriptionPrompt(option);
    const withScreenText = buildVisualDescriptionPrompt({ ...option, screenLineList });
    const block = buildScreenTextBlock({
      lineList: screenLineList, keywordSourceList: ['저 전망대 정말 높죠', '저 전망대'], usage: SCREEN_TEXT_USAGE_MAP.scale,
    }).text;
    assert.ok(block, language);
    assert.equal(withScreenText, insertBeforeListenerLine({ prompt: base, block }), language);
  }
});

test('척도 프롬프트: OCR 줄이 없거나 비면 지금과 글자 하나까지 같다', () => {
  for (const language of ['ko', 'en']) {
    const base = buildVisualDescriptionPrompt({ subKind: SCALE, utterance: '정말 크죠', language });
    for (const emptyList of [undefined, null, [], [{ text: '' }, { text: '   ' }]]) {
      assert.equal(
        buildVisualDescriptionPrompt({ subKind: SCALE, utterance: '정말 크죠', language, screenLineList: emptyList }),
        base, `${language}/${JSON.stringify(emptyList)}`,
      );
    }
    assert.doesNotMatch(base, /글자 인식기/);
  }
});

test('사진 반응·무발화 묘사 프롬프트는 OCR 줄을 받아도 넣지 않는다', () => {
  for (const option of [
    { subKind: VISUAL_DESCRIPTION_KIND_MAP.reaction },
    { subKind: VISUAL_DESCRIPTION_KIND_MAP.reaction, origin: NARRATION_ORIGIN_MAP.silence, recentTranscript: '그래프 보시죠' },
  ]) {
    assert.equal(buildVisualDescriptionPrompt({ ...option, screenLineList }), buildVisualDescriptionPrompt(option));
  }
});

test('근거가 꺼져 있으면 OCR 을 부르지 않고 척도 프롬프트는 지금과 같다', async () => {
  const callList = [];
  const ocrClient = { recognize: async () => { callList.push(1); return { lineList: screenLineList, meanScore: 0.95, verticalBoxRatio: 0 }; } };
  const task = createScreenTextGrounding({ ocrClient, isEnabled: () => false }).start({ jpegBuffer: Buffer.from('x') });
  const { lineList, record } = await task.waitForPrompt();
  assert.equal(callList.length, 0);
  assert.equal(record.skipReason, 'disabled');
  const option = { subKind: SCALE, utterance: '정말 높죠' };
  assert.equal(buildVisualDescriptionPrompt({ ...option, screenLineList: lineList }), buildVisualDescriptionPrompt(option));
});

async function runVisualAgent({ content, ...generateOption }) {
  const originalFetch = globalThis.fetch;
  const promptList = [];
  globalThis.fetch = async (_url, option) => {
    const body = JSON.parse(option.body);
    promptList.push(body.messages[0].content.find((item) => item.type === 'text').text);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  try {
    const result = await createVisualDescriptionAgent({ config: { vlmUrl: 'http://x', vlmModel: 'm' } }).generate({
      jpegBuffer: Buffer.from('x'), ...generateOption,
    });
    return { result, promptList };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('척도 에이전트: OCR 줄을 프롬프트에 넣고, 실제로 들어간 양을 기록용으로 돌려준다', async () => {
  const { result, promptList } = await runVisualAgent({
    content: '{"caption":"옆 30층 건물보다 높은 전망대"}',
    subKind: SCALE, utterance: '저 전망대 정말 높죠', screenLineList,
  });
  assert.equal(promptList.length, 1);
  assert.match(promptList[0], /글자 인식기\(OCR\)/);
  assert.match(promptList[0], /전망대 높이 120m/);
  assert.deepEqual(result.screenTextBlock, { lineCount: 3, charCount: screenLineList.reduce((sum, line) => sum + line.text.length, 0), numberLineCount: 2 });
  assert.equal(result.isGrounded, true);
});

test('척도 에이전트: OCR 줄이 없으면 덩어리 없이 부르고 기록 양은 0이다', async () => {
  const { result, promptList } = await runVisualAgent({
    content: '{"caption":"옆 30층 건물보다 높은 전망대"}',
    subKind: SCALE, utterance: '저 전망대 정말 높죠',
  });
  assert.doesNotMatch(promptList[0], /글자 인식기/);
  assert.deepEqual(result.screenTextBlock, { lineCount: 0, charCount: 0, numberLineCount: 0 });
});

test('파이프라인: 척도 후보도 OCR 을 시작·기다리고, 척도 에이전트에 줄을 넘긴다(척도 설정을 따른다)', () => {
  const source = fs.readFileSync(new URL('../src/main/caption-pipeline/index.js', import.meta.url), 'utf8');
  assert.match(source, /shouldStartScreenTextGrounding\(\{ triggerCandidateList, isScaleEnabled: config\.isScaleEnabled \}\)/);
  assert.match(source, /isScreenTextNarrationType\(narrationType\) && screenTextTask/);
  const visualArgMatch = source.match(/\[NARRATION_TYPE_MAP\.visualDescription\]: \{[^}]*\}/);
  assert.ok(visualArgMatch, '척도 에이전트 인자');
  assert.match(visualArgMatch[0], /screenLineList: screenText\?\.lineList \|\| \[\]/);
  const deixisArgMatch = source.match(/\[NARRATION_TYPE_MAP\.deixis\]: \{[^}]*\}/);
  assert.doesNotMatch(deixisArgMatch[0], /screenLineList/, '지시 에이전트에는 넘기지 않는다');
});
