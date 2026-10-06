import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
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

// 이 모듈 위치(tools/eval/lib)에서 저장소 루트를 찾는다. 실행 위치(cwd)와 상관없다.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// 캐시에 담기는 판정 결과(routed·judged)를 만드는 production 코드. 입력 꼴(buildRouterInput)·후보 정규화
// (normalizeCandidate·허용 subKind)·토큰 상한·온도 규칙이 프롬프트 밖에 있어서, git merge production 으로
// 이 파일들이 바뀌면 캐시가 저절로 무효가 되도록 원문 해시를 캐시 키에 넣는다.
export const PRODUCTION_SOURCE_FILE_LIST_MAP = {
  router: [
    'src/main/caption-pipeline/router/unified-router.js',
    'src/main/caption-pipeline/prompts/unified-router.js',
    'src/main/caption-pipeline/agents/shared/bedrock-converse.js',
    'src/main/caption-pipeline/agents/shared/judge-llm.js',
    'src/main/caption-pipeline/config.js',
    'src/main/caption-pipeline/contracts/narration-types.js',
  ],
  silence: [
    'src/main/caption-pipeline/router/silence-judge.js',
    'src/main/caption-pipeline/prompts/silence-judge.js',
    'src/main/caption-pipeline/agents/shared/bedrock-converse.js',
    'src/main/caption-pipeline/agents/shared/judge-llm.js',
    'src/main/caption-pipeline/config.js',
  ],
};

// 파일이 없으면 바로 멈춘다. 이름이 바뀐 파일을 건너뛰면 바뀐 production 으로 옛 캐시를 쓰게 된다.
export function hashProductionSource({ repoRoot = REPO_ROOT, fileList }) {
  return hashInput(fileList.map((filePath) => ({
    filePath, text: fs.readFileSync(path.join(repoRoot, filePath), 'utf8'),
  })));
}

export const PRODUCTION_SOURCE_HASH_MAP = {
  router: hashProductionSource({ fileList: PRODUCTION_SOURCE_FILE_LIST_MAP.router }),
  silence: hashProductionSource({ fileList: PRODUCTION_SOURCE_FILE_LIST_MAP.silence }),
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
  if (![SILENCE_JUDGE_SOURCE_MAP.bedrock, SILENCE_JUDGE_SOURCE_MAP.gpu].includes(judged.source)) return null;
  if (!capture.rawText) return PATH_ERROR_MAP.emptyText;
  if (!isSilenceTextWellFormed(capture.rawText)) return PATH_ERROR_MAP.parse;
  return null;
}

// 캐시 키·보고서에 쓰는 판정 모델 이름표. gpu 백엔드는 GPU 모델로 판정하고 실패한 호출만 Bedrock 이 답한다.
export function buildJudgeModelLabel({ config }) {
  return config.judgeBackend === 'gpu' ? `gpu:${config.judgeGpuModel}` : config.judgeModelId;
}

// 실제로 어느 경로가 답했는지 센다. gpu 백엔드인데 bedrock 이 있으면 그만큼 GPU 가 실패해 Bedrock 이 판정한 것이다.
export function countJudgeSource({ rawList }) {
  const countMap = {};
  for (const raw of rawList) {
    const source = raw.routed?.source ?? raw.judged?.source;
    if (source) countMap[source] = (countMap[source] || 0) + 1;
  }
  return countMap;
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

export function createJudgeRunner({
  route, judgeSilence, capture, cache, routerModelId, sourceHashMap = PRODUCTION_SOURCE_HASH_MAP,
}) {
  async function runRouter({ input, repeatIndex }) {
    const key = hashInput({
      kind: 'router', modelId: routerModelId, promptHash: PROMPT_HASH_MAP.router, sourceHash: sourceHashMap.router, input, repeatIndex,
    });
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
    const key = hashInput({
      kind: 'silence', modelId: routerModelId, promptHash: PROMPT_HASH_MAP.silence, sourceHash: sourceHashMap.silence, input: judgeInput, repeatIndex,
    });
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
