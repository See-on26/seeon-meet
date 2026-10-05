# 평가 셋 형식

실험 모드의 두 평가 도구가 읽는 파일 형식이다. 이 문서대로 만들고 `node tools/eval/validate.mjs <파일>` 로 검사한다. 검사기는 잘못된 칸을 줄 번호와 함께 알려 준다.

- 3.1 탐지 평가: `items.jsonl` (한 줄 = 전사 1건) → `extract` 가 후보 위치를 붙인 라벨 초안 → 사람이 정답을 채운 `labeled.jsonl`
- 3.2 이해도 평가: `questions.json` (영상 목록 + 문항 목록 + 사람 작성 AD)
- 샘플: `docs/eval/samples/detection-items.sample.jsonl`(평가 방법론 3.1.5 (3) 예시 16건: 한국어 14·영어 2), `docs/eval/samples/questions.sample.json`(확인용 영상 문항 4개)

샘플은 평가 방법론에 실린 예시를 그대로 옮긴 형식 확인용이다. **생성 틀이 아니다.** 예를 들어 p-04 는 아래 생성 원칙이 금하는 표면 단서("보시는 것처럼")를 담고 있고, 대부분 항목이 앞뒤 7초보다 훨씬 짧다(한두 문장). 평가 셋은 아래 생성 원칙과 길이를 따른다.

평가는 **교차 출력의 균형 모드**(production `delayed`)로 돌린다(팀 결정). 판정기 맥락 창은 **트리거 앞뒤 7초**다. 그래서 항목 하나는 트리거 문장과 그 앞뒤 약 7초 분량(어절·단어로 약 15개씩)의 발화로 만든다. 채점 도구는 기본으로 항목 전체를 앞 맥락·판정 발화·뒤 맥락으로 나눠 판정기에 준다. 공백을 해소하는 문맥(정답 X 의 근거)은 이 7초 안에 둔다.

평가 셋은 영어 약 70%·한국어 약 30% 로 만든다. 결과는 유형별과 함께 언어별로도 나온다.

## 1. 3.1 탐지 항목 `items.jsonl`

한 줄에 JSON 객체 하나. 빈 줄은 건너뛴다.

```json
{"id":"d-001","language":"ko","domain":"강의","pairId":"p-01","targetType":"demonstrative","resolution":"none","generatorModel":"gpt-5","transcript":"자, 다음으로 넘어가 볼게요. 이 부분에서 오류가 제일 많이 납니다.","targetTrigger":"이 부분","isTargetGap":true,"targetRationale":"\"이 부분\"이 무엇인지 앞뒤 발화에 없음"}
```

| 칸 | 필수 | 값 |
|---|---|---|
| `id` | O | 항목 ID. 파일 안에서 겹치면 안 된다 |
| `language` | O | `ko`(한국어) 또는 `en`(영어). 말주머니 대조 방법이 언어마다 다르다 |
| `domain` | O | 강의·발표·보고·뉴스·회의 등 |
| `pairId` | O | 최소 대립쌍 묶음 ID. 같은 트리거 문장에 앞뒤 문맥만 바꾼 O/X 쌍이 같은 값을 쓴다. 묶음 크기는 2건이 보통이지만 정해져 있지 않다: 경계 사례(`boundary`)는 혼자 1건으로 둘 수 있고(샘플 p-07), 무발화처럼 트리거(무음 구간)만 같고 앞 문맥이 다른 `none`·`before`·`boundary` 3건을 한 묶음으로 둘 수도 있다(샘플 p-08). 검사기는 묶음 크기를 보지 않는다 |
| `targetType` | O | `demonstrative`(2-1 지시대명사)·`adjective_noun`(2-2 형용사+지시 명사)·`value`(3-1 단순 수치)·`change`(3-2 변화·비교·결론)·`scale`(3-3 추상적 척도)·`silence`(4-1 무발화) |
| `resolution` | O | 해소 위치. `before`(앞 발화에서 해소)·`after`(뒤 발화에서 해소)·`none`(해소 안 됨)·`boundary`(경계 사례) |
| `generatorModel` | 권장 | 전사를 만든 모델. 판정 모델과 같은 계열이면 안 된다(3.1.5 (2)) |
| `transcript` | O | 트리거 문장과 그 앞뒤 약 7초씩 분량의 전사문. 무발화는 `[무발화 7초]` 처럼 길이와 함께 쓴다. `silence` 유형은 5초 이상 표시가 하나 이상 있어야 한다 |
| `targetTrigger` | 선택 | 생성할 때 목표로 삼은 트리거 글자. 전사에 나온 꼴 그대로 적는다(조사·어미가 붙어 있으면 붙인 채로, 예: `싼 쪽으로`·`30%예요`). 무발화면 `[무발화 7초]` 그대로 |
| `isTargetGap` | 선택 | 목표 트리거의 정답 ②(공백이면 `true`, 아니면 `false`). `targetTrigger` 와 함께 쓴다 |
| `targetRationale` | 선택 | 목표 트리거의 정답 ③(근거) |
| `utteranceList` | 선택 | `[{ "text", "startMs", "endMs" }]`. 있으면 문장 나누기·시각 추정 대신 이것을 쓴다. 각 `text` 는 전사에 순서대로 들어 있어야 한다. `startMs`·`endMs` 는 0 이상의 숫자이고 `endMs ≥ startMs`, 발화는 `startMs` 오름차순으로 적는다 |

`targetTrigger`·`isTargetGap`·`targetRationale` 을 적어 두면 `extract` 가 목표 위치의 정답 칸을 미리 채운다. 생성 모델이 이미 아는 정답을 다시 손으로 옮기지 않게 하려는 것이다. 목표 위치는 전사에서 `targetTrigger` 가 나오는 글자 범위와 겹치는 **같은 유형**(`targetType`) 후보다. 후보의 범위가 `targetTrigger` 와 꼭 같을 필요는 없다("싼 쪽으로" 를 적으면 후보 "싼 쪽" 에 채운다). 겹치는 같은 유형 후보가 없으면 채우지 않고 `extract` 요약의 "목표 트리거가 후보로 뽑히지 않은 항목"에 나온다.

`targetTrigger` 가 전사에 여러 번 나오면 다음 순서로 한 자리를 고른다.

1. 겹치는 같은 유형 후보가 낱말 경계(전사 처음, 띄어쓰기·문장부호 뒤)에서 시작하는 자리만 본다. "회의는 10분이거든요. 이거 보시면" 에서 `이거` 는 "분이거든요" 안이 아니라 뒤의 "이거" 다.
2. 그중 적힌 꼴 그대로 한 낱말인 자리(앞뒤가 낱말 경계)를 앞세운다. "저기요, 잠깐만요. 저기 보이는" 에서 `저기` 는 "저기요" 가 아니라 "저기" 다.
3. 그다음 후보 범위가 `targetTrigger` 와 더 같은 자리를 앞세운다.

그래도 가장 나은 자리가 둘 이상이면(같은 표현이 두 번 나옴), 또는 겹치는 같은 유형 후보는 있지만 낱말 경계에서 시작하는 후보가 하나도 없으면(모두 다른 낱말 안) **미리 채우지 않고** `extract` 요약의 "목표 트리거가 여러 번 나와 미리 채우지 않음"에 항목 id 가 나온다. 이때는 `targetTrigger` 를 조사·어미까지 붙여 한 번만 나오는 꼴로 적거나(예: `이 부분` 대신 `이 부분을`) 라벨 파일에서 손으로 채운다. 목표가 아닌 위치(생성된 문장에 섞인 "이제", "그 방법" 같은 일치)는 비워 둔 채로 나온다.

시각이 없는 전사는 문장 끝(`.` `?` `!` `…`)으로 발화를 나누고 어절당 0.45초로 말한다고 본다. `[무발화 N초]` 는 N초를 더한다.

### 생성 원칙 (평가 방법론 3.1.5 (2))

- 최소 대립쌍: 트리거 문장은 그대로 두고 앞뒤 문맥만 바꿔 O/X 쌍을 만든다. "보시다시피"·"앞서 말씀드린" 같은 표면 단서를 붙이지 않는다.
- 해소 위치 다양화: 유형마다 before·after·none·boundary 네 칸의 개수를 정해 만든다. 해소 문맥은 트리거 앞뒤 7초(어절로 약 15개) 안에 둔다.
- 구어체: 간투사("어", "음"), 반복, 말줄임을 넣는다.
- 생성 모델과 판정 모델을 분리한다(판정 모델은 GPU 서버의 Gemma 4 26B-A4B 이고, GPU 가 실패해도 Claude 로 넘기지 않는다).

### 트리거 말주머니 (평가 방법론 3.1.4)

| 유형 | 한국어 | 영어 |
|---|---|---|
| 2-1 지시대명사 | 관형사 이·그·저, 대명사 이것·그것·저것·여기·거기·저기, 부사 이렇게·그렇게·저렇게, 구어 요거·요기 | this, that, these, those, here, there |
| 2-2 형용사+지시 명사 | 형용사 관형형(빨간·싼·어두운·큰 등) + 쪽·부분·거·것·곳 | the + 형용사 + one / side / part |
| 3-1 단순 수치 | 숫자 + 단위(%, 배, 명, 원 등) | number + unit (%, percent, times, people, dollars 등) |
| 3-2 변화·비교·결론 | 올랐다·떨어졌다·늘었다·줄었다, 더 높다·~에 비해, 결국·따라서 | increased, dropped, higher than, compared to, so, in the end |
| 3-3 추상적 척도 | 크다·작다·길다·짧다·넓다·많다·적다 | big, small, long, short, wide, many, few |
| 4-1 무발화 | 5초 이상 무음 구간(시간 조건) | 같다 |

한국어는 글자가 아니라 형태소 분석(Kiwi) 후 품사 단위로 대조한다. 영어는 단어 경계·대소문자 무시로 대조하고, 적힌 꼴만 잡는다(increased 는 잡고 increase 는 잡지 않는다).

production 트리거(main `src/main/caption-pipeline/trigger/speech-trigger.js`)는 이 말주머니와 같은 목록이 아니다. 같은 5유형(무발화는 시간 조건)을 한국어는 Kiwi 형태소 분석 뒤 품사 규칙으로, 영어는 규칙(낱말 목록·정규식)으로 잡는다. 예를 들어 숫자는 단위가 붙어야 3-1 이고, "그 때"·"이 정도"처럼 시간·정도를 가리키는 말이나 "I think that …" 의 that 은 2-1 이 아니다. 말주머니에만 있는 위치는 시스템 성능의 "트리거 누락"으로 측정만 한다. 어느 목록을 기준으로 삼을지는 팀이 정할 일이라 평가 도구는 말주머니를 바꾸지 않는다.

## 2. 3.1 라벨 `labeled.jsonl`

`node tools/eval/detection-eval.mjs extract --in items.jsonl --out labeling.jsonl` 가 항목마다 후보 위치를 붙여 준다. 후보 = production 트리거(발화마다 돌린다) ∪ 평가 방법론 말주머니(3.1.4) ∪ `[무발화 N초]`(N ≥ 5).

```json
"positionList":[{"posId":"demonstrative@17-21","type":"demonstrative","start":17,"end":21,"trigger":"이 부분","sourceList":["production","methodology"],"isApproximate":false,"isGap":null,"rationale":""}]
```

| 칸 | 뜻 |
|---|---|
| `posId` | 위치 ID(유형@시작-끝). 고치지 않는다 |
| `type` | 그 위치의 유형 |
| `start`·`end` | 전사 원문 기준 글자 위치(0부터, end 는 포함 안 함). `trigger` 는 `transcript.slice(start, end)` 와 같아야 한다 |
| `sourceList` | 그 위치를 잡은 쪽. `production`(제품 트리거)·`methodology`(평가 방법론 말주머니) |
| `isApproximate` | `true` 면 Kiwi 없이 어절 경계로 근사한 말주머니 결과다 |
| `isGap` | **사람이 채운다.** 공백이면 `true`, 아니면 `false`. 판단하지 않을 위치는 `null` 로 둔다(채점에서 빠지고 진행률로만 센다) |
| `rationale` | 정답 근거(정답 ③). 오류 분석에 쓴다 |

라벨을 다 붙인 뒤 `node tools/eval/validate.mjs labeled.jsonl --labeled` 로 검사한다.

예전 초안의 `isProductionFired` 칸(조각마다 첫 일치 1건만 발동하던 옛 트리거와 겹치는지)은 더 쓰지 않는다. 지금 production 은 조각에서 뽑은 후보 구를 모두 판단 LLM 에 넘기고 후보마다 공백(O)인지 가린다. 칸이 남아 있어도 검사·채점은 그대로 된다.

채점(`score`)은 라벨 위치를 그때의 production 트리거·말주머니로 다시 뽑은 후보와 **구간 겹침**으로 대조한다. production 을 받아온 뒤 트리거가 바뀌어도 라벨은 그대로 쓸 수 있고, 라벨 파일에 없는 새 후보는 개수만 보고된다.

## 3. 3.2 문항 셋 `questions.json`

```json
{"generatorModel":"gpt-5",
 "videoList":[{"videoId":"v1","domain":"발표","file":"v1.mp4","runDir":"out/lab/20261005-140309-v1",
   "humanAdList":[{"startMs":12000,"text":"막대그래프: 재구매율 30%"}]}],
 "questionList":[{"id":"q1","videoId":"v1","category":"조각","subcategory":"수치 의미 파악",
   "question":"발표자가 말한 30%는 무엇의 수치인가?","choiceList":["재구매율","이탈률","전환율","응답률"],"answerIndex":0}]}
```

| 칸 | 필수 | 값 |
|---|---|---|
| `generatorModel` | O | 문항을 만든 모델. 답변 모델과 같으면 도구가 경고한다 |
| `videoList[].videoId` | O | 영상 ID. 겹치면 안 된다 |
| `videoList[].domain` | O | 보고 단위의 도메인 |
| `videoList[].file` | O | 원본 영상 파일 경로(기록용) |
| `videoList[].runDir` | 선택 | 실험 모드 결과 폴더. 명령의 `--run <videoId>=<폴더>` 가 앞선다 |
| `videoList[].language` | 선택 | `ko`·`en`. 있으면 보고서가 언어별로도 나누고, 결과 폴더의 회의 언어(`run.json.asrLanguage`)와 다르면 경고한다(`auto` 는 어느 언어와도 맞고, `asrLanguage` 가 없는 옛 결과 폴더는 `ko` 로 본다) |
| `videoList[].humanAdList` | 선택 | 사람 작성 AD `[{ "startMs", "text" }]`(원본 영상 시각). 없으면 그 영상은 H 조건을 건너뛴다 |
| `questionList[].id` | O | 문항 ID. 겹치면 안 된다 |
| `questionList[].videoId` | O | `videoList` 에 있는 영상 |
| `questionList[].category` | O | `조각` 또는 `통합`. 소분류와 맞아야 한다 |
| `questionList[].subcategory` | O | 조각: `지시 대상 파악`·`수치 의미 파악`·`변화·비교 파악`·`정도 파악` / 통합: `교차 조회`·`교차 대조` |
| `questionList[].question` | O | 문항. 화면을 가리킬 때는 발화를 인용한다("하늘색 선" 같은 화면 어휘를 쓰지 않는다) |
| `questionList[].choiceList` | O | 빈 값 없는 보기 4개. 같은 보기를 두 번 쓰면 안 된다(앞뒤 공백은 무시하고 견준다). "알 수 없음"은 넣지 않는다(도구가 5번째 보기로 붙인다) |
| `questionList[].answerIndex` | O | 정답 보기 번호(0부터) |

문항 작성 원칙은 평가 방법론 3.2.3 을 따른다: 정답 사실은 모두 영상 안(발화 또는 화면)에 있어야 하고, 보기에는 "발화만으로 걸러지는 오답"과 "화면이 있어야 걸러지는 오답"을 섞는다.
