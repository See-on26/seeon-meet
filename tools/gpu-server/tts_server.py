# TTS 서버 — 앱이 보내는 {text}를 받아 WAV 바이너리를 반환한다.
# 앱 계약: POST /tts, body={"text": "..."} → audio/wav (뷰어가 WebAudio decodeAudioData로 재생)
# 실행: cd ~/gpu-server && ~/venv-audio/bin/uvicorn tts_server:app --host 127.0.0.1 --port 8803
import os
import re
import tempfile

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from melo.api import TTS
from pydantic import BaseModel

app = FastAPI()

tts = TTS(language="KR", device="cuda")
speaker_id_map = tts.hps.data.spk2id  # 한국어는 'KR' 화자 1종

# ── 합성 불가 기호 ──
# MeloTTS 한국어 g2p는 아래 ASCII 기호를 그대로 통과시키는데 음소 심볼 테이블에 없어
# `melo/text/__init__.py`의 `symbol_to_id_map[symbol]`이 KeyError로 터진다(라이브러리에 폴백 없음).
# 그러면 여기서 500이 나가고, 청자에게는 **캡션이 조용히 음성 없이 사라지는** 것으로 나타난다.
# `Q&A` 하나 때문에 정상 캡션이 통째로 묵음이 됐다.
# 11개 전부 500, 나머지(`%` `#` `~` `*` `[` `]` `\`)는 정상임을 실측했다(2026-08-05 · 2026-08-07 재확인).
#
# 여기는 **"절대 500을 내지 않는다"는 안전망**이다. 기호를 읽기 좋은 한국어로 바꾸는 일은
# 앱(src/main/caption-pipeline/output/tts-client.js)이 한다 — 치환 맵을 양쪽에 두면 어긋난다.
UNSPEAKABLE_SYMBOL_PATTERN = re.compile(r"[&<>$@|`{}=+]")


class SynthesisRequest(BaseModel):
    text: str


@app.post("/tts")
def synthesize(request: SynthesisRequest):
    """텍스트를 합성해 WAV 바이너리로 반환한다."""
    text = UNSPEAKABLE_SYMBOL_PATTERN.sub(" ", request.text).strip()
    if not text:
        raise HTTPException(status_code=422, detail="합성할 텍스트가 비어 있다")
    output_path = tempfile.mktemp(suffix=".wav")
    try:
        # speed=2.0 은 실서버(<서버 이름>)의 실제 운영값이다(2026-08-07 확인).
        # 어절당 발화 초(M-1)를 재잴 때는 반드시 이 값을 기준으로 해야 한다 —
        # renderer/core/mode/mode-policy.js 의 SPEECH_MS_PER_WORD 가 여기에 종속된다.
        tts.tts_to_file(text, speaker_id_map["KR"], output_path, speed=2.0)
        with open(output_path, "rb") as wav_file:
            wav_bytes = wav_file.read()
    except KeyError as exc:
        # 위 패턴에서 걸러지지 않은 새 기호다. 500(서버 장애)이 아니라 422(입력 문제)로 내려
        # 앱이 "서버가 죽었다"와 "이 텍스트가 나쁘다"를 구분할 수 있게 한다.
        raise HTTPException(status_code=422, detail=f"합성 불가 기호: {exc}") from exc
    finally:
        if os.path.exists(output_path):
            os.unlink(output_path)
    return Response(content=wav_bytes, media_type="audio/wav")
