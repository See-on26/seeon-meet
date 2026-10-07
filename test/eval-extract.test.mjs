import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  mergeCandidateList, extractSilenceCandidateList, dropSilenceMarkerOverlap, isSpanOverlap, buildPosId,
} from '../tools/eval/lib/candidate-merge.mjs';
import { extractItemPositionList, buildLabelDraft, summarizeExtraction } from '../tools/eval/lib/extract-items.mjs';
import { REGEX_MATCHER } from '../tools/eval/lib/methodology-matcher.mjs';
import { RULE_PRODUCTION_TRIGGER } from '../tools/eval/lib/production-trigger.mjs';
import { runExtractCommand } from '../tools/eval/lib/extract-command.mjs';

const regexMatcher = REGEX_MATCHER;
// Kiwi 모델 유무와 상관없이 같은 결과가 나오게 production 트리거는 대체 규칙(Kiwi 를 못 띄운 production 과 같다)으로 돈다.
const productionTrigger = RULE_PRODUCTION_TRIGGER;
const createRuleTrigger = async () => RULE_PRODUCTION_TRIGGER;

test('구간이 겹치면 같은 위치로 보고 맞닿기만 하면 다른 위치다', () => {
  assert.equal(isSpanOverlap({ start: 0, end: 4 }, { start: 3, end: 5 }), true);
  assert.equal(isSpanOverlap({ start: 0, end: 4 }, { start: 4, end: 6 }), false);
  assert.equal(buildPosId({ type: 'value', start: 8, end: 11 }), 'value@8-11');
});

test('같은 유형의 겹치는 후보를 합집합 구간 하나로 합치고 출처를 모은다', () => {
  const text = '이 부분을 보시면 됩니다';
  const positionList = mergeCandidateList({
    text,
    candidateList: [
      { type: 'demonstrative', start: 0, end: 4, source: 'production', kind: 'demonstrative' },
      { type: 'demonstrative', start: 2, end: 4, source: 'production', kind: 'adjective_noun' },
      { type: 'demonstrative', start: 0, end: 1, source: 'methodology', isApproximate: true },
      { type: 'value', start: 0, end: 1, source: 'methodology' },
    ],
  });
  assert.deepEqual(positionList, [
    {
      type: 'demonstrative', start: 0, end: 4, trigger: '이 부분', sourceList: ['production', 'methodology'],
      productionKindList: ['demonstrative', 'adjective_noun'], isApproximate: true,
    },
    { type: 'value', start: 0, end: 1, trigger: '이', sourceList: ['methodology'], productionKindList: [], isApproximate: false },
  ]);
});

test('무발화 표시는 5초 이상만 두 출처 후보가 되고 표시 안 숫자는 어휘 후보에서 빠진다', () => {
  const text = '보시죠. [무발화 7초] 음. [무발화 3초]';
  assert.deepEqual(extractSilenceCandidateList({ text }).map((candidate) => [candidate.trigger, candidate.sourceList]), [
    ['[무발화 7초]', ['production', 'methodology']],
  ]);
  const kept = dropSilenceMarkerOverlap({ text, candidateList: [{ type: 'value', start: 10, end: 12 }, { type: 'demonstrative', start: 0, end: 2 }] });
  assert.deepEqual(kept, [{ type: 'demonstrative', start: 0, end: 2 }]);
});

const summarizePosition = (item) => extractItemPositionList({ item, matcher: regexMatcher, productionTrigger })
  .map((position) => `${buildPosId(position)}:${position.sourceList.join('+')}`);

test('production 트리거(main speech-trigger.js)와 말주머니 후보의 합집합을 뽑는다', () => {
  const item = { id: 'd-010', language: 'ko', targetType: 'scale', transcript: '음, 대기 시간이 꽤 길죠. 평균 40분인데 업계 평균은 10분이거든요.' };
  assert.deepEqual(summarizePosition(item), [
    'scale@10-14:production+methodology',
    'value@19-22:methodology',
    'value@32-35:methodology',
  ], '척도 "꽤 길죠" 는 production 도 잡고 겹치는 말주머니 "길죠" 와 한 위치로 합친다');
});

test('production 후보는 발화마다 뽑아 전사 원문 위치로 합친다', () => {
  assert.deepEqual(summarizePosition({ id: 'g', language: 'ko', transcript: '이 부분입니다. 그리고 30% 올랐습니다.' }), [
    'demonstrative@0-1:methodology', 'value@13-16:production+methodology', 'change@17-22:production+methodology',
  ]);
});

test('목표 위치에만 정답을 미리 채우고 나머지는 null 로 둔다', () => {
  const item = {
    id: 'd-x', language: 'ko', targetType: 'demonstrative', transcript: '이 부분을 보시면 그리고 이 부분도 보시면 됩니다.',
    targetTrigger: '이 부분을', isTargetGap: true, targetRationale: '무엇인지 없음',
  };
  const draft = buildLabelDraft({ item, positionList: extractItemPositionList({ item, matcher: regexMatcher, productionTrigger }) });
  assert.deepEqual(draft.positionList.map((position) => [position.posId, position.isGap, position.rationale, position.sourceList]), [
    ['demonstrative@0-4', true, '무엇인지 없음', ['production', 'methodology']],
    ['demonstrative@14-18', null, '', ['production', 'methodology']],
  ]);
  const summary = summarizeExtraction({ draftList: [draft], matcher: regexMatcher, productionTrigger });
  assert.equal(summary.prefilledCount, 1);
  assert.equal(summary.isApproximate, true);
  assert.equal(summary.productionKoreanAnalyzer, 'rule');
  assert.deepEqual(summary.missingTargetIdList, []);
  assert.deepEqual(summary.ambiguousTargetIdList, []);
});

const draftTarget = (item) => {
  const draft = buildLabelDraft({ item, positionList: extractItemPositionList({ item, matcher: regexMatcher, productionTrigger }) });
  return { draft, summary: summarizeExtraction({ draftList: [draft], matcher: regexMatcher, productionTrigger }) };
};
const listGap = (draft) => draft.positionList.map((position) => [position.posId, position.isGap]);

test('목표 트리거가 다른 낱말 안에도 나오면 낱말 경계에서 시작하는 같은 유형 후보에 채운다', () => {
  const { draft, summary } = draftTarget({
    id: 'd-in-word', language: 'ko', targetType: 'demonstrative', transcript: '회의는 10분이거든요. 이거 보시면 됩니다.',
    targetTrigger: '이거', isTargetGap: true, targetRationale: '무엇인지 없음',
  });
  assert.deepEqual(listGap(draft), [['value@4-7', null], ['demonstrative@13-15', true]],
    '"분이거든요" 안의 이거(7-9)가 아니라 낱말 이거(13-15)');
  assert.equal(draft.positionList[1].rationale, '무엇인지 없음');
  assert.deepEqual(summary.ambiguousTargetIdList, []);
  assert.deepEqual(summary.missingTargetIdList, []);
});

test('목표 트리거가 더 긴 낱말의 앞부분으로도 나오면 적힌 꼴 그대로 한 낱말인 자리에 채운다', () => {
  const { draft, summary } = draftTarget({
    id: 'd-prefix', language: 'ko', targetType: 'demonstrative', transcript: '저기요, 잠깐만요. 저기 보이는 숫자가 중요합니다.',
    targetTrigger: '저기', isTargetGap: true, targetRationale: '어디인지 없음',
  });
  assert.deepEqual(listGap(draft), [['demonstrative@0-2', null], ['demonstrative@11-13', true]], '"저기요" 가 아니라 "저기"');
  assert.deepEqual(summary.ambiguousTargetIdList, []);
});

test('목표 트리거가 여러 번 나와 어느 자리인지 가를 수 없으면 미리 채우지 않고 요약에 항목 id 를 남긴다', () => {
  const { draft, summary } = draftTarget({
    id: 'd-twice', language: 'ko', targetType: 'demonstrative', transcript: '이 부분을 보시면 그리고 이 부분도 보시면 됩니다.',
    targetTrigger: '이 부분', isTargetGap: true, targetRationale: '무엇인지 없음',
  });
  assert.deepEqual(listGap(draft), [['demonstrative@0-4', null], ['demonstrative@14-18', null]]);
  assert.equal(summary.prefilledCount, 0);
  assert.deepEqual(summary.ambiguousTargetIdList, ['d-twice']);
  assert.deepEqual(summary.missingTargetIdList, [], '후보는 뽑혔으므로 "뽑히지 않은 항목" 이 아니다');
});

test('영어 항목은 말주머니를 단어 경계로 대조하고 production 영어 규칙 후보와 합친다', () => {
  const item = { id: 'd-en', language: 'en', targetType: 'demonstrative', transcript: 'Okay, moving on. This part is 30% of errors.' };
  assert.deepEqual(summarizePosition(item), [
    'demonstrative@17-26:production+methodology', 'value@30-33:production+methodology',
  ], 'production 은 "This part" 를, 말주머니는 "This" 를 잡아 한 위치가 된다');
});

test('목표 트리거가 어느 후보에도 안 걸리면 요약에 항목 id 를 남긴다', () => {
  const item = { id: 'd-y', language: 'ko', targetType: 'scale', transcript: '처리 속도가 엄청 빠릅니다.', targetTrigger: '엄청', isTargetGap: true };
  const draft = buildLabelDraft({ item, positionList: extractItemPositionList({ item, matcher: regexMatcher, productionTrigger }) });
  assert.deepEqual(summarizeExtraction({ draftList: [draft], matcher: regexMatcher, productionTrigger }).missingTargetIdList, ['d-y']);
});

test('extract 명령은 샘플을 읽어 검사기를 통과하는 라벨 초안을 쓴다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-extract-'));
  const outFile = path.join(dir, 'labeling.jsonl');
  const cliPath = new URL('../tools/eval/detection-eval.mjs', import.meta.url).pathname;
  const sampleFile = new URL('../docs/eval/samples/detection-items.sample.jsonl', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [cliPath, 'extract', '--in', sampleFile, '--out', outFile, '--matcher', 'regex'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /항목 16건\(ko 14 · en 2\)/);
  assert.match(result.stdout, /정답 미리 채움 16개/);
  assert.match(result.stdout, /production 트리거\(main speech-trigger\.js\): 한국어 (Kiwi 형태소 분석|대체 규칙)/);
  const validatorPath = new URL('../tools/eval/validate.mjs', import.meta.url).pathname;
  const validated = spawnSync(process.execPath, [validatorPath, outFile, '--labeled'], { encoding: 'utf8' });
  assert.equal(validated.status, 0, validated.stdout);
});

test('extract 요약은 목표 트리거가 여러 번 나와 미리 채우지 않은 항목을 따로 알린다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-extract-'));
  const inFile = path.join(dir, 'items.jsonl');
  fs.writeFileSync(inFile, `${JSON.stringify({
    id: 'd-twice', language: 'ko', domain: '강의', pairId: 'p-01', targetType: 'demonstrative', resolution: 'none', generatorModel: 'm',
    transcript: '이 부분을 보시면 그리고 이 부분도 보시면 됩니다.', targetTrigger: '이 부분', isTargetGap: true, targetRationale: '무엇인지 없음',
  })}\n`);
  const logList = [];
  const code = await runExtractCommand({
    argList: ['--in', inFile, '--out', path.join(dir, 'labeling.jsonl')], log: (line) => logList.push(line),
    createMatcher: async () => regexMatcher, createTrigger: createRuleTrigger,
  });
  assert.equal(code, 0);
  assert.match(logList.join('\n'), /목표 트리거가 여러 번 나와 미리 채우지 않음: d-twice/);
  assert.doesNotMatch(logList.join('\n'), /후보로 뽑히지 않은 항목/);
});

const twiceItem = {
  id: 'd-1', language: 'ko', domain: '강의', pairId: 'p-01', targetType: 'demonstrative', resolution: 'none', generatorModel: 'm',
  transcript: '이 부분을 보시면 그리고 이 부분도 보시면 됩니다.',
};
const labeledPosition = (patch) => ({
  type: 'demonstrative', sourceList: ['production'], isApproximate: false, ...patch,
});

function prepareLabeledOut() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-extract-guard-'));
  const inFile = path.join(dir, 'items.jsonl');
  const outFile = path.join(dir, 'labeling.jsonl');
  fs.writeFileSync(inFile, `${JSON.stringify(twiceItem)}\n`);
  const labeledText = `${JSON.stringify({
    ...twiceItem,
    positionList: [
      labeledPosition({ posId: 'demonstrative@0-4', start: 0, end: 4, trigger: '이 부분', isGap: null, rationale: '' }),
      labeledPosition({ posId: 'demonstrative@14-18', start: 14, end: 18, trigger: '이 부분', isGap: false, rationale: '앞 문장의 부분' }),
      labeledPosition({ posId: 'demonstrative@20-22', start: 20, end: 22, trigger: '보시', isGap: true, rationale: '옛 후보' }),
    ],
  })}\n`;
  fs.writeFileSync(outFile, labeledText);
  return { dir, inFile, outFile, labeledText };
}

test('extract 는 --out 에 손으로 채운 라벨이 있으면 덮어쓰지 않고 2 로 끝난다(--in 과 같은 파일이어도)', async () => {
  const { inFile, outFile, labeledText } = prepareLabeledOut();
  const logList = [];
  const run = (argList) => runExtractCommand({
    argList, log: (line) => logList.push(line), createMatcher: async () => regexMatcher, createTrigger: createRuleTrigger,
  });
  assert.equal(await run(['--in', inFile, '--out', outFile]), 2);
  assert.equal(fs.readFileSync(outFile, 'utf8'), labeledText, '라벨 파일은 그대로다');
  assert.match(logList.join('\n'), /손으로 채운 라벨 2개/);
  assert.match(logList.join('\n'), /--force/);
  assert.equal(await run(['--in', outFile, '--out', outFile]), 2);
  assert.equal(fs.readFileSync(outFile, 'utf8'), labeledText);
});

test('extract 는 --out 에 라벨이 없는 초안만 있으면 그대로 다시 쓴다', async () => {
  const { inFile, outFile } = prepareLabeledOut();
  fs.writeFileSync(outFile, `${JSON.stringify({ ...twiceItem, positionList: [labeledPosition({ posId: 'demonstrative@0-4', isGap: null, rationale: '' })] })}\n`);
  const code = await runExtractCommand({
    argList: ['--in', inFile, '--out', outFile], log: () => {}, createMatcher: async () => regexMatcher, createTrigger: createRuleTrigger,
  });
  assert.equal(code, 0);
  assert.equal(JSON.parse(fs.readFileSync(outFile, 'utf8')).positionList.length, 2);
});

test('extract --force 는 기존 라벨을 같은 posId 위치로 옮겨 쓰고 옮긴 수·옮기지 못한 수를 알린다', async () => {
  for (const isSameFile of [false, true]) {
    const { inFile, outFile } = prepareLabeledOut();
    const logList = [];
    const code = await runExtractCommand({
      argList: ['--in', isSameFile ? outFile : inFile, '--out', outFile, '--force'],
      log: (line) => logList.push(line), createMatcher: async () => regexMatcher, createTrigger: createRuleTrigger,
    });
    assert.equal(code, 0, logList.join('\n'));
    const draft = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    assert.deepEqual(draft.positionList.map((position) => [position.posId, position.isGap, position.rationale]), [
      ['demonstrative@0-4', null, ''],
      ['demonstrative@14-18', false, '앞 문장의 부분'],
    ]);
    const logText = logList.join('\n');
    assert.match(logText, /기존 라벨 1개를 같은 posId 위치로 옮겼다/);
    assert.match(logText, /옮기지 못한 라벨 1개/);
    assert.match(logText, /d-1 demonstrative@20-22/);
  }
});

const targetItem = {
  ...twiceItem, id: 'd-2', targetTrigger: '이 부분을', isTargetGap: true, targetRationale: '무엇인지 없음',
};

function prepareTargetDraft() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-extract-prefill-'));
  const inFile = path.join(dir, 'items.jsonl');
  const outFile = path.join(dir, 'labeling.jsonl');
  const writeItem = (patch = {}) => fs.writeFileSync(inFile, `${JSON.stringify({ ...targetItem, ...patch })}\n`);
  const run = async (argList) => {
    const logList = [];
    const code = await runExtractCommand({
      argList, log: (line) => logList.push(line), createMatcher: async () => regexMatcher, createTrigger: createRuleTrigger,
    });
    return { code, logText: logList.join('\n') };
  };
  const readPositionList = () => JSON.parse(fs.readFileSync(outFile, 'utf8')).positionList
    .map((position) => [position.posId, position.isGap, position.rationale]);
  const editPosition = (posId, patch) => {
    const draft = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    draft.positionList = draft.positionList.map((position) => (position.posId === posId ? { ...position, ...patch } : position));
    fs.writeFileSync(outFile, `${JSON.stringify(draft)}\n`);
  };
  writeItem();
  return { inFile, outFile, writeItem, run, readPositionList, editPosition };
}

test('extract 가 미리 채운 목표 정답만 있는 초안은 손으로 채운 라벨이 아니라서 --force 없이 다시 뽑힌다', async () => {
  const { inFile, outFile, run, readPositionList } = prepareTargetDraft();
  assert.equal((await run(['--in', inFile, '--out', outFile])).code, 0);
  const rerun = await run(['--in', inFile, '--out', outFile]);
  assert.equal(rerun.code, 0, rerun.logText);
  assert.equal((await run(['--in', outFile, '--out', outFile])).code, 0, '--in 과 --out 이 같은 초안이어도');
  assert.deepEqual(readPositionList(), [['demonstrative@0-4', true, '무엇인지 없음'], ['demonstrative@14-18', null, '']]);
});

test('항목의 목표 정답을 고친 뒤 다시 뽑으면 옛 초안의 미리 채운 값이 아니라 새 정답이 들어간다(--force 여도)', async () => {
  const { inFile, outFile, writeItem, run, readPositionList } = prepareTargetDraft();
  assert.equal((await run(['--in', inFile, '--out', outFile])).code, 0);
  writeItem({ isTargetGap: false, targetRationale: '앞 문장의 표를 가리킴' });
  const forced = await run(['--in', inFile, '--out', outFile, '--force']);
  assert.equal(forced.code, 0, forced.logText);
  assert.deepEqual(readPositionList(), [['demonstrative@0-4', false, '앞 문장의 표를 가리킴'], ['demonstrative@14-18', null, '']]);
  writeItem({ isTargetGap: true, targetRationale: '다시 바꿈' });
  assert.equal((await run(['--in', inFile, '--out', outFile])).code, 0, '미리 채운 값만 있으므로 --force 없이도 된다');
  assert.deepEqual(readPositionList(), [['demonstrative@0-4', true, '다시 바꿈'], ['demonstrative@14-18', null, '']]);
});

test('목표가 아닌 위치에 손으로 채운 라벨은 --force 없이 멈추고 --force 면 옮긴다', async () => {
  const { inFile, outFile, run, readPositionList, editPosition } = prepareTargetDraft();
  assert.equal((await run(['--in', inFile, '--out', outFile])).code, 0);
  editPosition('demonstrative@14-18', { isGap: false, rationale: '앞 문장의 부분' });
  const refused = await run(['--in', inFile, '--out', outFile]);
  assert.equal(refused.code, 2);
  assert.match(refused.logText, /손으로 채운 라벨 1개/, '미리 채운 목표 정답은 세지 않는다');
  const forced = await run(['--in', inFile, '--out', outFile, '--force']);
  assert.equal(forced.code, 0, forced.logText);
  assert.deepEqual(readPositionList(), [['demonstrative@0-4', true, '무엇인지 없음'], ['demonstrative@14-18', false, '앞 문장의 부분']]);
  assert.match(forced.logText, /기존 라벨 1개를 같은 posId 위치로 옮겼다/);
});

test('손으로 고친 목표 위치 라벨이 새 목표 정답과 다르면 새 정답을 쓰고 그 위치를 알린다', async () => {
  const { inFile, outFile, run, readPositionList, editPosition } = prepareTargetDraft();
  assert.equal((await run(['--in', inFile, '--out', outFile])).code, 0);
  editPosition('demonstrative@0-4', { isGap: false, rationale: '손으로 고침' });
  const refused = await run(['--in', inFile, '--out', outFile]);
  assert.equal(refused.code, 2);
  assert.match(refused.logText, /손으로 채운 라벨 1개/);
  const forced = await run(['--in', inFile, '--out', outFile, '--force']);
  assert.equal(forced.code, 0, forced.logText);
  assert.deepEqual(readPositionList()[0], ['demonstrative@0-4', true, '무엇인지 없음']);
  assert.match(forced.logText, /새 목표 정답과 달라 새 정답을 쓴 위치 1개/);
  assert.match(forced.logText, /d-2 demonstrative@0-4 isGap=false "손으로 고침" → isGap=true "무엇인지 없음"/);
  assert.match(forced.logText, /옮기지 못한 라벨 0개/);
});
