import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { TARGET_TYPE_BY_TRIGGER_TYPE_MAP } from './eval-types.mjs';
import { summarizeConverseCapture, NO_REQUEST_ERROR } from './fetch-recorder.mjs';
import { hashInput } from './cache-store.mjs';
import { isSpanOverlap } from './candidate-merge.mjs';

const require = createRequire(import.meta.url);
const {
  ROUTER_SOURCE_MAP, NARRATION_BY_TRIGGER_TYPE_MAP,
} = require('../../../src/main/caption-pipeline/router/unified-router.js');
const {
  ROUTER_PROMPT_MAP, GAP_VERDICT_MAP, ROUTER_BLOCKED_REASON_MAP, readJudgeGroup,
} = require('../../../src/main/caption-pipeline/prompts/unified-router.js');
const { TRIGGER_TYPE_LABEL_MAP } = require('../../../src/main/caption-pipeline/trigger/speech-trigger.js');
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
  router: hashInput({ promptMap: ROUTER_PROMPT_MAP }),
  silence: hashInput({ system: SILENCE_JUDGE_SYSTEM_PROMPT, fewShot: SILENCE_FEW_SHOT_LIST }),
};

// 이 모듈 위치(tools/eval/lib)에서 저장소 루트를 찾는다. 실행 위치(cwd)와 상관없다.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// 캐시에 담기는 판정 결과(routed·judged)를 만드는 production 코드. 입력 꼴(buildRouterInput)·후보 번호 매기기·
// O/X 읽기·토큰 상한·온도 규칙과 프롬프트의 유형 이름(speech-trigger.js)이 프롬프트 밖에 있어서, git merge production 으로
// 이 파일들이 바뀌면 캐시가 저절로 무효가 되도록 원문 해시를 캐시 키에 넣는다.
export const PRODUCTION_SOURCE_FILE_LIST_MAP = {
  router: [
    'src/main/caption-pipeline/router/unified-router.js',
    'src/main/caption-pipeline/prompts/unified-router.js',
    'src/main/caption-pipeline/trigger/speech-trigger.js',
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

// production 이 번호를 매겨 판단 LLM 에 넘기는 후보 수(알 수 있는 유형이고 구가 있는 후보만 넘긴다).
export function countJudgeableCandidate(candidateList = []) {
  return candidateList.filter((candidate) => NARRATION_BY_TRIGGER_TYPE_MAP[candidate.type] && candidate.phrase).length;
}

// production parseJudgeText 가 기본값(X)으로 채우지 않고 후보마다 모델의 O/X 를 읽을 수 있는 응답인지.
// JSON 을 읽지 못했거나 번호 1~n 중 판단이 빠진 후보가 있으면 production 은 그 후보를 "판단 없음" X 로 둔다.
export function isRouterTextWellFormed({ text, candidateCount }) {
  if (typeof text !== 'string') return false;
  const match = text.replace(/```(?:json)?/g, '').match(/\{[\s\S]*\}/);
  if (!match) return false;
  let parsed = null;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed?.judgeList)) return false;
  const verdictList = Object.values(GAP_VERDICT_MAP);
  const judgedIdSet = new Set(parsed.judgeList
    .filter((entry) => verdictList.includes(String(entry?.gap).trim().toUpperCase()))
    .map((entry) => Number(entry.id)));
  return Array.from({ length: candidateCount }, (_, index) => index + 1).every((id) => judgedIdSet.has(id));
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

// production 라우터는 판정 LLM 을 쓸 수 없으면(fallback) 부르지 않고, 호출이 실패하면(error) 모든 후보를 X 로 둔다.
// 후보가 없으면(none) 부르지 않는다 — 평가는 후보가 있는 발화만 넘기므로 생기지 않는다.
// production 판단은 지시 대상·발화 기반 묶음마다 따로 부르고 묶음 안에서 번호를 1부터 매긴다. 호출은 끝난 순서로 기록되므로
// 응답마다 어느 묶음 것인지 모른다 — 묶음 후보 수를 응답에 하나씩 맞출 수 있는 배치가 있으면 다 읽은 것이다.
function countJudgeableCandidateByGroup(candidateList = []) {
  const countMap = new Map();
  for (const candidate of candidateList) {
    if (!NARRATION_BY_TRIGGER_TYPE_MAP[candidate.type] || !candidate.phrase) continue;
    const group = readJudgeGroup(candidate.type);
    countMap.set(group, (countMap.get(group) || 0) + 1);
  }
  return [...countMap.values()];
}

function canAssignCount({ textList, countList }) {
  if (!textList.length) return !countList.length;
  const [text, ...restTextList] = textList;
  return countList.some((count, index) => isRouterTextWellFormed({ text, candidateCount: count })
    && canAssignCount({ textList: restTextList, countList: countList.filter((_, other) => other !== index) }));
}

export function classifyRouterPathError({ routed, capture, captureList = null, candidateList = [] }) {
  if (routed.source === ROUTER_SOURCE_MAP.fallback) return PATH_ERROR_MAP.noToken;
  if (routed.source === ROUTER_SOURCE_MAP.error) return PATH_ERROR_MAP.http;
  if (routed.source === ROUTER_SOURCE_MAP.none) return null;
  const summaryList = captureList?.length ? captureList : [capture];
  if (summaryList.some((summary) => !summary?.rawText)) return PATH_ERROR_MAP.emptyText;
  const countList = countJudgeableCandidateByGroup(candidateList);
  if (summaryList.length !== countList.length) return PATH_ERROR_MAP.parse;
  if (!canAssignCount({ textList: summaryList.map((summary) => summary.rawText), countList })) return PATH_ERROR_MAP.parse;
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

// 캐시 키·보고서에 쓰는 판정 모델 이름표. gpu 백엔드는 GPU 모델로만 판정한다(실패해도 Bedrock 으로 넘기지 않는다).
export function buildJudgeModelLabel({ config }) {
  return config.judgeBackend === 'gpu' ? `gpu:${config.judgeGpuModel}` : config.judgeModelId;
}

// 실제로 어느 경로가 답했는지 센다. gpu 백엔드인데 bedrock 이 있으면 그만큼 GPU 가 실패해 Bedrock 이 판정한 것이다.
export function countJudgeSource({ rawList }) {
  const countMap = {};
  for (const raw of rawList) {
    const source = raw.output?.source;
    if (source) countMap[source] = (countMap[source] || 0) + 1;
  }
  return countMap;
}

// 판단 LLM 이 X 로 가렸거나, 이 위치가 넘긴 후보 목록에 없었던 경우의 사유 코드.
export const JUDGE_BLOCK_REASON_MAP = { noGap: ROUTER_BLOCKED_REASON_MAP.noGap, notJudged: 'not_judged' };

export function formatJudgeList(judgeList = []) {
  return judgeList
    .map((entry) => `${TRIGGER_TYPE_LABEL_MAP[entry.type] || entry.type}:"${entry.phrase}"=${entry.isGap ? GAP_VERDICT_MAP.gap : GAP_VERDICT_MAP.noGap}`
      + `(${entry.reason || '-'})`)
    .join(' · ');
}

// production 이 공백(O) 후보로 만든 해설 후보(toNarrationCandidateList)와 판단 항목이 같은 후보인지.
const isSameCandidate = (narration, entry) => narration.triggerType === entry.type && narration.anchor === entry.phrase;

// 판단 LLM 이 후보마다 낸 O/X 중 이 위치(같은 유형·구간 겹침)의 것을 읽는다. pieceStart 는 판정 발화의 전사 원문 시작
// 위치다(라우터에 넘긴 후보 위치는 발화 글 기준). 겹치는 후보가 둘 이상이면 하나라도 O 면 넘김이다.
// 생성 대상 여부와 한 발화 후보 1건 선택(중재)은 production 후보 선택기로 본다.
export function resolveCandidateVerdict({ position, pieceStart, routed, isScaleEnabled }) {
  const judgeList = routed.judgeList || [];
  const narrationCandidateList = routed.candidateList || [];
  const matchedList = judgeList.filter((entry) => TARGET_TYPE_BY_TRIGGER_TYPE_MAP[entry.type] === position.type
    && isSpanOverlap({ start: pieceStart + entry.start, end: pieceStart + entry.end }, position));
  const gapList = matchedList.filter((entry) => entry.isGap);
  const isJudgePass = gapList.length > 0;
  const ownNarrationList = narrationCandidateList.filter((narration) => gapList.some((entry) => isSameCandidate(narration, entry)));
  const isGeneratable = isJudgePass && Boolean(selectGeneratableCandidate({ candidateList: ownNarrationList, isScaleEnabled }).selected);
  const arbiterSelected = selectGeneratableCandidate({ candidateList: narrationCandidateList, isScaleEnabled }).selected;
  return {
    isJudgePass,
    isGeneratable,
    isArbiterSelected: Boolean(arbiterSelected) && gapList.some((entry) => isSameCandidate(arbiterSelected, entry)),
    blockReason: isJudgePass ? null : (matchedList.length ? JUDGE_BLOCK_REASON_MAP.noGap : JUDGE_BLOCK_REASON_MAP.notJudged),
    rationale: matchedList.map((entry) => entry.reason).filter(Boolean).join(' / '),
    judgeText: formatJudgeList(judgeList),
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
    const entry = {
      routed, capture: captureSummary,
      pathError: classifyRouterPathError({
        routed, capture: captureSummary, candidateList: input.candidateList,
        captureList: captureList.map((captured) => summarizeConverseCapture([captured])),
      }),
    };
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
