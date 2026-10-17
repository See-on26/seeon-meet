// 모드마다 회의 소리를 늦춰 트는 시간(렌더러 mode-policy.js delayMs). main 에서 렌더러 ESM 을 불러올 수 없어 값만 옮기고,
// 같은 값인지는 dev-flow 테스트가 렌더러 모듈과 대조한다.
const MODE_DELAY_MS_MAP = {
  listening: 60000,
  delayed: 10000,
  realtime_sic: 0,
  realtime_mix: 0,
};

module.exports = { MODE_DELAY_MS_MAP };
