#!/usr/bin/env bash
# GPU 서버에서 EMBED(8804, SigLIP 이미지 임베딩)용 venv-embed를 만든다.
# 사용: bash ~/gpu-server/setup-embed.sh
#
# embed_server.py가 쓰는 것만 넣는다: torch · transformers · Pillow · FastAPI, /ocr 용 onnxruntime · opencv-python-headless · rapidocr.
# (예전엔 구 VLM용 venv-vllm에 vLLM 0.7.3까지 깔고 EMBED가 얹혀 썼다 — EMBED에 vLLM은 필요 없다)
# 버전은 그 venv에서 SigLIP이 실제로 돌던 조합(torch 2.5.1+cu121 · transformers 4.49.0)을 따른다.
#
# 사전: uv (curl -LsSf https://astral.sh/uv/install.sh | sh)
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"
uv python install 3.10
uv venv --python 3.10 --seed ~/venv-embed
~/venv-embed/bin/pip install -U pip

# torch를 cu121로. 드라이버 580(CUDA 13.0)은 하위 CUDA 런타임과 호환되므로 그대로 돈다.
~/venv-embed/bin/pip install torch==2.5.1 --index-url https://download.pytorch.org/whl/cu121

# SigLIP 프로세서는 토크나이저까지 불러오므로 sentencepiece가 필요하다
~/venv-embed/bin/pip install "transformers==4.49.0" "numpy<2" pillow sentencepiece protobuf fastapi uvicorn

# 슬라이드 전사 OCR(/ocr, ocr_engine.py). venv-embed(Python 3.10, numpy<2)에 맞는 버전으로 고정한다:
# onnxruntime 1.23+ 는 Python 3.11 이상, opencv 4.11+·5.x 는 numpy 2 이상을 요구한다.
# rapidocr 는 GUI 판 opencv-python 을 요구하지만 서버에는 headless 를 쓰므로 rapidocr 만 --no-deps 로 넣는다.
~/venv-embed/bin/pip install "numpy<2" "onnxruntime==1.22.1" "opencv-python-headless==4.10.0.84" \
  "pyclipper==1.4.0" "shapely==2.1.2" "omegaconf==2.3.1" "colorlog==6.12.0" "six==1.17.0" "tqdm==4.70.1"
~/venv-embed/bin/pip install --no-deps "rapidocr==3.9.2"
bash ~/gpu-server/fetch-ocr-models.sh

echo "[setup-embed] 완료. 버전 확인:"
# pip show numpy는 번들 라이브러리 라이선스 전문을 출력해 grep Version이 엉뚱한 줄을 잡는다 — 직접 묻는다
~/venv-embed/bin/python -c "import sys, torch, transformers, numpy; print('python', sys.version.split()[0]); print('torch', torch.__version__, '| GPU', torch.cuda.is_available()); print('transformers', transformers.__version__); print('numpy', numpy.__version__); import onnxruntime, cv2; print('onnxruntime', onnxruntime.__version__, '| opencv', cv2.__version__)"
echo "[setup-embed] SigLIP 가중치(~800MB)는 첫 기동 때 ~/.cache/huggingface로 내려받는다."
