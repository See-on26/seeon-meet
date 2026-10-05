import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { validateDetectionItemList, formatIssueList, ISSUE_LEVEL_MAP } from './dataset-validate.mjs';
import { createMethodologyMatcher, MATCHER_KIND_MAP } from './methodology-matcher.mjs';
import { extractItemPositionList, buildLabelDraft, summarizeExtraction } from './extract-items.mjs';
import { TARGET_TYPE_LIST, TARGET_TYPE_CODE_MAP, TARGET_TYPE_LABEL_MAP } from './eval-types.mjs';

export const EXTRACT_USAGE = 'node tools/eval/detection-eval.mjs extract --in items.jsonl --out labeling.jsonl [--matcher auto|kiwi|regex]';

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
  const { itemList, issueList } = validateDetectionItemList({ text: fs.readFileSync(values.in, 'utf8') });
  const errorList = issueList.filter((issue) => issue.level === ISSUE_LEVEL_MAP.error);
  if (errorList.length) {
    log(`[extract] 형식 오류 ${errorList.length}건 — 먼저 고친다\n${formatIssueList(errorList)}`);
    return 1;
  }
  const matcher = await createMatcher({ kind: values.matcher });
  const draftList = itemList.map((item) => buildLabelDraft({ item, positionList: extractItemPositionList({ item, matcher }) }));
  fs.mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
  fs.writeFileSync(values.out, `${draftList.map((draft) => JSON.stringify(draft)).join('\n')}\n`, 'utf8');
  log(formatSummary(summarizeExtraction({ draftList, matcher })));
  log(`[extract] 라벨 초안 → ${values.out} (isGap 이 null 인 위치에 true·false 를 채운다)`);
  return 0;
}
