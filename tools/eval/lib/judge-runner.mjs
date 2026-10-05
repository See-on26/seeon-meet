import { createRequire } from 'node:module';
import { ROUTER_EXPECTATION_MAP } from './eval-types.mjs';
import { summarizeConverseCapture, NO_REQUEST_ERROR } from './fetch-recorder.mjs';
import { hashInput } from './cache-store.mjs';

const require = createRequire(import.meta.url);
const { normalizeCandidate, ROUTER_SOURCE_MAP, ROUTER_SYSTEM_PROMPT } = require('../../../src/main/caption-pipeline/router/unified-router.js');
const { FEW_SHOT_LIST } = require('../../../src/main/caption-pipeline/prompts/unified-router.js');
const { SILENCE_JUDGE_SOURCE_MAP } = require('../../../src/main/caption-pipeline/router/silence-judge.js');
const {
  SILENCE_JUDGE_SYSTEM_PROMPT, SILENCE_FEW_SHOT_LIST,
} = require('../../../src/main/caption-pipeline/prompts/silence-judge.js');
const { selectGeneratableCandidate } = require('../../../src/main/caption-pipeline/orchestrator/candidate-selector.js');

export const PATH_ERROR_MAP = {
  noToken: 'no_token',
  http: 'http',
  parse: 'parse',
  emptyText: 'empty_text',
};

// production 프롬프트가 바뀌면 캐시가 저절로 무효가 되도록 프롬프트 해시를 캐시 키에 넣는다.
export const PROMPT_HASH_MAP = {
  router: hashInput({ system: ROUTER_SYSTEM_PROMPT, fewShot: FEW_SHOT_LIST }),
  silence: hashInput({ system: SILENCE_JUDGE_SYSTEM_PROMPT, fewShot: SILENCE_FEW_SHOT_LIST }),
};

// production parseRouterText 가 "통과(deixis 기본값)" 로 떨어지지 않는 제대로 된 응답인지.
export function isRouterTextWellFormed(text) {
  if (typeof text !== 'string') return false;
  const match = text.replace(/```(?:json)?/g, '').match(/\{[\s\S]*\}/);
  if (!match) return false;
  let parsed = null;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed.candidateList)) return false;
  const candidateList = parsed.candidateList.map((rawCandidate) => normalizeCandidate(rawCandidate)).filter(Boolean);
  return candidateList.length > 0 || typeof parsed.blockedReason === 'string';
}

// production parseSilenceJudgeText 가 "차단" 으로 떨어지지 않는, cue 가 참·거짓인 응답인지.
export function isSilenceTextWellFormed(text) {
  if (typeof text !== 'string') return false;
  const match = text.replace(/```(?:json)?/g, '').match(/\{[^{}]*\}/);
  if (!match) return false;
  try {
    return typeof JSON.parse(match[0]).cue === 'boolean';
  } catch {
    return false;
  }
}

export function classifyRouterPathError({ routed, capture }) {
  if (routed.source === ROUTER_SOURCE_MAP.fallback) return PATH_ERROR_MAP.noToken;
  if (routed.source === ROUTER_SOURCE_MAP.error) return PATH_ERROR_MAP.http;
  if (!capture.rawText) return PATH_ERROR_MAP.emptyText;
  if (!isRouterTextWellFormed(capture.rawText)) return PATH_ERROR_MAP.parse;
  return null;
}

// production 무발화 판정기는 토큰이 없으면 요청 전에 예외로 끝나 source 가 error 다. 요청이 없었으면 토큰 없음으로 센다.
export function classifySilencePathError({ judged, capture }) {
  if (judged.source === SILENCE_JUDGE_SOURCE_MAP.error) {
    return capture?.errorMessage === NO_REQUEST_ERROR ? PATH_ERROR_MAP.noToken : PATH_ERROR_MAP.http;
  }
  if (judged.source !== SILENCE_JUDGE_SOURCE_MAP.bedrock) return null;
  if (!capture.rawText) return PATH_ERROR_MAP.emptyText;
  if (!isSilenceTextWellFormed(capture.rawText)) return PATH_ERROR_MAP.parse;
  return null;
}

const describeCandidate = (candidate) => `${candidate.type}/${candidate.subKind || '-'}`;

// 라우터 후보 중 그 유형에 맞는 후보가 있으면 "넘김"이다. 생성 대상 여부는 production 후보 선택기로 본다.
export function resolveLexicalVerdict({ type, routed, isScaleEnabled }) {
  const expectation = ROUTER_EXPECTATION_MAP[type];
  const candidateList = routed.candidateList || [];
  const matchedList = candidateList.filter((candidate) => candidate.type === expectation.type
    && (!expectation.subKind || candidate.subKind === expectation.subKind));
  const isJudgePass = matchedList.length > 0;
  const isGeneratable = isJudgePass && Boolean(selectGeneratableCandidate({ candidateList: matchedList, isScaleEnabled }).selected);
  const arbiterSelected = selectGeneratableCandidate({ candidateList, isScaleEnabled }).selected;
  const candidateText = candidateList.map(describeCandidate).join(', ');
  return {
    isJudgePass,
    isGeneratable,
    isTypeOnlyMatch: !isJudgePass && candidateList.some((candidate) => candidate.type === expectation.type),
    isArbiterSelected: Boolean(arbiterSelected)
      && matchedList.some((candidate) => describeCandidate(candidate) === describeCandidate(arbiterSelected)),
    blockReason: isJudgePass ? null : (routed.blockedReason || (candidateList.length ? `type_mismatch:${candidateText}` : 'no_candidate')),
    anchorList: matchedList.map((candidate) => candidate.anchor).filter(Boolean),
    candidateText,
  };
}

export function createJudgeRunner({ route, judgeSilence, capture, cache, routerModelId }) {
  async function runRouter({ input, repeatIndex }) {
    const key = hashInput({ kind: 'router', modelId: routerModelId, promptHash: PROMPT_HASH_MAP.router, input, repeatIndex });
    const cached = cache.read(key);
    if (cached) return { ...cached, isCacheHit: true };
    const { result: routed, captureList } = await capture(() => route(input));
    const captureSummary = summarizeConverseCapture(captureList);
    const entry = { routed, capture: captureSummary, pathError: classifyRouterPathError({ routed, capture: captureSummary }) };
    if (!entry.pathError) cache.write(key, entry);
    return { ...entry, isCacheHit: false };
  }

  // 전제 조건이 안 맞으면(직전 발화 없음 등) production 처럼 판정기를 부르지 않는다.
  async function runSilence({ input, repeatIndex }) {
    if (!input.precondition.isReady) {
      return { judged: null, capture: null, pathError: null, isCacheHit: false, skipReason: input.precondition.reason };
    }
    const judgeInput = { transcript: input.transcript, silenceMs: input.silenceMs };
    const key = hashInput({ kind: 'silence', modelId: routerModelId, promptHash: PROMPT_HASH_MAP.silence, input: judgeInput, repeatIndex });
    const cached = cache.read(key);
    if (cached) return { ...cached, isCacheHit: true };
    const { result: judged, captureList } = await capture(() => judgeSilence(judgeInput));
    const captureSummary = summarizeConverseCapture(captureList);
    const entry = { judged, capture: captureSummary, pathError: classifySilencePathError({ judged, capture: captureSummary }), skipReason: null };
    if (!entry.pathError) cache.write(key, entry);
    return { ...entry, isCacheHit: false };
  }

  return { runRouter, runSilence };
}
