# 평가 실행 방법

녹화 영상과 평가 셋으로 3.1 탐지 성능과 3.2 이해도 성능을 돌리는 순서다. 형식은 [dataset-format.md](dataset-format.md) 를 본다.

평가는 **교차 출력의 균형 모드**(production `delayed`, 지연 10초)로 돌리고, 판정기 맥락 창은 **트리거 앞뒤 7초**다(팀 결정). 3.1 항목은 트리거 문장 앞뒤 약 7초 분량으로 만들고, 채점 도구는 기본으로 항목 전체를 맥락으로 준다. 두 도구와 실험 창 모두 이 값이 기본이다.

## 0. 준비

아래 명령은 모두 저장소 맨 위 폴더(`seeon-meet`)에서 돌린다.

### 0-1. 처음 한 번

필요한 것: macOS, git, Node.js 22 이상(확인 환경 v22.14.0), ffmpeg(`brew install ffmpeg` — 확인용 영상 만들기와 녹음 길이 고치기에 쓴다). GPU 서버 앱 전용 키 파일과 Bedrock 토큰은 저장소에 없으니 따로 준비한다.

1. 저장소를 받고 실험 브랜치로 바꾼다.

   ```bash
   git clone https://github.com/See-on26/seeon-meet.git
   cd seeon-meet
   git checkout experiment
   npm ci
   ```

   이미 받아 두었으면 `cd seeon-meet && git fetch origin && git checkout experiment && npm ci`.

2. 저장소 맨 위 폴더에 `.env` 파일을 만들고 Bedrock 토큰과 GPU 서버 앱 전용 키 경로를 넣는다. `.env` 는 gitignore 돼 커밋되지 않는다. GPU 서비스 주소(`127.0.0.1:8801`~`8805`)·GPU 서버 SSH 주소·계정·포트·Bedrock 지역·모델은 기본값이 지금 제품 설정이라 따로 적지 않는다.

   ```
   AWS_BEARER_TOKEN_BEDROCK=<Bedrock 토큰>
   SEEON_GPU_SSH_KEY=<앱 전용 키 파일 경로>
   ```

   토큰이 없으면 두 평가 도구가 시작하자마자 멈춘다(3.1 은 GPU 판정이 실패한 호출을 Bedrock 이 대신 판정하지 못해 "판정 실패 → 해설 안 함"으로 떨어지고, 3.2 는 답변 모델을 부를 수 없다). 키는 실험 창이 GPU 서버 터널을 여는 데 쓴다(0-3).

3. Kiwi 형태소 분석 모델을 두 곳에 받는다(둘 다 v0.24.0 base 묶음에서 꺼낸다).

   ```bash
   npm run setup:kiwi        # production 트리거용 → vendor/kiwi-model (약 83MB)
   tools/eval/setup-kiwi.sh  # 3.1 평가 방법론 말주머니 매처용 → out/cache/kiwi-model (약 88MB)
   ```

   - `vendor/kiwi-model` 은 제품 앱·실험 창의 한국어 트리거(main `speech-trigger.js`)와 3.1 도구의 "production 트리거" 후보가 쓴다. 없으면 production 처럼 경고만 하고 한국어를 대체 규칙(어절 경계)으로 잡는다. 실험 창은 터미널에 `[pipeline] Kiwi 를 띄우지 못해 …`, 3.1 도구는 요약·`report.md` 에 "대체 규칙"이라고 적는다. 설치본 제품과 다른 결과이니 받고 돌린다.
   - `out/cache/kiwi-model` 은 말주머니 매처가 쓴다. 없으면 3.1 도구가 어절 경계 근사로 돌고 결과에 "근사"라고 적는다.

4. 평가 셋·응답 파일을 둘 폴더를 만든다. 이 문서의 예시 경로는 모두 `out/eval/` 아래다(이유는 0-4).

   ```bash
   mkdir -p out/eval
   ```

### 0-2. 평가 전마다: production 받아 합치기

팀이 올린 실험 코드와 최신 production 을 받아 실험 브랜치에 합친다. 평가 수치가 지금 제품의 수치가 되게 하려는 것이다. 반대 방향(실험 → production) 병합은 하지 않는다.

```bash
git checkout experiment
git pull --no-rebase --no-edit origin experiment
git fetch origin production:production
git merge --no-edit production
npm ci
npm run setup:kiwi
npm test
```

- `git fetch origin production:production` 이 이 맥의 `production` 브랜치를 origin 의 최신 커밋으로 옮긴다. 로컬 `production` 은 fetch 해야만 앞으로 가므로, 이 줄 없이 `git merge production` 만 하면 처음 받았을 때의 옛 production 을 합친다.
- 이 문서대로 했다면 `production` 은 체크아웃돼 있지 않다. 체크아웃해 둔 상태면 위 fetch 가 거부되므로(`refusing to fetch into branch`) 그때는 `git checkout production && git pull origin production && git checkout experiment` 로 받은 뒤 `git merge --no-edit production` 을 한다.
- 병합이 충돌로 멈추면 `git merge --abort` 로 되돌리고 팀에 알린다. `npm test` 가 실패해도 팀에 알린다.
- `npm run setup:kiwi` 는 같은 버전 모델이 있으면 건너뛴다. production 이 Kiwi 버전을 올렸으면 새 모델을 받는다.

### 0-3. 실험 창을 돌릴 때: GPU 서버 터널

실험 창(3.2 결과 폴더 만들기)은 GPU 서버의 VLM(8801)·ASR(8802)·TTS(8803)·EMBED(8804)·판정 LLM(8805)이 필요하다. 3.1 탐지 평가와 실험 창은 제품과 같은 판정 LLM 을 쓴다 — 기본은 GPU 서버에서 VLM 과 같은 모델(Gemma 4 26B-A4B, 서빙 이름 `gemma-4-26b-a4b-qat`)을 따로 띄운 판정 LLM(8805)이고, GPU 가 실패해도 Bedrock 으로 넘기지 않는다(`SEEON_JUDGE_BACKEND=bedrock` 이면 Bedrock 만). 어느 서버로 갔는지는 `run.json.modelConfig` 의 `judgeBackend`·`judgeGpuUrl`·`judgeGpuModel` 과 `pipeline.jsonl` 의 `경로=gpu` 로 본다. 3.2 이해 평가는 Bedrock 만 쓴다.

실험 창은 제품 앱처럼 **켜질 때 GPU 서버의 다섯 포트를 SSH 터널로 이 맥의 같은 포트(`127.0.0.1:8801`~`8805`)에 직접 붙인다.** `.env` 의 `SEEON_GPU_SSH_KEY`(0-1) 만 있으면 따로 할 일이 없다. 그 터널은 실험 창이 떠 있는 동안만 있고, 끊기면 2초부터 최대 30초 간격으로 다시 붙는다.

- 다른 터널(먼저 띄운 제품 앱이나 `tools/tunnel.sh`)이 이미 그 포트를 쓰고 있으면 새로 열지 않고 그 터널을 쓴다. 그 터널을 끄면 실험 창도 GPU 서버를 못 쓴다.
- 앱 전용 키가 없으면 `tools/tunnel.sh` 로 직접 포워딩한 뒤 실험 창을 띄운다(`GPU_SSH_HOST=<주소> GPU_SSH_USER=<계정> GPU_SSH_PORT=<포트> GPU_SSH_KEY=<키 파일> tools/tunnel.sh`, 키 파일 권한은 `chmod 400`). 터널 창은 평가가 끝날 때까지 닫지 않는다.
- 상태는 실험 창 오른쪽 production 화면의 설정(톱니) → `GPU 서버` 줄과 터미널의 `[gpu-tunnel]` 줄에 나온다.

  | `GPU 서버` | 뜻 |
  |---|---|
  | `연결됨` | 실험 창이 연 터널로 붙었다 |
  | `외부 터널` | 다른 터널이 포트를 쓰고 있어 그것을 쓴다 |
  | `연결 중` · `다시 연결 중 (이유)` | 붙는 중이다. 이유는 서버 지문 불일치·인증 실패·키 형식 오류·응답 없음·네트워크 오류·연결 끊김 |
  | `키 없음` | `SEEON_GPU_SSH_KEY` 가 없거나 그 경로에 파일이 없다. 외부 터널이 있으면 그대로 돈다 |
  | `꺼짐` | `.env` 에 `SEEON_GPU_TUNNEL=off` 가 있다(외부 터널만 쓴다) |

실험 창을 띄운 채로(또는 외부 터널을 켠 채로) 다른 터미널에서 다섯 서버가 모두 답하는지 본다.

```bash
curl -s localhost:8801/v1/models | head -c 120; echo
curl -s localhost:8805/v1/models | head -c 120; echo
curl -s localhost:8803/tts -H 'content-type: application/json' -d '{"text":"테스트입니다"}' -o /tmp/seeon-tts-check.wav && file /tmp/seeon-tts-check.wav
curl -s "localhost:8802/asr?startTs=0" -H 'content-type: audio/webm' --data-binary @/tmp/seeon-tts-check.wav; echo
curl -s -o /dev/null -w "%{http_code}\n" localhost:8804/embed
```

| 서버 | 정상 |
|---|---|
| VLM 8801 | 모델 목록 JSON(`{"object":"list","data":[{"id":"gemma-4-26b-a4b-qat"…`) |
| 판정 LLM 8805 | 모델 목록 JSON(`"id":"gemma-4-26b-a4b-qat"`). 두 서버의 이름이 같다 |
| TTS 8803 | `WAVE audio` |
| ASR 8802 | TTS 가 만든 소리를 받아쓴 `{"text":"테스트입니다.", "segmentList":[…]}`. 글자가 조금 달라도 `text` 가 비지 않으면 된다 |
| EMBED 8804 | `405`(GET 은 받지 않는다는 뜻이라 서버는 떠 있다) |

아무것도 안 찍히거나 `000` 이 나오면 터널이나 그 서버가 죽은 것이다. 그때는 영상을 돌리지 않고 팀에 알린다. 특히 ASR 이 죽어 있어도 실험 창은 `isComplete=true` 로 끝날 수 있다(3절 "실행마다 확인").

### 0-4. 기준 커밋 확인

결과물에는 어느 커밋으로 돌렸는지가 남는다(`run.json.git`, 두 평가 도구 `metrics.json.runInfo.git` 의 `head`·`branch`·`productionMergeBase`·`isDirty`). `productionMergeBase` 는 그때 HEAD 와 이 맥의 `production` 브랜치의 merge-base 다. 평가 뒤 이 값이 origin 의 production 최신 커밋과 같은지 본다.

```bash
git ls-remote origin refs/heads/production    # 첫 칸이 productionMergeBase 와 같아야 한다
```

로컬 `production` 이 아니라 origin 과 견주므로, 0-2 의 fetch 나 merge 를 빼먹어 옛 production 으로 돌렸으면 여기서 다르게 나온다. 다르면 그 결과는 지금 제품의 수치가 아니다. 평가 도중 production 이 새로 올라와도 다르게 나오므로, 어느 쪽이든 0-2 부터 다시 하고 돌린다.

`isDirty: true` 면 저장소에 커밋하지 않은 변경이 있는 채로 돌린 것이다. 추적하지 않는 새 파일(예: 저장소 맨 위에 둔 평가 셋·CSV)도 `isDirty` 를 `true` 로 만든다. 그래서 평가 셋·응답 파일은 gitignore 된 `out/` 아래(이 문서는 `out/eval/`)나 저장소 밖에 둔다. `.env`·`out/` 은 gitignore 돼 있어 상관없다.

## 1. 평가 셋 검사

```bash
node tools/eval/validate.mjs out/eval/my-items.jsonl
node tools/eval/validate.mjs out/eval/my-questions.json
```

`형식 오류 없음` 이 나올 때까지 고친다. `[참고]` 줄은 오류가 아니다. 확장자가 `.jsonl` 이면 3.1 항목, 그 밖에는 3.2 문항 셋으로 읽는다. 두 평가 도구도 시작할 때 같은 검사를 하고, 오류가 있으면 Bedrock 을 부르지 않고 멈춘다.

## 2. 3.1 탐지 평가

1. 후보 위치 뽑기(라벨 초안). Bedrock 을 부르지 않는다.

   ```bash
   node tools/eval/detection-eval.mjs extract --in out/eval/my-items.jsonl --out out/eval/labeling.jsonl
   ```

   요약에 유형별 후보 수(production·말주머니·둘 다)와 "목표 트리거가 후보로 뽑히지 않은 항목"이 나온다. 뽑히지 않은 항목은 두 매처 모두 그 표현을 모른다는 뜻이다. `targetTrigger`·`isTargetGap` 을 적은 항목은 목표 위치(전사에서 `targetTrigger` 가 나오는 자리와 겹치는 같은 유형 후보)의 정답이 미리 채워진다. `targetTrigger` 가 여러 번 나오면 낱말 경계에서 시작하고 적힌 꼴 그대로 한 낱말인 자리를 고르고, 그래도 가를 수 없으면 채우지 않고 요약의 "목표 트리거가 여러 번 나와 미리 채우지 않음"에 항목 id 가 나온다(규칙은 [dataset-format.md](dataset-format.md)). `--matcher auto|kiwi|regex` 로 한국어 매처를 고를 수 있다(기본 `auto`: Kiwi 모델이 있으면 Kiwi).

   `--out` 파일에 이미 손으로 채운 라벨이 있으면 덮어쓰지 않고 멈춘다(종료 코드 2, `--in` 과 `--out` 이 같은 파일일 때도). 손으로 채운 라벨은 `isGap` 이 `null` 이 아닌 위치 가운데 extract 가 그 초안을 쓸 때 미리 채운 목표 정답(그 줄의 `isTargetGap`·`targetRationale`)과 값이 다른 것이다. 미리 채운 목표 정답만 있는 초안은 `--force` 없이 다시 뽑히고, 목표 정답은 지금 항목 값으로 다시 채워진다. 그래서 목표 정답을 바꾸려면 라벨 파일이 아니라 항목의 `isTargetGap`·`targetRationale` 을 고치고 다시 뽑는다.

   손으로 라벨을 채운 뒤 항목을 고쳐 다시 뽑으려면 `--force` 를 붙인다. 그러면 손 라벨(`isGap`·`rationale`)을 새 초안의 같은 항목·같은 `posId` 위치(그 자리 글자도 같을 때)로 옮겨 쓴다. 새 초안이 그 위치에 목표 정답을 미리 채웠으면 항목 값이 이기고, 손 라벨과 값이 다르면 그 위치를 `옛 값 → 새 값` 으로 찍는다. 옮긴 수와 옮기지 못한 라벨 목록도 찍는다. 옮기지 못한 라벨은 새 파일에 남지 않으므로 그 목록을 보고 다시 채운다.

2. `out/eval/labeling.jsonl` 의 `isGap: null` 위치에 `true`(공백)·`false`(공백 아님)와 `rationale`(근거)을 채운다. 판단하지 않을 위치는 `null` 로 둔다.
3. 검사: `node tools/eval/validate.mjs out/eval/labeling.jsonl --labeled`
4. 채점(판정 LLM 호출 — 기본 GPU 서버 8805, GPU 가 실패해도 Bedrock 으로 넘기지 않는다). `report.md` 머리에 판정 모델과 경로별 호출 수(`gpu`·`bedrock`), production 트리거의 한국어 분석기(Kiwi·대체 규칙)가 나온다. `bedrock` 경로는 `SEEON_JUDGE_BACKEND=bedrock` 일 때만 나온다. gpu 백엔드인데 `bedrock` 이 섞이면 설정이 어긋난 것이라 주의 줄이 붙는다.

   판정 재현은 production 통합 라우터 계약 그대로다. 발화(문장)마다 production 트리거 후보 구를 번호를 붙여 넘기고, 판단 LLM 이 후보마다 낸 O/X 를 그 위치의 판정으로 읽는다. 말주머니에만 있는 라벨 위치가 있는 발화는 그 위치를 후보로 더한 호출을 한 번 더 부른다 — 판정기 성능은 그 호출, 시스템 성능은 production 후보만 넘긴 호출의 O/X 로 낸다(`raw.jsonl` 의 `role`: `system_judge`·`system`·`judge`).

   ```bash
   node tools/eval/detection-eval.mjs score --in out/eval/labeling.jsonl --repeat 3
   ```

   | 옵션 | 기본 | 뜻 |
   |---|---|---|
   | `--mode` | `delayed`(균형) | `realtime_mix`·`listening`·`all` 도 고를 수 있다 |
   | `--context` | `item` | 항목 전체를 앞·뒤 맥락으로 준다. `symmetric7` 은 앞뒤 7초로 자르고, `production` 은 모드 정책 그대로(균형이면 앞 60초를 항목 시작에 고정·뒤 7초, 실회의에서는 뒤 맥락이 약 5초만 모인다) |
   | `--before-ms`·`--after-ms` | – | 프리셋보다 앞서는 창 길이(ms). 0 이상의 숫자(소수 가능)만 받는다 |
   | `--repeat` | 1 | 같은 입력을 몇 번 물을지. 판정 모델은 temperature 0 으로 부르지만 같은 입력에도 답이 달라질 수 있으므로 3 이상을 권한다 |
   | `--concurrency` | 4 | 동시 호출 수 |
   | `--cache` / `--no-cache` | `out/eval/cache/detection` | 같은 입력이면 다시 묻지 않는다(반복 번호가 다르면 따로 묻는다). 경로 오류가 난 호출은 캐시에 넣지 않아 다시 돌리면 다시 묻는다 |
   | `--matcher` | `auto` | `kiwi`(모델이 없으면 멈춘다)·`regex`(어절 경계 근사). `auto` 는 Kiwi 를 못 쓰면 근사로 돌고 결과에 적는다 |
   | `--out-dir` | `out/eval/detection-<시각>` | 결과 폴더 |

   옵션은 엄격하게 읽는다. 모르는 옵션, 고를 수 없는 값(`--mode`·`--context`·`--matcher`), 빈 값·글자가 들어간 ms(`--before-ms=`·`--after-ms=7s`), 1 이상의 정수가 아닌 `--repeat`·`--concurrency` 는 Bedrock 을 부르기 전에 사용법과 함께 멈춘다(종료 코드 2). 다른 맥락 창으로 조용히 평가하지 않게 하려는 것이다.

   종료 코드

   | 코드 | 언제 |
   |---|---|
   | 0 | 끝까지 돌았고 판정기 호출이 모두 판정 LLM(GPU·Bedrock)에 닿았다(`parse`·`empty_text` 경로 오류는 모델 응답이라 0 이다) |
   | 1 | 토큰이 없거나 입력 형식 오류로 시작하지 못했다. 또는 판정기 호출 가운데 판정 LLM(GPU·Bedrock)에 닿지 못한 것(`http`·`no_token`)이 있다 — 이때도 결과 폴더는 쓰고, 마지막 줄 `[score] 실패: 판정기 호출 N회가 판정 LLM(GPU·Bedrock)에 닿지 못했다 …` 와 `report.md` 맨 위 "주의" 줄로 알린다. GPU 서버 연결(터널)·토큰 만료·네트워크를 확인하고 같은 명령을 다시 돌린다. 실패한 호출은 캐시에 넣지 않으므로 다시 돌리면 그것만 다시 묻는다(그 결과 폴더는 새로 쓴 것을 쓴다) |
   | 2 | 옵션이 잘못됐다 |

5. 결과 `out/eval/detection-<시각>/`

   | 파일 | 내용 |
   |---|---|
   | `report.md` | 유형 6개별 판정기 성능·시스템 성능(TP·FP·FN·TN·정밀도·재현율·F1), FN 나누기(트리거 누락·판정 차단·척도 비활성), 경로 오류 |
   | `metrics.json` | 같은 수치(반복별·평균·표준편차·평균에 든 반복 수 `n`)와 실행 정보(`runInfo`: 맥락 창·모델·매처·기준 커밋) |
   | `errors.jsonl` | 틀린 위치마다 판정 근거와 정답 근거(오류 분석용). 경로 오류 행은 지표와 같은 규칙으로 들어가고 `pathError` 가 붙는다 |
   | `raw.jsonl` | 판정기 호출마다 입력·원문 응답·종료 사유·사용량 |

   - 표는 유형별(2-1·2-2·3-1·3-2·3-3·4-1)과 언어별(한국어·영어)로 나온다.
   - **판정기 성능**: 그 위치를 판정기에 넣었을 때 넘겼는가. 평가 방법론 3.1 의 정의다.
   - **시스템 성능**: production 트리거가 그 위치를 잡았고, 그 후보 목록으로 판단 LLM 이 공백(O)이라 했고, 생성 대상인가(3-3 척도는 기본으로 생성하고 `SEEON_ROUTER_SCALE_ENABLED=false` 일 때만 `scale_disabled`). 제품 그대로의 수치다.
   - production 트리거(main `speech-trigger.js`: 한국어 Kiwi 품사·영어 규칙)와 평가 방법론 말주머니는 같은 목록이 아니다. 말주머니에만 있는 위치는 시스템 성능에서 trigger_miss 로 나온다. 어느 목록이 기준인지는 팀이 정할 일이라 평가 도구는 측정만 한다.
   - 반복을 2회 이상 돌리면 정밀도·재현율·F1·정확도 칸은 평균 ± 표본 표준편차(%p)다. 경로 오류로 어떤 반복의 분모가 0 이 되면 그 반복을 빼고 평균하고, 그 칸에 `(n=평균에 든 반복 수)` 를 붙인다. 후보·TP·FP·FN·TN 은 반복 1 기준이다.
   - **경로 오류**: 판정기 호출이 실패했거나(`http`·`no_token`) 응답이 비었거나(`empty_text`) 잘렸거나(종료 사유 `max_tokens`) JSON 이 아니거나 후보 판단이 빠져서(`parse`) production 이 기본값(판단 LLM 은 해설 안 함 X, 무발화 판정은 차단)으로 처리한 호출이다. **판정기 성능에서는 판정 호출이 실패한 위치를 뺀다.** **시스템 성능에서는 production 트리거가 잡지 않은 위치를 늘 trigger_miss(놓침)로 넣는다** — production 은 그 위치에서 판정기를 부르지 않으므로 판정과 상관없이 결과가 정해진다. 트리거가 잡은 위치는 production 후보만 넘긴 호출이 실패했으면 시스템 성능에서도 뺀다. 그래서 두 표의 후보 수가 다를 수 있다. 반복마다 종류·종료 사유별 개수를 보고한다. 많으면 팀에 알린다.

   production 에도 `npm run eval:detection`(tools/detection-eval)이 있다. 그것은 별도의 탐지 평가 셋(문항 폴더 JSON, train/test)을 읽어 production 트리거가 정답 후보 구를 잡는지와 판단 LLM 의 O/X 를 항목당 정답 하나로 재는 제품 쪽 회귀 도구다. 이 3.1 도구는 평가 방법론 3.1 방법(평가 셋 jsonl → 후보 = production 트리거 ∪ 평가 방법론 말주머니 → 사람 라벨 → 판정기·시스템 성능 두 표, 모드·맥락 창·반복·경로 오류 집계)을 따른다. 둘 다 같은 `speech-trigger.js`·Kiwi 모델(`vendor/kiwi-model`)·통합 라우터를 부르므로 트리거·판단 쪽 수치 방향은 같고, 데이터 형식과 후보 범위가 다르다.

## 3. 실험 창으로 영상 돌리기 (3.2 결과 폴더)

실험 창을 띄우고 0-3 의 GPU 서버 확인(설정의 `GPU 서버` 가 `연결됨`·`외부 터널`, 네 서버 응답)을 한 뒤 돌린다.

```bash
npm run lab
```

- 왼쪽 위 조작 바 · 왼쪽 아래 재생 화면 · 오른쪽 production 화면이다. production 화면이 재생 화면을 회의 대신 캡처하므로 제품과 같은 해설이 같은 방식으로 들린다.
- **영상 선택** → 모드 고르기(기본 균형) → 회의 언어 고르기(기본 한국어) → **평가 설정**(기본 켜짐) → 필요하면 **ROI 편집**(녹화에 발표자 타일이 섞였을 때 공유 화면 영역을 드래그) → **시작**.
- **ROI 는 영상을 고른 뒤 첫 화면 위에서 맞춘다.** 영상을 고르면 재생 화면에 첫 화면을 띄워 멈춰 둔다(캡처·재생은 하지 않는다). 그 위에서 **ROI 편집**으로 영역을 맞추고 **시작** 하면 영상을 처음부터 다시 불러와 돈다. 첫 화면을 띄우지 못하면 조작 바 상태 줄에 이유가 나오고, 시작은 그대로 할 수 있다. 정한 영역은 앱을 닫을 때까지 다음 실행에도 쓰이고 `run.json.roiNormRect` 에 남는다.
- **회의 언어는 영상마다 고른다**: `한국어`·`English`·`자동(한·영)`. 회의 음성을 이 언어로 전사한다(GPU ASR `language=ko|en|auto`). 영어 영상은 `English` 또는 `자동(한·영)` 으로 돌린다. 자동은 말하는 조각마다 한국어·영어 중 하나로 전사한다. 실행할 때마다 production 화면의 회의 언어 저장값(`seeon.meetingLanguage`)에 써 넣고 화면을 새로 불러 적용한다. 시작 전에만 바꿀 수 있다. 고른 값은 `run.json.asrLanguage`, 실제로 실린 언어는 `run.json.asrLanguageApplied` 에 남는다(아래 표).
- **평가 설정**이 켜져 있으면 페이지 전환 안내·화자 안내·회의 요약을 끄고 돈다(지시·발화·무발화 해설은 늘 동작). 평가 설정을 다시 켜면 모드 선택이 균형으로 돌아가고, 그 뒤 다른 모드도 직접 고를 수 있다. 끄면 세 기능이 제품 기본(켜짐)으로 돈다. 실제로 쓴 값은 `run.json` 의 `mode`·`isEvalPreset`·`featureToggleMap` 에 남는다.
- 영상이 끝나면 지연 재생과 남은 해설을 기다렸다가(균형 약 33초, 품질 약 83초, 성능·동시 약 23초, 해설이 나오는 중이면 끝날 때까지) 스스로 정지하고 결과 폴더를 만든다. 도중에 **정지**를 누르면 기다리지 않고 바로 마무리한다.
- 영상 끝 전에 **정지**로 끝낸 결과 폴더는 `run.json.videoEndedWallMs` 가 `null` 이다. 빠진 파일이 없으면 `isComplete` 는 `true` 일 수 있으니, 3.2 도구가 그 폴더를 "영상 끝까지 가지 않았다"(잘린 실행)로 경고하고 보고서 결과 폴더 상태 표에 적는다. 평가에는 영상 끝까지 돈 폴더를 쓴다.
- **일시정지**는 재생 화면과 production 화면을 함께 멈춘다(버튼이 **재개**로 바뀐다). 영상·모드·회의 언어·평가 설정·ROI 는 시작 전에만 바꾼다.
- **결과 폴더**는 가장 최근에 끝난 실행의 결과 폴더를 연다(끝난 실행이 없으면 지금 쓰는 폴더). **시연 창**은 6절을 본다. **파이프라인**은 해설 결정마다 트리거 → 판정 → 에이전트 → 출력 흐름과 단계 신호등을 별도 창으로 보여 준다(실행 전·중·후 언제 열어도 된다).
- 재생 화면 크기가 곧 캡처 해상도다. 기본 창은 1920×1080 이지만 화면이 더 작으면 macOS 가 창을 줄인다(노트북 화면 1512×982 에서는 1512×917 안팎, 재생 화면 907×853 안팎이었다 — Dock 크기에 따라 다르다). 실제 크기는 `run.json.layout`·`playerViewport` 에 남는다. 평가 영상끼리는 같은 모니터·같은 크기로 돌린다. 크기는 `SEEON_LAB_WINDOW=1600x900 npm run lab` 처럼 바꿀 수 있다.
- 실험 앱은 제품 앱과 저장소를 나눠 쓴다(userData `seeon-lab`). 제품 앱을 띄워 둔 채로 돌려도 된다.

결과 폴더 `out/lab/<YYYYMMDD-HHmmss>-<영상이름>/`

| 파일 | 내용 |
|---|---|
| `run.json` | 영상·모드·기능 설정·회의 언어(`asrLanguage`)·실제로 실린 회의 언어(`asrLanguageApplied`)·창 크기·기준 커밋·모델 설정(비밀값 제외)·세션 ID·AD 지연/겹침 요약(`adTiming`)·오류 목록(`errorList`)·`isComplete`·영상 끝 시각(`videoEndedWallMs`) |
| `transcript.json`·`transcript.txt` | ASR 발화(원본 영상 시각). **A 조건 입력**. `transcript.json` 발화에는 서버가 고른 언어(`detectedLanguage`, `ko`·`en`)가 있으면 붙는다 |
| `ad-timeline.json` | 들린 해설마다 사건 시각(`eventMediaMs`)·들린 자리(`playedMediaMs`)·녹음 위치(`outputMs`)·길이·지연(`latencyMs`)·겹친 발화(`overlapSpeechMs`)·근거, 그리고 버려진 해설과 사유(`droppedList`). 사유는 렌더러가 알린 것(`no_audio` = TTS 합성 실패, `delay_exceeded`·`leader_cancelled`·`dwell_cancelled`·`emit_failed`·`stopped`·`expired`·`slide_changed`·`interrupted`·`feature_off`), main 이 내보내지 않은 것(`feature_off`·`rate-limited`·`duplicate:…` 등), 알림 없이 들리지 않은 것(`not_played`)이다 |
| `ad.srt` | AD 자막 |
| `s-condition.txt` | 전사와 AD 를 들린 순서대로 합친 글. **S 조건 입력** |
| `output-audio.webm` | 사용자가 들은 소리 그대로(스테레오: 동시 모드는 해설 왼쪽·회의 오른쪽). **사람 평가용** |
| `slides/`·`slides.json` | 슬라이드별 대표 이미지와 시작 시각. **C 조건 입력** |
| `pipeline.jsonl` | 그 세션의 원본 기록(디버깅용) |
| `flow.json` | 해설 결정마다 묶은 흐름(`flowList`: 유형·사건 시각 `eventMediaMs`(ad-timeline 과 같은 변환, 해설이 없으면 입력 발화의 전사 시각)·결정 시각 `mediaMs`·단계 `stepList`·결과 `outcome` 재생됨/버려짐/막힘/결과 없음과 이유, 해설이 둘 이상이면 `outcome.captionList` 에 해설마다의 결과), 세션 수준 기록(`sessionInfoList`), 전사 줄(`asrList`). `pipeline.jsonl` 의 debug 기록으로 만든다 |

`run.json.asrLanguageApplied` 는 고른 회의 언어가 실제로 실렸는지의 근거다.

| 칸 | 뜻 |
|---|---|
| `sessionLanguage` | production 화면이 캡처를 시작할 때 파이프라인에 넘긴 회의 언어 |
| `requestLanguageCountMap` | ASR 요청에 실린 언어별 조각 수(`pipeline.jsonl` asr 기록의 `language`) |
| `detectedLanguageCountMap` | 서버가 고른 언어별 조각 수(asr 기록의 `detectedLanguage`). 자동이면 영어 영상은 `en` 이 나와야 한다 |
| `isMatched` | 위 두 언어가 모두 `asrLanguage` 와 같으면 `true`, 다르면 `false`(`asr_language_mismatch`), 근거가 없으면 `null` |

`run.json.isComplete` 가 `false` 면 결과물에 빠진 것이 있다. `errorList` 의 `code` 를 본다. 아래 코드가 하나라도 있으면 `false` 다.

| 코드 | 뜻 |
|---|---|
| `roi_missing` | production 화면이 재생 화면 ROI 를 받지 못해 시작할 수 없었다 |
| `capture_failed` | production 화면이 재생 화면 캡처를 시작하지 못했거나 정지 전에 캡처가 끝났다 |
| `start_failed` | 결과 폴더를 만든 뒤 시작을 마치지 못했다(녹음 시작이 10초, 시작 버튼·LIVE 확인·재생 호출이 3초 안에 응답하지 않음 등) |
| `output_record_failed` | viewer 소리 녹음을 시작·정지·쓰기 하지 못했다(녹음 끝부분이 빠졌을 수 있다) |
| `no_output_audio` | `output-audio.webm` 이 비었다 |
| `no_playback_report` | 해설은 왔는데 들린 기록(재생 시작 알림)이 하나도 없다 — 대개 TTS 서버 문제 |
| `no_player_time` | 재생 화면 시각 보고가 없다(원본 시각으로 바꿀 수 없다) |
| `session_unknown` | 파이프라인 세션 ID·기록 파일을 받지 못했다 |
| `record_read_failed` | 세션 기록(`pipeline.jsonl` 원본)을 읽지 못했다 |
| `session_end_timeout` | 파이프라인 세션이 60초 안에 닫히지 않았다(세션 기록 끝부분이 빠졌을 수 있다) |
| `write_failed` | 결과 파일을 쓰지 못했다 |
| `asr_language_mismatch` | 고른 회의 언어로 전사되지 않았다(production 화면이 다른 회의 언어로 캡처를 시작함). 전사·해설이 고른 언어 기준이 아니다 |

`record_line_broken`(세션 기록의 깨진 줄을 건너뜀)·`slide_copy_failed`(슬라이드 이미지 복사 실패)·`page_unresponsive`(마무리 중 화면 응답 없음)·`flow_failed`(`flow.json` 을 만들거나 쓰지 못함)는 `errorList` 에 남지만 그것만으로는 `isComplete` 를 `false` 로 만들지 않는다.

결과 폴더를 만들기 전에 실패하면 폴더가 생기지 않고 조작 바 상태 줄(`[failed] <이유> · 오류 <코드>`)에만 나온다.

| 코드 | 언제 |
|---|---|
| `viewer_reload_failed` | production 화면을 15초 안에 다시 불러오지 못했다 |
| `mode_select_failed` | production 화면을 고른 모드로 바꾸지 못했다 |
| `video_load_failed` | 영상을 불러오다 오류가 났다(없는 파일·재생할 수 없는 형식 등) |
| `start_failed` | 화면 호출이 제한 시간 안에 응답하지 않았다(모드 선택·ROI 편집 끄기 3초, 영상 불러오기 30초), 또는 결과 폴더를 만들지 못했다 |

결과 폴더를 만든 뒤 마무리(결과 파일 쓰기) 자체가 예외로 끝나면 `finalize_failed` 다. 상태 줄에 `결과 폴더를 쓰지 못했다: …` 가 나오고, 폴더는 있지만 `run.json` 이 남지 않는다(다른 파일은 일부만 있을 수 있다). 그 폴더는 평가에 쓰지 않는다.

**실행마다 확인**: `transcript.txt` 가 비지 않았는지 본다. ASR 서버가 죽어 있으면 전사가 비는데, 전사가 없는 것은 오류로 세지 않으므로 `isComplete=true` 로 남는다. 전사가 비었으면 0-3 의 ASR 확인부터 다시 하고 돌린다. 해설이 하나도 없으면(`ad-timeline.json` 의 `adList` 가 빔) `droppedList` 의 사유도 본다.

확인용 영상(실회의 슬라이드 5장 + macOS 음성 Yuna, 약 1분)은 `out/lab-samples/sample-5slides.mp4` 다. 영상 파일은 저장소에 없으므로(mp4 는 gitignore) 슬라이드 이미지 폴더로 직접 만든다.

```bash
tools/lab/make-sample-video.sh <슬라이드 폴더>
```

- 슬라이드 폴더는 `slide-1` … `slide-5` 아래 `base.jpg` 가 있는 폴더다. 앱을 돌리면 `out/slides/session-<id>/` 에 같은 구조로 남는다. 첫 인자는 꼭 준다. 주지 않거나 폴더에 이미지가 없으면 사용법(없으면 없는 이미지도)을 찍고 멈춘다(종료 코드 2).
- 결과는 `out/lab-samples/sample-5slides.mp4` 와 구간 시각 `out/lab-samples/sample-5slides.script.json` 이다. 둘째 인자로 다른 출력 경로를 줄 수 있다.
- ffmpeg 와 macOS 한국어 음성 Yuna 가 필요하다. Yuna 가 없으면 시스템 설정의 손쉬운 사용 → 읽기 및 말하기에서 받아 두거나, `SEEON_SAMPLE_VOICE=<다른 한국어 음성>` 으로 바꾼다.
- 샘플 문항(`docs/eval/samples/questions.sample.json`)과 사람 작성 AD 는 확인용 슬라이드 기준이다. 다른 슬라이드로 만든 영상에는 맞지 않는다.

손 대지 않고 한 번 돌리려면:

```bash
SEEON_LAB_AUTORUN=out/lab-samples/sample-5slides.mp4 npm run lab
```

| 환경 변수 | 뜻 |
|---|---|
| `SEEON_LAB_AUTORUN` | 영상 경로. 창이 뜬 뒤 바로 시작한다 |
| `SEEON_LAB_MODE` | `delayed`·`listening`·`realtime_sic`·`realtime_mix`. 없으면 평가 설정에 따라 균형(끄면 동시) |
| `SEEON_LAB_EVAL_PRESET=false` | 평가 설정을 끄고 돌린다 |
| `SEEON_LAB_ASR_LANGUAGE` | 회의 언어 `ko`·`en`·`auto`. 없으면 `ko`, 그 밖의 값이면 `[lab] … 고를 수 없는 회의 언어다` 를 찍고 `ko` 로 돈다. 영어 영상은 `en` 또는 `auto` |
| `SEEON_LAB_EXIT_ON_DONE=false` | 끝나도 앱을 닫지 않는다 |
| `SEEON_LAB_WINDOW` | 창 크기 `<가로>x<세로>`(예 `1600x900`, 없으면 `1920x1080`). 자동 실행이 아니어도 쓴다 |

자동 실행이 끝나는 꼴은 셋이다. `SEEON_LAB_EXIT_ON_DONE=false` 면 앱을 닫지 않고, 시작 실패는 터미널에 찍지 않고 조작 바 상태 줄에만 나온다.

- 끝까지 돌고 빠진 것이 없음: `[lab] 결과 폴더 <경로> (완료=true)` 를 찍고 종료 코드 0 으로 닫는다.
- 결과 폴더를 만든 뒤 실패했거나 빠진 것이 있음: `[lab] 결과 폴더 <경로> (완료=false · 오류 <코드,…>)` 를 찍고 종료 코드 1 로 닫는다(`finalize_failed` 도 여기다).
- 결과 폴더를 만들기 전에 실패함: `[lab] 자동 실행 시작 실패: <이유>` 를 찍고 종료 코드 1 로 닫는다. 결과 폴더는 없다.

### 3-1. Windows 설치본(SEEON Lab)
- 맥에서 `npm run dist:win:kit -- --app lab --env <.env> --label <받는사람>` 로 만든다. 기준은 `origin/experiment`(`--ref` 로 바꿈)이고, 바탕화면에 `SEEON-Lab-Windows-<시각>-<커밋>-<받는사람>.zip`(설치 파일 + 안내문 + 버전)이 생긴다. 설치 파일에는 GPU 터널 키·Bedrock 토큰이 들어 있으니 공개된 곳에 올리지 않는다.
- 설치본은 제품 SEEON 과 앱 이름·appId 가 달라(`SEEON Lab`, `kr.seeon.lab`) 한 PC 에 함께 설치된다. 결과 폴더는 `%APPDATA%\seeon-lab\out\lab` 이다(조작 바 **결과 폴더** 로 연다). 설치본에는 git 이 없어 `run.json.git` 은 비어 있다.

## 4. 3.2 이해도 평가

1. 문항 필터(문항 준비 단계). "제공된 자료만" 지시 없이 N(문항만)·V(슬라이드 이미지만)·C(전사+슬라이드)로 묻는다. 필터는 반복 1회로 돈다.

   ```bash
   node tools/eval/e2e-eval.mjs --questions out/eval/my-questions.json --run v1=out/lab/<실행 폴더> --filter N,V,C
   ```

   `out/eval/e2e-filter-<시각>/report.md` 의 폐기 문항(N·V 로 풀림, C 로 못 풂)을 문항 셋에서 빼거나 고친다. 같은 폴더에 `filter.json`(문항별 결정과 이유, 결정별 개수 `decisionCountMap`)·`answers.jsonl` 이 남는다.

   문항 결정은 셋이다. **폐기**: 폐기 사유가 하나라도 있다. **판단 못 함**(`undecided`): 폐기 사유는 없지만 응답 오류·자료 없음(예: 슬라이드가 없어 V 를 건너뜀)으로 판단하지 못한 필터가 있다. **유지**: 고른 필터가 모두 판단했고 폐기 사유가 없다. 판단 못 함은 유지로 세지 않으니, 다시 돌리거나 직접 보고 정한다.

2. 평가.

   ```bash
   node tools/eval/e2e-eval.mjs --questions out/eval/my-questions.json --run v1=out/lab/<실행 폴더> --run v2=out/lab/<실행 폴더> --repeat 3
   ```

   | 옵션 | 기본 | 뜻 |
   |---|---|---|
   | `--run` | 문항 셋의 `videoList[].runDir` | `<videoId>=<결과 폴더>`. 영상마다 하나씩 준다. 문항 셋의 `runDir` 보다 앞선다 |
   | `--condition` | `A,S,H,C` | A 전사 · S 전사+SEEON AD · H 전사+사람 작성 AD · C 전사+슬라이드 이미지 |
   | `--model` | `.env` 의 Bedrock 모델 | 답변 모델. 문항 생성 모델과 같으면 경고한다 |
   | `--max-slides` | 20 | C·V 조건에 넣는 슬라이드 최대 장수(많으면 처음·끝을 남기고 고르게 고른다) |
   | `--repeat`·`--concurrency`·`--cache`/`--no-cache`·`--out-dir` | 1·4·`out/eval/cache/e2e`·`out/eval/e2e-<시각>` | 3.1 도구와 같다. 요청이 실패했거나 답을 못 읽은 응답은 캐시에 넣지 않아 같은 명령을 다시 돌리면 그것만 다시 묻는다 |

   옵션은 3.1 도구처럼 엄격하게 읽는다. 모르는 조건·필터 글자, `<videoId>=<폴더>` 꼴이 아닌 `--run`, 1 이상의 정수가 아닌 `--repeat`·`--concurrency`·`--max-slides` 는 Bedrock 을 부르기 전에 멈춘다(종료 코드 2). 결과 폴더를 읽지 못한 영상은 멈추지 않고 그 영상의 조건만 건너뛰고 이유를 남긴다.

   종료 코드(평가·필터 같다)

   | 코드 | 언제 |
   |---|---|
   | 0 | 끝까지 돌았고 Bedrock 요청이 하나도 실패하지 않았다(답을 못 읽은 응답 오류·건너뛴 조합은 결과에 세고 0 이다) |
   | 1 | 토큰이 없거나 문항 셋을 읽지 못했거나 형식 오류다. 또는 Bedrock 요청이 실패한 답이 있다 — 이때도 결과 폴더는 쓰고, 마지막 줄 `[e2e] 실패: Bedrock 요청 N건이 실패했다 …`(첫 오류 내용 포함)와 `report.md` 맨 위 "주의" 줄로 알린다. GPU 서버 연결(터널)·토큰 만료·네트워크를 확인하고 같은 명령을 다시 돌린다. 실패한 요청은 캐시에 넣지 않으므로 다시 돌리면 그것만 다시 묻는다(그 결과 폴더는 새로 쓴 것을 쓴다) |
   | 2 | 옵션이 잘못됐다 |

3. 결과 `out/eval/e2e-<시각>/`

   | 파일 | 내용 |
   |---|---|
   | `report.md` | 결과 폴더 상태(실행 모드·전사 언어·영상 끝까지 갔는지·`isComplete`·전사 끝 시각), 조건별 정답률 CA·알 수 없음 비율·응답 오류·글 답에서 읽은 수, 도달률 S÷C, 도달률 증가폭 (S−A)÷C, Accuracy Ratio (S−A)÷(H−A), 도메인 × 조각/통합 × 소분류 표, 화면 자료(보낸 슬라이드 수와 줄인 이유), 건너뛴 조합 |
   | `metrics.json` | 같은 수치와 실행 정보(`runInfo`: 모델·결과 폴더 상태·Bedrock 한도·기준 커밋) |
   | `answers.jsonl` | 문항×조건×반복마다 답 번호·원문·근거·읽은 곳(`source`)·종료 사유 |
   | `answers.csv` | 혼합효과 모형용 긴 형식(아래) |

   - 답변 프롬프트는 답을 JSON 한 줄(`{"answer": 보기 번호 1~5, "reason": "근거 한 문장"}`)로 내라고 한다. JSON 의 `answer` 가 있으면 그 값만으로 읽는다.
   - JSON 이 아닌 글 답은 **답 전체가** 번호 꼴(`3`·`3번`·`보기 3번`·`정답은 3번입니다`·`정답: 3`·`The answer is 3`)이거나 보기 글 그대로일 때만 읽는다. 글 안에서 번호를 찾지 않으므로 그 밖의 글 답, 1~5 밖의 번호, 번호와 보기 글이 다른 보기를 가리키는 답, 숫자 보기와 헷갈리는 번호는 모두 **응답 오류**다.
   - `answers.jsonl` 의 `source` 는 답을 읽은 곳(`json`·`text`, 못 읽었으면 `null`)이다. `report.md` 조건 표의 "글 답에서 읽음"이 `text` 개수다(정답률에 들어간다). 많으면 답변 모델이 형식을 어기는 것이다.
   - "알 수 없음"은 오답이다. 응답 오류는 따로 세고 정답률 분모에서 뺀다("그중 요청 실패"는 Bedrock 요청 자체가 실패한 수).
   - 도달률 S÷C 는 같은 문항·반복에서 S·C 가 모두 답한 짝끼리, 증가폭 (S−A)÷C 는 A·S·C 가 모두 답한 짝끼리 센다. 짝 수는 `report.md` 에 `n=` 으로, `metrics.json` 에 `reachPairCount`·`reachGainPairCount` 로 남는다. C 를 건너뛴 영상(슬라이드 없음·결과 폴더 못 읽음)이나 응답 오류인 문항은 짝에서 빠지므로, 조건 표의 CA 로 바로 나눈 값과 다를 수 있다.
   - 문항 셋의 영상 언어(`videoList[].language`)와 결과 폴더의 회의 언어(`run.json.asrLanguage`)가 다르면(예: 영어 영상을 `ko` 로 돌린 결과) 실행 중 `[e2e] 주의: <영상> 영상 언어 en · 전사 언어 ko …` 줄과 결과 폴더 상태 표의 주의 칸, `report.md` 머리의 "전사 언어 주의" 줄로 알린다. `auto` 는 어느 영상 언어와도 맞는 것으로 본다. `asrLanguage` 가 없는 옛 결과 폴더는 회의 언어를 고르기 전 실행이라 `ko` 로 전사된 것으로 본다(표에 `ko (언어 지정 전)`). 영상 언어가 없으면 판단하지 않는다. 그 영상은 실험 창에서 회의 언어를 맞춰 다시 돌린다.
   - 잘린 실행(영상 끝 전에 정지한 결과 폴더, `run.json.videoEndedWallMs` 가 `null`)은 결과 폴더 상태 표와 실행 중 `[e2e] 주의:` 줄로 알린다. 그때 전사 끝 뒤에 있는 사람 작성 AD 는 H 조건만 받으므로 그 개수도 함께 적는다. 균형 모드가 아닌 결과 폴더, `isComplete=false` 인 결과 폴더도 같은 자리에 경고한다.
   - C·V 조건은 Bedrock 한도(메시지 하나에 이미지 20장, 한 장 3.75MB, 자료 전체 약 18MB)에 맞춘다. 한 장 한도를 넘거나 읽지 못한 슬라이드는 빼고, 20장을 넘으면 20장으로, 요청 크기가 넘으면 비율만큼 장수를 줄인다. 줄였으면 실행 중 `[e2e] 화면 자료 …` 줄과 `report.md` 화면 자료 표의 메모에 남는다.
   - C 조건은 LLM 이 영상 대신 슬라이드 이미지를 본다는 한계가 있다.

### answers.csv (LLM·사람 공통 칸)

| 칸 | 값 |
|---|---|
| `evaluator` | LLM 은 `LLM`, 사람은 `사람` |
| `participantId` | 사람 참여자 ID(LLM 은 비움) |
| `model` | 답변 모델(사람은 비움) |
| `repeat` | 반복 번호(1부터) |
| `videoId`·`domain`·`questionId`·`category`·`subcategory` | 문항 셋 그대로 |
| `condition` | `A`·`S`·`H`·`C` |
| `chosenIndex` | 고른 보기(0부터, 4 = 알 수 없음). 응답 오류면 비움 |
| `isUnknown` | 알 수 없음이면 1, 아니면 0. 응답 오류면 비움 |
| `isCorrect` | 맞으면 1, 틀리거나 알 수 없음이면 0. 응답 오류면 비움 |
| `isResponseError` | 답을 읽지 못했으면 1, 아니면 0 |

사람 응답도 같은 칸, 같은 순서로 적으면(`evaluator=사람`, `participantId` 채움, `model` 비움, `repeat=1`) 머리줄을 뺀 줄을 LLM 결과 뒤에 그대로 이어 붙여 문항×조건 단위 모형(모형 A/B, 부트스트랩)에 넣을 수 있다.

```bash
cp out/eval/e2e-<시각>/answers.csv out/eval/combined.csv
tail -n +2 out/eval/human-answers.csv >> out/eval/combined.csv   # human-answers.csv 도 같은 머리줄로 시작한다
```

파일은 UTF-8(BOM 없음), 줄 끝 `\n` 이다. 쉼표·따옴표·줄바꿈이 든 칸은 따옴표로 감싼다. 엑셀에서는 "데이터 → 텍스트/CSV 가져오기"로 UTF-8 을 골라 연다.

## 5. 사람 평가

`output-audio.webm` 을 기존 설문 도구에 올려 들려준다. 재생기가 길이를 못 읽으면 길이 정보만 다시 쓴다.

```bash
ffmpeg -i out/lab/<실행 폴더>/output-audio.webm -c copy out/lab/<실행 폴더>/output-audio.fixed.webm
```

## 6. 시연 창

조작 바 **시연 창**을 누르면 큰 글씨 AD 창이 열린다(보조 모니터로 옮길 수 있다). 해설이 들리기 시작할 때 분류 배지와 문장 카드가 쌓인다(최근 50장). 창이 열려 있는 동안 들린 해설만 받으므로 시작 전에 열어 둔다. `G` 근거 보이기·숨기기, `+`/`−` 글자 크기, `C` 지우기. 키는 자판 위치로 읽으므로 한글 입력 상태에서도 같다.

## 7. 알려진 한계

- **production 트리거와 평가 방법론 말주머니는 같은 목록이 아니다.** production 트리거(main `speech-trigger.js`)는 한국어를 Kiwi 품사 규칙으로, 영어를 규칙으로 5유형을 잡는다. 말주머니에만 있는 위치는 시스템 성능에서 trigger_miss 다. 어느 목록을 기준으로 삼을지는 팀이 정한다.
- **영어 영상은 회의 언어를 English 또는 자동으로 골라 돌린다.** 회의 언어를 고르기 전에 만든 결과 폴더(`run.json` 에 `asrLanguage` 가 없음)는 한국어로 전사된 것이라, 영어 영상이면 A·S·H·C 조건 모두 영향을 받는다. 3.2 도구가 영상 언어와 다르면 경고한다(4절). 회의 언어는 전사 언어만 바꾼다. 해설은 영어 영상에서도 한국어로 나온다. 트리거는 조각마다 한글·영어 낱말 수로 언어를 정해 영어 규칙으로 잡는다.
- **판단 응답이 잘리면 해설하지 않는다.** production 통합 라우터의 `max_tokens` 는 400 이다. 후보가 많아 응답이 잘리면(종료 사유 `max_tokens`) production 은 그 후보들을 X 로 둔다. 3.1 도구는 이것을 경로 오류로 따로 센다(2절).
- **C 조건은 슬라이드 이미지를 쓴다.** LLM 은 영상을 볼 수 없어 슬라이드 대표 이미지로 화면을 대신한다. 슬라이드가 아닌 화면(영상·판서)은 이미지가 부족할 수 있다.
- **실험 창 캡처 해상도 = 재생 화면 크기**다. 창이 디스플레이보다 크면 macOS 가 줄이므로(`run.json.layout`·`playerViewport` 로 확인) 평가 영상끼리 같은 모니터·같은 창 크기로 돌린다.
- 3.1 도구는 문장 단위로 트리거를 보고 문장마다 판단 LLM 을 부른다. production 은 1.5~3초 ASR 조각마다 보고, 후보가 나온 조각으로 결정을 만든 뒤 look-ahead(2~2.5초)와 판단 전 보류의 앞 2.5초(균형·품질 모드) 동안 들어온 조각의 후보를 그 결정에 합쳐 한 번에 판단한다. 그 뒤에 온 후보는 새 결정으로 따로 판단한다. 그래서 production 의 판단 하나가 여러 문장을 묶을 수 있는데, 3.1 도구는 이 조각 경계·합침 효과는 재현하지 않는다. 시각이 없는 전사는 어절(영어는 단어)당 0.45초로 추정한다.
