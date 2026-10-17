import { test } from 'node:test';
import assert from 'node:assert/strict';
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

test('복귀 해설: 슬라이드면 "이전 슬라이드 N", 슬라이드가 아니면 "이전 페이지" 로 말한다', () => {
  assert.equal(buildRevisitNarration({ isSlide: true, displayNumber: 2, topic: '공정한 보상 원칙' }), '이전 슬라이드 2: 공정한 보상 원칙');
  assert.equal(buildRevisitNarration({ isSlide: false, displayNumber: 3, topic: '반기 연봉 조정 제도' }), '이전 페이지: 반기 연봉 조정 제도');
  assert.equal(buildRevisitNarration({ isSlide: true, displayNumber: null, topic: '공정한 보상 원칙' }), '이전 화면: 공정한 보상 원칙');
});

test('패널 안내: 전환 순간에는 슬라이드인지 모르므로 내부 순번을 보이지 않는다', () => {
  assert.equal(buildSlideTransitionNotice({ isRevisit: false }), '화면 전환 — 화면 고지 생성 중…');
  assert.equal(buildSlideTransitionNotice({ isRevisit: true }), '이전 화면으로 복귀 — 고지 생성 중…');
});
