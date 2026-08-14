# TTS 서버 — 앱이 보내는 {text}를 받아 WAV 바이너리를 반환한다.
# 앱 계약: POST /tts, body={"text": "..."} → audio/wav (뷰어가 WebAudio decodeAudioData로 재생)
# 실행: cd ~/gpu-server && ~/venv-audio/bin/uvicorn tts_server:app --host 127.0.0.1 --port 8803
import os
import tempfile

from fastapi import FastAPI
from fastapi.responses import Response
from melo.api import TTS
from pydantic import BaseModel

app = FastAPI()

tts = TTS(language="KR", device="cuda")
speaker_id_map = tts.hps.data.spk2id  # 한국어는 'KR' 화자 1종


class SynthesisRequest(BaseModel):
    text: str


@app.post("/tts")
def synthesize(request: SynthesisRequest):
    """텍스트를 합성해 WAV 바이너리로 반환한다."""
    output_path = tempfile.mktemp(suffix=".wav")
    try:
        tts.tts_to_file(request.text, speaker_id_map["KR"], output_path, speed=1.3)
        with open(output_path, "rb") as wav_file:
            wav_bytes = wav_file.read()
    finally:
        if os.path.exists(output_path):
            os.unlink(output_path)
    return Response(content=wav_bytes, media_type="audio/wav")
