#!/usr/bin/env bash
# GPU 서버에서 탐지 판정 LLM(8805) 가중치를 준비한다.
# 사용: bash ~/gpu-server/setup-judge.sh
#
# 판정 LLM 은 VLM(8801)과 같은 모델(Gemma 4 26B-A4B-it QAT 4비트)을 따로 띄운 것이라 가중치도 같다.
# 그래서 setup-vlm.sh 가 받은 가중치를 그대로 쓰고, 없을 때만 같은 리비전으로 받는다. venv 도 VLM 의 /data/venv-vllm-35 를 같이 쓴다.
# A100(sm_80)은 네이티브 FP8 을 못 쓰므로 FP8 체크포인트를 받지 않는다(README "절대 쓰면 안 되는 것").
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"
export HF_HOME=/data/hf-cache

MODEL_REPO=cyankiwi/gemma-4-26B-A4B-it-qat-AWQ-INT4
MODEL_REVISION=18a3c7285c33ee39d3e5e16ee6fb2c18f4955ef9
SNAPSHOT_DIR="$HF_HOME/hub/models--${MODEL_REPO/\//--}/snapshots/$MODEL_REVISION"
# 스냅샷 폴더로 cd 한 뒤에 대조하므로, 상대 경로로 불러도(cd ~/gpu-server && bash setup-judge.sh) 찾게 절대 경로로 정한다.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHA256_FILE="$SCRIPT_DIR/gemma4-26b-a4b-qat-18a3c72.sha256"

if [ ! -x /data/venv-vllm-35/bin/vllm ]; then
  echo "[setup-judge] /data/venv-vllm-35 가 없다 — setup-vlm.sh 를 먼저 돌릴 것" >&2
  exit 1
fi

# shellcheck disable=SC1091
source /data/venv-vllm-35/bin/activate
if [ ! -f "$SNAPSHOT_DIR/model.safetensors" ]; then
  hf download "$MODEL_REPO" --revision "$MODEL_REVISION"
fi
# 받은 파일이 기록해 둔 해시와 같은지 본다(파일 이름은 링크라 sha256sum 이 실제 내용을 읽는다).
(cd "$SNAPSHOT_DIR" && sha256sum -c "$SHA256_FILE")

echo "[setup-judge] 완료. 다음 순서로 올린다 (README '판정 LLM(8805)' 참고):"
echo "  1) seeon-vlm.service 의 --gpu-memory-utilization 이 0.55 인지 확인 (0.85 면 판정 LLM 이 들어갈 자리가 없다)"
echo "  2) sudo cp ~/gpu-server/systemd/seeon-judge.service /etc/systemd/system/ && sudo systemctl daemon-reload"
echo "  3) sudo systemctl restart seeon-vlm && sudo systemctl enable --now seeon-judge"
echo "  4) 앱 전용 키의 authorized_keys 줄에 permitopen=\"127.0.0.1:8805\" 가 있는지 확인한다"
