# ASR 서버 — 앱이 보내는 audio/webm 세그먼트를 받아 전사를 반환한다.
# 앱 계약: POST /asr?startTs=<ms>, body=audio/webm(raw) → { text, segmentList:[{startSec,endSec,text}] }
# 실행: cd ~/gpu-server && ~/venv-audio/bin/uvicorn asr_server:app --host 127.0.0.1 --port 8802
import io

from fastapi import FastAPI, Request
from faster_whisper import WhisperModel

app = FastAPI()

# large-v3-turbo, GPU, float16. "large-v3-turbo" 별칭이 안 먹으면
# "deepdml/faster-whisper-large-v3-turbo-ct2"로 바꾸세요.
# (cuDNN 9 필요 — 없다고 에러 나면 README의 cuDNN 설치 항목 참고)
model = WhisperModel("large-v3-turbo", device="cuda", compute_type="float16")


@app.post("/asr")
async def transcribe(request: Request):
    """audio/webm 원본을 전사해 앱 계약 형식으로 반환한다."""
    webm = await request.body()
    # faster-whisper가 PyAV로 webm/opus를 직접 디코딩한다.
    segments, _info = model.transcribe(io.BytesIO(webm), language="ko", vad_filter=True)
    segment_list, full_text_list = [], []
    for segment in segments:
        text = segment.text.strip()
        segment_list.append(
            {"startSec": round(segment.start, 2), "endSec": round(segment.end, 2), "text": text}
        )
        full_text_list.append(text)
    return {"text": " ".join(full_text_list), "segmentList": segment_list}
