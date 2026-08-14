# ASR 서버 — 앱이 보내는 audio/webm 세그먼트를 받아 전사를 반환한다.
# 앱 계약: POST /asr?startTs=<ms>&language=ko|en|auto, body=audio/webm(raw)
#   → { text, segmentList:[{startSec,endSec,text}], language, languageProbability }
#   language 가 없으면 ko. auto 는 ko·en 중 감지 확률이 높은 쪽으로 전사한다(asr_language.py).
#   응답 language 는 실제 전사에 쓴 언어, languageProbability 는 auto 일 때만 감지 확률(고정 언어면 null).
# 실행: cd ~/gpu-server && ~/venv-audio/bin/uvicorn asr_server:app --host 127.0.0.1 --port 8802
import io

from fastapi import FastAPI, HTTPException, Request
from faster_whisper import WhisperModel, decode_audio

from asr_language import parse_language_query, resolve_language

app = FastAPI()

# large-v3-turbo, GPU, float16. "large-v3-turbo" 별칭이 안 먹으면
# "deepdml/faster-whisper-large-v3-turbo-ct2"로 바꾸세요.
# (cuDNN 9 필요 — 없다고 에러 나면 README의 cuDNN 설치 항목 참고)
model = WhisperModel("large-v3-turbo", device="cuda", compute_type="float16")


@app.post("/asr")
async def transcribe(request: Request):
    """audio/webm 원본을 전사해 앱 계약 형식으로 반환한다."""
    try:
        requested_language = parse_language_query(request.query_params.get("language"))
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
    webm = await request.body()
    # faster-whisper가 PyAV로 webm/opus를 디코딩한다. 언어 감지와 전사가 같은 파형을 쓰도록 한 번만 디코딩한다.
    audio = decode_audio(io.BytesIO(webm), sampling_rate=model.feature_extractor.sampling_rate)

    def detect_probability_list():
        _language, _probability, probability_list = model.detect_language(audio=audio, vad_filter=True)
        return probability_list

    language, language_probability = resolve_language(requested_language, detect_probability_list)
    segments, _info = model.transcribe(audio, language=language, vad_filter=True)
    segment_list, full_text_list = [], []
    for segment in segments:
        text = segment.text.strip()
        segment_list.append(
            {"startSec": round(segment.start, 2), "endSec": round(segment.end, 2), "text": text}
        )
        full_text_list.append(text)
    return {
        "text": " ".join(full_text_list),
        "segmentList": segment_list,
        "language": language,
        "languageProbability": language_probability,
    }
