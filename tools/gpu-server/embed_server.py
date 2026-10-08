# 임베딩 서버 — 앱이 보내는 image/jpeg 프레임을 이미지 임베딩 벡터로 반환한다.
# Stage 1 슬라이드 전환 확정용: 후보 프레임 임베딩의 코사인 거리로 새 슬라이드/재방문을 가른다.
# 앱 계약: POST /embed, body=image/jpeg(raw) → { embedding: [float, ...] }  (L2 정규화된 벡터)
# 슬라이드 전사: POST /ocr, body=image/jpeg(raw) → { text, lineList, meanScore, verticalBoxRatio, ... } (ocr_engine.py)
# 실행: cd ~/gpu-server && ~/venv-embed/bin/uvicorn embed_server:app --host 127.0.0.1 --port 8804
#   (venv-embed 는 setup-embed.sh 가 만든다 — torch · transformers · Pillow · FastAPI, /ocr 용 onnxruntime · opencv-python-headless · rapidocr)
import io
import threading

import torch
from fastapi import FastAPI, HTTPException, Request
from PIL import Image
from starlette.concurrency import run_in_threadpool
from transformers import AutoModel, AutoProcessor

from ocr_engine import InvalidImageError, OcrEngineError, create_ocr_state, recognize

app = FastAPI()

# SigLIP 이미지 타워 — 감지 전용이라 작은 모델로 충분(수십 ms). 다국어 슬라이드면
# "google/siglip2-base-patch16-224" 등으로 교체 가능(계약은 동일).
MODEL_NAME = "google/siglip-base-patch16-224"
device = "cuda" if torch.cuda.is_available() else "cpu"
model = AutoModel.from_pretrained(MODEL_NAME).to(device).eval()
processor = AutoProcessor.from_pretrained(MODEL_NAME)


@app.post("/embed")
async def embed(request: Request):
    """image/jpeg 원본을 이미지 임베딩(L2 정규화)으로 반환한다."""
    jpeg = await request.body()
    image = Image.open(io.BytesIO(jpeg)).convert("RGB")
    inputs = processor(images=image, return_tensors="pt").to(device)
    with torch.no_grad():
        features = model.get_image_features(**inputs)
    features = torch.nn.functional.normalize(features, dim=-1)
    return {"embedding": features[0].cpu().tolist()}


# 슬라이드 전사 OCR. 모델·패키지가 없어도 임베딩은 계속 돌고 /ocr 만 503 을 돌려준다.
ocr_engine, ocr_engine_error = create_ocr_state()
# RapidOCR 엔진 객체가 여러 스레드에서 동시에 불려도 안전하다는 보장이 없어 한 번에 한 장만 인식한다.
ocr_lock = threading.Lock()


def recognize_one(jpeg):
    with ocr_lock:
        return recognize(ocr_engine, jpeg)


@app.post("/ocr")
async def ocr(request: Request):
    """image/jpeg 원본을 줄 단위 글과 품질 지표로 반환한다. 인식은 스레드 풀에서 돌려 /embed 를 막지 않는다.

    읽지 못한 이미지는 400, 엔진이 그 장만 처리하지 못하면 422 로 답한다. 앱은 4xx 를 그 장만의 오류로 보고
    그 장만 VLM 으로 넘기며, 5xx 일 때만 서비스 다운으로 보고 OCR 을 한동안 건너뛴다.
    """
    if ocr_engine is None:
        raise HTTPException(status_code=503, detail=f"OCR 엔진 없음: {ocr_engine_error}")
    jpeg = await request.body()
    try:
        return await run_in_threadpool(recognize_one, jpeg)
    except InvalidImageError as error:
        raise HTTPException(status_code=400, detail=str(error))
    except OcrEngineError as error:
        raise HTTPException(status_code=422, detail=str(error))
