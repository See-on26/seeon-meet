// 3.2 E2E 이해도 평가 도구. 문항 셋과 실험 결과 폴더로 조건 A·S·H·C 의 LLM 답과 3.2.4 지표를 낸다.
//   node tools/eval/e2e-eval.mjs --questions questions.json --run v1=out/lab/<실행 폴더>
//   node tools/eval/e2e-eval.mjs --questions questions.json --run v1=out/lab/<실행 폴더> --filter N,V,C
import { runE2eCommand } from './lib/e2e-command.mjs';

process.exitCode = await runE2eCommand({ argList: process.argv.slice(2) });
