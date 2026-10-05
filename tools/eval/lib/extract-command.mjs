import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { validateDetectionItemList, formatIssueList, ISSUE_LEVEL_MAP } from './dataset-validate.mjs';
import { createMethodologyMatcher, MATCHER_KIND_MAP } from './methodology-matcher.mjs';
import { extractItemPositionList, buildLabelDraft, summarizeExtraction } from './extract-items.mjs';
import { TARGET_TYPE_LIST, TARGET_TYPE_CODE_MAP, TARGET_TYPE_LABEL_MAP } from './eval-types.mjs';

export const EXTRACT_USAGE = 'node tools/eval/detection-eval.mjs extract --in items.jsonl --out labeling.jsonl [--matcher auto|kiwi|regex] [--force]';

const toLabelKey = (itemId, posId) => `${itemId}\u0000${posId}`;

// --out 에 이미 있는 라벨(isGap 이 null 이 아닌 위치)을 항목 id·posId 로 읽는다. JSON 으로 읽지 못한 줄은 센다 —
// 손으로 고치다 깨진 줄에도 라벨이 들어 있을 수 있다. 파일이 없으면 null.
function readExistingLabel(outPath) {
  if (!fs.existsSync(outPath)) return null;
  const labelMap = new Map();
  let brokenLineCount = 0;
  for (const line of fs.readFileSync(outPath, 'utf8').replace(/^\uFEFF/, '').split('\n')) {
    if (!line.trim()) continue;
    let draft = null;
    try {
      draft = JSON.parse(line);
    } catch {
      brokenLineCount += 1;
      continue;
    }
    for (const position of Array.isArray(draft?.positionList) ? draft.positionList : []) {
      if (position?.isGap === null || position?.isGap === undefined) continue;
      labelMap.set(toLabelKey(draft.id, position.posId), {
        itemId: draft.id, posId: position.posId, trigger: position.trigger, isGap: position.isGap, rationale: position.rationale ?? '',
      });
    }
  }
  return { labelMap, brokenLineCount };
}

// 기존 라벨을 새 초안의 같은 항목·같은 posId 위치로 옮긴다. 전사가 바뀌어 그 자리 글자가 달라졌으면 옮기지 않는다.
function carryExistingLabel({ draftList, labelMap }) {
  const carriedKeySet = new Set();
  const carriedDraftList = draftList.map((draft) => ({
    ...draft,
    positionList: draft.positionList.map((position) => {
      const key = toLabelKey(draft.id, position.posId);
      const label = labelMap.get(key);
      if (!label || (typeof label.trigger === 'string' && label.trigger !== position.trigger)) return position;
      carriedKeySet.add(key);
      return { ...position, isGap: label.isGap, rationale: label.rationale };
    }),
  }));
  const droppedList = [...labelMap].filter(([key]) => !carriedKeySet.has(key)).map(([, label]) => label);
  return { draftList: carriedDraftList, carriedCount: carriedKeySet.size, droppedList };
}

function formatRefusal({ outPath, existing }) {
  const lineList = [`[extract] ${outPath} 에 손으로 채운 라벨 ${existing.labelMap.size}개(isGap 이 null 이 아닌 위치)가 있어 덮어쓰지 않는다.`];
  if (existing.brokenLineCount) lineList.push(`  JSON 으로 읽지 못한 줄도 ${existing.brokenLineCount}개 있다(그 줄에 든 라벨은 셀 수 없다).`);
  lineList.push('  다른 --out 을 주거나, 기존 라벨을 새 초안의 같은 posId 위치로 옮겨 쓰려면 --force 를 붙인다(옮기지 못한 라벨은 목록으로 알려 준다).');
  return lineList.join('\n');
}

function formatCarrySummary({ carriedCount, droppedList, brokenLineCount }) {
  const lineList = [`[extract] --force: 기존 라벨 ${carriedCount}개를 같은 posId 위치로 옮겼다 · 옮기지 못한 라벨 ${droppedList.length}개`
    + ' (새 초안에 같은 위치가 없거나 그 자리 글자가 바뀜 — 파일에서 지워졌으니 필요하면 아래를 보고 다시 채운다)'];
  for (const label of droppedList) {
    lineList.push(`  - ${label.itemId} ${label.posId} ${JSON.stringify(label.trigger ?? '')} isGap=${label.isGap} ${JSON.stringify(label.rationale)}`);
  }
  if (brokenLineCount) lineList.push(`[extract] --force: JSON 으로 읽지 못한 줄 ${brokenLineCount}개는 옮기지 못했다`);
  return lineList.join('\n');
}

function formatSummary(summary) {
  const lineList = [
    `[extract] 항목 ${summary.itemCount}건(${Object.entries(summary.languageCountMap).map(([language, count]) => `${language} ${count}`).join(' · ')})`
      + ` · 후보 위치 ${summary.positionCount}개 · 정답 미리 채움 ${summary.prefilledCount}개`,
    `[extract] 한국어 말주머니 매처: ${summary.matcherKind}${summary.isApproximate ? ' (근사 — 품사 분석 없이 어절 경계로 대조)' : ''} · 영어는 단어 경계 대조`,
  ];
  for (const type of TARGET_TYPE_LIST) {
    const typeSummary = summary.typeSummaryMap[type];
    lineList.push(`  ${TARGET_TYPE_CODE_MAP[type]} ${TARGET_TYPE_LABEL_MAP[type]}: ${typeSummary.count}개`
      + ` (production ${typeSummary.productionCount} · 말주머니 ${typeSummary.methodologyCount} · 둘 다 ${typeSummary.bothCount})`);
  }
  if (summary.missingTargetIdList.length) {
    lineList.push(`[extract] 목표 트리거가 후보로 뽑히지 않은 항목: ${summary.missingTargetIdList.join(', ')}`);
  }
  if (summary.ambiguousTargetIdList.length) {
    lineList.push(`[extract] 목표 트리거가 여러 번 나와 미리 채우지 않음: ${summary.ambiguousTargetIdList.join(', ')}`
      + ' (어느 자리인지 가를 수 없다 — targetTrigger 를 조사·어미까지 붙여 한 번만 나오는 꼴로 적거나 손으로 채운다)');
  }
  return lineList.join('\n');
}

export async function runExtractCommand({ argList, log = console.log, createMatcher = createMethodologyMatcher }) {
  let values = null;
  try {
    ({ values } = parseArgs({
      args: argList,
      options: {
        in: { type: 'string' },
        out: { type: 'string' },
        matcher: { type: 'string', default: MATCHER_KIND_MAP.auto },
        force: { type: 'boolean', default: false },
      },
    }));
  } catch (error) {
    log(`[extract] ${error.message}\n사용법: ${EXTRACT_USAGE}`);
    return 2;
  }
  if (!values.in || !values.out) {
    log(`사용법: ${EXTRACT_USAGE}`);
    return 2;
  }
  // 다시 돌리면 손으로 채운 라벨이 지워지므로(--in 과 --out 이 같은 파일일 때도) --force 없이는 쓰지 않는다.
  const existing = readExistingLabel(values.out);
  const hasExistingLabel = Boolean(existing) && (existing.labelMap.size > 0 || existing.brokenLineCount > 0);
  if (hasExistingLabel && !values.force) {
    log(formatRefusal({ outPath: values.out, existing }));
    return 2;
  }
  const { itemList, issueList } = validateDetectionItemList({ text: fs.readFileSync(values.in, 'utf8') });
  const errorList = issueList.filter((issue) => issue.level === ISSUE_LEVEL_MAP.error);
  if (errorList.length) {
    log(`[extract] 형식 오류 ${errorList.length}건 — 먼저 고친다\n${formatIssueList(errorList)}`);
    return 1;
  }
  const matcher = await createMatcher({ kind: values.matcher });
  const draftList = itemList.map((item) => buildLabelDraft({ item, positionList: extractItemPositionList({ item, matcher }) }));
  const carried = hasExistingLabel ? carryExistingLabel({ draftList, labelMap: existing.labelMap }) : null;
  const writtenDraftList = carried ? carried.draftList : draftList;
  fs.mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
  fs.writeFileSync(values.out, `${writtenDraftList.map((draft) => JSON.stringify(draft)).join('\n')}\n`, 'utf8');
  log(formatSummary(summarizeExtraction({ draftList, matcher })));
  if (carried) log(formatCarrySummary({ ...carried, brokenLineCount: existing.brokenLineCount }));
  log(`[extract] 라벨 초안 → ${values.out} (isGap 이 null 인 위치에 true·false 를 채운다)`);
  return 0;
}
