#!/usr/bin/env bash
# GPU 서버에서 VLM(8801)용 신 스택 venv를 /data/venv-vllm-35에 만들고 모델을 받는다.
# 사용: bash ~/gpu-server/setup-vlm.sh
#
# 모델: cyankiwi/gemma-4-26B-A4B-it-qat-AWQ-INT4 (Gemma 4 26B-A4B-it, 구글 QAT 가중치를 compressed-tensors W4A16 으로 바꾼 판, 17.2GB).
#       8801(VLM)과 8805(판정 LLM)가 같은 가중치를 쓴다. 판(리비전)을 고정해 받고, 기록해 둔 해시와 대조한다.
#       서버의 vLLM 은 CUDA 13 휠이라 드라이버 580(CUDA 13.0) 이상이 전제다.
# vLLM은 nightly 휠을 받는다 — nightly는 오래된 빌드가 지워지므로 특정 버전을 핀할 수 없다.
#       설치 뒤 출력되는 버전을 README "현재 상태"에 기록할 것.
#
# Python은 uv가 받은 3.12로 고정한다(--python-preference only-managed).
#   시스템 Python 3.12에는 헤더(Python.h)가 없어, vLLM이 기동 중에 Triton 커널을 컴파일할 때 실패한다.
#
# 사전: uv (curl -LsSf https://astral.sh/uv/install.sh | sh), gcc
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"
export UV_CACHE_DIR=/data/uv-cache
export HF_HOME=/data/hf-cache

sudo mkdir -p /data/hf-cache /data/uv-cache /data/venv-vllm-35
sudo chown "$USER:$USER" /data/hf-cache /data/uv-cache /data/venv-vllm-35

uv python install 3.12
uv venv --python 3.12 --python-preference only-managed /data/venv-vllm-35
# shellcheck disable=SC1091
source /data/venv-vllm-35/bin/activate
uv pip install vllm --torch-backend=auto --extra-index-url https://wheels.vllm.ai/nightly

# 가중치는 HF_HOME(/data/hf-cache)에 받는다 — systemd 유닛이 같은 HF_HOME·리비전을 쓴다(HF_HUB_OFFLINE=1 이라 기동 때는 받지 않는다)
MODEL_REPO=cyankiwi/gemma-4-26B-A4B-it-qat-AWQ-INT4
MODEL_REVISION=18a3c7285c33ee39d3e5e16ee6fb2c18f4955ef9
# 스냅샷 폴더로 cd 한 뒤에 대조하므로, 상대 경로로 불러도(cd ~/gpu-server && bash setup-vlm.sh) 찾게 절대 경로로 정한다.
SHA256_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/gemma4-26b-a4b-qat-18a3c72.sha256"
hf download "$MODEL_REPO" --revision "$MODEL_REVISION"
# 받은 파일이 기록해 둔 해시와 같은지 본다(파일 이름은 링크라 sha256sum 이 실제 내용을 읽는다).
(cd "$HF_HOME/hub/models--${MODEL_REPO/\//--}/snapshots/$MODEL_REVISION" && sha256sum -c "$SHA256_FILE")

echo "[setup-vlm] 완료. 버전 확인 (README 현재 상태에 기록할 것):"
python --version
python -c "import vllm, torch, transformers; print('vllm', vllm.__version__); print('torch', torch.__version__); print('transformers', transformers.__version__)"
echo "[setup-vlm] systemd 유닛의 CUDA_HOME 경로가 실제로 있는지 확인:"
ls -d /data/venv-vllm-35/lib/python3.12/site-packages/nvidia/cu1* 2>/dev/null || echo "⚠️ nvidia/cu1x 디렉토리가 없다 — seeon-vlm.service의 CUDA_HOME을 실제 경로로 고칠 것"
