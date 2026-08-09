const { ensureUsPrefix, buildInferenceConfig } = require('../router/deixis-judge');
const { NARRATION_TYPE_MAP } = require('../contracts/narration-types');

const REQUEST_TIMEOUT_MS = 12000;
const MAX_GAP_TOKENS = 120;

const GAP_SOURCE_MAP = {
  bedrock: 'bedrock',
  fallback: 'fallback',
  none: 'none',
};

const BOUNDARY_KIND_MAP = {
  complete: 'complete',
  pause: 'pause',
};

const BOUNDARY_KIND_LABEL_MAP = {
  [BOUNDARY_KIND_MAP.complete]: '완결',
  [BOUNDARY_KIND_MAP.pause]: '중단',
};

const GAP_SYSTEM_PROMPT = [
  '너는 시각장애인용 회의 캡션 시스템의 "삽입 위치 결정자"다.',
  '이미 만들어진 내레이션 하나를 회의 음성의 **어느 틈에 끼워 넣을지** 고른다.',
  '내레이션의 내용은 바꾸지 않는다. 위치만 고른다.',
  '',
  '── 삽입이 일어나는 방식 (이걸 알아야 판단이 선다) ──',
  '· 삽입 지점에 도달하면 회의 영상이 **정지**하고 내레이션만 단독으로 재생된 뒤 다시 이어진다.',
  '  그래서 내레이션이 회의 음성을 덮을 걱정은 없다. **무음이 짧아도 넣을 수 있다.**',
  '· 대신 **문장 한가운데서 멈추면** 청자는 끊긴 문장을 듣고, 내레이션이 끝난 뒤에야 나머지를 듣는다.',
  '  이것이 이 판단에서 피해야 할 가장 큰 사고다.',
  '· 청자는 화면을 볼 수 없다. 내레이션은 그 순간의 화면을 설명하므로 **그 대상이 화제인 동안**',
  '  들어가야 한다. 너무 늦으면 이야기가 이미 넘어가 무엇에 대한 설명인지 알 수 없다.',
  '',
  '── 판단 기준 (앞이 우선) ──',
  '1. **문장이 끝난 지점을 고른다.** 끝맺음=완결 > 중단. 완결 후보가 있으면 중단 후보를 고르지 마라.',
  '2. **그 대상을 발표자가 이어서 설명하기 시작하면 그 앞에 넣는다.**',
  '   설명이 끝난 뒤에 넣으면 청자는 이미 들은 이야기의 그림을 뒤늦게 받는다.',
  '3. **화제가 바뀌는 지점을 넘기지 마라.** 뒤 발화가 다른 대상·다음 페이지로 넘어갔다면',
  '   그 전환보다 **앞선** 틈이어야 한다.',
  '4. 1~3이 같다면 **트리거에 가까운 쪽**을 고른다. 설명은 이를수록 좋다.',
  '5. 그래도 같다면 무음이 긴 쪽이 자연스럽다.',
  '',
  '── 트리거보다 앞선 틈(음수 시각) ──',
  `**${NARRATION_TYPE_MAP.speakerIdentity}에만 허용된다.** "누가 말하는지"는 그 사람이 입을 열기`,
  '전에 알려 줘야 맥락이 된다.',
  '다른 유형은 음수 후보를 고르지 마라 — 그 시점에는 설명할 화면·발화가 아직 나오지 않았다.',
  '화면 전환 고지를 전환 전에 넣으면 아직 뜨지도 않은 화면을 설명하는 셈이다.',
  '양수 후보가 하나도 없으면 gapIndex를 null로 두어라.',
  '',
  '── 내레이션 유형별 원칙 (제품 정의 5.1) ──',
  `· ${NARRATION_TYPE_MAP.pageTransition}: 화면이 바뀐 직후 **가장 이른** 완결 지점.`,
  '  이 고지는 뒤따르는 내용 캡션의 맥락이라 늦으면 그 뒤 캡션까지 함께 무너진다.',
  `· ${NARRATION_TYPE_MAP.speakerIdentity}: 그 사람이 말을 시작하기 **직전** 틈이 가장 좋다.`,
  '  이미 말이 시작된 뒤라면 첫 완결 지점.',
  `· ${NARRATION_TYPE_MAP.deixis} / ${NARRATION_TYPE_MAP.interpretation} / ${NARRATION_TYPE_MAP.visualDescription}:`,
  '  지시어·수치·척도 표현이 들어 있는 **그 문장이 끝난 직후**가 기본값이다.',
  '  즉 트리거 발화가 끝나는 첫 완결 지점. 그보다 뒤를 고르려면 기준 2·3에 해당하는 이유가 있어야 한다.',
  `· ${NARRATION_TYPE_MAP.userCommand}: 사용자가 방금 물었다. **가장 이른** 지점.`,
  '',
  '── 출력 ──',
  'JSON 한 줄만 출력한다(다른 텍스트 금지): {"gapIndex": 번호, "reason": "고른 이유 한 구절"}',
  '문장 중간뿐이라 넣을 만한 틈이 하나도 없으면 {"gapIndex": null, "reason": "..."}를 출력한다.',
  '  (그러면 시스템이 트리거 지점에 그대로 넣는다 — 위치를 못 고르는 것이 캡션을 버리는 것보다 낫다.)',
].join('\n');

const FEW_SHOT_LIST = [
  {
    input: {
      narrationText: '3년간 물류비 추이 표를 보는 중',
      narrationType: NARRATION_TYPE_MAP.deixis,
      subKind: 'simple',
      rationale: '발화="여기 이 표를 보시면" · 근거 표현="이 표"',
      screenSummary: '슬라이드 4 — 물류비 추이 표 1개',
      gapList: [
        { offsetMs: 300, kind: BOUNDARY_KIND_MAP.pause, silenceMs: 600, beforeText: '여기 이 표를 보시면', afterText: '3년치 물류비인데요' },
        { offsetMs: 2400, kind: BOUNDARY_KIND_MAP.complete, silenceMs: 900, beforeText: '3년치 물류비인데요', afterText: '작년에 크게 늘었습니다' },
        { offsetMs: 6100, kind: BOUNDARY_KIND_MAP.complete, silenceMs: 1400, beforeText: '작년에 크게 늘었습니다', afterText: '다음 장으로 가겠습니다' },
      ],
    },
    output: { gapIndex: 1, reason: '지시 문장이 끝나는 첫 완결 지점' },
  },
  {
    input: {
      narrationText: '이미지 제시, 컨테이너가 가득 쌓인 항만',
      narrationType: NARRATION_TYPE_MAP.visualDescription,
      subKind: 'reaction',
      rationale: '사진 단독 제시 화면',
      screenSummary: '슬라이드 7 — 항만 사진 한 장',
      gapList: [
        { offsetMs: 900, kind: BOUNDARY_KIND_MAP.complete, silenceMs: 700, beforeText: '사진 한 장 보시겠습니다', afterText: '보시면 컨테이너가 산더미처럼 쌓여 있죠' },
        { offsetMs: 4300, kind: BOUNDARY_KIND_MAP.complete, silenceMs: 1100, beforeText: '보시면 컨테이너가 산더미처럼 쌓여 있죠', afterText: '이게 작년 12월 부산항입니다' },
      ],
    },
    output: { gapIndex: 0, reason: '뒤 발화가 사진을 이어서 설명한다 — 그 앞에 넣어야 그림이 먼저 선다' },
  },
  {
    input: {
      narrationText: '슬라이드 5: 채용 절차와 3단계 흐름도',
      narrationType: NARRATION_TYPE_MAP.pageTransition,
      subKind: 'slide',
      rationale: '화면 전환 감지 · 화면유형=ppt',
      screenSummary: '슬라이드 5 — 채용 절차 흐름도',
      gapList: [
        { offsetMs: 800, kind: BOUNDARY_KIND_MAP.complete, silenceMs: 500, beforeText: '다음 장입니다', afterText: '채용 절차를 보겠습니다' },
        { offsetMs: 9200, kind: BOUNDARY_KIND_MAP.complete, silenceMs: 1800, beforeText: '서류부터 최종 면접까지 세 단계고요', afterText: '그럼 급여 얘기로 넘어가죠' },
      ],
    },
    output: { gapIndex: 0, reason: '전환 고지는 뒤 설명의 맥락 — 가장 이른 완결 지점' },
  },
  {
    input: {
      narrationText: '73%는 작년 대비 재고 회전율을 의미',
      narrationType: NARRATION_TYPE_MAP.interpretation,
      subKind: 'value_to_meaning',
      rationale: '발화="73%까지 올라갔는데" · 근거 표현="73%"',
      screenSummary: '슬라이드 9 — 재고 회전율 그래프',
      gapList: [
        { offsetMs: 500, kind: BOUNDARY_KIND_MAP.pause, silenceMs: 300, beforeText: '73%까지 올라갔는데', afterText: '그러니까' },
        { offsetMs: 1500, kind: BOUNDARY_KIND_MAP.pause, silenceMs: 350, beforeText: '그러니까', afterText: '이게 무슨 뜻이냐면' },
      ],
    },
    output: { gapIndex: null, reason: '전부 문장 중간 — 끊으면 문장이 잘린다' },
  },
];

function formatGapLine({ gap, index }) {
  const offsetSec = (gap.offsetMs / 1000).toFixed(1);
  const sign = gap.offsetMs >= 0 ? '+' : '';
  const kindLabel = BOUNDARY_KIND_LABEL_MAP[gap.kind] || gap.kind;
  return `[${index}] ${sign}${offsetSec}초 · 앞 발화 "${gap.beforeText || '(없음)'}"`
    + ` · 끝맺음=${kindLabel} · 무음 ${(gap.silenceMs / 1000).toFixed(1)}초`
    + ` · 뒤 발화 "${gap.afterText || '(없음)'}"`;
}

function buildGapInput({ narrationText, narrationType, subKind = null, rationale = '',
  screenSummary = '', beforeTranscript = '', gapList }) {
  return [
    `내레이션: "${narrationText}"`,
    `유형: ${narrationType}${subKind ? ` / 세부: ${subKind}` : ''}`,
    `만들어진 근거: ${rationale || '(없음)'}`,
    `화면: ${screenSummary || '(없음)'}`,
    ...(beforeTranscript ? [`직전 맥락: ${beforeTranscript}`] : []),
    '트리거 시각: 0.0초 (아래 후보의 기준점 — 음수는 트리거보다 앞선 틈이다)',
    '',
    '후보 틈:',
    ...gapList.map((gap, index) => formatGapLine({ gap, index })),
    '',
    '선택(JSON 한 줄):',
  ].join('\n');
}

function buildFewShotMessageList() {
  return FEW_SHOT_LIST.flatMap((example) => [
    { role: 'user', content: [{ text: buildGapInput(example.input) }] },
    { role: 'assistant', content: [{ text: JSON.stringify(example.output) }] },
  ]);
}

function canPickBeforeTrigger({ narrationType }) {
  return narrationType === NARRATION_TYPE_MAP.speakerIdentity;
}

function selectFallbackGapIndex({ gapList }) {
  if (!Array.isArray(gapList) || !gapList.length) return null;
  const forwardList = gapList
    .map((gap, index) => ({ gap, index }))
    .filter((entry) => entry.gap.offsetMs >= 0)
    .sort((left, right) => left.gap.offsetMs - right.gap.offsetMs);
  const complete = forwardList.find((entry) => entry.gap.kind === BOUNDARY_KIND_MAP.complete);
  if (complete) return complete.index;
  return forwardList.length ? forwardList[0].index : null;
}

function parseGapText({ text, gapCount }) {
  const empty = { gapIndex: null, reason: '' };
  if (typeof text !== 'string') return empty;
  const match = text.replace(/```(?:json)?/g, '').match(/\{[\s\S]*\}/);
  if (!match) return empty;
  let parsed = null;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return empty;
  }
  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';
  if (!Number.isInteger(parsed.gapIndex)) return { gapIndex: null, reason };
  if (parsed.gapIndex < 0 || parsed.gapIndex >= gapCount) return { gapIndex: null, reason };
  return { gapIndex: parsed.gapIndex, reason };
}

function createGapInferenceAgent({ config }) {
  const apiKey = config.bedrockApiKey;
  const converseUrl = `https://bedrock-runtime.${config.bedrockRegion}.amazonaws.com`
    + `/model/${ensureUsPrefix(config.judgeModelId)}/converse`;

  async function infer({ narrationText, narrationType, subKind = null, rationale = '',
    screenSummary = '', beforeTranscript = '', gapList = [] }) {
    if (!gapList.length) return { gapIndex: null, reason: '후보 틈 없음', source: GAP_SOURCE_MAP.none };
    if (!apiKey) {
      return {
        gapIndex: selectFallbackGapIndex({ gapList }),
        reason: '규칙 폴백 — 트리거 이후 첫 완결 경계 (Bedrock 키 없음)',
        source: GAP_SOURCE_MAP.fallback,
      };
    }
    try {
      const response = await fetch(converseUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system: [{ text: GAP_SYSTEM_PROMPT }],
          messages: [
            ...buildFewShotMessageList(),
            {
              role: 'user',
              content: [{
                text: buildGapInput({
                  narrationText, narrationType, subKind, rationale, screenSummary,
                  beforeTranscript, gapList,
                }),
              }],
            },
          ],
          inferenceConfig: buildInferenceConfig({
            modelId: config.judgeModelId, maxTokens: MAX_GAP_TOKENS,
          }),
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        const body = (await response.text()).slice(0, 160);
        throw new Error(`Bedrock Converse HTTP ${response.status} ${body}`);
      }
      const json = await response.json();
      const text = json?.output?.message?.content?.[0]?.text || '';
      const parsed = parseGapText({ text, gapCount: gapList.length });

      const chosen = Number.isInteger(parsed.gapIndex) ? gapList[parsed.gapIndex] : null;
      if (chosen && chosen.offsetMs < 0 && !canPickBeforeTrigger({ narrationType })) {
        return {
          gapIndex: selectFallbackGapIndex({ gapList }),
          reason: `앞선 틈은 이 유형에 쓸 수 없어 규칙으로 대체 (모델 사유="${parsed.reason}")`,
          source: GAP_SOURCE_MAP.fallback,
        };
      }
      return { ...parsed, source: GAP_SOURCE_MAP.bedrock };
    } catch (error) {
      console.error('[pipeline] 삽입 위치 추론 실패, 규칙 폴백:', error.message);
      return {
        gapIndex: selectFallbackGapIndex({ gapList }),
        reason: `규칙 폴백 — 첫 완결 경계 (${error.message})`,
        source: GAP_SOURCE_MAP.fallback,
      };
    }
  }

  return { infer };
}

module.exports = {
  createGapInferenceAgent, buildGapInput, parseGapText, selectFallbackGapIndex, formatGapLine,
  canPickBeforeTrigger, GAP_SYSTEM_PROMPT, GAP_SOURCE_MAP, BOUNDARY_KIND_MAP,
};
