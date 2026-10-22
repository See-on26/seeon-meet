// 해설 내용 개선 항목을 하나씩 끌 수 있게 하는 스위치. 기본은 모두 켜짐이고, 환경변수에 'false' 를 주면 그 항목만 예전 동작으로 돌아간다.
// 칸 목록·자르기·프롬프트를 만드는 함수는 스위치를 받지 않으면 부를 때의 환경변수를 읽는다(config 없이 불러도 같은 스위치를 따른다).
const CONTENT_SWITCH_ENV_NAME_MAP = {
  // 식별 사실 완결: 지시 단순형에 식별 사실 칸(fact), 수치 해설에 근거 줄 칸(source)을 두고, 잘린 칸의 범위 끝("…까지")을 떼지 않는다.
  isFactCompleteEnabled: 'SEEON_FACT_COMPLETE_ENABLED',
};

function readContentSwitch(env = process.env) {
  return Object.fromEntries(Object.entries(CONTENT_SWITCH_ENV_NAME_MAP)
    .map(([key, envName]) => [key, env[envName] !== 'false']));
}

// 일부만 준 스위치(시험·config)는 나머지를 지금 환경변수로 채운다.
function resolveContentSwitch(partial = null) {
  return { ...readContentSwitch(), ...(partial || {}) };
}

module.exports = { CONTENT_SWITCH_ENV_NAME_MAP, readContentSwitch, resolveContentSwitch };
