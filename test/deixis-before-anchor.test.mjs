import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import {
  MODE_MAP, MODE_POLICY_MAP, CONTEXT_ANCHOR_MAP, ANAPHORIC_MIN_BEFORE_MS,
  resolveDeixisBeforeAnchorTs, isAnaphoricDeixis, getModePolicy,
} from '../src/renderer/core/mode/mode-policy.js';
import { TranscriptWindow } from '../src/renderer/core/trigger/transcript-window.js';

const require = createRequire(import.meta.url);
const { TRIGGER_TYPE_MAP, detectKoreanCandidateListByRule } = require('../src/main/caption-pipeline/trigger/speech-trigger.js');

const readSource = (relativePath) => fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

// 카드 영상: 슬라이드 2 확정 5.3초, 트리거 "그걸 밝혀 주는…" 11.3초, 결정하는 사이 슬라이드 3 확정 13.7초.
const TRANSITION_TS_LIST = [5300, 13700];

test('앞 맥락 기준은 트리거 시각 이전의 마지막 전환이다 — 트리거 뒤에 확정된 전환은 무시한다', () => {
  for (const mode of Object.values(MODE_MAP)) {
    assert.equal(resolveDeixisBeforeAnchorTs({ mode, transitionTsList: TRANSITION_TS_LIST, triggerTs: 11300 }), 5300, mode);
    assert.equal(resolveDeixisBeforeAnchorTs({ mode, transitionTsList: TRANSITION_TS_LIST, triggerTs: 14000 }), 13700, mode);
  }
});

test('트리거와 같은 시각에 확정된 전환은 기준이 된다', () => {
  assert.equal(resolveDeixisBeforeAnchorTs({
    mode: MODE_MAP.realtimeMix, transitionTsList: TRANSITION_TS_LIST, triggerTs: 13700,
  }), 13700);
});

test('전환 목록 순서와 관계없이 트리거 이전 가장 늦은 전환을 고른다', () => {
  assert.equal(resolveDeixisBeforeAnchorTs({
    mode: MODE_MAP.delayed, transitionTsList: [13700, 1000, 5300, Number.NaN, null], triggerTs: 11300,
  }), 5300);
});

test('그-계열 지시는 마지막 전환보다 15초 앞까지 앞 발화를 본다', () => {
  assert.equal(ANAPHORIC_MIN_BEFORE_MS, 15000);
  assert.equal(resolveDeixisBeforeAnchorTs({
    mode: MODE_MAP.realtimeMix, transitionTsList: TRANSITION_TS_LIST, triggerTs: 14000, isAnaphoric: true,
  }), -1000);
  // 전환이 트리거보다 15초 넘게 앞이면 전환 기준 그대로(더 넓다).
  assert.equal(resolveDeixisBeforeAnchorTs({
    mode: MODE_MAP.realtimeMix, transitionTsList: [1000], triggerTs: 30000, isAnaphoric: true,
  }), 1000);
});

test('트리거 이전 전환이 없거나 앵커 정책이 화면 전환이 아닌 모드면 기준이 없다(null)', () => {
  assert.equal(resolveDeixisBeforeAnchorTs({ mode: MODE_MAP.realtimeMix, transitionTsList: [], triggerTs: 11300 }), null);
  assert.equal(resolveDeixisBeforeAnchorTs({ mode: MODE_MAP.realtimeMix, transitionTsList: [13700], triggerTs: 11300 }), null);
  assert.equal(resolveDeixisBeforeAnchorTs({ mode: MODE_MAP.realtimeMix, triggerTs: 11300 }), null);
  assert.equal(resolveDeixisBeforeAnchorTs({ mode: 'unknown', transitionTsList: TRANSITION_TS_LIST, triggerTs: 11300 }), null);
  const policy = getModePolicy({ mode: MODE_MAP.realtimeMix });
  const originalAnchor = policy.contextAnchor;
  try {
    MODE_POLICY_MAP[MODE_MAP.realtimeMix].contextAnchor = CONTEXT_ANCHOR_MAP.window;
    assert.equal(resolveDeixisBeforeAnchorTs({
      mode: MODE_MAP.realtimeMix, transitionTsList: TRANSITION_TS_LIST, triggerTs: 11300, isAnaphoric: true,
    }), null);
  } finally {
    MODE_POLICY_MAP[MODE_MAP.realtimeMix].contextAnchor = originalAnchor;
  }
});

test('그-계열 지시대명사·거기 후보가 하나라도 있으면 앞말을 받는 지시로 본다', () => {
  const demonstrative = (phrase) => ({ type: TRIGGER_TYPE_MAP.demonstrative, phrase });
  for (const phrase of ['그걸', '그것', '그게', '그거', '그 뒷면', '거기', '그렇게']) {
    assert.equal(isAnaphoricDeixis({ candidateList: [demonstrative(phrase)] }), true, phrase);
  }
  for (const phrase of ['이 그래프', '여기', '저기', '이거', '저쪽']) {
    assert.equal(isAnaphoricDeixis({ candidateList: [demonstrative(phrase)] }), false, phrase);
  }
  assert.equal(isAnaphoricDeixis({ candidateList: [demonstrative('이 그래프'), demonstrative('그 뒷면')] }), true);
  // 지시대명사가 아닌 후보(형용사+명사·수치)는 그로 시작해도 세지 않는다.
  assert.equal(isAnaphoricDeixis({ candidateList: [{ type: TRIGGER_TYPE_MAP.adjectiveNoun, phrase: '그런 쪽' }] }), false);
  assert.equal(isAnaphoricDeixis({ candidateList: [] }), false);
  assert.equal(isAnaphoricDeixis({}), false);
  assert.equal(isAnaphoricDeixis({ candidateList: [null, { type: TRIGGER_TYPE_MAP.demonstrative }] }), false);
});

test('main 트리거가 뽑은 후보 모양 그대로 그-계열을 알아본다', () => {
  assert.equal(isAnaphoricDeixis({ candidateList: detectKoreanCandidateListByRule({ text: '그럼 그 뒷면에는 무조건' }) }), true);
  assert.equal(isAnaphoricDeixis({ candidateList: detectKoreanCandidateListByRule({ text: '이 그래프를 보세요' }) }), false);
});

function buildCardTranscriptWindow() {
  const transcriptWindow = new TranscriptWindow({});
  transcriptWindow.push({ text: '연습을 많이 하면 그 일에 친숙해지죠.', ts: 1000 });
  transcriptWindow.push({ text: '사람을 더 똑똑하고 지혜롭게 만든다는 것과는 무관하거든요.', ts: 8000 });
  transcriptWindow.push({ text: '그걸 밝혀 주는 아주 재밌는 연구가 있습니다.', ts: 11300 });
  transcriptWindow.push({ text: '그럼 그 뒷면에는 무조건', ts: 16100 });
  return transcriptWindow;
}

test('트리거 이전 전환을 기준으로 고르면 앞 화면에서 한 주장이 앞 맥락에 들어간다', () => {
  const transcriptWindow = buildCardTranscriptWindow();
  const triggerTs = 11300;
  const anchorTs = resolveDeixisBeforeAnchorTs({
    mode: MODE_MAP.realtimeMix, transitionTsList: TRANSITION_TS_LIST, triggerTs,
  });
  const { before } = transcriptWindow.getContext({ triggerTs, beforeMs: 60000, afterMs: 2000, anchorTs });
  assert.match(before, /무관하거든요/);
  assert.doesNotMatch(before, /친숙해지죠/, '슬라이드 2 확정(5.3초) 앞 발화는 이·저-계열이면 빠진다');

  // 결정 시각의 마지막 전환(13.7초)을 기준으로 쓰면 앞 맥락이 통째로 빈다 — 되돌림 방지.
  assert.equal(transcriptWindow.getContext({ triggerTs, beforeMs: 60000, afterMs: 2000, anchorTs: 13700 }).before, '');
});

test('그-계열이면 앞 슬라이드에서 한 앞말까지 앞 맥락에 들어간다', () => {
  const transcriptWindow = buildCardTranscriptWindow();
  const triggerTs = 11300;
  const anchorTs = resolveDeixisBeforeAnchorTs({
    mode: MODE_MAP.realtimeMix, transitionTsList: TRANSITION_TS_LIST, triggerTs,
    isAnaphoric: isAnaphoricDeixis({ candidateList: [{ type: TRIGGER_TYPE_MAP.demonstrative, phrase: '그걸' }] }),
  });
  assert.equal(anchorTs, triggerTs - ANAPHORIC_MIN_BEFORE_MS);
  const { before } = transcriptWindow.getContext({ triggerTs, beforeMs: 60000, afterMs: 2000, anchorTs });
  assert.match(before, /친숙해지죠/);
  assert.match(before, /무관하거든요/);
});

test('렌더러는 화면 전환 확정 시각을 목록으로 모으고 캡처 시작 때 비운 뒤, 지시 판정의 앞 맥락 기준을 트리거 시각으로 고른다', () => {
  const source = readSource('src/renderer/app/main.js');
  const readBody = (name) => {
    const start = source.indexOf(`async function ${name}(`);
    assert.ok(start >= 0, name);
    return source.slice(start, source.indexOf('\n}\n', start));
  };
  assert.match(source, /\nconst screenTransitionTsList = \[\];/);
  assert.match(readBody('confirmSlideCandidate'),
    /lastScreenTransitionAt = performance\.now\(\);\n\s*recordScreenTransitionTs\(lastScreenTransitionAt\);/);
  assert.match(readBody('attemptStartExperiment'),
    /lastScreenTransitionAt = performance\.now\(\);\n\s*screenTransitionTsList\.length = 0;\n\s*recordScreenTransitionTs\(lastScreenTransitionAt\);/);
  const decisionBody = readBody('runDeixisDecision');
  assert.match(decisionBody, /const isAnaphoric = isAnaphoricDeixis\(\{ candidateList \}\);/);
  assert.match(decisionBody,
    /const anchorTs = resolveDeixisBeforeAnchorTs\(\{\s*mode, transitionTsList: screenTransitionTsList, triggerTs: captureTs, isAnaphoric,\s*\}\);/);
  assert.doesNotMatch(decisionBody, /screenTransitionTs: lastScreenTransitionAt/);
});
