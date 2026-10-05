#!/usr/bin/env bash
# 3.1 평가 도구의 회의록 말주머니 매처가 쓰는 Kiwi 형태소 분석 모델(v0.24.0 base, 약 88MB)을 받는다.
# 모델은 저장소에 넣지 않고 out/cache/kiwi-model(또는 SEEON_KIWI_MODEL_DIR)에 푼다.
#   tools/eval/setup-kiwi.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
KIWI_VERSION="0.24.0"
MODEL_DIR="${SEEON_KIWI_MODEL_DIR:-$ROOT_DIR/out/cache/kiwi-model}"
MODEL_URL="https://github.com/bab2min/Kiwi/releases/download/v${KIWI_VERSION}/kiwi_model_v${KIWI_VERSION}_base.tgz"

if [ -f "$MODEL_DIR/models/cong/base/sj.morph" ] && [ -f "$MODEL_DIR/models/cong/base/cong.mdl" ]; then
  echo "[kiwi] 모델이 이미 있다: $MODEL_DIR/models/cong/base"
  exit 0
fi

mkdir -p "$MODEL_DIR"
echo "[kiwi] 모델 받는 중: $MODEL_URL"
curl -fL --retry 2 -o "$MODEL_DIR/model.tgz" "$MODEL_URL"
tar -xzf "$MODEL_DIR/model.tgz" -C "$MODEL_DIR"
rm -f "$MODEL_DIR/model.tgz"
echo "[kiwi] 모델 준비 완료: $MODEL_DIR/models/cong/base"
