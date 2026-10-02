// 렌더러 ESM 모듈 그래프의 문법·import/export 짝을 Node 에서 점검한다.
// 브라우저 전역(window, document) 접근으로 나는 평가 단계 오류는 정상으로 본다.
const target = process.argv[2];
if (!target) {
  console.error('사용법: node tools/check-esm.mjs <모듈 경로>');
  process.exit(2);
}
import(new URL(target, `file://${process.cwd()}/`).href)
  .then(() => { console.log('loaded'); })
  .catch((error) => {
    console.log(`${error.name}: ${error.message.split('\n')[0]}`);
    process.exit(error.name === 'SyntaxError' ? 1 : 0);
  });
