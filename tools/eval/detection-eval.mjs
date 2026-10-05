// 3.1 탐지 평가 도구. production 트리거·판정기를 Electron 없이 그대로 불러 후보를 뽑고 채점한다.
//   node tools/eval/detection-eval.mjs extract --in items.jsonl --out labeling.jsonl
//   node tools/eval/detection-eval.mjs score --in labeled.jsonl [--mode delayed|realtime_mix|listening|all] [--repeat N]
const COMMAND_MAP = {
  extract: async (argList) => (await import('./lib/extract-command.mjs')).runExtractCommand({ argList }),
};

const [commandName, ...argList] = process.argv.slice(2);
const command = COMMAND_MAP[commandName];
if (!command) {
  console.error(`사용법: node tools/eval/detection-eval.mjs <${Object.keys(COMMAND_MAP).join('|')}> [옵션]`);
  process.exit(2);
}
process.exitCode = await command(argList);
