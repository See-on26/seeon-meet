// 평가 셋 형식 검사기. 잘못된 칸을 줄 번호와 함께 알려 준다.
//   node tools/eval/validate.mjs <items.jsonl|labeled.jsonl|questions.json> [--labeled]
import fs from 'node:fs';
import { validateFile, formatIssueList, ISSUE_LEVEL_MAP } from './lib/dataset-validate.mjs';

const [filePath, ...flagList] = process.argv.slice(2);
if (!filePath) {
  console.error('사용법: node tools/eval/validate.mjs <items.jsonl|labeled.jsonl|questions.json> [--labeled]');
  process.exit(2);
}

const text = fs.readFileSync(filePath, 'utf8');
const result = validateFile({ filePath, text, isLabeledRequired: flagList.includes('--labeled') });
console.log(`[검사] ${filePath} — ${result.kindLabel} ${result.count}건`);
if (result.issueList.length) console.log(formatIssueList(result.issueList));
const errorCount = result.issueList.filter((issue) => issue.level === ISSUE_LEVEL_MAP.error).length;
console.log(errorCount ? `오류 ${errorCount}건 — 고친 뒤 다시 검사하세요` : '형식 오류 없음');
process.exit(errorCount ? 1 : 0);
