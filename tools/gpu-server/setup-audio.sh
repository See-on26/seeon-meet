#!/usr/bin/env bash
# GPU 서버에서 ASR(faster-whisper) + TTS(MeloTTS)용 venv-audio를 만든다.
# 사용: bash ~/gpu-server/setup-audio.sh
#
# Python은 3.10으로 고정한다 — 시스템 Python(Ubuntu 24.04는 3.12)으로는 설치가 안 된다.
#   MeloTTS → transformers==4.27.4 고정 → tokenizers<0.14 요구 → 0.13.x 휠이 cp311까지만 있다.
#   3.12에서는 tokenizers를 소스(Rust)로 빌드하려다 실패한다.
# 시스템 Python을 내리면 apt 등 OS 도구가 깨지므로, uv가 받은 3.10을 venv에만 쓴다.
#
# 사전: uv (curl -LsSf https://astral.sh/uv/install.sh | sh)
#       ffmpeg (sudo apt-get install -y ffmpeg) — /tts-long의 mp3 인코딩에 쓴다
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"
uv python install 3.10
# --seed: venv에 pip를 넣는다. MeloTTS가 git 설치를 pip로 받는 편이 검증된 경로다
uv venv --python 3.10 --seed ~/venv-audio
~/venv-audio/bin/pip install -U pip

# ASR (faster-whisper는 torch가 아니라 ctranslate2 사용) + 웹서버
~/venv-audio/bin/pip install faster-whisper fastapi uvicorn

# TTS (MeloTTS-Korean)
~/venv-audio/bin/pip install git+https://github.com/myshell-ai/MeloTTS.git
~/venv-audio/bin/python -m unidic download

# torch 3형제를 cu121로 맞춘다. 드라이버 580(CUDA 13.0)은 하위 CUDA 런타임과 호환되므로 그대로 돈다.
# ⚠️ --no-deps 쓰지 말 것 — CUDA 런타임 라이브러리(libcudart/libcublas)까지 함께 받아야 한다.
~/venv-audio/bin/pip install --force-reinstall \
  torch==2.5.1 torchvision==0.20.1 torchaudio==2.5.1 \
  --index-url https://download.pytorch.org/whl/cu121

# torch 설치로 딸려 올라간 numpy를 <2로, librosa(구버전)가 쓰는 pkg_resources용 setuptools<81로 고정
~/venv-audio/bin/pip install "numpy<2" "setuptools<81"

echo "[setup-audio] 완료. 버전 확인:"
# pip show numpy는 번들 라이브러리 라이선스 전문을 출력해 grep Version이 엉뚱한 줄을 잡는다 — 직접 묻는다
~/venv-audio/bin/python -c "import sys, torch, transformers, numpy, setuptools, faster_whisper; print('python', sys.version.split()[0]); print('torch', torch.__version__, '| GPU', torch.cuda.is_available()); print('transformers', transformers.__version__); print('numpy', numpy.__version__); print('setuptools', setuptools.__version__); print('faster-whisper', faster_whisper.__version__)"
command -v ffmpeg >/dev/null || echo "[setup-audio] ⚠️ ffmpeg가 없다 — /tts-long이 503을 낸다 (sudo apt-get install -y ffmpeg)"
