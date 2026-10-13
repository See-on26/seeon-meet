import { MEET_RELOAD_TARGET_MAP } from '../constants.js';

export function buildMeetReloadNotice({ target, isCaptureActive }) {
  const head = target === MEET_RELOAD_TARGET_MAP.home ? 'Meet 첫 화면으로 돌아왔어요.' : 'Meet 화면을 새로고침했어요.';
  if (isCaptureActive) return `${head} 회의에 다시 참여한 뒤, 캡처가 멈췄다면 다시 시작해 주세요`;
  return target === MEET_RELOAD_TARGET_MAP.home
    ? `${head} 회의 코드를 넣거나 회의 링크로 참여해 주세요`
    : `${head} 회의에 다시 참여해 주세요`;
}
