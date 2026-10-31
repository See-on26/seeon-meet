# 앱 설정 화면에서 고른 읽기 속도(1.4·1.6·1.8·2.0, MeloTTS speed)를 요청마다 받는다. 값이 없으면 서버 기본 속도로 읽는다.
# 너무 느리거나 빠른 값은 1배~2배 사이로 둔다.
import math

MIN_SPEECH_SPEED = 1.0
MAX_SPEECH_SPEED = 2.0


def resolve_speech_speed(requested, default_speed):
    if requested is None or not math.isfinite(requested):
        return default_speed
    return min(MAX_SPEECH_SPEED, max(MIN_SPEECH_SPEED, float(requested)))
