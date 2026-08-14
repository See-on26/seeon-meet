#!/usr/bin/env bash
# GPU 서버에서 VLM용 venv-vllm을 만든다.
#
# ⚠️ 구 조합이다 (2026-08-07 확인). 이 스크립트는
#    vLLM 0.7.3 + cu121 torch + Qwen2.5-VL-32B-Instruct-AWQ 조합을 고정하며,
#    드라이버가 CUDA 12.2에 고정됐던 2026-07-09 환경에서 검증된 순서다.
#    현재 서버는 Qwen/Qwen3.5-35B-A3B-GPTQ-Int4를 서빙하고 있고(README "현재 상태"),
#    그 모델은 vLLM 0.7.3에서 동작하지 않는다.
#    → 현재 환경의 드라이버·vLLM 버전은 레포에 기록이 없다. 새로 세팅하기 전에
#      서버에서 실제 버전을 떠서 README와 이 스크립트를 함께 갱신할 것.
#         nvidia-smi | head -3
#         ~/venv-vllm/bin/pip show vllm torch transformers | grep -E 'Name|Version'
#    아래 핀은 그때까지 "과거에 동작했던 조합"의 기록으로만 유효하다.
#
# 모델 세대 변경 경위: docs/design/model-selection.md §3
# 사용: bash ~/gpu-server/setup-vllm.sh
#
# 사전: python3-venv 필요 (없으면: sudo apt-get install -y python3.10-venv)
set -euo pipefail

python3 -m venv ~/venv-vllm
~/venv-vllm/bin/pip install -U pip

# Qwen2.5-VL을 지원하는 vLLM (최신 vLLM은 torch가 CUDA 12.8을 요구해 이 드라이버에선 못 씀)
~/venv-vllm/bin/pip install "vllm==0.7.3"

# 드라이버(CUDA 12.2) 대응: torch 3형제를 cu121로 (deps 포함 — CUDA 런타임 라이브러리 함께)
~/venv-vllm/bin/pip install --force-reinstall \
  torch==2.5.1 torchvision==0.20.1 torchaudio==2.5.1 \
  --index-url https://download.pytorch.org/whl/cu121

# vLLM 0.7.3은 numpy<2 요구, 토크나이저 호환 위해 transformers는 4.49.0으로 고정
~/venv-vllm/bin/pip install "numpy<2" "transformers==4.49.0"

echo "[setup-vllm] 완료. 버전 확인:"
~/venv-vllm/bin/pip show vllm torch numpy transformers | grep -E 'Name|Version'
echo "[setup-vllm] 기동은 README.md의 'VLM 기동' 참조."
