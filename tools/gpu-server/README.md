# GPU 서버 세팅 (VLM · ASR · TTS · EMBED · JUDGE)

캡션 파이프라인의 로컬 모델 5종을 GPU 서버에 올리는 스크립트와 절차.

다섯 서버 모두 `127.0.0.1`에 바인딩하고, 로컬 앱은 SSH 터널로 접속한다(외부에 포트 노출 안 함).
이제 앱이 켜질 때 직접 터널을 연다 — `.env`에 서버 주소·포트·계정·호스트 키 지문(`SEEON_GPU_SSH_HOST`·`SEEON_GPU_SSH_PORT`·`SEEON_GPU_SSH_USER`·`SEEON_GPU_SSH_HOST_FINGERPRINT`)과 `SEEON_GPU_SSH_KEY=<앱 전용 키 경로>`를 두면 된다.
서버 주소·계정·포트·키는 **저장소에 적지 않는다** — 실제 값은 `.env` 에만 둔다
(서버는 이 키에 `127.0.0.1:8801~8805` 포트 전달만 허용한다 — 판정 LLM(8805)을 새로 올릴 때 `permitopen`도 더할 것, 아래 "판정 LLM(8805)" 참고). 상태는 설정 패널의 `GPU 서버` 줄에 보인다.
앱 키 없이 쓸 때는 앱을 띄우기 전에 맥에서 터널을 열어 두면, 앱의 기본 엔드포인트(`localhost:8801~8805`)가 그대로 서버로 이어진다
(이 터널이 떠 있으면 앱은 이미 쓰이는 포트를 건너뛰고 이 터널을 쓴다):

```bash
chmod 400 <관리자 키 경로>    # 처음 한 번 — 권한이 넓으면 ssh가 키를 거부한다
GPU_SSH_HOST=<서버 주소> GPU_SSH_USER=<계정> GPU_SSH_PORT=<SSH 포트> GPU_SSH_KEY=<관리자 키 경로> ./tools/tunnel.sh
```

`→ localhost:8801/8802/8803/8804/8805`가 뜨고 조용히 멈춰 있으면 연결된 것이다(끊지 말 것).
확인: 다른 터미널에서 `curl -s localhost:8801/v1/models` → `gemma-4-26b-a4b-qat`가 보이면 정상.

> **venv가 셋이고 Python이 둘이다.** 시스템 Python은 어느 venv에도 쓰지 않는다.
>
> | venv | 서버 | Python | 핵심 버전 | 셋업 |
> |---|---|---|---|---|
> | `/data/venv-vllm-35` | VLM (8801) · JUDGE (8805) — 같은 모델을 따로 띄움 | uv 3.12 | vLLM nightly · torch cu132 | `setup-vlm.sh` (+ `setup-judge.sh`는 가중치 확인만) |
> | `~/venv-audio` | ASR·TTS (8802·8803) | uv 3.10 | torch 2.5.1+cu121 · transformers 4.27.4 | `setup-audio.sh` |
> | `~/venv-embed` | EMBED (8804) | uv 3.10 | torch 2.5.1+cu121 · transformers 4.49.0 | `setup-embed.sh` |
>
> - **ASR·TTS·EMBED가 3.10인 이유**: MeloTTS가 transformers 4.27.4를 고정하고, 그게 요구하는
>   tokenizers<0.14의 휠이 cp311까지만 있다. 시스템 Python 3.12로는 설치가 안 된다(소스 빌드 실패).
> - **VLM이 uv 3.12인 이유**: 시스템 Python에는 헤더(`Python.h`)가 없어, vLLM이 기동 중
>   Triton 커널을 컴파일할 때 실패한다. uv가 받은 Python은 헤더를 포함한다.
> - cu121 torch가 드라이버 580(CUDA 13.0)에서 도는 것은 드라이버의 하위 CUDA 런타임 호환 덕이다.

## 이 디렉토리

| 파일 | 용도 |
|---|---|
| `setup-vlm.sh` | VLM용 `/data/venv-vllm-35` 생성 + 모델 다운로드(리비전 고정·해시 대조, vLLM nightly, 17.2GB) |
| `setup-audio.sh` | ASR·TTS용 `~/venv-audio` 생성 (faster-whisper + MeloTTS + cu121 torch) |
| `setup-embed.sh` | EMBED용 `~/venv-embed` 생성 (torch + transformers + Pillow, `/ocr`용 onnxruntime + opencv-python-headless + rapidocr) |
| `setup-judge.sh` | 판정 LLM(8805) 가중치 확인 — VLM 과 같은 리비전을 받고(이미 받았으면 금방 끝난다) 해시를 대조한다(venv도 VLM 것을 같이 씀) |
| `gemma4-26b-a4b-qat-18a3c72.sha256` | 고정 리비전 가중치 파일 8개의 sha256. 두 셋업 스크립트가 받은 뒤 `sha256sum -c` 로 대조한다 |
| `asr_server.py` | ASR FastAPI (`POST /asr` webm→전사). 쿼리 `language=ko\|en\|auto`(없으면 `ko`, 그 밖은 400) — `auto`는 ko·en 중 감지 확률이 높은 쪽으로 전사하고 응답에 `language`·`languageProbability`를 더한다 |
| `asr_language.py` | ASR 언어 판정(쿼리 검증·ko/en 고르기). `asr_server.py`가 import한다 — 시험: `python3 -m unittest test_asr_language` |
| `tts_server.py` | TTS FastAPI (`POST /tts` 텍스트→wav · `POST /tts-long` 긴 텍스트→mp3) |
| `embed_server.py` | 임베딩 FastAPI (`POST /embed` jpeg→벡터, Stage 1 슬라이드 전환 확정용) |
| `ocr_lines.py` | OCR 상자 → 줄 단위 글·평균 점수·세로 글씨 비율. `embed_server.py`의 `/ocr`가 쓴다 — 시험: `python3 -m unittest test_ocr_lines` |
| `ocr_engine.py` | RapidOCR 엔진(모델 경로 명시, 각도 분류기 끔, 4스레드). `embed_server.py`가 import한다 — 시험: `python3 -m unittest test_ocr_engine` |
| `fetch-ocr-models.sh` | OCR 모델 3개를 `~/gpu-server/ocr-models`에 받는다(SHA256 확인). `setup-embed.sh`가 부른다 |
| `systemd/` | 상시 기동 유닛 5개 (`seeon-vlm`·`seeon-asr`·`seeon-tts`·`seeon-embed`·`seeon-judge`) |

## 전제 (검증 환경)

- A100 SXM4 80GB, **Ubuntu 24.04**, 드라이버 **580.105.08 / CUDA 13.0**
- 시스템에 `gcc`가 있어야 한다(vLLM의 Triton 커널 컴파일). CUDA 툴킷(`nvcc`)은 필요 없다 —
  CUDA 런타임은 전부 pip 휠에 딸려 온다
- 지금 vLLM 은 CUDA 13 휠이다 → **드라이버 580 이상이 전제**. Gemma 4 는 vLLM 0.19 부터 돈다

> **서버 이력**: 2026-07-09엔 드라이버 535/CUDA 12.2 고정이라 `Qwen2.5-VL-32B-AWQ + vLLM 0.7.3(cu121)`을
> 썼다. 2026-08-03에 580으로 상향해 Qwen3.5로 교체했다. 2026-10-03 서버를 새 머신으로 옮겼다
> (Ubuntu 22.04 → 24.04, 비밀번호 → 키 인증, SSH 기본 포트 → 비표준 포트). **2026-10-20 VLM·판정 LLM 을 Qwen3.5(35B-A3B·9B)에서
> Gemma 4 26B-A4B-it QAT 4비트 하나로 바꿨다**(탐지 F1 93.8 대 92.4, 이해도 동등, VLM 약 3배·판정 약 35% 빠름).
> 옛 Qwen 유닛은 서버의 `/etc/systemd/system/seeon-{vlm,judge}.service.bak-20261020` 에, Qwen 가중치는 `/data/hf-cache` 에 남아 있다(되돌리기 = 백업 유닛 복원 → `daemon-reload` → `restart seeon-vlm` → 8801 이 뜬 뒤 `restart seeon-judge`).

### A100(sm_80)에서 절대 쓰면 안 되는 것

| 금지 | 이유 |
|---|---|
| **FP8 체크포인트** | 네이티브 FP8은 cc 8.9+ 필요. `Qwen3-VL-32B-Instruct-FP8` 기동 실패 실측 |
| **`--kv-cache-dtype fp8` / TurboQuant(k8v4)** | 하이브리드 MoE와 조합 시 Ampere에서 **에러 없이 오답**을 낸다 (vLLM #40124) |

## 업로드 (맥 → 서버)

키 인증 + 비표준 포트다. `scp`는 포트 옵션이 대문자 `-P`다.

```bash
KEY=<관리자 키 경로>; SERVER=<계정>@<서버 주소>; PORT=<SSH 포트>
ssh -i $KEY -p $PORT $SERVER 'mkdir -p ~/gpu-server/systemd'
scp -i $KEY -P $PORT tools/gpu-server/*.py tools/gpu-server/*.sh tools/gpu-server/*.sha256 $SERVER:~/gpu-server/
scp -i $KEY -P $PORT tools/gpu-server/systemd/*.service $SERVER:~/gpu-server/systemd/
```

ASR은 `asr_server.py`와 `asr_language.py` **두 파일을 함께** 올려야 한다(서버가 `asr_language`를 import한다). `asr_server.py`만 올리면 ASR이 기동하지 못한다.
EMBED도 마찬가지로 `embed_server.py`·`ocr_engine.py`·`ocr_lines.py` **세 파일을 함께** 올려야 한다. `ocr_engine.py`가 없으면 `/ocr`뿐 아니라 `/embed`까지 기동하지 못한다
(모델·rapidocr가 없을 때는 `/ocr`만 503이고 `/embed`는 돈다).

## 설치 (서버에서 1회)

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh     # uv — 세 셋업 스크립트가 모두 쓴다
sudo apt-get install -y ffmpeg                       # /tts-long의 mp3 인코딩

bash ~/gpu-server/setup-vlm.sh      # /data/venv-vllm-35 + Gemma 4 26B-A4B QAT 가중치(17.2GB → /data/hf-cache, 해시 대조)
bash ~/gpu-server/setup-audio.sh    # ~/venv-audio — ASR·TTS
bash ~/gpu-server/setup-embed.sh    # ~/venv-embed — EMBED(+ /ocr 패키지, OCR 모델 약 24MB → ~/gpu-server/ocr-models)
bash ~/gpu-server/setup-judge.sh    # JUDGE 가중치 확인(VLM 과 같은 가중치). setup-vlm.sh 뒤에 돌린다
```

셋은 서로 독립이라 **동시에 돌려도 된다**(설치는 GPU를 쓰지 않는다). 새 서버에서 셋을 병렬로 돌려
약 10분이 걸렸다(다운로드 약 89MB/s).

`setup-vlm.sh`는 vLLM **nightly**를 받는다. nightly는 오래된 빌드가 지워져 버전을 핀할 수 없으므로,
끝에 출력되는 버전을 아래 "현재 상태"에 기록한다.

이미 `~/venv-embed`가 있는 서버에 `/ocr`만 더할 때는 venv를 다시 만들지 않고 `setup-embed.sh`의 OCR 묶음
(pip 두 줄 + `bash ~/gpu-server/fetch-ocr-models.sh`)만 돌린 뒤 `sudo systemctl restart seeon-embed`한다.
OCR 패키지는 venv-embed의 `numpy<2`를 지키도록 버전을 고정해 두었다 — 핀을 풀면 최신 opencv가 numpy 2를 끌어온다.

## 항상 켜두기 (systemd — 재부팅·크래시 자동 복구)

tmux는 SSH 끊김엔 견디지만 **재부팅엔 안 살아남는다.** `systemd/`의 유닛을 설치한다.

⚠️ 먼저 tmux/포그라운드로 띄운 기존 서버를 종료해 포트를 비운다: `tmux kill-server`.
tmux 밖(예: VS Code 통합 터미널)에서 띄운 프로세스는 `tmux kill-server`로 안 죽는다 —
`ss -tlnp | grep 8801` 로 **이중 리슨이 없는지 반드시 확인**할 것.

```bash
for unit in ~/gpu-server/systemd/*.service; do
  sed "s/@GPU_USER@/$(whoami)/g" "$unit" | sudo tee "/etc/systemd/system/$(basename "$unit")" >/dev/null
done
sudo systemctl daemon-reload
sudo systemctl enable --now seeon-vlm seeon-asr seeon-tts seeon-embed seeon-judge
```

유닛은 계정 자리를 `@GPU_USER@`로 비워 두었다(`User=`·`/home/…` 경로). 위처럼 설치할 때 지금 계정으로 채운다
(systemd는 `~`를 풀지 않는다). 유닛을 다시 설치할 때도 `sudo cp` 대신 이 반복문으로 넣는다.

⚠️ **EMBED(8804)를 빠뜨리지 말 것.** 2026-08-07까지 이 유닛이 없어 8804가 아예 떠 있지 않았고,
앱은 그동안 로컬 격자 luma 폴백(`renderer/app/main.js`의 `computeGridEmbedding`)으로 슬라이드를
판별했다. 폴백은 템플릿을 공유하는 슬라이드 간 거리가 ≈0.03으로 좁아 **복귀 슬라이드를 구분하지
못하고 과다 고지한다.** 콘솔에 `GPU 임베딩 서버 미연결` 경고나 `[slide] … src=local`이 보이면
8804가 죽은 것이다.

관리:
```bash
systemctl is-active seeon-vlm seeon-asr seeon-tts seeon-embed seeon-judge
sudo journalctl -u seeon-vlm -f          # 기동 2~3분 (첫 기동은 torch.compile로 더 걸림)
sudo systemctl restart seeon-tts         # 예: TTS speed 변경 후 (10~25초 끊김)
```
- `Restart=always`로 죽으면 5초 뒤 재기동. **`systemctl stop`은 명시적 정지라 재기동하지 않는다.**
- 유닛을 고쳤으면 `daemon-reload` 후 `restart`.
- 첫 기동 때 ASR·TTS·EMBED는 가중치를 내려받느라 포트가 늦게 열린다. 네 포트가 다 열릴 때까지
  `ss -tln | grep 880`으로 확인한다.

## 기동 (수동 — 디버깅용)

```bash
# VLM (8801)
source /data/venv-vllm-35/bin/activate
export HF_HOME=/data/hf-cache
export CUDA_HOME=/data/venv-vllm-35/lib/python3.12/site-packages/nvidia/cu13
export PATH="$CUDA_HOME/bin:$PATH"
export VLLM_USE_FLASHINFER_SAMPLER=0
export HF_HUB_OFFLINE=1 VLLM_NO_USAGE_STATS=1 DO_NOT_TRACK=1
VLLM_CACHE_ROOT=~/.cache/vllm-gemma4-vlm vllm serve cyankiwi/gemma-4-26B-A4B-it-qat-AWQ-INT4 \
  --revision 18a3c7285c33ee39d3e5e16ee6fb2c18f4955ef9 \
  --served-model-name gemma-4-26b-a4b-qat --host 127.0.0.1 --port 8801 \
  --max-model-len 32768 --gpu-memory-utilization 0.55 \
  --limit-mm-per-prompt '{"video":0}' --mm-processor-kwargs '{"max_soft_tokens":560}' --reasoning-parser gemma4

# JUDGE (8805) — VLM이 다 뜬 뒤에 띄운다(두 vLLM이 동시에 메모리를 재면 기동이 실패한다)
VLLM_CACHE_ROOT=~/.cache/vllm-gemma4-judge vllm serve cyankiwi/gemma-4-26B-A4B-it-qat-AWQ-INT4 \
  --revision 18a3c7285c33ee39d3e5e16ee6fb2c18f4955ef9 \
  --served-model-name gemma-4-26b-a4b-qat --host 127.0.0.1 --port 8805 \
  --max-model-len 8192 --gpu-memory-utilization 0.30 --language-model-only --reasoning-parser gemma4

# ASR (8802) — ctranslate2가 venv 안의 cuBLAS·cuDNN을 찾도록 경로를 알려 준다
NV=~/venv-audio/lib/python3.10/site-packages/nvidia
tmux new -d -s asr "cd ~/gpu-server && LD_LIBRARY_PATH=$NV/cublas/lib:$NV/cudnn/lib ~/venv-audio/bin/uvicorn asr_server:app --host 127.0.0.1 --port 8802"

# TTS (8803)
tmux new -d -s tts 'cd ~/gpu-server && ~/venv-audio/bin/uvicorn tts_server:app --host 127.0.0.1 --port 8803'

# EMBED (8804)
tmux new -d -s embed 'cd ~/gpu-server && ~/venv-embed/bin/uvicorn embed_server:app --host 127.0.0.1 --port 8804'
```

VLM·판정 플래그가 왜 그런지:

| 플래그 · env | 이유 |
|---|---|
| `--revision 18a3c72…` + `HF_HUB_OFFLINE=1` | 커뮤니티 4비트 판(구글 공식 vLLM 4비트는 26B-A4B 에 없다)이라 판을 고정한다. 기동 때 Hugging Face 에 묻지 않아 저장소가 바뀌거나 지워져도 영향이 없다 |
| `--quantization` 없음 | 체크포인트의 `quant_method: compressed-tensors` 로 자동 인식된다(A100 은 Marlin 커널) |
| `--max-model-len 32768` (VLM) | 앱의 가장 긴 VLM 요청(글 질문 약 2만 토큰)이 들어간다 |
| `--limit-mm-per-prompt '{"video":0}'` (VLM) | 이미지 장수는 기본값(앱은 최대 2장), 동영상은 쓰지 않는다 |
| `--mm-processor-kwargs '{"max_soft_tokens":560}'` (VLM) | 1280×720 화면을 비율 그대로 줄이지 않는 가장 작은 이미지 토큰 예산(약 527토큰). 기본 280 은 1056×576 으로 줄여 작은 글자가 흐려진다 |
| `--language-model-only` (판정) | 판정은 글만 보낸다. 비전 타워를 올리지 않아 그만큼 KV 캐시가 늘어난다 |
| `--gpu-memory-utilization` 0.55 · 0.30 | 둘을 합쳐 0.85 — 나머지 15%에 ASR·TTS·EMBED(약 5GB)가 들어간다 |
| `--reasoning-parser gemma4` | Gemma 4 의 생각 채널을 `reasoning` 칸으로 나눈다. 앱은 품질 모드 삽입 위치 추론(8805)만 사고를 켜고, 나머지는 끄고 묻는다(`enable_thinking:false`) |
| `VLLM_CACHE_ROOT` 자리별 분리 | 같은 모델을 이미지 있음(8801)·없음(8805)으로 띄우면 컴파일 캐시를 서로 읽고 기동이 죽는다(vLLM #50891) |
| `VLLM_NO_USAGE_STATS=1` · `DO_NOT_TRACK=1` | vLLM 의 익명 사용 통계(stats.vllm.ai) 전송을 끈다 |
| `VLLM_USE_FLASHINFER_SAMPLER=0` | FlashInfer 샘플러가 런타임 JIT(nvcc)을 요구 — 끄면 첫 기동도 빨라진다 |

- Qwen 전용 플래그(`--quantization moe_wna16`, `--max-num-batched-tokens 2096`, `--reasoning-parser qwen3`)는 쓰지 않는다. 특히 qwen3 파서는 Gemma 답을 reasoning 칸으로 보내 "빈 응답"이 된다.

- 앱은 `SEEON_EMBED_URL`(기본 `http://127.0.0.1:8804/embed`)로 접속한다. SSH 터널에 8804도 포함할 것.
- 임베딩 모델은 첫 기동 때 `~/.cache/huggingface`로 다운로드된다(SigLIP base 약 800MB).
- **슬라이드 전사 `/ocr`(같은 8804, CPU RapidOCR)**: `POST /ocr`, body `image/jpeg`(raw) →
  `{ text, lineList[{text,score,left,top,width,height}], imageWidth, imageHeight, meanScore, verticalBoxRatio, elapsedMs, engine }`.
  400 = 이미지를 못 읽음, 422 = 엔진이 그 장을 처리하지 못함(앱은 그 장만 VLM 으로 넘기고 서비스 다운으로 보지 않는다), 503 = 엔진 없음(`~/gpu-server/ocr-models`의 모델 3개·`rapidocr` 패키지 확인 — 이유가 `detail`에 담긴다).
  한 번에 한 장만 인식한다(동시 요청은 차례를 기다린다). 모델은 `fetch-ocr-models.sh`가 미리 받아 두고, 서버는 실행 중 내려받지 않는다.
- **`--served-model-name gemma-4-26b-a4b-qat`는 앱의 `SEEON_VLM_MODEL`·`SEEON_JUDGE_GPU_MODEL`과 정확히 일치해야 한다.**
  어긋나면 vLLM이 404를 내고 캡션 에이전트 6개가 전부 실패한다(증상은 "캡션이 안 나온다"뿐). 옛 이름을 별칭으로 걸지 않는다 — 기록에 Gemma 결과가 Qwen 으로 남는다.
- **기동 직후 첫 요청들은 느리다.** 배치 크기·이미지 해상도별 커널을 처음 만날 때 컴파일한다.
  새 서버 실측(2026-10-03, Qwen3.5-35B-A3B 시절): 동시 5개가 첫 회 3,177ms → 데워진 뒤 1,270~1,352ms. 성능을 잴 때는 한 바퀴 돌린 뒤 잰다.

## 판정 LLM (8805)

탐지 단계의 LLM 판정(통합 라우터·무발화 판정·지시 판정)은 VLM과 같은 모델(**Gemma 4 26B-A4B**)을 8805 에 따로 띄워 한다.
내레이션 삽입 위치 추론(품질·균형 모드)도 판정 백엔드 설정과 상관없이 이 8805를 쓴다. 품질 모드는 사고(thinking)를 켜고
1,024토큰에서 끊으면, 그때까지의 생각을 user 메시지에 붙여 사고를 끈 채 답만 한 번 더 묻는다(생각 칸을 이어 쓰는 `continue_final_message` 는 모델마다 생각 표기가 달라 쓰지 않는다).
균형 모드는 사고 없이 묻는다. 실패하면 규칙(첫 완결 경계)으로 고른다.
앱 기본값은 `SEEON_JUDGE_GPU_URL=http://127.0.0.1:8805/v1/chat/completions`, `SEEON_JUDGE_GPU_MODEL=gemma-4-26b-a4b-qat`다.
8805가 응답하지 않거나 6초를 넘기면 다른 서비스로 넘기지 않고 판정 없음(X)으로 둔다.

| 항목 | 값 | 이유 |
|---|---|---|
| 모델 | `cyankiwi/gemma-4-26B-A4B-it-qat-AWQ-INT4` @ `18a3c72` (VLM 과 같음) | MoE 25.2B 중 토큰마다 3.8B 만 써서 판정이 빠르다(p50 약 0.39초). 4비트라 0.30 몫에 들어간다. A100은 FP8을 못 쓴다 |
| `--gpu-memory-utilization` | VLM 0.55 · JUDGE 0.30 | 둘을 합쳐 0.85 — 나머지 15%에 ASR·TTS·EMBED가 들어간다 |
| `--max-model-len 8192` | 판정 입력(지시문 + few-shot + 앞 60초 · 뒤 7초 문맥)이 4천 토큰 안팎이다 |
| `--language-model-only` | 판정은 글만 보낸다. 비전 타워를 올리지 않는다(KV 약 5.9GiB = 42,342토큰) |
| 기동 순서 | VLM 다음 | `seeon-judge.service`의 `ExecStartPre`가 8801이 뜰 때까지 기다린다 |

서버에 올리는 순서(처음 올릴 때와 이미 떠 있는 서버의 유닛을 바꿀 때 모두 같다):

```bash
bash ~/gpu-server/setup-judge.sh
# 깔려 있는 유닛을 날짜를 붙여 남긴다(되돌릴 때 이 파일을 복원한다). 처음 올리는 서버라 유닛이 없으면 이 두 줄은 건너뛴다.
sudo cp /etc/systemd/system/seeon-vlm.service /etc/systemd/system/seeon-vlm.service.bak-$(date +%Y%m%d)
sudo cp /etc/systemd/system/seeon-judge.service /etc/systemd/system/seeon-judge.service.bak-$(date +%Y%m%d)
for unit in ~/gpu-server/systemd/seeon-vlm.service ~/gpu-server/systemd/seeon-judge.service; do
  sed "s/@GPU_USER@/$(whoami)/g" "$unit" | sudo tee "/etc/systemd/system/$(basename "$unit")" >/dev/null
done
sudo systemctl daemon-reload
sudo systemctl restart seeon-vlm
sudo systemctl enable seeon-judge && sudo systemctl restart seeon-judge   # 떠 있던 판정 LLM 도 새 유닛으로 다시 띄운다. VLM이 뜰 때까지 기다렸다가 뜬다
curl -s localhost:8801/v1/models | head -c 120; echo   # → gemma-4-26b-a4b-qat
curl -s localhost:8805/v1/models | head -c 120; echo   # → gemma-4-26b-a4b-qat
```

`enable --now` 는 이미 떠 있는 서비스를 다시 띄우지 않는다. 그래서 유닛을 바꾼 뒤에는 `restart` 를 쓴다.

앱 전용 키로 터널을 여는 경우, 서버 `~/.ssh/authorized_keys`의 앱 키 줄에 8805를 더해야 앱이 8805를 전달할 수 있다:
`permitopen="127.0.0.1:8801",…,permitopen="127.0.0.1:8805" ssh-ed25519 AAAA… seeon-app`

## 셀프 검증 (서버에서)

```bash
curl -s localhost:8801/v1/models | head -c 120; echo
curl -s localhost:8805/v1/models | head -c 120; echo
curl -s localhost:8803/tts -H 'content-type: application/json' -d '{"text":"테스트"}' -o /tmp/t.wav && file /tmp/t.wav
curl -s "localhost:8802/asr?startTs=0" -H 'content-type: audio/webm' --data-binary @/tmp/t.wav
curl -s localhost:8804/embed -H 'content-type: image/jpeg' --data-binary @some.jpg | head -c 60; echo
curl -s localhost:8804/ocr -H 'content-type: image/jpeg' --data-binary @some.jpg | head -c 120; echo
curl -s localhost:8803/tts-long -H 'content-type: application/json' -d '{"text":"회의 요약입니다. 첫 번째 안건은 블록체인 산업 전망이었습니다."}' -o /tmp/t.mp3 && file /tmp/t.mp3
```
- VLM·JUDGE → `gemma-4-26b-a4b-qat` JSON, TTS → `RIFF ... WAVE`, ASR → `{"text":...,"segmentList":[...]}`,
  EMBED → `{"embedding":[...]}`, OCR → `{"text":...,"lineList":[...]`(503이면 `detail`의 이유를 본다), TTS-LONG → `Audio file with ID3 ... MPEG ADTS, layer III`면 정상.
- `/v1/models`는 떠 있다는 것만 증명한다. **실제 생성까지 보려면 이미지 요청을 한 번 보낼 것.**

## TTS 말소리 속도 조절

**속도 상수가 둘로 갈려 있다. 고칠 때 둘을 헷갈리지 말 것.**

| 상수 | 경로 | 값 | 성격 |
|---|---|---|---|
| `speed=2.0` (리터럴) | `POST /tts` | 2.0 | **실시간 어절 예산의 교정 상수** |
| `SUMMARY_SPEECH_SPEED` | `POST /tts-long` | 1.5 | 요약본 낭독 속도 (독립) |

`/tts`의 값은 함부로 바꾸면 안 된다 — `renderer/core/mode/mode-policy.js`의 `SPEECH_MS_PER_WORD`
(잠정 450ms, M-1 미실측)가 여기에 종속돼 있어, **바꾸면 M-1을 다시 재야 한다.**
요약본 속도만 조정하려면 `SUMMARY_SPEECH_SPEED`만 건드린다.

```bash
sed -i 's/^SUMMARY_SPEECH_SPEED = .*/SUMMARY_SPEECH_SPEED = 1.4/' ~/gpu-server/tts_server.py
sudo systemctl restart seeon-tts
```

## 트러블슈팅 (실제로 겪은 것들)

| 증상 | 원인 · 해결 |
|---|---|
| ASR이 500, 로그에 `libcublas.so.12 is not found` | ctranslate2가 venv 안의 CUDA 라이브러리를 못 찾음 → `LD_LIBRARY_PATH`에 `nvidia/cublas/lib`·`nvidia/cudnn/lib` (유닛에 반영돼 있다) |
| `tokenizers` 빌드 실패 / `requirements are unsatisfiable` | Python 3.12로 venv-audio를 만듦 → `setup-audio.sh`대로 uv 3.10 |
| vLLM 기동 중 `Python.h: No such file` | 시스템 Python으로 VLM venv를 만듦 → `setup-vlm.sh`대로 uv 관리 3.12 |
| 터널 스크립트 `Permission denied` | 실행 권한 없음 → `chmod +x tools/tunnel.sh` |
| `driver too old (found version 12020)` | (구 서버) torch가 CUDA 12.2보다 높은 빌드 → cu121로 강제 |
| `libcudart.so.12 / libcublas... not found` (torch) | torch를 `--no-deps`로 깔아 CUDA 런타임 라이브러리 누락 → `--no-deps` 없이 재설치 |
| `No module named 'pkg_resources'` | 새 venv에 setuptools 없음/너무 최신 → `pip install "setuptools<81"` |
| `TorchAudio ... different CUDA versions` | torchaudio만 cu124 → 3형제 모두 cu121로 통일 |
| `pip show numpy` 결과에 라이선스 문구가 섞임 | numpy가 번들 라이브러리 라이선스 전문을 출력한다 → 버전은 `python -c "import numpy; print(numpy.__version__)"`로 |

## 현재 상태 (2026-10-20 실측 — VLM·판정 LLM 을 Gemma 4 26B-A4B 로 바꾼 뒤)

> 2026-10-20 VLM(8801)·판정 LLM(8805)을 Qwen3.5-35B-A3B·Qwen3.5-9B 에서 Gemma 4 26B-A4B-it QAT 4비트 하나로 바꿨다.
> 옛 유닛은 서버의 `/etc/systemd/system/seeon-{vlm,judge}.service.bak-20261020`(그 전 VLM 0.85 판은 `seeon-vlm.service.bak-20261006-230226`)에 있다.
> 첫 기동(torch.compile 포함) VLM 약 3분 20초, 판정 LLM 약 6분(VLM 을 기다린 시간 포함) 걸렸다. 다음부터는 자리별 컴파일 캐시를 쓴다.

- 접속: 키 인증, SSH 비표준 포트 — 주소·계정·포트·키는 저장소에 두지 않는다(`.env` 에만 둔다)
- A100 SXM4 80GB, Ubuntu 24.04.1, 드라이버 580.105.08 / CUDA 13.0, RAM 235GB
- 다섯 서버 모두 **systemd `enabled` + `active`** — 재부팅·크래시에 자동 복구된다
- VRAM 74.6GB / 81.9GB (VLM 0.55 + 판정 LLM 0.30 + ASR·TTS·EMBED 약 6GB). KV 캐시는 VLM 463,381토큰 · 판정 42,342토큰
- 디스크 `/data` 82GB 여유 (`/data` 전체 196GB, Gemma 17GB·Qwen 두 모델·옛 시험 가중치 포함)

| 포트 | 서비스 | 모델 | venv |
|---|---|---|---|
| 8801 | VLM | `cyankiwi/gemma-4-26B-A4B-it-qat-AWQ-INT4` @ `18a3c72` (`gemma-4-26b-a4b-qat`, `max_model_len` 32768, 이미지 토큰 예산 560) | `/data/venv-vllm-35` — py3.12.15 · vLLM 0.30.1rc1.dev583 · torch 2.13.0+cu132 · transformers 5.17.0 |
| 8802 | ASR | faster-whisper `large-v3-turbo`, float16, VAD | `~/venv-audio` — py3.10.22 · torch 2.5.1+cu121 · faster-whisper 1.2.1 · ctranslate2 4.8.2 |
| 8803 | TTS | MeloTTS-Korean (`/tts` speed 2.0 · `/tts-long` 1.5) | `~/venv-audio` — transformers 4.27.4 |
| 8804 | EMBED | `google/siglip-base-patch16-224` → 768차원 | `~/venv-embed` — py3.10.22 · torch 2.5.1+cu121 · transformers 4.49.0 |
| 8805 | JUDGE | 8801 과 같은 가중치 (`gemma-4-26b-a4b-qat`, `max_model_len` 8192, `--language-model-only`) | `/data/venv-vllm-35` (VLM 과 같음) |

**판정 LLM (8805) 실측 (10/20, 판정 요청 2,880건, 동시 4)** — 판단 p50 0.39초 · p95 약 0.65초 · 최대 1.1초, 6초 초과 0.
같은 조건의 Qwen3.5-9B 는 p50 0.61초 · p95 약 0.99초였다. F1 93.8(Qwen 92.4), 한국어 93.0.
삽입 위치 추론: 균형(사고 없음) 약 0.2초, 품질(사고 1,024토큰 한도) 4.8~7.4초(Qwen 은 3건 모두 한도에 걸려 약 13.5초).

**VLM (8801) 실측 (10/20, 슬라이드 8장 × 에이전트 4종, 순차)** — 전환 고지 평균 0.95초 · 무발화 묘사 0.32초 · 지시 해설 0.35초 · 질문 답 0.25초.
같은 날 Qwen3.5-35B-A3B 는 2.7 · 1.3 · 1.4 · 0.7초였다. 실험실 30클립에서 화면 글자 읽기 20초 초과는 Qwen 18건 → Gemma 0건이었다.

**VLM 동시 실행 (2026-10-03, Qwen3.5-35B-A3B 시절 실측 — 데워진 뒤, 프레임 1장 + 프롬프트 592토큰, 생성 짧음)**

| 동시 요청 | 요청당 평균 |
|---|---|
| 1개 | 409 ms |
| 3개 | 837~849 ms |
| 5개 | 1,270~1,352 ms |
| 8개 | 1,934~1,971 ms |

**`/tts-long` 합성 시간 (2026-08-08, 이전 서버 실측)** — 앱 타임아웃(10분) 판단 근거:

| 입력 | 소요 | mp3 | 재생 길이 |
|---|---|---|---|
| 5,200자 | 69초 | 5.6MB | 12분 |
| 10,400자 | 137초 | 11.3MB | 약 24분 |

글자 수에 선형이다(약 13ms/자). 실제 요약본 상한 15,000자면 약 200초로 **타임아웃 대비 3배 여유**.
