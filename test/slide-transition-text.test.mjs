import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { buildSlideTransitionNotice } from '../src/renderer/core/ui/slide-transition-notice.js';

const require = createRequire(import.meta.url);
const {
  buildTransitionNarration, buildRevisitNarration,
} = require('../src/main/caption-pipeline/orchestrator/slide-transition-text.js');

test('전환 해설: 번호가 있는 슬라이드만 "슬라이드 N:", 슬라이드가 아니면 "페이지:" 를 붙인다', () => {
  assert.equal(buildTransitionNarration({ isSlide: true, displayNumber: 1, narration: '매출 추이 그래프' }), '슬라이드 1: 매출 추이 그래프');
  assert.equal(buildTransitionNarration({ isSlide: false, displayNumber: 3, narration: '연봉 제도를 설명한 PDF 문서' }), '페이지: 연봉 제도를 설명한 PDF 문서');
  assert.equal(buildTransitionNarration({ isSlide: true, displayNumber: null, narration: '매출 추이 그래프' }), '매출 추이 그래프');
});

test('복귀 해설: 화면 유형·번호와 상관없이 "이전 페이지: 주제" 로 짧게 말한다', () => {
  assert.equal(buildRevisitNarration({ isSlide: true, displayNumber: 2, topic: '공정한 보상 원칙' }), '이전 페이지: 공정한 보상 원칙');
  assert.equal(buildRevisitNarration({ isSlide: false, displayNumber: 3, topic: '반기 연봉 조정 제도' }), '이전 페이지: 반기 연봉 조정 제도');
  assert.equal(buildRevisitNarration({ isSlide: true, displayNumber: null, topic: '공정한 보상 원칙' }), '이전 페이지: 공정한 보상 원칙');
});

test('패널 안내: 전환 순간에는 슬라이드인지 모르므로 내부 순번을 보이지 않는다', () => {
  assert.equal(buildSlideTransitionNotice({ isRevisit: false }), '화면 전환 — 화면 고지 생성 중…');
  assert.equal(buildSlideTransitionNotice({ isRevisit: true }), '이전 화면으로 복귀 — 고지 생성 중…');
});

test('패널 안내: 페이지 전환 안내를 꺼 두면 전환·복귀 안내를 띄우지 않는다', () => {
  assert.equal(buildSlideTransitionNotice({ isRevisit: false, isPageTransitionOn: false }), null);
  assert.equal(buildSlideTransitionNotice({ isRevisit: true, isPageTransitionOn: false }), null);
  assert.equal(buildSlideTransitionNotice({ isRevisit: false, isPageTransitionOn: true }), '화면 전환 — 화면 고지 생성 중…');
});

test('패널 안내: 렌더러는 페이지 전환 토글 상태를 넘기고, 안내가 없으면 띄우지 않는다', () => {
  const mainSource = fs.readFileSync(new URL('../src/renderer/app/main.js', import.meta.url), 'utf8');
  assert.match(mainSource, /buildSlideTransitionNotice\(\{[^}]*isPageTransitionOn: featureToggleStore\.isOn\(FEATURE_KEY_MAP\.pageTransition\)/);
  assert.match(mainSource, /if \(transitionNotice\) showNotice\(transitionNotice\)/);
});
