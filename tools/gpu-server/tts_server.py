# TTS 서버 — 앱이 보내는 {text, language}를 받아 음성을 반환한다.
# 앱 계약: POST /tts,      body={"text": "...", "language": "KR"|"EN"} → audio/wav  (뷰어가 WebAudio decodeAudioData로 재생)
#          POST /tts-long, body={"text": "...", "language": "KR"|"EN"} → audio/mpeg (회의 요약본 전문 → mp3 파일)
# language 는 앱의 캡션 언어다(빠지면 KR).
# 실행: cd ~/gpu-server && ~/venv-audio/bin/uvicorn tts_server:app --host 127.0.0.1 --port 8803
import os
import re
import shutil
import subprocess
import tempfile

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from melo.api import TTS
from pydantic import BaseModel

app = FastAPI()

# 언어별 MeloTTS 모델과 화자. 한국어는 'KR' 화자 1종, 영어는 미국식 'EN-US' 를 쓴다.
# 둘 다 시작할 때 띄운다 — 첫 영어 요청 때 띄우면 모델 로딩이 앱의 TTS 시간 제한(15초)을 넘겨 그 AD 가 소리 없이 지나간다.
# 영어 모델을 못 띄워도(NLTK 데이터 없음 등) 한국어 TTS 는 그대로 뜨고, 영어 요청은 한국어 모델로 읽는다.
SPEAKER_BY_LANGUAGE_MAP = {"KR": "KR", "EN": "EN-US"}
DEFAULT_LANGUAGE = "KR"
tts_by_language_map = {DEFAULT_LANGUAGE: TTS(language=DEFAULT_LANGUAGE, device="cuda")}
try:
    english_model = TTS(language="EN", device="cuda")
    # 영어 모델은 첫 합성 때 언어 모델(BERT)을 불러와 6초 넘게 걸린다(10/18 실측). 기동할 때 한 번 데워 둔다.
    warmup_path = tempfile.mktemp(suffix=".wav")
    english_model.tts_to_file("Ready.", english_model.hps.data.spk2id[SPEAKER_BY_LANGUAGE_MAP["EN"]], warmup_path, speed=2.0)
    os.unlink(warmup_path)
    tts_by_language_map["EN"] = english_model
except Exception as exc:  # noqa: BLE001 — 영어 모델 실패가 한국어 TTS 기동을 막지 않게 한다
    print(f"[tts] 영어 모델을 띄우지 못해 영어 요청도 한국어 모델로 읽는다: {exc}", flush=True)


def resolve_tts(language):
    """언어에 맞는 (모델, 화자 id) 를 돌려준다. 모르는 언어나 못 띄운 언어는 한국어로 읽는다."""
    key = language if language in tts_by_language_map else DEFAULT_LANGUAGE
    model = tts_by_language_map[key]
    return model, model.hps.data.spk2id[SPEAKER_BY_LANGUAGE_MAP[key]]

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

# 한 번에 합성할 최대 글자 수. 너무 길게 넣으면 MeloTTS가 느려지고 메모리를 크게 쓴다.
MAX_CHUNK_CHARS = 300

# 요약본 낭독 속도. /tts 의 2.0 과 **일부러 분리한다.**
# /tts 의 속도는 실시간 어절 예산의 교정 상수다 — mode-policy.js 의 SPEECH_MS_PER_WORD 가
# 여기에 종속돼 있어, 값을 공유하면 요약본 속도를 손보는 순간 실시간 캡션 예산이 조용히 어긋난다.
# 요약본은 삽입할 틈도 어절 예산도 없는 독립 파일이라 그 제약을 물려받을 이유가 없다.
SUMMARY_SPEECH_SPEED = 1.5


class SynthesisRequest(BaseModel):
    text: str
    language: str = DEFAULT_LANGUAGE


@app.post("/tts")
def synthesize(request: SynthesisRequest):
    """텍스트를 합성해 WAV 바이너리로 반환한다."""
    text = UNSPEAKABLE_SYMBOL_PATTERN.sub(" ", request.text).strip()
    if not text:
        raise HTTPException(status_code=422, detail="합성할 텍스트가 비어 있다")
    output_path = tempfile.mktemp(suffix=".wav")
    try:
        # speed=2.0 은 실시간 캡션의 운영값이다.
        # 어절당 발화 초(M-1)를 재잴 때는 반드시 이 값을 기준으로 해야 한다 —
        # renderer/core/mode/mode-policy.js 의 SPEECH_MS_PER_WORD 가 여기에 종속된다.
        model, speaker_id = resolve_tts(request.language)
        model.tts_to_file(text, speaker_id, output_path, speed=2.0)
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


def split_into_chunk_list(text):
    """긴 텍스트를 문장 경계에서 잘라 합성 단위 목록으로 만든다."""
    chunk_list = []
    for paragraph in text.split("\n"):
        paragraph = paragraph.strip()
        if not paragraph:
            continue
        # 문장 끝(마침표·물음표·느낌표) 뒤에서 자른다
        for sentence in re.split(r"(?<=[.!?])\s+", paragraph):
            sentence = sentence.strip()
            if not sentence:
                continue
            if chunk_list and len(chunk_list[-1]) + len(sentence) + 1 <= MAX_CHUNK_CHARS:
                chunk_list[-1] = chunk_list[-1] + " " + sentence
            else:
                # 한 문장이 상한을 넘으면 그대로 둔다(문장 중간을 자르면 억양이 깨진다)
                chunk_list.append(sentence)
    return chunk_list


@app.post("/tts-long")
def synthesize_long(request: SynthesisRequest):
    """회의 요약본 전문을 합성해 mp3 하나로 반환한다."""
    if not shutil.which("ffmpeg"):
        return Response(
            content=b"ffmpeg not installed on the TTS server",
            status_code=503,
            media_type="text/plain",
        )

    # /tts 와 같은 안전망을 통과시킨다 — 청크 하나가 KeyError로 터지면 몇 분 걸린 합성이
    # 통째로 날아간다. 읽기 좋게 바꾸는 일은 앱이 이미 했다(tts-client.js).
    text = UNSPEAKABLE_SYMBOL_PATTERN.sub(" ", request.text)
    chunk_list = split_into_chunk_list(text)
    if not chunk_list:
        return Response(content=b"empty text", status_code=400, media_type="text/plain")

    model, speaker_id = resolve_tts(request.language)
    work_dir = tempfile.mkdtemp(prefix="tts-long-")
    try:
        wav_path_list = []
        for index, chunk in enumerate(chunk_list):
            wav_path = os.path.join(work_dir, f"part-{index:04d}.wav")
            model.tts_to_file(chunk, speaker_id, wav_path, speed=SUMMARY_SPEECH_SPEED)
            wav_path_list.append(wav_path)
            print(f"[tts-long] {index + 1}/{len(chunk_list)} 합성 완료", flush=True)

        # ffmpeg concat demuxer로 이어 붙이면서 mp3로 인코딩한다
        list_path = os.path.join(work_dir, "list.txt")
        with open(list_path, "w", encoding="utf-8") as list_file:
            for wav_path in wav_path_list:
                list_file.write(f"file '{wav_path}'\n")

        mp3_path = os.path.join(work_dir, "summary.mp3")
        subprocess.run(
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
             "-f", "concat", "-safe", "0", "-i", list_path,
             "-c:a", "libmp3lame", "-b:a", "64k", "-ac", "1", mp3_path],
            check=True,
        )
        with open(mp3_path, "rb") as mp3_file:
            mp3_bytes = mp3_file.read()
        print(f"[tts-long] mp3 {len(mp3_bytes) // 1024}KB 반환", flush=True)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)

    return Response(content=mp3_bytes, media_type="audio/mpeg")
