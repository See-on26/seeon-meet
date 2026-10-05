#!/usr/bin/env bash
# 실험 창 확인용 영상을 만든다. 실회의 슬라이드 이미지 5장 + macOS say(유나) 음성, 약 1분.
# 같은 이름의 .script.json 에 구간별 원본 시각(말 시작·끝, 무발화 끝)을 남겨 전사 시각을 맞춰 볼 수 있게 한다.
#   tools/lab/make-sample-video.sh <슬라이드 세션 폴더> [출력 mp4]
# 슬라이드 세션 폴더 = slide-1 … slide-5 아래 base.jpg 가 있는 폴더(앱이 out/slides/session-<id>/ 에 같은 구조로 남긴다).
# 슬라이드 세션 폴더는 꼭 준다. 없으면 사용법을 찍고 종료 코드 2 로 멈춘다.
set -euo pipefail

print_usage() {
  echo "사용법: tools/lab/make-sample-video.sh <슬라이드 세션 폴더> [출력 mp4]" >&2
  echo "  슬라이드 세션 폴더 = slide-1 … slide-5 아래 base.jpg 가 있는 폴더(앱이 out/slides/session-<id>/ 에 같은 구조로 남긴다)" >&2
}

if [ $# -lt 1 ] || [ -z "$1" ]; then
  echo "[sample] 슬라이드 세션 폴더를 주지 않았다" >&2
  print_usage
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SLIDE_ROOT="$1"
OUT_FILE="${2:-$ROOT_DIR/out/lab-samples/sample-5slides.mp4}"
FFMPEG="${FFMPEG:-$(command -v ffmpeg || echo /opt/homebrew/bin/ffmpeg)}"
FFPROBE="${FFPROBE:-$(command -v ffprobe || echo /opt/homebrew/bin/ffprobe)}"
VOICE="${SEEON_SAMPLE_VOICE:-Yuna}"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
mkdir -p "$(dirname "$OUT_FILE")"

# 슬라이드|말|말 뒤 무발화 초. 같은 슬라이드를 이어 쓰면 화면은 그대로이고 말·무발화만 이어진다.
SEGMENT_LIST=(
  "slide-1|자, 오늘은 보상 제도를 소개하겠습니다. 구성원이라면 누구나 공정한 보상을 받습니다. 오른쪽에 카드가 두 장 있는데요, 이 부분이 오늘의 핵심입니다.|2"
  "slide-2|다음은 보상 구조의 변화입니다. 빨간 막대들을 보시면 제도가 하나씩 늘어났습니다. 이것이 저희가 지금까지 만든 구조입니다.|2"
  "slide-3|둘째, 반기 연봉 조정입니다. 이 그래프를 보시면 하반기에 250이 올랐습니다. 결국 일 년 총액이 더 높다는 겁니다.|2"
  "slide-5|여러분, 이 사진들을 한번 보시죠.|8"
  "slide-5|네, 다들 즐거워 보이죠?|2"
  "slide-4|마지막으로 평가 구조입니다. 저희는 절대 평가를 합니다. 이상으로 발표를 마치겠습니다. 감사합니다.|6"
)

# 슬라이드 이미지가 하나라도 없으면 ffmpeg 오류 대신 무엇을 넘겨야 하는지 알리고 멈춘다.
missing_count=0
previous_slide=""
for segment in "${SEGMENT_LIST[@]}"; do
  slide="${segment%%|*}"
  [ "$slide" = "$previous_slide" ] && continue
  previous_slide="$slide"
  if [ ! -f "$SLIDE_ROOT/$slide/base.jpg" ]; then
    echo "[sample] 슬라이드 이미지가 없다: $SLIDE_ROOT/$slide/base.jpg" >&2
    missing_count=$((missing_count + 1))
  fi
done
if [ "$missing_count" -gt 0 ]; then
  print_usage
  exit 2
fi

probe_ms() {
  "$FFPROBE" -v error -show_entries format=duration -of csv=p=0 "$1" | awk '{ printf "%d", $1 * 1000 }'
}

: > "$WORK_DIR/concat.txt"
cursor_ms=0
script_json="["
for index in "${!SEGMENT_LIST[@]}"; do
  IFS='|' read -r slide text silence_sec <<< "${SEGMENT_LIST[$index]}"
  speech_file="$WORK_DIR/speech-$index.aiff"
  say -v "$VOICE" -o "$speech_file" "$text"
  speech_ms="$(probe_ms "$speech_file")"
  "$FFMPEG" -v error -y -i "$speech_file" -f lavfi -t "$silence_sec" -i anullsrc=r=48000:cl=stereo \
    -filter_complex "[0:a]aresample=48000,aformat=channel_layouts=stereo[speech];[speech][1:a]concat=n=2:v=0:a=1[audio]" \
    -map "[audio]" "$WORK_DIR/audio-$index.wav"
  "$FFMPEG" -v error -y -loop 1 -framerate 30 -i "$SLIDE_ROOT/$slide/base.jpg" -i "$WORK_DIR/audio-$index.wav" \
    -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p" \
    -c:v libx264 -tune stillimage -preset veryfast -c:a aac -b:a 160k -ar 48000 -shortest "$WORK_DIR/clip-$index.mp4"
  clip_ms="$(probe_ms "$WORK_DIR/clip-$index.mp4")"
  echo "file '$WORK_DIR/clip-$index.mp4'" >> "$WORK_DIR/concat.txt"
  [ "$index" -gt 0 ] && script_json+=","
  script_json+="{\"slide\":\"$slide\",\"speechStartMs\":$cursor_ms,\"speechEndMs\":$((cursor_ms + speech_ms)),\"segmentEndMs\":$((cursor_ms + clip_ms)),\"text\":\"$text\"}"
  cursor_ms=$((cursor_ms + clip_ms))
done
script_json+="]"

"$FFMPEG" -v error -y -f concat -safe 0 -i "$WORK_DIR/concat.txt" -c copy "$OUT_FILE"
echo "$script_json" > "${OUT_FILE%.mp4}.script.json"
echo "[sample] $OUT_FILE ($(probe_ms "$OUT_FILE")ms) · 구간 시각 ${OUT_FILE%.mp4}.script.json"
