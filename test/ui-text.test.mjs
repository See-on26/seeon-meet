import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import {
  UI_TEXT_MAP, DEFAULT_UI_LANGUAGE, createUiText, defaultUiText, applyUiTextToDom,
} from '../src/renderer/core/i18n/ui-text.js';
import { describeNonDefaultCaptionLanguage } from '../src/renderer/core/mode/caption-language-store.js';
import {
  createFeatureToggleStore, FEATURE_KEY_MAP, FEATURE_KEY_LIST, FEATURE_LABEL_MAP, readFeatureLabel,
  listDisabledFeatureLabel, describeDisabledFeatureBadge, describeDisabledFeatureNotice,
} from '../src/renderer/core/mode/feature-toggle-store.js';
import {
  createQuestionPresetStore, DEFAULT_QUESTION_PRESET_TEXT_LIST, readQuestionPresetText,
} from '../src/renderer/core/mode/question-preset-store.js';
import {
  SLIDE_TEXT_BACKEND_OPTION_LIST, SLIDE_TEXT_BACKEND_LABEL_MAP, readSlideTextBackendLabel,
} from '../src/renderer/core/mode/slide-text-backend-store.js';
import { buildMeetReloadNotice } from '../src/renderer/core/ui/meet-reload-notice.js';
import { describeGpuTunnelStatus } from '../src/renderer/core/ui/gpu-tunnel-label.js';
import { buildSlideTransitionNotice } from '../src/renderer/core/ui/slide-transition-notice.js';
import { formatMeetingLabel } from '../src/renderer/core/archive/meeting-label.js';
import { MicQuestionController } from '../src/renderer/core/command/mic-question-controller.js';
import { MeetMicGuard } from '../src/renderer/core/command/meet-mic-guard.js';
import { MEET_RELOAD_TARGET_MAP } from '../src/renderer/core/constants.js';
import { SELF_MIC_STATE_MAP } from '../src/renderer/core/roi/roi-store.js';

const HANGUL_PATTERN = /[ㄱ-ㅎㅏ-ㅣ가-힣]/;
const PLACEHOLDER_PATTERN = /\{(\w+)\}/g;

const tKo = createUiText({ getLanguage: () => 'ko' });
const tEn = createUiText({ getLanguage: () => 'en' });

const readSource = (relativePath) => fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

function createMemoryStorage() {
  const map = new Map();
  return { getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => { map.set(key, String(value)); } };
}

function readPlaceholderList(text) {
  return [...text.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]).sort();
}

// 사전

test('화면 글자 사전은 한국어·영어 두 언어이고 기본은 한국어다', () => {
  assert.deepEqual(Object.keys(UI_TEXT_MAP).sort(), ['en', 'ko']);
  assert.equal(DEFAULT_UI_LANGUAGE, 'ko');
});

test('한국어와 영어는 키 목록이 정확히 같다', () => {
  const koKeyList = Object.keys(UI_TEXT_MAP.ko).sort();
  const enKeyList = Object.keys(UI_TEXT_MAP.en).sort();
  assert.deepEqual(enKeyList.filter((key) => !koKeyList.includes(key)), [], '영어에만 있는 키');
  assert.deepEqual(koKeyList.filter((key) => !enKeyList.includes(key)), [], '한국어에만 있는 키');
});

test('모든 값은 빈 문자열이 아닌 문자열이고, 영어 값에는 한글이 없다', () => {
  for (const language of ['ko', 'en']) {
    for (const [key, value] of Object.entries(UI_TEXT_MAP[language])) {
      assert.equal(typeof value, 'string', `${language}.${key}`);
      assert.ok(value.length > 0, `${language}.${key}`);
    }
  }
  const hangulKeyList = Object.entries(UI_TEXT_MAP.en).filter(([, value]) => HANGUL_PATTERN.test(value)).map(([key]) => key);
  assert.deepEqual(hangulKeyList, []);
});

test('같은 키는 두 언어의 {자리표}가 같다', () => {
  for (const [key, koText] of Object.entries(UI_TEXT_MAP.ko)) {
    assert.deepEqual(readPlaceholderList(UI_TEXT_MAP.en[key]), readPlaceholderList(koText), key);
  }
});

// 번역기

test('번역기는 지금 언어의 문구를 고르고, 언어가 바뀌면 다음 호출부터 따른다', () => {
  let language = 'ko';
  const t = createUiText({ getLanguage: () => language });
  assert.equal(t('capture.start'), '회의 캡처 시작');
  language = 'en';
  assert.equal(t('capture.start'), 'Start meeting capture');
});

test('번역기는 {이름} 자리표를 값으로 바꾸고, 넘기지 않은 자리표는 그대로 둔다', () => {
  assert.equal(tKo('preset.removed', { slot: 3 }), 'Control 3 질문을 지웠어요');
  assert.equal(tEn('preset.removed', { slot: 3 }), 'Deleted the Control 3 question');
  assert.equal(tEn('preset.chipAriaLabel', { text: 'Who is talking?', slot: 4 }), 'Who is talking?, shortcut Control 4');
  assert.equal(tEn('preset.chipAriaLabel', { slot: 4 }), '{text}, shortcut Control 4');
  assert.equal(tEn('hint.meetJoined', { count: 0 }), 'In a meeting (tiles: 0)');
});

test('모르는 언어·영어에 없는 키는 한국어로, 어디에도 없는 키는 키 그대로 돌려준다', () => {
  assert.equal(createUiText({ getLanguage: () => 'ja' })('capture.start'), '회의 캡처 시작');
  assert.equal(createUiText({ getLanguage: () => undefined })('capture.start'), '회의 캡처 시작');
  UI_TEXT_MAP.ko['test.koOnly'] = '한국어만 {name}';
  try {
    assert.equal(tEn('test.koOnly', { name: 'A' }), '한국어만 A');
  } finally {
    delete UI_TEXT_MAP.ko['test.koOnly'];
  }
  assert.equal(tEn('no.such.key'), 'no.such.key');
});

test('기본 번역기는 한국어다', () => {
  assert.equal(defaultUiText('capture.start'), '회의 캡처 시작');
});

// 화면에 입히기

function createFakeElement(dataset) {
  return {
    dataset, textContent: '(원래 글자)', attributeMap: {},
    setAttribute(name, value) { this.attributeMap[name] = value; },
  };
}

const DATASET_KEY_BY_SELECTOR = {
  '[data-ui-text]': 'uiText',
  '[data-ui-text-aria-label]': 'uiTextAriaLabel',
  '[data-ui-text-title]': 'uiTextTitle',
  '[data-ui-text-placeholder]': 'uiTextPlaceholder',
};

function createFakeRoot(elementList) {
  return {
    querySelectorAll: (selector) => elementList.filter((element) => DATASET_KEY_BY_SELECTOR[selector] in element.dataset),
  };
}

test('data-ui-text* 를 단 요소에 글자·aria-label·title·placeholder 를 지금 언어로 입힌다', () => {
  const button = createFakeElement({ uiText: 'capture.start', uiTextTitle: 'archive.buttonTitle' });
  const icon = createFakeElement({ uiTextAriaLabel: 'settings.title', uiTextTitle: 'settings.title' });
  const input = createFakeElement({ uiTextPlaceholder: 'question.inputPlaceholder' });
  const plain = createFakeElement({});
  applyUiTextToDom({ root: createFakeRoot([button, icon, input, plain]), t: tEn });
  assert.equal(button.textContent, 'Start meeting capture');
  assert.deepEqual(button.attributeMap, { title: 'View past meeting summaries and transcripts' });
  assert.equal(icon.textContent, '(원래 글자)', 'data-ui-text 가 없으면 글자는 그대로');
  assert.deepEqual(icon.attributeMap, { 'aria-label': 'Settings', title: 'Settings' });
  assert.deepEqual(input.attributeMap, { placeholder: 'Ask anything about the screen' });
  assert.equal(plain.textContent, '(원래 글자)');
  assert.deepEqual(plain.attributeMap, {});

  applyUiTextToDom({ root: createFakeRoot([button, icon]), t: tKo });
  assert.equal(button.textContent, '회의 캡처 시작');
  assert.equal(icon.attributeMap['aria-label'], '사용자 설정');
});

// index.html

function readBodyHtml() {
  const html = readSource('src/renderer/app/index.html');
  return html.slice(html.indexOf('<body'), html.indexOf('</body>'))
    .replace(/<script\b[\s\S]*?<\/script>/g, '')
    .replace(/<style\b[\s\S]*?<\/style>/g, '');
}

function readAttribute(tag, name) {
  const match = tag.match(new RegExp(`\\s${name}=(["'])(.*?)\\1`));
  return match ? match[2] : null;
}

const ANNOTATED_TEXT_ELEMENT_PATTERN = /<(\w+)\b[^>]*\sdata-ui-text="([^"]*)"[^>]*>([^<]*)<\/\1>/g;
const ATTRIBUTE_BINDING_LIST = [
  { attribute: 'aria-label', dataAttribute: 'data-ui-text-aria-label' },
  { attribute: 'title', dataAttribute: 'data-ui-text-title' },
  { attribute: 'placeholder', dataAttribute: 'data-ui-text-placeholder' },
];

test('index.html 의 data-ui-text* 는 모두 사전에 있는 키다', () => {
  const keyList = [...readBodyHtml().matchAll(/\sdata-ui-text(?:-aria-label|-title|-placeholder)?="([^"]*)"/g)]
    .map((match) => match[1]);
  assert.ok(keyList.length >= 40, `키 ${keyList.length}개`);
  for (const key of keyList) {
    assert.ok(Object.hasOwn(UI_TEXT_MAP.ko, key), key);
    assert.ok(Object.hasOwn(UI_TEXT_MAP.en, key), key);
  }
});

test('index.html 의 data-ui-text 요소는 글자만 담고, 기본 글자는 사전의 한국어와 같다(첫 화면이 그대로다)', () => {
  const bodyHtml = readBodyHtml();
  const annotatedCount = (bodyHtml.match(/\sdata-ui-text="/g) || []).length;
  const matchList = [...bodyHtml.matchAll(ANNOTATED_TEXT_ELEMENT_PATTERN)];
  assert.equal(matchList.length, annotatedCount, '안쪽에 태그가 있는 data-ui-text 요소가 있다');
  for (const [, , key, content] of matchList) {
    assert.equal(content.replace(/\s+/g, ' ').trim(), UI_TEXT_MAP.ko[key], key);
  }
});

test('index.html 의 한국어 aria-label·title·placeholder 는 data-ui-text-* 짝이 있고, 값이 사전의 한국어와 같다', () => {
  const tagList = readBodyHtml().match(/<[a-zA-Z][^>]*>/g) || [];
  let checkedCount = 0;
  for (const tag of tagList) {
    for (const { attribute, dataAttribute } of ATTRIBUTE_BINDING_LIST) {
      const value = readAttribute(tag, attribute);
      if (value === null || !HANGUL_PATTERN.test(value)) continue;
      const key = readAttribute(tag, dataAttribute);
      assert.ok(key, `${dataAttribute} 없음: ${tag}`);
      assert.equal(value, UI_TEXT_MAP.ko[key], key);
      checkedCount += 1;
    }
  }
  assert.ok(checkedCount >= 15, `속성 ${checkedCount}개`);
});

test('단축키 안내 줄에 전체 화면 단축키(윈도 F11 · 맥 Control+Cmd+F)를 패널 접기 다음에 보인다', () => {
  const bodyHtml = readBodyHtml();
  const start = bodyHtml.indexOf('<div class="shortcuts">');
  const shortcutsHtml = bodyHtml.slice(start, bodyHtml.indexOf('</div>', start));
  const fullScreenItem = '<span><span data-ui-text="shortcut.onWindows">윈도</span> <kbd>F11</kbd>'
    + ' · <span data-ui-text="shortcut.onMac">맥</span> <kbd>Control</kbd>+<kbd>Cmd</kbd>+<kbd>F</kbd>'
    + ' <span data-ui-text="shortcut.fullScreen">전체 화면</span></span>';
  assert.ok(shortcutsHtml.includes(fullScreenItem), shortcutsHtml);
  assert.ok(shortcutsHtml.indexOf('shortcut.panelToggle') < shortcutsHtml.indexOf('shortcut.fullScreen'));
  assert.deepEqual(
    ['shortcut.onWindows', 'shortcut.onMac', 'shortcut.fullScreen'].map((key) => [tKo(key), tEn(key)]),
    [['윈도', 'Windows'], ['맥', 'Mac'], ['전체 화면', 'Full screen']],
  );
});

test('index.html 은 data-ui-text 요소를 빼면 <body> 에 보이는 한국어 글자가 없다', () => {
  const restText = readBodyHtml()
    .replace(ANNOTATED_TEXT_ELEMENT_PATTERN, '')
    .replace(/<[^>]*>/g, ' ');
  const hangulLineList = restText.split('\n').map((line) => line.trim()).filter((line) => HANGUL_PATTERN.test(line));
  assert.deepEqual(hangulLineList, []);
});

// main.js

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

// 따옴표 안의 괄호·세미콜론은 세지 않고 읽는다. stopAt 이 ')' 면 여는 괄호의 짝까지, ';' 면 문장 끝까지다.
function readUntilBalanced(source, startIndex, stopAt) {
  let depth = 0;
  let quote = null;
  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) {
      depth -= 1;
      if (stopAt === ')' && depth === 0) return source.slice(startIndex + 1, index);
      if (depth < 0) return source.slice(startIndex, index);
    } else if (stopAt === ';' && char === ';' && depth === 0) return source.slice(startIndex, index);
  }
  throw new Error(`짝이 맞지 않는다: ${source.slice(startIndex, startIndex + 80)}`);
}

function listCallArgument(source, pattern) {
  return [...source.matchAll(pattern)].map((match) => ({
    head: match[0], text: readUntilBalanced(source, match.index + match[0].length - 1, ')'),
  }));
}

function listAssignmentValue(source, pattern) {
  return [...source.matchAll(pattern)].map((match) => ({
    head: match[0], text: readUntilBalanced(source, match.index + match[0].length, ';'),
  }));
}

test('main.js 는 알림·안내·화면 글자에 한글 문자열을 직접 쓰지 않고 t(...) 로 고른다', () => {
  const source = stripComments(readSource('src/renderer/app/main.js'));
  const callList = listCallArgument(source, /\b(?:announce|showNotice|setArchiveStatus|showModal|appendAskBubble)\(/g);
  const attributeCallList = listCallArgument(source, /\.setAttribute\((?='(?:aria-label|title|placeholder)')/g);
  const assignmentList = listAssignmentValue(source, /\.(?:textContent|title|placeholder)\s*=(?!=)/g);
  assert.ok(callList.length >= 40, `알림 호출 ${callList.length}개`);
  assert.ok(assignmentList.length >= 30, `글자 대입 ${assignmentList.length}개`);
  const hangulList = [...callList, ...attributeCallList, ...assignmentList]
    .filter(({ text }) => HANGUL_PATTERN.test(text))
    .map(({ head, text }) => `${head} ${text.trim().slice(0, 60)}`);
  assert.deepEqual(hangulList, []);
});

test('main.js 는 캡션 언어로 번역기를 만들어 시작할 때와 언어가 바뀔 때 화면 글자를 다시 입힌다', () => {
  const source = readSource('src/renderer/app/main.js');
  assert.match(source, /const t = createUiText\(\{ getLanguage: \(\) => captionLanguageStore\.get\(\) \}\);/);
  assert.match(source, /document\.documentElement\.lang = captionLanguageStore\.get\(\);\napplyUiTextToDom\(\{ root: document, t \}\);/);
  assert.match(source, /captionLanguageStore\.subscribe\(\(\{ language \}\) => \{\n {2}applyCaptionLanguageToUi\(\{ language \}\);/);
  const applyBody = source.slice(source.indexOf('function applyCaptionLanguageToUi'), source.indexOf('// 선택 상자는 스크린리더가 바뀐 값을 읽으므로'));
  for (const call of [
    'document.documentElement.lang = language', 'applyUiTextToDom', 'setToggleUi', 'setPauseUi', 'syncToggleAvailability',
    'renderModeButtons', 'buildFeatureToggleList', 'renderSlideTextBackendOptions', 'buildQuestionPresetChips',
    'buildQuestionPresetEditor', 'rerenderGpuTunnelStatus',
  ]) assert.ok(applyBody.includes(call), call);
});

test('main.js 는 main 에 넘기는 질문 문구(questionLabel)를 한국어 그대로 넘긴다', () => {
  const source = readSource('src/renderer/app/main.js');
  assert.match(source, /questionLabel: USER_COMMAND_LABEL_MAP\[command\] \|\| ''/);
  assert.match(source, /\[USER_COMMAND_MAP\.screenMaterial\]: '지금 화면에 무슨 자료가 있어\?'/);
});

// 모듈의 영어 경로(한국어 기본 동작은 각 모듈의 기존 테스트가 지킨다)

test('캡처 시작 안내의 캡션 언어 문구도 화면 언어를 따른다(언어 이름은 그대로)', () => {
  assert.equal(describeNonDefaultCaptionLanguage({ language: 'en', t: tEn }), 'Caption language: English');
  assert.equal(describeNonDefaultCaptionLanguage({ language: 'ko', t: tEn }), '');
});

test('기능 이름·꺼진 기능 배지·시작 안내를 영어로도 만든다', () => {
  const store = createFeatureToggleStore({ storage: createMemoryStorage() });
  store.set(FEATURE_KEY_MAP.pageTransition, false);
  store.set(FEATURE_KEY_MAP.meetingSummary, false);
  assert.deepEqual(listDisabledFeatureLabel({ store, t: tEn }), ['Page change announcements', 'Meeting summary']);
  assert.equal(describeDisabledFeatureBadge({ store, t: tEn }), 'Off: Page change announcements · Meeting summary');
  assert.equal(describeDisabledFeatureNotice({ store, t: tEn }),
    'Features turned off: Page change announcements (Control Q), Meeting summary (Control 0). You can turn them on in settings or with shortcuts');
  assert.equal(readFeatureLabel({ key: FEATURE_KEY_MAP.speakerIdentity, t: tEn }), 'Speaker announcements');
  for (const key of FEATURE_KEY_LIST) assert.equal(FEATURE_LABEL_MAP[key], readFeatureLabel({ key }), key);
  assert.equal(FEATURE_LABEL_MAP[FEATURE_KEY_MAP.speakerIdentity], '화자 안내');
});

test('기본 질문 프리셋은 화면 언어의 이름으로 보이고, 한국어 이름은 저장된 기본 문구와 같다', () => {
  const store = createQuestionPresetStore({ storage: createMemoryStorage() });
  assert.deepEqual(store.list().map((preset) => readQuestionPresetText({ preset })), DEFAULT_QUESTION_PRESET_TEXT_LIST);
  assert.deepEqual(store.list().map((preset) => readQuestionPresetText({ preset, t: tEn })),
    ["What's this material?", 'Summarize this screen', 'What are the graph axes?']);
  store.add('발표자 이름이 뭐야?');
  store.setText(2, 'Who is presenting?');
  assert.equal(readQuestionPresetText({ preset: store.get(4), t: tEn }), '발표자 이름이 뭐야?', '사용자가 넣은 문구는 그대로');
  assert.equal(readQuestionPresetText({ preset: store.get(2), t: tEn }), 'Who is presenting?');
});

test('화면 글자 읽기 선택지 이름을 영어로도 만들고, 한국어 이름표는 그대로다', () => {
  assert.equal(readSlideTextBackendLabel({ backend: 'vlm', t: tEn }), 'VLM (vision model)', '설정 패널 한 줄에 들어가는 길이');
  assert.equal(readSlideTextBackendLabel({ backend: 'ocr', t: tEn }), 'OCR (text recognition)');
  assert.deepEqual(SLIDE_TEXT_BACKEND_LABEL_MAP, { vlm: 'VLM(화면 이해 모델)', ocr: 'OCR(글자 인식)' });
  for (const backend of SLIDE_TEXT_BACKEND_OPTION_LIST) assert.ok(readSlideTextBackendLabel({ backend, t: tEn }), backend);
});

test('GPU 서버 상태를 화면 언어로 쓰고, 한국어는 main 의 상태 문구와 같다', () => {
  const { describeTunnelStatus, TUNNEL_STATUS_MAP, TUNNEL_REASON_MAP } = createRequire(import.meta.url)('../src/main/gpu-tunnel/tunnel-status.js');
  const snapshotList = [
    ...Object.values(TUNNEL_STATUS_MAP).map((status) => ({ status, reason: null })),
    ...Object.values(TUNNEL_REASON_MAP).map((reason) => ({ status: TUNNEL_STATUS_MAP.reconnecting, reason })),
  ];
  for (const snapshot of snapshotList) {
    const label = describeTunnelStatus(snapshot);
    assert.equal(describeGpuTunnelStatus({ ...snapshot, label, t: tKo }), label, JSON.stringify(snapshot));
    const english = describeGpuTunnelStatus({ ...snapshot, label, t: tEn });
    assert.ok(english && !HANGUL_PATTERN.test(english), `${JSON.stringify(snapshot)} → ${english}`);
  }
  assert.equal(describeGpuTunnelStatus({ status: TUNNEL_STATUS_MAP.external, label: '외부 터널', t: tEn }), 'External tunnel');
  assert.equal(describeGpuTunnelStatus({
    status: TUNNEL_STATUS_MAP.reconnecting, reason: TUNNEL_REASON_MAP.authFailed, label: '다시 연결 중 (인증 실패)', t: tEn,
  }), 'Reconnecting (authentication failed)');
  assert.equal(describeGpuTunnelStatus({ status: 'unknown_status', label: '새 상태', t: tEn }), '새 상태',
    '모르는 상태 코드면 main 이 만든 문구를 그대로 쓴다');
});

test('Meet 새로고침·화면 전환 안내를 영어로도 만든다', () => {
  assert.equal(buildMeetReloadNotice({ target: MEET_RELOAD_TARGET_MAP.meeting, isCaptureActive: false, t: tEn }),
    'Reloaded the Meet screen. Please rejoin the meeting');
  assert.equal(buildMeetReloadNotice({ target: MEET_RELOAD_TARGET_MAP.home, isCaptureActive: false, t: tEn }),
    'Back on the Meet home screen. Enter a meeting code or join with a meeting link');
  assert.equal(buildMeetReloadNotice({ target: MEET_RELOAD_TARGET_MAP.home, isCaptureActive: true, t: tEn }),
    'Back on the Meet home screen. Rejoin the meeting, and if capture stopped, start it again');
  assert.equal(buildSlideTransitionNotice({ isRevisit: false, t: tEn }), 'Screen changed — preparing announcement…');
  assert.equal(buildSlideTransitionNotice({ isRevisit: true, t: tEn }), 'Back to a previous screen — preparing announcement…');
});

test('지난 회의 항목을 영어 어순(월 이름·12시간제)으로 읽는다', () => {
  const startedAt = new Date(2026, 9, 5, 14, 30).getTime();
  assert.equal(formatMeetingLabel({
    meeting: { startedAt, endedAt: startedAt + 42 * 60_000, title: 'Q3 sales', hasSummary: true }, t: tEn,
  }), 'Meeting on October 5, 2:30 PM, Q3 sales, 42 min, summary available');
  assert.equal(formatMeetingLabel({ meeting: { startedAt: new Date(2026, 0, 9, 9, 5).getTime(), hasSummary: false }, t: tEn }),
    'Meeting on January 9, 9:05 AM, no summary');
  assert.equal(formatMeetingLabel({ meeting: { startedAt: new Date(2026, 11, 31, 0, 0).getTime(), hasSummary: false }, t: tEn }),
    'Meeting on December 31, 12:00 AM, no summary');
  assert.equal(formatMeetingLabel({ meeting: { startedAt: new Date(2026, 11, 31, 0, 0).getTime(), hasSummary: false } }),
    '12월 31일 오전 12시 0분 회의, 요약 없음');
  const januaryMeeting = { startedAt: new Date(2026, 0, 9, 9, 5).getTime(), hasSummary: false };
  assert.equal(formatMeetingLabel({ meeting: { ...januaryMeeting, summaryStatus: 'pending' }, t: tEn }),
    'Meeting on January 9, 9:05 AM, summary in progress');
  assert.equal(formatMeetingLabel({ meeting: { ...januaryMeeting, summaryStatus: 'failed' }, t: tEn }),
    'Meeting on January 9, 9:05 AM, summary failed');
});

test('마이크 질문 안내를 영어로도 읽는다', async () => {
  const log = [];
  const controller = new MicQuestionController({
    recorder: { start: async () => false, toggle() {}, cancel() {} },
    canStart: () => false,
    beginSession: async () => {}, endSession: async () => {},
    announce: (text) => log.push(text), setUi: () => {}, onQuestionAudio: async () => {},
    t: tEn,
  });
  await controller.toggle();
  await controller.handleCancel({ reason: 'permission' });
  await controller.handleCancel({ reason: 'unknown' });
  assert.deepEqual(log, ['Start meeting capture to ask a question', 'Microphone permission is needed', 'Voice question cancelled']);
});

test('회의 마이크 확인 실패 안내를 영어로도 읽는다', async () => {
  const noticeList = [];
  const guard = new MeetMicGuard({
    getSelfMicState: () => SELF_MIC_STATE_MAP.unknown, toggleMeetMic: async () => ({ isOk: true }),
    wait: async () => {}, notify: (text) => noticeList.push(text), t: tEn,
  });
  assert.equal(await guard.muteForRecording(), false);
  assert.deepEqual(noticeList, ["Couldn't check the meeting microphone status"]);
});

// 실험실 확인(10/18): 타일이 하나일 때 "In a meeting (1 tiles)" 로 보였다. 개수와 상관없이 맞는 꼴로 쓴다.
test('회의 참여 안내의 타일 수는 영어에서도 개수와 상관없이 문법이 맞다', () => {
  assert.equal(tEn('hint.meetJoined', { count: 1 }), 'In a meeting (tiles: 1)');
  assert.equal(tEn('hint.meetJoined', { count: 4 }), 'In a meeting (tiles: 4)');
  assert.equal(tKo('hint.meetJoined', { count: 1 }), '회의 참여 확인 (타일 1개)');
});
