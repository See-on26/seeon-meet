// 탐지 평가 DB(「성능 평가 방식」 1장)로 탐지 Layer 를 돌려 유형별·언어별 정밀도·재현율·F1 을 낸다.
// 사용:
//   node tools/detection-eval/run-detection-eval.mjs --db "<탐지 평가 DB>/문항" --split train            (트리거만)
//   node tools/detection-eval/run-detection-eval.mjs --db "<탐지 평가 DB>/문항" --split test --judge     (트리거 + 판단 LLM)
//   --lang ko|en · --type <유형> · --limit N · --concurrency N · --out <결과 JSON 경로> · --show-miss N
//   --outside-labels <JSON> : 트리거 문장 안 정답 밖 후보의 라벨([{ key: "<id>@<시작>-<끝>", label: "O"|"X" }]).
//     주면 판단기가 그 위치에 낸 O/X 도 혼동표에 더한다("정답 밖" 줄과 전체). 없으면 정답 후보만 센다.
// 판단 LLM 은 앱과 같은 설정(.env 의 SEEON_JUDGE_*)을 쓴다. 평가 계획상 판단 LLM 은 평가 데이터를 만든 모델(Claude·GPT)과 다른 계열(GPU Gemma)이어야 한다.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSpeechTrigger, TRIGGER_TYPE_MAP } = require('../../src/main/caption-pipeline/trigger/speech-trigger.js');
const { createKiwiTokenizer } = require('../../src/main/caption-pipeline/trigger/kiwi-tokenizer.js');
const { DEV_KIWI_MODEL_DIR } = require('../../src/main/caption-pipeline/trigger/kiwi-model.js');

// 평가 DB 의 유형 이름 → 트리거 유형. 무발화는 시간 조건이라 트리거 단계가 늘 잡는다.
const DB_TYPE_MAP = {
  지시대명사: TRIGGER_TYPE_MAP.demonstrative,
  '형용사 + 지시 명사': TRIGGER_TYPE_MAP.adjectiveNoun,
  '단순 수치': TRIGGER_TYPE_MAP.number,
  '변화·비교·결론': TRIGGER_TYPE_MAP.change,
  '추상적 척도': TRIGGER_TYPE_MAP.scale,
  무발화: 'silence',
};
const GAP_LABEL = 'O';

export function parseArgs(argList) {
  const option = { db: '', split: 'train', judge: false, lang: '', type: '', limit: 0, concurrency: 4, out: '', showMiss: 0, outsideLabels: '' };
  for (let index = 0; index < argList.length; index += 1) {
    const arg = argList[index];
    const value = argList[index + 1];
    if (arg === '--judge') { option.judge = true; continue; }
    const key = { '--db': 'db', '--split': 'split', '--lang': 'lang', '--type': 'type', '--out': 'out', '--outside-labels': 'outsideLabels' }[arg];
    if (key) { option[key] = value; index += 1; continue; }
    const numberKey = { '--limit': 'limit', '--concurrency': 'concurrency', '--show-miss': 'showMiss' }[arg];
    if (numberKey) { option[numberKey] = Number(value); index += 1; continue; }
    throw new Error(`모르는 인자: ${arg}`);
  }
  if (!option.db) throw new Error('--db <탐지 평가 DB 문항 폴더> 가 필요하다');
  return option;
}

export function loadItemList({ db, split, lang, type, limit }) {
  const dir = path.join(db, split);
  const itemList = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')))
    .filter((item) => (!lang || item.lang === lang) && (!type || item.type === type));
  return limit > 0 ? itemList.slice(0, limit) : itemList;
}

function overlaps(left, right) {
  return left.start < right.end && right.start < left.end;
}

// 트리거 단계: 전사문 전체에서 후보를 뽑아 정답 후보 구와 겹치는 것을 찾는다.
export function matchTrigger({ item, speechTrigger }) {
  const { candidateList, analyzer } = speechTrigger.detect({ text: item.text });
  const label = { start: item.candidate.start, end: item.candidate.end };
  const matched = candidateList.find((candidate) => overlaps(candidate, label)) || null;
  const extraList = candidateList.filter((candidate) => !overlaps(candidate, label));
  return { matched, extraList, analyzer, candidateList };
}

export function buildOutsideKey({ id, start, end }) {
  return `${id}@${start}-${end}`;
}

// 판단 목록(트리거 문장 기준 위치)에서 정답 후보를 뺀 나머지 후보의 판단.
export function toOutsideVerdictList({ id, judgeList = [], matchedInSentence = null }) {
  return judgeList
    .filter((entry) => !(matchedInSentence && entry.start === matchedInSentence.start && entry.end === matchedInSentence.end))
    .map((entry) => ({ key: buildOutsideKey({ id, start: entry.start, end: entry.end }), phrase: entry.phrase, isPredictedGap: Boolean(entry.isGap) }));
}

export function scoreOutsideVerdictList({ outsideVerdictList, labelMap }) {
  const score = { tp: 0, fp: 0, fn: 0, tn: 0, unlabeledCount: 0 };
  for (const verdict of outsideVerdictList) {
    const label = labelMap.get(verdict.key);
    if (!label) { score.unlabeledCount += 1; continue; }
    const isGap = label === GAP_LABEL;
    if (isGap && verdict.isPredictedGap) score.tp += 1;
    else if (!isGap && verdict.isPredictedGap) score.fp += 1;
    else if (isGap) score.fn += 1;
    else score.tn += 1;
  }
  return score;
}

function loadOutsideLabelMap(labelPath) {
  if (!labelPath) return null;
  const labelList = JSON.parse(fs.readFileSync(labelPath, 'utf8'));
  return new Map(labelList.map((entry) => [entry.key, entry.label]));
}

function emptyCount() {
  return { tp: 0, fp: 0, fn: 0, tn: 0, triggerHit: 0, triggerTotal: 0, typeHit: 0 };
}

function addCount({ countMap, key, isGap, isPredictedGap, isTriggerHit, isTypeHit }) {
  if (!countMap.has(key)) countMap.set(key, emptyCount());
  const count = countMap.get(key);
  count.triggerTotal += 1;
  if (isTriggerHit) count.triggerHit += 1;
  if (isTypeHit) count.typeHit += 1;
  if (isPredictedGap === null) return;
  if (isGap && isPredictedGap) count.tp += 1;
  else if (!isGap && isPredictedGap) count.fp += 1;
  else if (isGap && !isPredictedGap) count.fn += 1;
  else count.tn += 1;
}

function formatRatio(numerator, denominator) {
  return denominator ? `${(numerator / denominator * 100).toFixed(1)}%` : '-';
}

function formatRow({ key, count, isJudge }) {
  const trigger = `트리거 ${formatRatio(count.triggerHit, count.triggerTotal)} (유형 일치 ${formatRatio(count.typeHit, count.triggerTotal)})`;
  if (!isJudge) return `${key.padEnd(18)} n=${String(count.triggerTotal).padStart(4)}  ${trigger}`;
  const precision = count.tp + count.fp ? count.tp / (count.tp + count.fp) : 0;
  const recall = count.tp + count.fn ? count.tp / (count.tp + count.fn) : 0;
  const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
  return `${key.padEnd(18)} n=${String(count.triggerTotal).padStart(4)}  ${trigger}  `
    + `P ${(precision * 100).toFixed(1)}  R ${(recall * 100).toFixed(1)}  F1 ${(f1 * 100).toFixed(1)}  `
    + `(TP ${count.tp} FP ${count.fp} FN ${count.fn} TN ${count.tn})`;
}

async function mapWithConcurrency({ itemList, concurrency, run }) {
  const resultList = new Array(itemList.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < itemList.length) {
      const index = nextIndex;
      nextIndex += 1;
      resultList[index] = await run(itemList[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return resultList;
}

async function createJudge() {
  const { loadEnvFile } = require('../../src/main/env.js');
  loadEnvFile();
  const { readPipelineConfig } = require('../../src/main/caption-pipeline/config.js');
  const { createUnifiedRouter } = require('../../src/main/caption-pipeline/router/unified-router.js');
  const { createSilenceJudge } = require('../../src/main/caption-pipeline/router/silence-judge.js');
  const config = readPipelineConfig();
  console.log(`[eval] 판단 LLM: GPU ${config.judgeGpuModel} (${config.judgeGpuUrl})`);
  return { router: createUnifiedRouter({ config }), silenceJudge: createSilenceJudge({ config }) };
}

async function judgeItem({ item, trigger, judge }) {
  if (DB_TYPE_MAP[item.type] === 'silence') {
    const silenceMs = Number((item.segments.trigger_sentence.match(/\d+/) || [7])[0]) * 1000;
    const verdict = await judge.silenceJudge.judge({ transcript: item.segments.before, silenceMs });
    return { isPredictedGap: verdict.hasCue, reason: verdict.reason || '', source: verdict.source };
  }
  if (!trigger.matched) return { isPredictedGap: false, reason: '트리거 놓침', source: 'trigger', outsideVerdictList: [] };
  const sentenceStart = item.text.indexOf(item.segments.trigger_sentence);
  const sentenceEnd = sentenceStart + item.segments.trigger_sentence.length;
  // 앱처럼 트리거 문장 안의 후보만 판단에 넘긴다. 위치는 문장 기준으로 옮긴다.
  const candidateList = trigger.candidateList
    .filter((candidate) => candidate.start >= sentenceStart && candidate.end <= sentenceEnd)
    .map((candidate) => ({ ...candidate, start: candidate.start - sentenceStart, end: candidate.end - sentenceStart }));
  const routed = await judge.router.route({
    utterance: item.segments.trigger_sentence, before: item.segments.before, after: item.segments.after, candidateList,
  });
  const matchedInSentence = { start: trigger.matched.start - sentenceStart, end: trigger.matched.end - sentenceStart };
  const verdict = (routed.judgeList || []).find((entry) => entry.start === matchedInSentence.start && entry.end === matchedInSentence.end);
  return {
    isPredictedGap: Boolean(verdict?.isGap), reason: verdict?.reason || routed.blockedReason || '', source: routed.source,
    outsideVerdictList: toOutsideVerdictList({ id: item.id, judgeList: routed.judgeList, matchedInSentence }),
  };
}

async function main() {
  const option = parseArgs(process.argv.slice(2));
  const tokenizer = createKiwiTokenizer({ modelDir: DEV_KIWI_MODEL_DIR });
  await tokenizer.load().catch((error) => console.warn(`[eval] Kiwi 를 못 띄워 한국어는 대체 규칙으로 잰다: ${error.message}`));
  const speechTrigger = createSpeechTrigger({ tokenizer });
  const itemList = loadItemList(option);
  const judge = option.judge ? await createJudge() : null;
  const outsideLabelMap = loadOutsideLabelMap(option.outsideLabels);
  console.log(`[eval] ${option.split} ${itemList.length}건${option.judge ? ' · 판단 LLM 포함' : ' · 트리거만'}`);

  const resultList = await mapWithConcurrency({
    itemList, concurrency: option.judge ? option.concurrency : 1,
    run: async (item) => {
      const isSilence = DB_TYPE_MAP[item.type] === 'silence';
      const trigger = isSilence ? { matched: { type: 'silence' }, extraList: [], candidateList: [] } : matchTrigger({ item, speechTrigger });
      const verdict = judge ? await judgeItem({ item, trigger, judge }) : null;
      return { item, trigger, verdict };
    },
  });

  const countMap = new Map();
  const missList = [];
  for (const { item, trigger, verdict } of resultList) {
    const isGap = item.label.gap === GAP_LABEL;
    const isTriggerHit = Boolean(trigger.matched);
    const isTypeHit = isTriggerHit && trigger.matched.type === DB_TYPE_MAP[item.type];
    const isPredictedGap = verdict ? verdict.isPredictedGap : null;
    for (const key of [`${item.type}`, `${item.type}/${item.lang}`, `전체/${item.lang}`, '전체']) {
      addCount({ countMap, key, isGap, isPredictedGap, isTriggerHit, isTypeHit });
    }
    if (!isTriggerHit || (verdict && verdict.isPredictedGap !== isGap)) missList.push({ item, trigger, verdict });
  }
  if (judge && outsideLabelMap) {
    let unlabeledCount = 0;
    for (const { item, verdict } of resultList) {
      const score = scoreOutsideVerdictList({ outsideVerdictList: verdict?.outsideVerdictList || [], labelMap: outsideLabelMap });
      unlabeledCount += score.unlabeledCount;
      for (const key of ['정답 밖', `전체/${item.lang}`, '전체']) {
        if (!countMap.has(key)) countMap.set(key, emptyCount());
        const count = countMap.get(key);
        for (const cell of ['tp', 'fp', 'fn', 'tn']) count[cell] += score[cell];
      }
    }
    console.log(`[eval] 정답 밖 위치를 라벨로 채점했다${unlabeledCount ? ` (라벨 없는 위치 ${unlabeledCount}개는 뺐다)` : ''}`);
  }
  const keyList = [...countMap.keys()].sort();
  for (const key of keyList) console.log(formatRow({ key, count: countMap.get(key), isJudge: Boolean(judge) }));
  for (const { item, trigger, verdict } of missList.slice(0, option.showMiss)) {
    const detected = trigger.candidateList?.map((candidate) => `${candidate.type}:"${candidate.phrase}"`).join(', ') || '-';
    console.log(`  ✗ ${item.id} [${item.type}/${item.lang}/${item.label.gap}] 정답="${item.candidate.text}" 검출=[${detected}]`
      + `${verdict ? ` 판단=${verdict.isPredictedGap ? 'O' : 'X'}(${verdict.reason})` : ''} | ${item.segments.trigger_sentence}`);
  }
  if (option.out) {
    fs.writeFileSync(option.out, JSON.stringify(resultList.map(({ item, trigger, verdict }) => ({
      id: item.id, type: item.type, lang: item.lang, gap: item.label.gap, candidate: item.candidate.text,
      matched: trigger.matched?.phrase || null, matchedType: trigger.matched?.type || null,
      extraList: (trigger.extraList || []).map((candidate) => candidate.phrase),
      predicted: verdict ? (verdict.isPredictedGap ? 'O' : 'X') : null, reason: verdict?.reason || null,
      outsideList: verdict?.outsideVerdictList?.map((entry) => ({ key: entry.key, phrase: entry.phrase, predicted: entry.isPredictedGap ? 'O' : 'X' })) || [],
    })), null, 2));
    console.log(`[eval] 결과 저장 ${option.out}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('detection-eval', 'run-detection-eval.mjs'))) {
  main().catch((error) => {
    console.error(`[eval] ${error.stack || error.message}`);
    process.exit(1);
  });
}
