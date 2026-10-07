import { createRequire } from 'node:module';
import { buildUtteranceList, PIECE_KIND_MAP } from './utterance-builder.mjs';
import { TARGET_TYPE_BY_TRIGGER_TYPE_MAP, CANDIDATE_SOURCE_MAP } from './eval-types.mjs';

const require = createRequire(import.meta.url);
const { createSpeechTrigger, TRIGGER_ANALYZER_MAP } = require('../../../src/main/caption-pipeline/trigger/speech-trigger.js');
const { createKiwiTokenizer } = require('../../../src/main/caption-pipeline/trigger/kiwi-tokenizer.js');
const { DEV_KIWI_MODEL_DIR } = require('../../../src/main/caption-pipeline/trigger/kiwi-model.js');

// 한국어 트리거를 무엇으로 잡았는지. production 은 Kiwi 를 띄우지 못하면 대체 규칙(어절 경계)으로 잡는다.
export const KOREAN_TRIGGER_ANALYZER_MAP = { kiwi: TRIGGER_ANALYZER_MAP.kiwi, rule: TRIGGER_ANALYZER_MAP.rule };

// production main 의 트리거(speech-trigger.js)를 그대로 쓴다. Kiwi 모델은 앱 개발 실행과 같은 vendor/kiwi-model
// (npm run setup:kiwi)이고, 띄우지 못하면 production 처럼 경고만 하고 한국어는 대체 규칙으로 잡는다.
export async function createProductionTrigger({
  modelDir = DEV_KIWI_MODEL_DIR, createTokenizer = createKiwiTokenizer, onWarn = (message) => console.warn(message),
} = {}) {
  const tokenizer = createTokenizer({ modelDir });
  try {
    await tokenizer.load();
  } catch (error) {
    onWarn(`[eval] Kiwi 를 띄우지 못해 production 처럼 한국어 트리거를 대체 규칙으로 잡는다(npm run setup:kiwi): ${error.message}`);
  }
  const speechTrigger = createSpeechTrigger({ tokenizer });
  return Object.freeze({
    koreanAnalyzer: tokenizer.isReady() ? KOREAN_TRIGGER_ANALYZER_MAP.kiwi : KOREAN_TRIGGER_ANALYZER_MAP.rule,
    detect: ({ text }) => speechTrigger.detect({ text }),
  });
}

// Kiwi 없이 대체 규칙으로만 잡는 production 트리거. 모델 유무와 상관없이 같은 결과가 필요한 시험에 쓴다.
export const RULE_PRODUCTION_TRIGGER = Object.freeze({
  koreanAnalyzer: KOREAN_TRIGGER_ANALYZER_MAP.rule,
  detect: createSpeechTrigger({ tokenizer: null }).detect,
});

// production 은 ASR 조각마다 트리거를 돌린다. 평가는 문장 단위 발화마다 돌리고, 위치를 전사 원문 기준으로 옮긴다.
// speech-trigger 는 앞뒤 공백을 떼고 위치를 세므로 뗀 길이만큼 더한다.
export function detectPieceCandidateList({ piece, productionTrigger }) {
  const leadingSpaceLength = piece.text.length - piece.text.trimStart().length;
  const offset = piece.start + leadingSpaceLength;
  return productionTrigger.detect({ text: piece.text }).candidateList
    .filter((candidate) => TARGET_TYPE_BY_TRIGGER_TYPE_MAP[candidate.type])
    .map((candidate) => ({
      type: TARGET_TYPE_BY_TRIGGER_TYPE_MAP[candidate.type],
      triggerType: candidate.type,
      kind: candidate.type,
      phrase: candidate.phrase,
      // 판단 LLM 에 넘기는 위치는 production 처럼 발화 글 기준이다.
      pieceStart: candidate.start + leadingSpaceLength,
      pieceEnd: candidate.end + leadingSpaceLength,
      start: offset + candidate.start,
      end: offset + candidate.end,
      trigger: candidate.phrase,
      utteranceIndex: piece.index,
      source: CANDIDATE_SOURCE_MAP.production,
    }));
}

// 항목의 발화마다 production 트리거 후보를 뽑는다. 무발화 표시 구간은 발화가 아니므로 보지 않는다.
export function extractProductionCandidateList({ item, productionTrigger, utteranceList = buildUtteranceList({ item }) }) {
  return utteranceList
    .filter((piece) => piece.kind === PIECE_KIND_MAP.speech)
    .flatMap((piece) => detectPieceCandidateList({ piece, productionTrigger }))
    .sort((candidateA, candidateB) => candidateA.start - candidateB.start || candidateA.end - candidateB.end);
}
