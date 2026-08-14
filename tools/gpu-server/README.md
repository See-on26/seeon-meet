# GPU 서버 세팅 (VLM · ASR · TTS)

캡션 파이프라인의 로컬 모델 3종을 GPU 서버에 올리는 스크립트와 절차.
로컬(맥)에서 앱을 실행하는 방법은 [../../docs/design/real-server-runbook.md](../../docs/design/real-server-runbook.md) 참조.

세 서버 모두 `127.0.0.1`에 바인딩하고, 로컬 앱은 SSH 터널로 접속한다(외부에 포트 노출 안 함).
앱 요청/응답 계약은 [../../docs/design/real-server-runbook.md](../../docs/design/real-server-runbook.md) 참조.

> ⚠️ **이 문서의 설치 절차(`setup-vllm.sh`)는 구 모델 조합 기준이다 (2026-08-07 확인).**
> 아래 "기동"의 모델명은 **현재 서버가 실제로 서빙하는 값**으로 갱신했으나
> (근거: `curl /v1/models` 실측 → findings.md 2026-08-03, 그리고 `.env.example`),
> `setup-vllm.sh`가 고정하는 **vLLM 0.7.3 + CUDA 12.2 조합에서는 Qwen3.5-35B-A3B가 동작하지 않는다.**
> 즉 지금 서버는 드라이버·vLLM이 올라간 상태인데 **그 버전이 레포에 기록되지 않았다.**
> 새 서버를 세팅해야 한다면 먼저 현재 서버에서 아래를 떠서 이 문서를 채워야 한다:
> ```bash
> nvidia-smi | head -3                                   # 드라이버 · CUDA
> ~/venv-vllm/bin/pip show vllm torch transformers | grep -E 'Name|Version'
> ```

## 이 디렉토리

| 파일 | 용도 |
|---|---|
| `setup-vllm.sh` | VLM용 venv-vllm 생성 (vLLM 0.7.3 + cu121 torch) — **구 조합, 위 경고 참조** |
| `setup-audio.sh` | ASR·TTS용 venv-audio 생성 (faster-whisper + MeloTTS + cu121 torch) |
| `asr_server.py` | ASR FastAPI (`POST /asr` webm→전사) |
| `tts_server.py` | TTS FastAPI (`POST /tts` 텍스트→wav) |
| `embed_server.py` | 임베딩 FastAPI (`POST /embed` jpeg→벡터, Stage 1 슬라이드 전환 확정용) |

## 전제 (검증 환경)

- A100 80GB, Ubuntu, Python 3.10, `python3.10-venv` 설치됨
  (`sudo apt-get install -y python3.10-venv ffmpeg tmux`)
- **2026-07-09 시점**: NVIDIA 드라이버 535 / CUDA 12.2 고정(외부 제공 서버라 못 올림) →
  그 제약 때문에 `Qwen2.5-VL-32B-AWQ + vLLM 0.7.3(cu121)` 조합을 썼고, `setup-vllm.sh`가 그 조합이다
- **현재(2026-08-03 이후)**: 제약이 풀려 `Qwen/Qwen3.5-35B-A3B-GPTQ-Int4`를 서빙 중이다.
  **드라이버·vLLM 버전은 미기록** — 위 경고 블록 참조
- 모델 세대 변경 경위: [../../docs/design/model-selection.md](../../docs/design/model-selection.md) §3

## 업로드 (맥 → 서버)

```bash
ssh <user>@<host> 'mkdir -p ~/gpu-server'
scp tools/gpu-server/* <user>@<host>:~/gpu-server/
```

## 설치 (서버에서 1회)

```bash
bash ~/gpu-server/setup-vllm.sh    # venv-vllm
bash ~/gpu-server/setup-audio.sh   # venv-audio
```

## 기동 (tmux 권장 — 세션 끊겨도 유지)

```bash
# VLM (8801) — 첫 기동 시 INT4 가중치 다운로드로 수 분
tmux new -d -s vlm '~/venv-vllm/bin/vllm serve Qwen/Qwen3.5-35B-A3B-GPTQ-Int4 \
  --served-model-name qwen3.5-35b-a3b --host 127.0.0.1 --port 8801 \
  --gpu-memory-utilization 0.6 --max-model-len 32768'

# ASR (8802) / TTS (8803)
tmux new -d -s asr 'cd ~/gpu-server && ~/venv-audio/bin/uvicorn asr_server:app --host 127.0.0.1 --port 8802'
tmux new -d -s tts 'cd ~/gpu-server && ~/venv-audio/bin/uvicorn tts_server:app --host 127.0.0.1 --port 8803'

# EMBED (8804) — 슬라이드 전환 확정용 이미지 임베딩(venv-vllm 재사용: torch+transformers 보유)
tmux new -d -s embed 'cd ~/gpu-server && ~/venv-vllm/bin/uvicorn embed_server:app --host 127.0.0.1 --port 8804'

tmux ls   # vlm/asr/tts/embed 4개 확인
```
- 앱은 `SEEON_EMBED_URL`(기본 `http://127.0.0.1:8804/embed`)로 접속한다. SSH 터널에 8804도 포함할 것.
- 임베딩 모델은 첫 요청 시 다운로드된다(SigLIP base ~수백 MB). Pillow 없으면 `~/venv-vllm/bin/pip install pillow`.
- **`--served-model-name qwen3.5-35b-a3b`는 앱의 `SEEON_VLM_MODEL`과 정확히 일치해야 한다.**
  어긋나면 vLLM이 404를 내고 캡션 에이전트 6개가 전부 실패한다(증상은 "캡션이 안 나온다"뿐).
- `--gpu-memory-utilization 0.6`은 세 서비스 VRAM 공존용 상한(단독이면 생략 가능).
- 각 서버는 첫 요청 시 모델을 내려받으니 최초 응답이 느릴 수 있다.

## 셀프 검증 (서버에서)

```bash
curl -s localhost:8801/v1/models | head -c 120; echo
curl -s localhost:8803/tts -H 'content-type: application/json' -d '{"text":"테스트"}' -o /tmp/t.wav && file /tmp/t.wav
curl -s "localhost:8802/asr?startTs=0" -H 'content-type: audio/webm' --data-binary @/tmp/t.wav
curl -s localhost:8804/embed -H 'content-type: image/jpeg' --data-binary @some.jpg | head -c 60; echo
```
- VLM → `qwen3.5-35b-a3b` JSON, TTS → `RIFF ... WAVE`, ASR → `{"text":...,"segmentList":[...]}`,
  EMBED → `{"embedding":[...]}`이면 정상.

## TTS 말소리 속도 조절

`tts_server.py`의 `speed=1.3`을 원하는 값(1.2~1.5)으로 바꾸고 tts만 재기동:
```bash
sed -i 's/speed=[0-9.]*/speed=1.4/' ~/gpu-server/tts_server.py
tmux kill-session -t tts
tmux new -d -s tts 'cd ~/gpu-server && ~/venv-audio/bin/uvicorn tts_server:app --host 127.0.0.1 --port 8803'
```

## 트러블슈팅 (실제로 겪은 것들)

| 증상 | 원인 · 해결 |
|---|---|
| `ensurepip is not available` | `sudo apt-get install -y python3.10-venv` |
| `driver too old (found version 12020)` | torch가 CUDA 12.2보다 높은 빌드 → cu121로 강제(setup 스크립트가 처리) |
| `libcudart.so.12 / libcublas... not found` | torch를 `--no-deps`로 깔아 CUDA 런타임 라이브러리 누락 → `--no-deps` 없이 재설치 |
| `Qwen2Tokenizer has no attribute all_special_tokens_extended` | transformers가 vLLM 0.7.3엔 너무 최신 → `transformers==4.49.0` |
| `No module named 'pkg_resources'` | 새 venv에 setuptools 없음/너무 최신 → `pip install "setuptools<81"` |
| `TorchAudio ... different CUDA versions` | torchaudio만 cu124 → 3형제 모두 cu121로 통일 |
| ASR `libcudnn... not found` | (이 환경은 미발생) 필요 시 `pip install "nvidia-cudnn-cu12==9.*"` |
| `compressed-tensors ... does not match awq_marlin` | AWQ 저장소가 compressed-tensors 포맷 → `--quantization` 플래그 빼고 자동감지 |

## 현재 상태

- 호스트: `tta@123.37.8.59` (rookie-s60), A100 80GB
- `~/venv-vllm`, `~/venv-audio`, `~/gpu-server/` 구성 완료
- VLM 8801 / ASR 8802 / TTS 8803 / EMBED 8804 네 서버 기동·검증 완료
- **VLM 서빙 모델**: `Qwen/Qwen3.5-35B-A3B-GPTQ-Int4` (`qwen3.5-35b-a3b`, `max_model_len` 32768)
  — 2026-08-03 `/v1/models` 실측
- 재부팅·tmux 종료 시 위 "기동" 명령으로 재시작 필요
- **미기록**: 현재 드라이버·vLLM·transformers 버전 (문서 상단 경고 블록 참조)
