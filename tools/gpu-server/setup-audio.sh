#!/usr/bin/env bash
# GPU 서버에서 ASR(faster-whisper) + TTS(MeloTTS)용 venv-audio를 만든다.
# 드라이버가 CUDA 12.2에 고정된 환경(외부 제공 서버)에서 검증된 순서다.
# 사용: bash ~/gpu-server/setup-audio.sh
#
# 사전: python3-venv 필요 (없으면: sudo apt-get install -y python3.10-venv)
set -euo pipefail

python3 -m venv ~/venv-audio
~/venv-audio/bin/pip install -U pip

# ASR (faster-whisper는 torch가 아니라 ctranslate2 사용) + 웹서버
~/venv-audio/bin/pip install faster-whisper fastapi uvicorn

# TTS (MeloTTS-Korean)
~/venv-audio/bin/pip install git+https://github.com/myshell-ai/MeloTTS.git
~/venv-audio/bin/python -m unidic download

# 드라이버(CUDA 12.2) 대응: torch 3형제를 cu121로 교체.
# ⚠️ --no-deps 쓰지 말 것 — CUDA 런타임 라이브러리(libcudart/libcublas)까지 함께 받아야 한다.
~/venv-audio/bin/pip install --force-reinstall \
  torch==2.5.1 torchvision==0.20.1 torchaudio==2.5.1 \
  --index-url https://download.pytorch.org/whl/cu121

# torch 설치로 딸려 올라간 numpy를 <2로, librosa(구버전)가 쓰는 pkg_resources용 setuptools<81로 고정
~/venv-audio/bin/pip install "numpy<2" "setuptools<81"

echo "[setup-audio] 완료. 버전 확인:"
~/venv-audio/bin/pip show torch numpy setuptools faster-whisper | grep -E 'Name|Version'
echo "[setup-audio] 기동은 README.md의 'ASR·TTS 기동' 참조."
