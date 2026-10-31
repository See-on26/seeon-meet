import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  NARRATION_TYPE_MAP, PAGE_TRANSITION_KIND_MAP, DEIXIS_FORM_MAP, INTERPRETATION_KIND_MAP,
  VISUAL_DESCRIPTION_KIND_MAP, SPEAKER_IDENTITY_KIND_MAP, USER_COMMAND_MAP,
} = require('../src/main/caption-pipeline/contracts/narration-types.js');
const { NARRATION_ORIGIN_MAP } = require('../src/main/caption-pipeline/contracts/narration-class.js');
const { buildOutputLanguageRuleList } = require('../src/main/caption-pipeline/prompts/output-language-rule.js');
const { buildGroundingPrompt } = require('../src/main/caption-pipeline/prompts/deixis-resolution.js');
const { buildInterpretationPrompt } = require('../src/main/caption-pipeline/prompts/interpretive-bridge.js');
const { buildVisualDescriptionPrompt } = require('../src/main/caption-pipeline/prompts/visual-description.js');
const { buildPageTransitionPrompt } = require('../src/main/caption-pipeline/prompts/page-transition.js');
const { buildSpeakerIdentityPrompt } = require('../src/main/caption-pipeline/prompts/speaker-identity.js');
const { buildCommandPrompt, buildFreeQuestionPrompt } = require('../src/main/caption-pipeline/prompts/command-processing.js');
const {
  buildPastSlideAnswerPrompt, buildImageAnswerPrompt, buildSpeakerAnswerPrompt, buildMeetingFlowPrompt,
  buildNarrationReplayPrompt,
} = require('../src/main/caption-pipeline/prompts/question-answer.js');
const {
  getSlotList, buildSlotInstruction, normalizeSlotMap, assembleNarration, scaleWordBudget, ENGLISH_WORD_SCALE,
} = require('../src/main/caption-pipeline/agents/shared/narration-format.js');
const {
  buildSlotOutputInstruction, computeMaxChars, parseSlotCaption, parseGroundingText,
} = require('../src/main/caption-pipeline/agents/shared/caption-parser.js');
const { parsePageTransitionText, createPageTransitionAgent } = require('../src/main/caption-pipeline/agents/page-transition-agent.js');
const {
  parseSpeakerIdentityText, buildSpeakerIdentityFromDom,
} = require('../src/main/caption-pipeline/agents/speaker-identity-agent.js');
const { createAgentFieldMap } = require('../src/main/caption-pipeline/agents/index.js');
const {
  buildTransitionNarration, buildRevisitNarration,
} = require('../src/main/caption-pipeline/orchestrator/slide-transition-text.js');
const {
  finalizeSilenceDescription, createSilenceNarrator, SILENCE_RESULT_MAP,
} = require('../src/main/caption-pipeline/orchestrator/silence-narrator.js');
const { createSilenceNarrationGate } = require('../src/main/caption-pipeline/orchestrator/silence-gate.js');
const { createContextStore } = require('../src/main/caption-pipeline/context/context-store.js');
const {
  createQuestionAnswerer, readAnswerText, ANSWER_TEXT_KEY_MAP, NOT_FOUND_TEXT, OFF_TOPIC_TEXT, NOT_FOUND_PHRASE_PATTERN,
} = require('../src/main/caption-pipeline/context/question-answerer.js');
const { QUESTION_ROUTE_MAP } = require('../src/main/caption-pipeline/context/question-classifier.js');

const RULE_MARK = '[출력 언어]';
const HANGUL_PATTERN = /[가-힣]/;

// 캡션 언어가 영어면 사용자에게 들리는 글을 만드는 프롬프트 끝에 출력 언어 규칙을 붙인다.
// 한국어면 아무것도 붙지 않아 언어를 넘기지 않은 지금의 프롬프트와 글자 하나까지 같아야 한다.
const SPOKEN_PROMPT_CASE_LIST = [
  ['지시 단순형', (option) => buildGroundingPrompt({ utterance: '여기 보시면', subKind: DEIXIS_FORM_MAP.simple, ...option })],
  ['지시 완전형', (option) => buildGroundingPrompt({ utterance: '이거거든요', subKind: DEIXIS_FORM_MAP.complete, ...option })],
  ['해석 값→의미', (option) => buildInterpretationPrompt({ utterance: '73%입니다', subKind: INTERPRETATION_KIND_MAP.valueToMeaning, ...option })],
  ['해석 주장→값(둘째 쌍)', (option) => buildInterpretationPrompt({
    utterance: '크게 늘었습니다', subKind: INTERPRETATION_KIND_MAP.claimToValue, mergedClaimList: ['방문자도 늘었고'], ...option,
  })],
  ['시각 반응', (option) => buildVisualDescriptionPrompt({ subKind: VISUAL_DESCRIPTION_KIND_MAP.reaction, ...option })],
  ['시각 척도', (option) => buildVisualDescriptionPrompt({ subKind: VISUAL_DESCRIPTION_KIND_MAP.scale, utterance: '정말 크죠', ...option })],
  ['무발화 묘사', (option) => buildVisualDescriptionPrompt({
    subKind: VISUAL_DESCRIPTION_KIND_MAP.reaction, origin: NARRATION_ORIGIN_MAP.silence, ...option,
  })],
  ['화면 전환', (option) => buildPageTransitionPrompt({ ...option })],
  ['발화자', (option) => buildSpeakerIdentityPrompt({ ...option })],
  ...Object.values(USER_COMMAND_MAP).map((command) => [`프리셋 ${command}`, (option) => buildCommandPrompt({ command, ...option })]),
  ['자유 질문', (option) => buildFreeQuestionPrompt({ questionText: '이 표의 단위는?', ...option })],
  ['지난 화면 답(그림 있음)', (option) => buildPastSlideAnswerPrompt({
    questionText: 'q', evidenceText: 'e', minWordCount: 3, maxWordCount: 15, hasImage: true, ...option,
  })],
  ['지난 화면 답(그림 없음)', (option) => buildPastSlideAnswerPrompt({
    questionText: 'q', evidenceText: 'e', minWordCount: 3, maxWordCount: 15, ...option,
  })],
  ['지난 화면 그림 답', (option) => buildImageAnswerPrompt({ questionText: 'q', evidenceText: 'e', minWordCount: 3, maxWordCount: 15, ...option })],
  ['화자 답', (option) => buildSpeakerAnswerPrompt({ questionText: 'q', utteranceText: 'u', minWordCount: 3, maxWordCount: 15, ...option })],
  ['회의 흐름 답', (option) => buildMeetingFlowPrompt({ questionText: 'q', flowText: 'f', minWordCount: 3, maxWordCount: 15, ...option })],
];

test('출력 언어 규칙: 한국어는 빈 목록, 영어는 영어로 쓰라는 규칙 한 덩어리', () => {
  assert.deepEqual(buildOutputLanguageRuleList({ language: 'ko' }), []);
  assert.deepEqual(buildOutputLanguageRuleList(), []);
  const englishList = buildOutputLanguageRuleList({ language: 'en', detailLineList: ['보충'] });
  assert.ok(englishList.some((line) => line.startsWith(RULE_MARK)));
  assert.match(englishList.join('\n'), /자연스러운 영어/);
  assert.match(englishList.join('\n'), /영어 단어 수/);
  assert.equal(englishList[englishList.length - 1], '보충');
});

for (const [label, build] of SPOKEN_PROMPT_CASE_LIST) {
  test(`프롬프트(${label}): 한국어는 지금과 같고 규칙이 없으며, 영어는 끝에 출력 언어 규칙이 붙는다`, () => {
    const defaultPrompt = build({});
    assert.equal(build({ language: 'ko' }), defaultPrompt);
    assert.ok(!defaultPrompt.includes(RULE_MARK));
    const englishPrompt = build({ language: 'en' });
    assert.ok(englishPrompt.includes(RULE_MARK));
    assert.ok(englishPrompt.lastIndexOf(RULE_MARK) > englishPrompt.length / 2, '규칙은 프롬프트 뒤쪽에 붙는다');
  });
}

test('해설 다시 듣기는 번호만 내므로 출력 언어 규칙을 붙이지 않는다', () => {
  const prompt = buildNarrationReplayPrompt({ questionText: 'again', narrationList: [{ text: 'a' }] });
  assert.ok(!prompt.includes(RULE_MARK));
});

test('칸 출력 형식: 영어는 영어 칸 설명·단어 수·NONE 꼴, 한국어 조사 규칙은 빠진다', () => {
  const option = { narrationType: NARRATION_TYPE_MAP.deixis, subKind: DEIXIS_FORM_MAP.simple };
  const korean = buildSlotOutputInstruction(option);
  assert.equal(buildSlotOutputInstruction({ ...option, language: 'ko' }), korean);
  const english = buildSlotOutputInstruction({ ...option, language: 'en' });
  assert.match(english, /"seen": what is actually visible/);
  assert.match(english, /"caption": the narration read to the listener/);
  assert.match(english, /"seen": .* — 0–38 words/);
  // 식별 사실 칸이 켜져 있으면(기본) caption 은 2~5어절로 안내하고 fact(0~3어절)를 따로 받는다.
  assert.match(english, /"caption": .* — 2–10 words/);
  assert.match(english, /"fact": .* — 0–6 words/);
  assert.match(english, /NONE: \(reason\)/);
  assert.match(english, /Chinese characters/);
  assert.doesNotMatch(english, /조사|관형형|어절/);
  assert.ok(!HANGUL_PATTERN.test(english));
});

// 영어는 관사·전치사 때문에 같은 내용도 한국어 어절보다 단어가 많다(GPU 시험: 9어절 상한에 영어 전환 묘사 6/15 가 길어 버려짐).
// 상한은 들리는 길이가 한국어와 같도록 TTS 실측 비율(어절 0.45초 ÷ 영어 단어 0.238초 ≈ 1.9)로 잡는다.
test('칸 목록: 영어는 같은 칸 이름에 영어 설명, 단어 상한은 한국어 어절의 1.9배(올림)·하한은 그대로', () => {
  const caseList = [
    [NARRATION_TYPE_MAP.pageTransition, PAGE_TRANSITION_KIND_MAP.slide],
    [NARRATION_TYPE_MAP.pageTransition, PAGE_TRANSITION_KIND_MAP.document],
    [NARRATION_TYPE_MAP.deixis, DEIXIS_FORM_MAP.simple],
    [NARRATION_TYPE_MAP.deixis, DEIXIS_FORM_MAP.complete],
    [NARRATION_TYPE_MAP.interpretation, INTERPRETATION_KIND_MAP.valueToMeaning],
    [NARRATION_TYPE_MAP.interpretation, INTERPRETATION_KIND_MAP.claimToValue, { hasSecondClaim: true }],
    [NARRATION_TYPE_MAP.visualDescription, VISUAL_DESCRIPTION_KIND_MAP.reaction],
    [NARRATION_TYPE_MAP.visualDescription, VISUAL_DESCRIPTION_KIND_MAP.reaction, { origin: NARRATION_ORIGIN_MAP.silence }],
    [NARRATION_TYPE_MAP.visualDescription, VISUAL_DESCRIPTION_KIND_MAP.scale],
    [NARRATION_TYPE_MAP.speakerIdentity, SPEAKER_IDENTITY_KIND_MAP.named],
    [NARRATION_TYPE_MAP.speakerIdentity, SPEAKER_IDENTITY_KIND_MAP.positional],
  ];
  for (const [narrationType, subKind, extra = {}] of caseList) {
    const korean = getSlotList({ narrationType, subKind, ...extra });
    const english = getSlotList({ narrationType, subKind, ...extra, language: 'en' });
    assert.deepEqual(english.map(({ key, minWordCount, maxWordCount }) => ({ key, minWordCount, maxWordCount })),
      korean.map(({ key, minWordCount, maxWordCount }) => ({ key, minWordCount, maxWordCount: Math.ceil(maxWordCount * ENGLISH_WORD_SCALE) })));
    for (const slot of english) assert.ok(!HANGUL_PATTERN.test(slot.label), `${narrationType}/${subKind}/${slot.key} 영어 설명`);
  }
  const instruction = buildSlotInstruction({ slotList: getSlotList({ narrationType: NARRATION_TYPE_MAP.deixis, subKind: DEIXIS_FORM_MAP.complete, language: 'en' }), language: 'en' });
  assert.match(instruction, /"caption": .* — 2–19 words$/m);
  assert.match(instruction, /for the record/);
});

test('글자 수 상한: 영어는 단어당 7자로 어림해 일찍 자르지 않는다', () => {
  assert.equal(computeMaxChars({ maxWordCount: 10 }), 45);
  assert.equal(computeMaxChars({ maxWordCount: 10, language: 'ko' }), 45);
  assert.equal(computeMaxChars({ maxWordCount: 10, language: 'en' }), 70);
});

const en = { language: 'en' };

test('영어 조립: 전환 슬라이드·페이지', () => {
  const description = 'Domestic development status slide with a map and text boxes';
  assert.equal(assembleNarration({
    narrationType: NARRATION_TYPE_MAP.pageTransition, subKind: PAGE_TRANSITION_KIND_MAP.slide,
    rawSlotMap: { description }, index: 3, ...en,
  }).text, `Slide 3: ${description}`);
  assert.equal(assembleNarration({
    narrationType: NARRATION_TYPE_MAP.pageTransition, subKind: PAGE_TRANSITION_KIND_MAP.document,
    rawSlotMap: { screenForm: 'Excel sheet', description: 'Monthly sales summary in an Excel sheet.' }, ...en,
  }).text, 'Page: Monthly sales summary in an Excel sheet');
  // 한국어 자료 명사 검사로는 영어 묘사가 늘 미완결로 버려진다. 영어 캡션은 그 검사를 거치지 않는다.
  assert.equal(assembleNarration({
    narrationType: NARRATION_TYPE_MAP.pageTransition, subKind: PAGE_TRANSITION_KIND_MAP.slide,
    rawSlotMap: { description }, index: 3,
  }), null);
});

test('영어 조립: 지시는 단순형·완전형 모두 caption 만 읽고 첫 글자는 대문자다(seen 은 읽지 않는 근거 칸)', () => {
  assert.equal(assembleNarration({
    narrationType: NARRATION_TYPE_MAP.deixis, subKind: DEIXIS_FORM_MAP.simple,
    rawSlotMap: { seen: 'two-year sales trend table', caption: 'the two-year sales trend table' }, ...en,
  }).text, 'The two-year sales trend table');
  assert.equal(assembleNarration({
    narrationType: NARRATION_TYPE_MAP.deixis, subKind: DEIXIS_FORM_MAP.complete,
    rawSlotMap: { seen: 'method E, method B', caption: 'method E and method B' }, ...en,
  }).text, 'Method E and method B');
});

test('영어 조립: 상한을 크게 넘긴 칸은 잘라 끝에 남은 관사·전치사를 뗀다', () => {
  const slotList = getSlotList({ narrationType: NARRATION_TYPE_MAP.interpretation, subKind: INTERPRETATION_KIND_MAP.claimToValue, ...en });
  const slotMap = normalizeSlotMap({
    slotList, rawSlotMap: { target: 'the big chart of quarterly sales figures broken down by region and by the year', value: '9.2 hours' }, ...en,
  });
  // 상한 8단어 + 여유 2단어에서 잘라 "… broken down by" 가 되고, 끝에 남은 전치사 by 를 뗀다.
  assert.equal(slotMap.target, 'the big chart of quarterly sales figures broken down');
  assert.equal(slotMap.value, '9.2 hours');
});

test('영어 조립: 해석 값→의미는 "… means …", 주장→값은 "대상, 값" 쌍', () => {
  assert.equal(assembleNarration({
    narrationType: NARRATION_TYPE_MAP.interpretation, subKind: INTERPRETATION_KIND_MAP.valueToMeaning,
    rawSlotMap: { value: '73%', frame: "Company A's year-over-year valuation growth rate" }, ...en,
  }).text, "73% means Company A's year-over-year valuation growth rate");
  assert.equal(assembleNarration({
    narrationType: NARRATION_TYPE_MAP.interpretation, subKind: INTERPRETATION_KIND_MAP.claimToValue,
    rawSlotMap: { target: 'first response time', value: '9.2 hours to 3.1 hours' }, ...en,
  }).text, 'First response time, 9.2 hours to 3.1 hours');
  assert.equal(assembleNarration({
    narrationType: NARRATION_TYPE_MAP.interpretation, subKind: INTERPRETATION_KIND_MAP.claimToValue, hasSecondClaim: true,
    rawSlotMap: { target: 'Sales', value: '10 billion to 12 billion won', target2: 'Visitors', value2: '3,000 to 5,000' }, ...en,
  }).text, 'Sales, 10 billion to 12 billion won. Visitors, 3,000 to 5,000');
  // 대상 이름이 값에 모두 나오면 값만 읽는다(대소문자는 가리지 않는다).
  assert.equal(assembleNarration({
    narrationType: NARRATION_TYPE_MAP.interpretation, subKind: INTERPRETATION_KIND_MAP.claimToValue,
    rawSlotMap: { target: 'Developers and designers', value: '120 developers and 30 designers' }, ...en,
  }).text, '120 developers and 30 designers');
  assert.equal(assembleNarration({
    narrationType: NARRATION_TYPE_MAP.interpretation, subKind: INTERPRETATION_KIND_MAP.claimToValue,
    rawSlotMap: { target: 'Sales', value: 'a big increase' }, ...en,
  }), null);
});

test('영어 조립: 시각 반응은 "Image:" 머리말(모델이 붙인 머리말은 떼고), 척도는 caption 한 구 그대로', () => {
  assert.equal(assembleNarration({
    narrationType: NARRATION_TYPE_MAP.visualDescription, subKind: VISUAL_DESCRIPTION_KIND_MAP.reaction,
    rawSlotMap: { description: 'Image: a starving child collapsed from exhaustion' }, ...en,
  }).text, 'Image: a starving child collapsed from exhaustion');
  assert.equal(assembleNarration({
    narrationType: NARRATION_TYPE_MAP.visualDescription, subKind: VISUAL_DESCRIPTION_KIND_MAP.reaction,
    rawSlotMap: { description: 'a cat wearing a tiny crown' }, ...en,
  }).text, 'Image: a cat wearing a tiny crown');
  assert.equal(assembleNarration({
    narrationType: NARRATION_TYPE_MAP.visualDescription, subKind: VISUAL_DESCRIPTION_KIND_MAP.scale,
    rawSlotMap: { caption: 'a Buddha statue about four times taller than the pine tree' }, ...en,
  }).text, 'A Buddha statue about four times taller than the pine tree');
});

test('영어 조립: 발화자 이름·위치', () => {
  assert.equal(assembleNarration({
    narrationType: NARRATION_TYPE_MAP.speakerIdentity, subKind: SPEAKER_IDENTITY_KIND_MAP.named,
    rawSlotMap: { speakerName: 'Kim Jio' }, ...en,
  }).text, 'Kim Jio is speaking');
  assert.equal(assembleNarration({
    narrationType: NARRATION_TYPE_MAP.speakerIdentity, subKind: SPEAKER_IDENTITY_KIND_MAP.positional,
    rawSlotMap: { position: 'the top left' }, ...en,
  }).text, 'The participant at the top left is speaking');
});

test('영어 칸 해설 파싱: JSON 은 영어로 조립하고 NONE 은 거절로 둔다', () => {
  const option = {
    narrationType: NARRATION_TYPE_MAP.deixis, subKind: DEIXIS_FORM_MAP.simple, maxChars: 56, maxWordCount: 8, ...en,
  };
  const parsed = parseSlotCaption({ ...option, content: '{"seen":"regional revenue bars","caption":"the regional revenue bar chart"}' });
  assert.equal(parsed.isGrounded, true);
  assert.equal(parsed.text, 'The regional revenue bar chart');
  const rejected = parseSlotCaption({ ...option, content: 'NONE: nothing readable where the pointer is' });
  assert.equal(rejected.isGrounded, false);
  assert.equal(rejected.rejectKind, 'none');
});

test('어절 예산: 영어 캡션이면 상한을 1.9배(올림)로, 하한과 한국어는 그대로', () => {
  assert.equal(ENGLISH_WORD_SCALE, 1.9);
  assert.deepEqual(scaleWordBudget({ minWordCount: 4, maxWordCount: 7, language: 'en' }), { minWordCount: 4, maxWordCount: 14 });
  assert.deepEqual(scaleWordBudget({ minWordCount: 4, maxWordCount: 7, language: 'ko' }), { minWordCount: 4, maxWordCount: 7 });
  assert.deepEqual(scaleWordBudget({ minWordCount: undefined, maxWordCount: 0, language: 'en' }), { minWordCount: undefined, maxWordCount: 0 });
});

test('영어 전환: 13단어 묘사는 받는다(9어절 상한의 1.9배)', () => {
  const thirteen = parsePageTransitionText(JSON.stringify({
    screenType: 'web', screenForm: 'web page', description: 'Kimchi information page with six photos of kimchi dishes and a short recipe',
  }), en);
  assert.equal(thirteen.rejectedReason, null);
  assert.match(thirteen.narration, /^Kimchi information page with six photos/);
});

test('영어 전환 파싱: 자료 명사 검사 없이 받고, 상한을 넘긴 묘사만 미완결로 본다', () => {
  const content = JSON.stringify({
    screenType: 'ppt', pageTopic: 'Domestic development status',
    description: 'Domestic development status slide with a map and text boxes',
  });
  const english = parsePageTransitionText(content, en);
  assert.equal(english.narration, 'Domestic development status slide with a map and text boxes');
  assert.equal(english.rejectedReason, null);
  assert.equal(parsePageTransitionText(content).narration, '');
  const long = parsePageTransitionText(JSON.stringify({
    screenType: 'ppt', description: 'A very long description of the domestic development status slide with a large map, several text boxes, a color legend and two footnotes at the bottom',
  }), en);
  assert.equal(long.narration, '');
  assert.equal(long.rejectedReason, 'incomplete');
  const document = parsePageTransitionText(JSON.stringify({
    screenType: 'web', screenForm: 'Web page', description: 'District office complaint filing guide',
  }), en);
  assert.equal(document.narration, 'Web page, District office complaint filing guide');
});

const vlmConfig = { vlmUrl: 'http://x', vlmModel: 'm' };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function mockVlm(replyList) {
  const promptList = [];
  globalThis.fetch = async (_url, option) => {
    const body = JSON.parse(option.body);
    promptList.push(body.messages[0].content.find((block) => block.type === 'text').text);
    const reply = replyList[Math.min(promptList.length - 1, replyList.length - 1)];
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: reply } }] }) };
  };
  return promptList;
}

test('영어 전환: 묘사가 길면 영어로 한 번 다시 묻고, 쓸 만한 답을 고지한다', async () => {
  const long = 'A very long description of the domestic development status slide with a large map, several text boxes, a color legend and two footnotes at the bottom';
  const promptList = mockVlm([
    JSON.stringify({ screenType: 'ppt', pageTopic: 'Domestic development', description: long }),
    JSON.stringify({ screenType: 'ppt', pageTopic: 'Domestic development', description: 'Domestic C-ITS pilot project status map' }),
  ]);
  const agent = createPageTransitionAgent({ config: vlmConfig, getCaptionLanguage: () => 'en' });
  const result = await agent.generate({ jpegBuffer: Buffer.from('x'), ts: 1, minWordCount: 6, maxWordCount: 9 });
  assert.equal(promptList.length, 2);
  assert.ok(promptList[0].includes(RULE_MARK));
  assert.match(promptList[1], /is 26 words — too long/);
  assert.match(promptList[1], /at most 18 words/);
  assert.equal(result.narration, 'Domestic C-ITS pilot project status map');
  assert.equal(result.isRetried, true);
});

test('에이전트: 캡션 언어를 읽어 프롬프트·조립에 넘긴다(기본은 한국어)', async () => {
  const languageRef = { value: 'en' };
  const agentFieldMap = createAgentFieldMap({ config: vlmConfig, getCaptionLanguage: () => languageRef.value });
  const jpegBuffer = Buffer.from('x');

  let promptList = mockVlm(['{"seen":"two-year sales trend table","caption":"the two-year sales trend table"}']);
  const deixis = await agentFieldMap[NARRATION_TYPE_MAP.deixis].generate({ jpegBuffer, utterance: '여기 보시면', subKind: DEIXIS_FORM_MAP.simple });
  assert.ok(promptList[0].includes(RULE_MARK));
  assert.match(promptList[0], /2–10 words/);
  assert.equal(deixis.text, 'The two-year sales trend table');

  promptList = mockVlm(['{"value":"73%","frame":"year-over-year valuation growth rate"}']);
  const interpretation = await agentFieldMap[NARRATION_TYPE_MAP.interpretation].generate({
    jpegBuffer, utterance: '73%입니다', subKind: INTERPRETATION_KIND_MAP.valueToMeaning,
  });
  assert.ok(promptList[0].includes(RULE_MARK));
  assert.equal(interpretation.text, '73% means year-over-year valuation growth rate');

  promptList = mockVlm(['{"caption":"a Buddha statue about four times taller than the pine tree"}']);
  const scale = await agentFieldMap[NARRATION_TYPE_MAP.visualDescription].generate({
    jpegBuffer, subKind: VISUAL_DESCRIPTION_KIND_MAP.scale, utterance: '정말 크죠',
  });
  assert.ok(promptList[0].includes(RULE_MARK));
  assert.equal(scale.text, 'A Buddha statue about four times taller than the pine tree');

  promptList = mockVlm(['The horizontal axis is the year and the vertical axis is revenue in billions of won.']);
  const command = await agentFieldMap[NARRATION_TYPE_MAP.userCommand].generate({ jpegBuffer, command: USER_COMMAND_MAP.graphAxis });
  assert.ok(promptList[0].includes(RULE_MARK));
  assert.equal(command.text, 'The horizontal axis is the year and the vertical axis is revenue in billions of won.');

  promptList = mockVlm(['{"speakerName":"","position":"top left","confidence":"high"}']);
  const speaker = await agentFieldMap[NARRATION_TYPE_MAP.speakerIdentity].generate({ jpegBuffer });
  assert.ok(promptList[0].includes(RULE_MARK));
  assert.equal(speaker.text, 'The participant at the top left is speaking');

  languageRef.value = 'ko';
  promptList = mockVlm(['{"seen":"2년간 매출 추이 표","caption":"2년간 매출 추이 표"}']);
  const korean = await agentFieldMap[NARRATION_TYPE_MAP.deixis].generate({ jpegBuffer, utterance: '여기 보시면', subKind: DEIXIS_FORM_MAP.simple });
  assert.ok(!promptList[0].includes(RULE_MARK));
  assert.equal(korean.text, '2년간 매출 추이 표');

  promptList = mockVlm(['{"seen":"2년간 매출 추이 표","caption":"2년간 매출 추이 표"}']);
  await createAgentFieldMap({ config: vlmConfig })[NARRATION_TYPE_MAP.deixis].generate({ jpegBuffer, utterance: '여기 보시면' });
  assert.ok(!promptList[0].includes(RULE_MARK));
});

test('발화자: 영어 캡션이면 DOM 경로의 한국어 위치 낱말을 영어로 바꿔 읽는다', () => {
  assert.equal(buildSpeakerIdentityFromDom({ speakerName: 'Kim Jio', language: 'en' }).text, 'Kim Jio is speaking');
  const positional = buildSpeakerIdentityFromDom({ position: '오른쪽 아래', participantId: 'p1', language: 'en' });
  assert.equal(positional.text, 'The participant at the bottom right is speaking');
  assert.equal(positional.speakerKey, 'participant:p1');
  assert.equal(buildSpeakerIdentityFromDom({ position: '오른쪽 아래' }).text, '오른쪽 아래 참가자가 말합니다');
  assert.equal(parseSpeakerIdentityText('{"speakerName":"","position":"가운데","confidence":"high"}', en).text,
    'The participant at the center is speaking');
});

test('전환 머리말: 영어는 Slide N / Page / Previous …', () => {
  assert.equal(buildTransitionNarration({ isSlide: true, displayNumber: 2, narration: 'Sales trend chart', ...en }), 'Slide 2: Sales trend chart');
  assert.equal(buildTransitionNarration({ isSlide: true, displayNumber: null, narration: 'Sales trend chart', ...en }), 'Sales trend chart');
  assert.equal(buildTransitionNarration({ isSlide: false, displayNumber: 2, narration: 'Salary policy PDF document', ...en }), 'Page: Salary policy PDF document');
  assert.equal(buildRevisitNarration({ isSlide: true, displayNumber: 2, topic: 'Fair pay principles', ...en }), 'Previous page: Fair pay principles');
  assert.equal(buildRevisitNarration({ isSlide: true, displayNumber: null, topic: 'Fair pay principles', ...en }), 'Previous page: Fair pay principles');
  assert.equal(buildRevisitNarration({ isSlide: false, displayNumber: 2, topic: 'Salary policy', ...en }), 'Previous page: Salary policy');
  assert.equal(buildTransitionNarration({ isSlide: true, displayNumber: 2, narration: '매출 그래프', language: 'ko' }), '슬라이드 2: 매출 그래프');
});

test('무발화 머리말: 영어는 "Image:" 를 붙이고 한국어 자료 명사 자르기를 하지 않는다', () => {
  assert.equal(finalizeSilenceDescription({ text: 'Image: a bar chart showing sales doubling over three years.', ...en }),
    'Image: a bar chart showing sales doubling over three years');
  assert.equal(finalizeSilenceDescription({ text: 'Image, sales doubling over three years', ...en }),
    'Image: sales doubling over three years');
  assert.equal(finalizeSilenceDescription({ text: 'Image: a chart', ...en }), null);
  assert.equal(finalizeSilenceDescription({ text: 'Image: sales doubling over three years' }), null);
  assert.equal(finalizeSilenceDescription({ text: '이미지 제시, 야윈 어린아이 사진' }), '이미지 제시, 야윈 어린아이 사진');
});

test('무발화 해설: 세션 캡션 언어가 영어면 영어 머리말로 내보낸다', async () => {
  const narrator = createSilenceNarrator({
    gate: createSilenceNarrationGate(),
    judge: { judge: async () => ({ hasCue: true, reason: 'presenting', source: 'gpu' }) },
    getCaptionLanguage: () => 'en',
  });
  const emittedList = [];
  const result = await narrator.run({
    slideLabel: '3', transcript: 'Take a look at this photo.', silenceMs: 5000,
    describe: async () => ({ isGrounded: true, text: 'Image: a starving child lying on the ground' }),
    emit: async ({ text }) => { emittedList.push(text); return { isEmitted: true }; },
  });
  assert.equal(result.status, SILENCE_RESULT_MAP.emitted);
  assert.deepEqual(emittedList, ['Image: a starving child lying on the ground']);
});

function makeStore() {
  const store = createContextStore();
  store.start({ sessionId: 's', startedAt: 0 });
  store.applyRecord({ kind: 'slide_mark', ts: 1000, slideLabel: '3', frameKind: 'base', filePath: '/tmp/3.jpg' });
  store.applyRecord({ kind: 'page_transition', ts: 1100, slideLabel: '3', pageTopic: 'Salary adjustment', description: 'salary chart', displayNumber: 1 });
  store.applyRecord({ kind: 'slide_mark', ts: 600_000, slideLabel: '4', frameKind: 'base', filePath: '/tmp/missing.jpg' });
  return store;
}

function makeAnswerer({ textReplyList = ['answer'], imageReply = 'image answer', imageMap = {}, language = 'en' } = {}) {
  const textCallList = [];
  const imageCallList = [];
  const answerer = createQuestionAnswerer({
    contextStore: makeStore(),
    requestText: async (args) => { textCallList.push(args); return textReplyList.shift(); },
    requestImage: async (args) => { imageCallList.push(args); return imageReply; },
    readImage: async (filePath) => imageMap[filePath] || null,
    now: () => 700_000,
    getCaptionLanguage: () => language,
  });
  return { answerer, textCallList, imageCallList };
}

const wordBudget = { minWordCount: 3, maxWordCount: 15 };

test('질문 답 고정 문구: 영어 캡션이면 영어로 답한다(한국어 상수는 그대로)', async () => {
  const { answerer } = makeAnswerer();
  assert.equal((await answerer.answer({ route: QUESTION_ROUTE_MAP.none, questionText: 'weather?', wordBudget })).text,
    'I can only answer questions about this meeting');
  assert.equal((await answerer.answer({ route: QUESTION_ROUTE_MAP.speakerNow, questionText: 'who?', wordBudget, speakerHintNow: 'Kim Jio' })).text,
    'Kim Jio is speaking');
  assert.equal((await answerer.answer({ route: QUESTION_ROUTE_MAP.speakerNow, questionText: 'who?', wordBudget })).text,
    'I could not tell who is speaking right now');
  assert.equal((await answerer.answer({ route: QUESTION_ROUTE_MAP.pastSlide, slideMajorList: [99], questionText: 'q', wordBudget })).text,
    'That is not on the screen or in what was said');
  assert.equal(readAnswerText({ key: ANSWER_TEXT_KEY_MAP.notFound }), NOT_FOUND_TEXT);
  assert.equal(readAnswerText({ key: ANSWER_TEXT_KEY_MAP.offTopic, language: 'ko' }), OFF_TOPIC_TEXT);
  const korean = makeAnswerer({ language: 'ko' }).answerer;
  assert.equal((await korean.answer({ route: QUESTION_ROUTE_MAP.speakerNow, questionText: '누구', wordBudget, speakerHintNow: '김지오' })).text,
    '김지오님이 말하고 있어요');
});

test('질문 답: 영어 거절 문장도 답 없음으로 보고 저장 그림으로 다시 찾는다', async () => {
  assert.ok(NOT_FOUND_PHRASE_PATTERN.test('The amount is Not Mentioned in the record'));
  assert.ok(NOT_FOUND_PHRASE_PATTERN.test('I cannot find that information.'));
  assert.ok(NOT_FOUND_PHRASE_PATTERN.test('기록에 없습니다'));
  const { answerer, textCallList, imageCallList } = makeAnswerer({
    textReplyList: ['The bonus amount is not mentioned in the record.'],
    imageReply: 'The chart shows a raise of five hundred.',
    imageMap: { '/tmp/3.jpg': Buffer.from('jpg') },
  });
  const result = await answerer.answer({ route: QUESTION_ROUTE_MAP.pastSlide, slideMajorList: [3], questionText: 'how much?', wordBudget });
  assert.equal(result.isImageUsed, true);
  assert.equal(result.text, 'The chart shows a raise of five hundred.');
  assert.ok(textCallList[0].prompt.includes(RULE_MARK));
  assert.ok(imageCallList[0].prompt.includes(RULE_MARK));
});

test('질문 답: 그림이 없는 화면에 그림 질문이면 영어 안내로 답한다', async () => {
  const { answerer } = makeAnswerer({ textReplyList: ['NEED_IMAGE'] });
  const result = await answerer.answer({ route: QUESTION_ROUTE_MAP.pastSlide, slideMajorList: [4], questionText: 'what color?', wordBudget });
  assert.equal(result.text, 'No picture of that screen was saved');
});

test('질문 답: 영어 캡션이면 어절 예산 상한을 1.9배로 바꿔 지시문·자르기에 쓴다', async () => {
  const store = createContextStore();
  store.start({ sessionId: 's', startedAt: 0 });
  store.applyRecord({ kind: 'slide_mark', ts: 1000, slideLabel: '3', frameKind: 'base', filePath: '' });
  store.applyRecord({ kind: 'page_transition', ts: 1100, slideLabel: '3', pageTopic: '연봉', description: '연봉 표', displayNumber: 1 });
  const promptList = [];
  const answerer = createQuestionAnswerer({
    contextStore: store, getCaptionLanguage: () => 'en',
    requestText: async ({ prompt }) => { promptList.push(prompt); return 'The B grade salary is 12.5 million won.'; },
    requestImage: async () => 'NONE', readImage: async () => null,
  });
  await answerer.answer({ route: QUESTION_ROUTE_MAP.pastSlide, slideMajorList: [3], questionText: 'B grade?', wordBudget: { minWordCount: 3, maxWordCount: 10 } });
  assert.match(promptList[0], /3~19/);
});

// GPU 확인(10/18): 무발화 묘사가 상한에서 잘려 "…customer satisfaction, and reduced" 처럼 말이 끊겼다.
test('영어 조립: 상한에서 잘린 칸은 뒤쪽 절반의 마지막 쉼표에서 끊어 말이 중간에 끊기지 않게 한다', () => {
  const slotList = getSlotList({
    narrationType: NARRATION_TYPE_MAP.visualDescription, subKind: VISUAL_DESCRIPTION_KIND_MAP.reaction, origin: NARRATION_ORIGIN_MAP.silence, ...en,
  });
  const description = "A table comparing last year and this year's response quality metrics, showing improved first response time,"
    + ' customer satisfaction, and reduced complaint counts across every regional support center this quarter';
  const slotMap = normalizeSlotMap({ slotList, rawSlotMap: { description }, ...en });
  assert.equal(slotMap.description, "A table comparing last year and this year's response quality metrics, showing improved first response time, customer satisfaction");
});

// 실험실 확인(10/18): 영어 화면 요약 답이 단어 상한에서 잘려 "…, 82 at 5 PM, and…" 처럼 접속사로 끝나 읽혔다.
test('영어 답 자르기: 상한 안 뒤쪽 절반에 문장 끝이 있으면 그 문장까지만 둔다', () => {
  const content = 'Six time slots are shown. Morning has the most inquiries at 96 cases. Evening drops to 29 cases, the lowest of the day.';
  assert.deepEqual(parseGroundingText(content, 500, 16, 'en'), {
    text: 'Six time slots are shown. Morning has the most inquiries at 96 cases.', isGrounded: true,
  });
});

test('영어 답 자르기: 문장 끝이 앞쪽에만 있으면 마지막 쉼표에서 끊고 끊긴 끝을 뗀 뒤 "…"를 붙인다', () => {
  const content = 'The chart shows six slots. The first bar shows 96 cases, while the gray bars show 71 at 11 AM, 38 at 1 PM,'
    + ' 64 at 3 PM, 82 at 5 PM, and 29 at 7 PM.';
  assert.equal(parseGroundingText(content, 500, 30, 'en').text,
    'The chart shows six slots. The first bar shows 96 cases, while the gray bars show 71 at 11 AM, 38 at 1 PM, 64 at 3 PM…');
});

test('영어 답 자르기: a.m.·p.m. 같은 줄임말의 마침표는 문장 끝으로 보지 않는다', () => {
  const content = 'Inquiries peak at 9 a.m. and fall to 29 by 7 p.m. in the evening, then rise again slightly.';
  assert.equal(parseGroundingText(content, 500, 12, 'en').text, 'Inquiries peak at 9 a.m. and fall to 29 by 7 p.m.…');
});

test('답 자르기: 한국어(기본)는 지금처럼 어절 상한에서 자르고 "…"를 붙인다', () => {
  assert.equal(parseGroundingText('가 나 다. 라 마', 500, 4).text, '가 나 다. 라…');
  assert.equal(parseGroundingText('가 나 다. 라 마', 500, 4, 'ko').text, '가 나 다. 라…');
});

test('영어 답 자르기는 질문 답·커맨드 답·칸 해설의 일반 문장 경로가 모두 캡션 언어를 넘겨 쓴다', async () => {
  const store = createContextStore();
  store.start({ sessionId: 's', startedAt: 0 });
  store.applyRecord({ kind: 'slide_mark', ts: 1000, slideLabel: '3', frameKind: 'base', filePath: '' });
  store.applyRecord({ kind: 'page_transition', ts: 1100, slideLabel: '3', pageTopic: 'Salary', description: 'salary table', displayNumber: 1 });
  const answerer = createQuestionAnswerer({
    contextStore: store, getCaptionLanguage: () => 'en',
    requestText: async () => 'The B grade salary is 12.5 million won. The C grade salary is 11 million won, and the D grade is lower.',
    requestImage: async () => 'NONE', readImage: async () => null,
  });
  const result = await answerer.answer({
    route: QUESTION_ROUTE_MAP.pastSlide, slideMajorList: [3], questionText: 'grades?', wordBudget: { minWordCount: 3, maxWordCount: 9 },
  });
  assert.equal(result.text, 'The B grade salary is 12.5 million won. The C grade salary is 11 million won…', '상한 9어절 → 영어 18단어');
  const commandSource = fs.readFileSync(new URL('../src/main/caption-pipeline/agents/command-processing-agent.js', import.meta.url), 'utf8');
  assert.match(commandSource, /parseGroundingText\(content, effectiveMaxChars, maxWordCount, language\)/);
  const parserSource = fs.readFileSync(new URL('../src/main/caption-pipeline/agents/shared/caption-parser.js', import.meta.url), 'utf8');
  assert.match(parserSource, /parseGroundingText\(cleaned, maxChars, maxWordCount, language\)/);
});

// 영어 캡션: OCR 덩어리 안내는 다른 지시문처럼 한국어로 들어가고, 출력 언어 규칙은 그대로 끝에 붙는다.
test('영어 캡션: 수치 프롬프트의 OCR 덩어리는 규칙보다 앞에 들어가고 출력 언어 규칙은 그대로다', () => {
  const screenLineList = [{ text: 'Error rate 0.07%', score: 0.95 }, { text: '목표 0.1% 이하', score: 0.9 }];
  for (const subKind of [INTERPRETATION_KIND_MAP.claimToValue, INTERPRETATION_KIND_MAP.valueToMeaning]) {
    const englishBase = buildInterpretationPrompt({ utterance: 'The error rate is far below the target.', subKind, language: 'en' });
    const english = buildInterpretationPrompt({ utterance: 'The error rate is far below the target.', subKind, language: 'en', screenLineList });
    assert.ok(english.includes('글자 인식기(OCR)'), subKind);
    assert.ok(english.includes('Error rate 0.07%'), subKind);
    assert.ok(english.indexOf('글자 인식기(OCR)') < english.lastIndexOf(RULE_MARK), subKind);
    assert.equal(english.slice(english.lastIndexOf(RULE_MARK)), englishBase.slice(englishBase.lastIndexOf(RULE_MARK)), subKind);
    const korean = buildInterpretationPrompt({ utterance: '오류율은 목표보다 훨씬 낮습니다.', subKind, screenLineList });
    assert.ok(!korean.includes(RULE_MARK), subKind);
  }
});

test('영어 캡션: OCR 줄을 받은 수치 에이전트도 영어로 조립한다', async () => {
  const promptList = mockVlm(['{"target":"error rate","value":"0.07%"}']);
  const agentFieldMap = createAgentFieldMap({ config: vlmConfig, getCaptionLanguage: () => 'en' });
  const result = await agentFieldMap[NARRATION_TYPE_MAP.interpretation].generate({
    jpegBuffer: Buffer.from('x'), utterance: '오류율은 목표보다 훨씬 낮습니다.', subKind: INTERPRETATION_KIND_MAP.claimToValue,
    screenLineList: [{ text: '오류율 0.07%', score: 0.95 }],
  });
  assert.ok(promptList[0].includes('글자 인식기(OCR)'));
  assert.ok(promptList[0].includes(RULE_MARK));
  assert.equal(result.text, 'Error rate, 0.07%');
});
