# 임베딩 서버 — 앱이 보내는 image/jpeg 프레임을 이미지 임베딩 벡터로 반환한다.
# Stage 1 슬라이드 전환 확정용: 후보 프레임 임베딩의 코사인 거리로 새 슬라이드/재방문을 가른다.
# 앱 계약: POST /embed, body=image/jpeg(raw) → { embedding: [float, ...] }  (L2 정규화된 벡터)
# 실행: cd ~/gpu-server && ~/venv-vllm/bin/uvicorn embed_server:app --host 127.0.0.1 --port 8804
#   (venv-vllm 은 torch+transformers 를 이미 갖는다. Pillow 만 없으면 `pip install pillow`)
import io

import torch
from fastapi import FastAPI, Request
from PIL import Image
from transformers import AutoModel, AutoProcessor

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
