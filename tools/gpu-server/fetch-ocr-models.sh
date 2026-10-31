#!/usr/bin/env bash
# 슬라이드 전사 OCR 모델을 ~/gpu-server/ocr-models 에 받는다. embed_server 는 이 파일만 쓰고 실행 중 내려받지 않는다.
# 사용: bash ~/gpu-server/fetch-ocr-models.sh   (SEEON_OCR_MODEL_DIR 로 받을 폴더를 바꿀 수 있다)
set -euo pipefail

MODEL_DIR="${SEEON_OCR_MODEL_DIR:-$HOME/gpu-server/ocr-models}"
BASE_URL="https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/onnx"
mkdir -p "$MODEL_DIR"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

fetch_model() {
  local remote_path="$1" file_name="$2" expected_sha="$3"
  local target="$MODEL_DIR/$file_name"
  if [[ -f "$target" && "$(sha256_of "$target")" == "$expected_sha" ]]; then
    echo "[ocr-models] 있음 $file_name"
    return
  fi
  curl -fL --retry 3 -o "$target.part" "$BASE_URL/$remote_path"
  if [[ "$(sha256_of "$target.part")" != "$expected_sha" ]]; then
    rm -f "$target.part"
    echo "[ocr-models] SHA256 불일치: $file_name" >&2
    exit 1
  fi
  mv "$target.part" "$target"
  echo "[ocr-models] 받음 $file_name"
}

fetch_model "PP-OCRv6/det/PP-OCRv6_det_small.onnx" "PP-OCRv6_det_small.onnx" "090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f"
fetch_model "PP-OCRv5/rec/korean_PP-OCRv5_rec_mobile.onnx" "korean_PP-OCRv5_rec_mobile.onnx" "cd6e2ea50f6943ca7271eb8c56a877a5a90720b7047fe9c41a2e541a25773c9b"
fetch_model "PP-OCRv4/cls/ch_ppocr_mobile_v2.0_cls_mobile.onnx" "ch_ppocr_mobile_v2.0_cls_mobile.onnx" "e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c"
echo "[ocr-models] 완료: $MODEL_DIR"
