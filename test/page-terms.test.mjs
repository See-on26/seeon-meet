import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildTransitionNarration, buildRevisitNarration, resolveHeardSlideNumber,
} = require('../src/main/caption-pipeline/orchestrator/slide-transition-text.js');
const { createScreenRegistry, SILENT_SCREEN_TYPE_LIST } = require('../src/main/caption-pipeline/orchestrator/screen-registry.js');
const { parsePageTransitionText } = require('../src/main/caption-pipeline/agents/page-transition-agent.js');
const { buildPageTransitionPrompt } = require('../src/main/caption-pipeline/prompts/page-transition.js');
const { hasCompleteTailNoun } = require('../src/main/caption-pipeline/agents/shared/narration-format.js');
const { createContextStore } = require('../src/main/caption-pipeline/context/context-store.js');

// QA 용어: PPT 만 "슬라이드 N: …", 나머지 화면은 번호 없이 "페이지: …". 번호는 안에서만 화면마다 매기고,
// 사용자가 듣는 번호는 PPT 슬라이드 순서다(예: 페이지: 윈도우 바탕화면 / 슬라이드 1: 김치의 역사 / 페이지: 김치 블로그 / 슬라이드 2: 김치의 종류).
test('PPT 는 "슬라이드 N:", PPT 가 아닌 화면은 번호 없이 "페이지:" 를 붙인다', () => {
  assert.equal(buildTransitionNarration({ isSlide: true, displayNumber: 2, narration: '김치의 종류를 정리한 표' }), '슬라이드 2: 김치의 종류를 정리한 표');
  assert.equal(buildTransitionNarration({ isSlide: false, displayNumber: null, narration: '김치에 미친 사람의 네이버 블로그 웹페이지' }),
    '페이지: 김치에 미친 사람의 네이버 블로그 웹페이지');
  assert.equal(buildTransitionNarration({ isSlide: false, displayNumber: 3, narration: '연봉 제도를 설명한 PDF 문서' }), '페이지: 연봉 제도를 설명한 PDF 문서');
});

test('돌아온 화면은 PPT 든 아니든 "이전 페이지:" 라고 말한다', () => {
  assert.equal(buildRevisitNarration({ isSlide: true, displayNumber: 2, topic: '김치의 종류' }), '이전 페이지: 김치의 종류');
  assert.equal(buildRevisitNarration({ isSlide: false, displayNumber: null, topic: '김치 블로그' }), '이전 페이지: 김치 블로그');
});

test('사용자가 듣는 번호는 PPT 에만 있다 — 문서 화면에 보이는 쪽 번호는 들려주는 번호가 아니다', () => {
  assert.equal(resolveHeardSlideNumber({ isSlide: true, registryNumber: 2, visiblePageNumber: null }), 2);
  assert.equal(resolveHeardSlideNumber({ isSlide: true, registryNumber: null, visiblePageNumber: 7 }), 7);
  assert.equal(resolveHeardSlideNumber({ isSlide: false, registryNumber: 3, visiblePageNumber: 3 }), null);
});

test('OS 화면(바탕화면·파일 탐색기·시작 메뉴·설정)도 페이지로 알리고, 판별이 확실하지 않은 화면만 알리지 않는다', () => {
  assert.deepEqual(SILENT_SCREEN_TYPE_LIST, ['unknown']);
  const registry = createScreenRegistry();
  for (const screenType of ['desktop', 'file_explorer', 'os_ui']) {
    assert.equal(registry.judgeAnnouncement({ screenType, title: screenType }).shouldAnnounce, true, screenType);
  }
  assert.equal(registry.judgeAnnouncement({ screenType: 'unknown', title: '' }).shouldAnnounce, false);
});

test('PPT 가 아닌 화면의 전환 AD 는 형태를 앞에 쉼표로 붙이지 않고 묘사 하나로 만든다', () => {
  const result = parsePageTransitionText(JSON.stringify({
    screenType: 'web', screenForm: '네이버 블로그', pageTopic: '김치', description: '김치에 미친 사람의 네이버 블로그 웹페이지',
  }));
  assert.equal(result.narration, '김치에 미친 사람의 네이버 블로그 웹페이지');
  assert.equal(result.screenForm, '네이버 블로그');
  const desktop = parsePageTransitionText(JSON.stringify({ screenType: 'desktop', screenForm: '윈도우', pageTopic: '바탕화면', description: '아이콘이 놓인 윈도우 바탕화면' }));
  assert.equal(desktop.narration, '아이콘이 놓인 윈도우 바탕화면');
});

test('화면 형태로 끝나는 묘사(블로그·사이트·탐색기·폴더·시트·파일)를 완결로 본다', () => {
  for (const text of ['김치에 미친 사람의 네이버 블로그', '구청 민원 안내 사이트', '보고서 폴더를 연 파일 탐색기', '다운로드 폴더', '월별 매출 엑셀 시트', '회의록 한글 파일']) {
    assert.equal(hasCompleteTailNoun({ text }), true, text);
  }
});

test('전환 지시문은 OS 화면을 알리는 대상으로, 판별 못 한 화면만 침묵 대상으로 두고, PPT 가 아니면 형태로 끝맺게 한다', () => {
  const prompt = buildPageTransitionPrompt();
  assert.match(prompt, /고지 대상: ppt\(발표 슬라이드\)[^\n]*desktop\(바탕화면\)[^\n]*file_explorer\(파일 탐색기\)[^\n]*os_ui/);
  assert.match(prompt, /침묵 대상: unknown/);
  assert.doesNotMatch(prompt, /침묵 대상: desktop/);
  assert.match(prompt, /"페이지: "/);
  assert.match(prompt, /블로그 웹페이지/);
});

test('묘사가 완결되지 않아 주제로 대신 적는 전환 줄도 PPT 가 아니면 "페이지:" 로 적는다', () => {
  const store = createContextStore();
  store.start({ sessionId: 's', startedAt: 0 });
  store.applyRecord({ kind: 'page_transition', ts: 1000, slideLabel: '1', screenType: 'web', narration: '', skipReason: 'incomplete_description', pageTopic: '김치 블로그' });
  store.applyRecord({ kind: 'page_transition', ts: 2000, slideLabel: '2', screenType: 'ppt', narration: '', skipReason: 'incomplete_description', pageTopic: '김치의 종류', displayNumber: 1 });
  assert.deepEqual(store.snapshot().transitionList.map((transition) => transition.text), ['페이지: 김치 블로그', '슬라이드 1: 김치의 종류']);
});

// GPU VLM 시험(10/17): 지시문만으로는 PDF 묘사가 "Attention Is All You Need 논문 본문"처럼 형태를 빠뜨렸다.
test('묘사에 화면 형태가 없으면 형태를 앞에 붙여 정보를 잃지 않는다', () => {
  const withoutForm = parsePageTransitionText(JSON.stringify({
    screenType: 'doc', screenForm: 'PDF 문서', pageTopic: '논문', description: 'Attention Is All You Need 논문 본문',
  }));
  assert.equal(withoutForm.narration, 'PDF 문서, Attention Is All You Need 논문 본문');
  const withForm = parsePageTransitionText(JSON.stringify({
    screenType: 'web', screenForm: '네이버 블로그', pageTopic: '레시피', description: '알타리무 김치 레시피를 소개하는 블로그 게시글',
  }));
  assert.equal(withForm.narration, '알타리무 김치 레시피를 소개하는 블로그 게시글');
  const noForm = parsePageTransitionText(JSON.stringify({ screenType: 'web', screenForm: '', pageTopic: 'x', description: '구청 민원 접수 방법 안내 웹페이지' }));
  assert.equal(noForm.narration, '구청 민원 접수 방법 안내 웹페이지');
});

test('지시문 예시는 특정 회사·운영체제 이름으로 묘사를 끌고 가지 않는다', () => {
  const prompt = buildPageTransitionPrompt();
  const exampleLine = prompt.split('\n').filter((line) => line.includes('예)') && /웹페이지|바탕화면|탐색기/.test(line)).join('\n');
  assert.doesNotMatch(exampleLine, /네이버|윈도우|김치/);
  assert.match(prompt, /형태 낱말을 두 번 쓰지 마라/);
});

// 윈도우 11·10·7 기본 화면 시험(10/17): 윈도우 10 을 "Windows 11 시작 메뉴"로 3/5 잘못 말했다. 버전은 글자로 보일 때만 쓴다.
test('운영체제 버전 번호는 화면에 글자로 적혀 있을 때만 쓰게 한다', () => {
  assert.match(buildPageTransitionPrompt(), /버전 번호\(11·10·7 등\)는 화면에 글자로 적혀 있을 때만/);
});
