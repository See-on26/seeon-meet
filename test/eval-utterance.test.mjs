import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitTranscript, buildUtteranceList, findPieceIndexByOffset, SPEECH_MS_PER_WORD,
} from '../tools/eval/lib/utterance-builder.mjs';
import { buildRouterInput, buildSilenceInput, resolveContextWindow } from '../tools/eval/lib/router-context.mjs';
import { computeSpeechDurationMs } from '../src/renderer/core/mode/mode-policy.js';

const pick = (pieceList) => pieceList.map(({ kind, text, startMs, endMs }) => ({ kind, text, startMs, endMs }));

test('어절당 시간은 production TTS 추정과 같다', () => {
  assert.equal(SPEECH_MS_PER_WORD, computeSpeechDurationMs({ wordCount: 1 }));
});

test('전사를 문장과 무발화 구간으로 나누고 글자 위치를 남긴다', () => {
  const transcript = '여러분, 이 사진을 한번 보시죠. [무발화 7초] 네, 어떠세요?';
  const pieceList = splitTranscript({ transcript });
  assert.deepEqual(pieceList.map((piece) => [piece.kind, transcript.slice(piece.start, piece.end)]), [
    ['speech', '여러분, 이 사진을 한번 보시죠.'],
    ['silence', '[무발화 7초]'],
    ['speech', '네, 어떠세요?'],
  ]);
});

test('시각이 없으면 어절당 0.45초로 추정하고 무발화는 그 길이를 더한다', () => {
  const utteranceList = buildUtteranceList({ item: { id: 'x', transcript: '여러분, 이 사진을 한번 보시죠. [무발화 7초] 네, 어떠세요?' } });
  assert.deepEqual(pick(utteranceList), [
    { kind: 'speech', text: '여러분, 이 사진을 한번 보시죠.', startMs: 0, endMs: 2250 },
    { kind: 'silence', text: '[무발화 7초]', startMs: 2250, endMs: 9250 },
    { kind: 'speech', text: '네, 어떠세요?', startMs: 9250, endMs: 10150 },
  ]);
  assert.deepEqual(utteranceList.map((piece) => piece.index), [0, 1, 2]);
});

test('utteranceList 가 있으면 그 시각을 쓰고 무발화는 앞 발화 끝에서 시작한다', () => {
  const utteranceList = buildUtteranceList({
    item: {
      id: 'x',
      transcript: '여러분, 이 사진을 한번 보시죠. [무발화 7초] 네, 어떠세요?',
      utteranceList: [
        { text: '여러분, 이 사진을 한번 보시죠.', startMs: 1000, endMs: 3500 },
        { text: '네, 어떠세요?', startMs: 11000, endMs: 12000 },
      ],
    },
  });
  assert.deepEqual(pick(utteranceList), [
    { kind: 'speech', text: '여러분, 이 사진을 한번 보시죠.', startMs: 1000, endMs: 3500 },
    { kind: 'silence', text: '[무발화 7초]', startMs: 3500, endMs: 10500 },
    { kind: 'speech', text: '네, 어떠세요?', startMs: 11000, endMs: 12000 },
  ]);
});

test('글자 위치로 발화를 찾고 발화 사이 공백은 앞 발화로 본다', () => {
  const utteranceList = buildUtteranceList({ item: { id: 'x', transcript: '하나 둘. 셋 넷.' } });
  assert.equal(findPieceIndexByOffset({ utteranceList, offset: 0 }), 0);
  assert.equal(findPieceIndexByOffset({ utteranceList, offset: 5 }), 0);
  assert.equal(findPieceIndexByOffset({ utteranceList, offset: 6 }), 1);
});

const threeSentenceItem = {
  id: 'x',
  transcript: '마지막 단계에서 두 테이블을 하나로 합치는데요. 이 부분에서 오류가 제일 많이 납니다. 그래서 순서를 바꿔서 다시 돌렸더니 오류가 사라졌습니다.',
};

test('맥락 창 프리셋: 기본 item 은 항목 전체, symmetric7 은 앞뒤 7초, production 은 모드 정책이고 ms 옵션이 앞선다', () => {
  assert.deepEqual(resolveContextWindow({ mode: 'delayed' }), { preset: 'item', beforeMs: null, afterMs: null, anchorTs: null });
  assert.deepEqual(resolveContextWindow({ mode: 'delayed', preset: 'symmetric7' }), { preset: 'symmetric7', beforeMs: 7000, afterMs: 7000, anchorTs: null });
  assert.deepEqual(resolveContextWindow({ mode: 'delayed', preset: 'production' }), { preset: 'production', beforeMs: 60000, afterMs: 7000, anchorTs: 0 });
  assert.deepEqual(resolveContextWindow({ mode: 'realtime_mix', preset: 'production' }), { preset: 'production', beforeMs: 60000, afterMs: 2000, anchorTs: null });
  assert.deepEqual(resolveContextWindow({ mode: 'delayed', preset: 'production', beforeMs: 7000, afterMs: 5000 }), { preset: 'production', beforeMs: 7000, afterMs: 5000, anchorTs: 0 });
  assert.throws(() => resolveContextWindow({ mode: 'unknown' }), /알 수 없는 모드/);
  assert.throws(() => resolveContextWindow({ mode: 'delayed', preset: 'wide' }), /--context/);
});

test('라우터 입력은 판정 발화를 빼고 앞·뒤 맥락 창으로 만든다', () => {
  const utteranceList = buildUtteranceList({ item: threeSentenceItem });
  const mix = buildRouterInput({ utteranceList, index: 1, contextWindow: resolveContextWindow({ mode: 'realtime_mix', preset: 'production' }) });
  assert.equal(mix.utterance, '이 부분에서 오류가 제일 많이 납니다.');
  assert.equal(mix.before, '마지막 단계에서 두 테이블을 하나로 합치는데요.');
  assert.equal(mix.after, '', '동시 모드의 뒤 맥락 2초 안에 끝나는 발화가 없다');
  const delayed = buildRouterInput({ utteranceList, index: 1, contextWindow: resolveContextWindow({ mode: 'delayed', preset: 'symmetric7' }) });
  assert.equal(delayed.after, '그래서 순서를 바꿔서 다시 돌렸더니 오류가 사라졌습니다.');
  const whole = buildRouterInput({ utteranceList, index: 1, contextWindow: resolveContextWindow({ mode: 'delayed' }) });
  assert.deepEqual([whole.before, whole.after], [mix.before, delayed.after], '항목 전체 맥락');
});

test('앞 창 7초보다 먼저 끝난 발화는 앞 맥락에서 빠지고 production 프리셋은 60초까지 본다', () => {
  const utteranceList = buildUtteranceList({ item: { id: 'x', transcript: '첫 문장입니다. [무발화 9초] 이 부분에서 오류가 납니다.' } });
  assert.equal(buildRouterInput({ utteranceList, index: 2, contextWindow: resolveContextWindow({ mode: 'delayed', preset: 'production' }) }).before, '첫 문장입니다.');
  assert.equal(buildRouterInput({ utteranceList, index: 2, contextWindow: resolveContextWindow({ mode: 'delayed', preset: 'symmetric7' }) }).before, '');
  assert.equal(buildRouterInput({ utteranceList, index: 2, contextWindow: resolveContextWindow({ mode: 'delayed' }) }).before, '첫 문장입니다.');
});

test('무발화 입력은 무음 5초 시점의 직전 15초 전사이고 production 전제 조건을 그대로 쓴다', () => {
  const utteranceList = buildUtteranceList({ item: { id: 'x', transcript: '이상으로 발표를 마치겠습니다. 감사합니다. [무발화 7초]' } });
  const input = buildSilenceInput({ utteranceList, index: 2, mode: 'realtime_mix' });
  assert.equal(input.transcript, '이상으로 발표를 마치겠습니다. 감사합니다.');
  assert.equal(input.silenceMs, 5000);
  assert.deepEqual(input.precondition, { isReady: true, reason: null });

  const first = buildUtteranceList({ item: { id: 'y', transcript: '[무발화 6초] 네.' } });
  const blocked = buildSilenceInput({ utteranceList: first, index: 0, mode: 'realtime_mix' });
  assert.deepEqual(blocked.precondition, { isReady: false, reason: 'no_utterance' });
});
