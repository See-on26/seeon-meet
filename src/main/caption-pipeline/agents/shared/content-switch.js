// 해설 내용 개선 항목을 하나씩 끌 수 있게 하는 스위치. 기본은 모두 켜짐이고, 환경변수에 'false' 를 주면 그 항목만 예전 동작으로 돌아간다.
// 칸 목록·자르기·프롬프트를 만드는 함수는 스위치를 받지 않으면 부를 때의 환경변수를 읽는다(config 없이 불러도 같은 스위치를 따른다).
const CONTENT_SWITCH_ENV_NAME_MAP = {
  // 식별 사실 완결: 지시 단순형에 식별 사실 칸(fact), 수치 해설에 근거 줄 칸(source)을 두고, 잘린 칸의 범위 끝("…까지")을 떼지 않는다.
  isFactCompleteEnabled: 'SEEON_FACT_COMPLETE_ENABLED',
  // 시점 표기 지키기: 예산 맞추기에서 대상 칸의 시점 낱말을 빼지 않고, 근거 칸에 하나뿐인 시점이 해설에서 빠졌으면 되살린다.
  isTimeMarkEnabled: 'SEEON_TIME_MARK_ENABLED',
  // 발화 어림 되풀이 막기: 발표자가 어림해 말한 수("약 800")를 짚어, 화면에 글자로 적힌 값이 있으면 그 값을 말하게 한다.
  isScreenValueFirstEnabled: 'SEEON_SCREEN_VALUE_FIRST_ENABLED',
  // 척도 에이전트 다시 만들기: 통계 패널·툴팁·범례 값을 먼저 읽어(reading 칸) 그 값이나 견준 크기로 말하고, NONE 조건을 줄인다.
  isScaleValueFirstEnabled: 'SEEON_SCALE_VALUE_FIRST_ENABLED',
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
