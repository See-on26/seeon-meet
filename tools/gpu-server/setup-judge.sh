#!/usr/bin/env bash
# GPU 서버에서 탐지 판정용 경량 LLM(8805, Qwen3.5-9B) 가중치를 받는다.
# 사용: bash ~/gpu-server/setup-judge.sh
#
# 모델: Qwen/Qwen3.5-9B (bf16 약 19GiB). VLM(8801)과 같은 Qwen3.5 계열이라 venv 는 VLM 의 /data/venv-vllm-35 를 같이 쓴다.
#       그래서 setup-vlm.sh 를 먼저 돌려 둔 서버여야 한다.
# A100(sm_80)은 네이티브 FP8 을 못 쓰므로 FP8 체크포인트를 받지 않는다(README "절대 쓰면 안 되는 것").
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"
export HF_HOME=/data/hf-cache

if [ ! -x /data/venv-vllm-35/bin/vllm ]; then
  echo "[setup-judge] /data/venv-vllm-35 가 없다 — setup-vlm.sh 를 먼저 돌릴 것" >&2
  exit 1
fi

# shellcheck disable=SC1091
source /data/venv-vllm-35/bin/activate
# 가중치는 HF_HOME(/data/hf-cache)에 받는다 — systemd 유닛이 같은 HF_HOME을 쓴다
hf download Qwen/Qwen3.5-9B

echo "[setup-judge] 완료. 다음 순서로 올린다 (README '판정 LLM(8805)' 참고):"
echo "  1) seeon-vlm.service 의 --gpu-memory-utilization 이 0.55 인지 확인 (0.85 면 9B 가 들어갈 자리가 없다)"
echo "  2) sudo cp ~/gpu-server/systemd/seeon-judge.service /etc/systemd/system/ && sudo systemctl daemon-reload"
echo "  3) sudo systemctl restart seeon-vlm && sudo systemctl enable --now seeon-judge"
echo "  4) 앱 전용 키의 authorized_keys 줄에 permitopen=\"127.0.0.1:8805\" 를 더한다"
