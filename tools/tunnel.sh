#!/usr/bin/env bash
# GPU 서버의 VLM/ASR/TTS/EMBED 포트를 로컬로 포워딩한다.
# 사용: GPU_SSH_HOST=... GPU_SSH_USER=... ./tools/tunnel.sh
#   비밀번호 로그인은 sshpass 설치 시 GPU_SSH_PASSWORD 환경변수 사용, 없으면 프롬프트에 직접 입력.
set -euo pipefail

GPU_SSH_HOST="${GPU_SSH_HOST:?GPU_SSH_HOST를 지정하세요 (예: gpu.example.com)}"
GPU_SSH_USER="${GPU_SSH_USER:?GPU_SSH_USER를 지정하세요 (예: ubuntu)}"
VLM_PORT="${SEEON_VLM_PORT:-8801}"
ASR_PORT="${SEEON_ASR_PORT:-8802}"
TTS_PORT="${SEEON_TTS_PORT:-8803}"
EMBED_PORT="${SEEON_EMBED_PORT:-8804}"

FORWARD_ARGS=(-N
  -L "${VLM_PORT}:127.0.0.1:${VLM_PORT}"
  -L "${ASR_PORT}:127.0.0.1:${ASR_PORT}"
  -L "${TTS_PORT}:127.0.0.1:${TTS_PORT}"
  -L "${EMBED_PORT}:127.0.0.1:${EMBED_PORT}"
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes)

echo "[tunnel] ${GPU_SSH_USER}@${GPU_SSH_HOST} → localhost:${VLM_PORT}/${ASR_PORT}/${TTS_PORT}/${EMBED_PORT}"
if command -v sshpass >/dev/null 2>&1 && [ -n "${GPU_SSH_PASSWORD:-}" ]; then
  exec sshpass -e ssh "${FORWARD_ARGS[@]}" "${GPU_SSH_USER}@${GPU_SSH_HOST}"
else
  exec ssh "${FORWARD_ARGS[@]}" "${GPU_SSH_USER}@${GPU_SSH_HOST}"
fi
# autossh가 설치돼 있으면 위 ssh 대신 `autossh -M 0 "${FORWARD_ARGS[@]}" "${GPU_SSH_USER}@${GPU_SSH_HOST}"`로 감싸면 연결이 끊겨도 자동 재접속한다.
