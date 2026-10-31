// 해설·질문 답을 읽는 빠르기. 렌더러 설정(speech-speed-store.js)에서 고르고 캡처를 시작할 때 세션마다 넘어온다.
// 값은 MeloTTS 의 speed 다. TTS 요청에 실어 보내면 TTS 서버(tools/gpu-server/tts_server.py)가 그 속도로 읽는다.
// 기본 2.0 은 그전까지 서버에 고정돼 있던 운영값이다.
const SPEECH_SPEED_LIST = [1.4, 1.6, 1.8, 2.0];
const DEFAULT_SPEECH_SPEED = 2.0;

function isSpeechSpeed(speed) {
  return SPEECH_SPEED_LIST.includes(speed);
}

// 값을 보내지 않는 옛 호출이면 조용히 기본 속도로, 허용값이 아니면 경고하고 기본 속도로 둔다.
function resolveSpeechSpeed(speed) {
  if (speed === undefined || speed === null) return DEFAULT_SPEECH_SPEED;
  if (isSpeechSpeed(speed)) return speed;
  console.warn(`[pipeline] 읽기 속도 "${speed}" 은 지원하지 않습니다 — ${DEFAULT_SPEECH_SPEED} 로 씁니다 (허용: ${SPEECH_SPEED_LIST.join('·')})`);
  return DEFAULT_SPEECH_SPEED;
}

module.exports = { SPEECH_SPEED_LIST, DEFAULT_SPEECH_SPEED, isSpeechSpeed, resolveSpeechSpeed };
