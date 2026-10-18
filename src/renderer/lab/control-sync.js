// 실행 상태 알림에서 조작 바 select 에 보일 실행 모드·받아쓰기 언어·캡션 언어를 고른다.
// 자동 실행처럼 조작 바를 거치지 않고 시작한 실행도 실제 값을 보이게 한다.
// 쉬는 중(idle·done·failed)에는 빈 객체를 돌려 사용자가 다음 실행용으로 고른 값을 덮지 않는다.
export const IDLE_PHASE_LIST = ['idle', 'done', 'failed'];

const isFilledText = (value) => typeof value === 'string' && value !== '';

export function pickRunSelection({ status }) {
  if (!status || IDLE_PHASE_LIST.includes(status.phase)) return {};
  return {
    ...(isFilledText(status.mode) ? { mode: status.mode } : {}),
    ...(isFilledText(status.asrLanguage) ? { asrLanguage: status.asrLanguage } : {}),
    ...(isFilledText(status.captionLanguage) ? { captionLanguage: status.captionLanguage } : {}),
  };
}
