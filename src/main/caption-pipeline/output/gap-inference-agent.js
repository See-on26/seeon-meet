const { toChatMessageList } = require('../agents/shared/judge-llm');
const { NARRATION_TYPE_MAP } = require('../contracts/narration-types');
const {
  BOUNDARY_KIND_MAP, BOUNDARY_KIND_LABEL_MAP, GAP_CANDIDATE_SOURCE_MAP, MEASURED_GAP_NOTE_LIST,
  GAP_SYSTEM_PROMPT, FEW_SHOT_LIST,
} = require('../prompts/gap-inference');

const MAX_GAP_TOKENS = 120;
const THINKING_MODEL_SUFFIX = '+thinking';
// 사고가 한도에서 끊기면 그때까지의 생각을 이 머리말과 함께 user 메시지로 넘기고, 사고를 끈 채 답만 다시 묻는다.
// vLLM 의 thinking_token_budget 은 생각 끝 토큰만 넣어서, 모델이 답 칸에서 생각을 이어 가다 JSON 없이 끝난다.
// 생각 칸을 이어 쓰는 방식(continue_final_message)은 모델마다 생각 표기가 달라 템플릿에 따라 깨진다.
const THINKING_HANDOFF_HEADER = '아래는 이 선택을 위해 따지던 생각이다. 시간이 끝나 중간에 끊겼다. 더 따지지 말고 이것으로 바로 고른다.';

// 삽입 위치는 GPU 판정 LLM(8805)이 고른다. 실패해도 다른 서비스로 넘기지 않고 규칙으로 고른다.
// 품질 모드는 지연이 60초라 사고(thinking)를 켠다. 한도 없이 두면 사고가 수천 토큰을 넘기기도 해서
// 1,024토큰에서 끊고 답하게 한다(실측 4.8~7.4초). 균형 모드는 지연이 10초라 사고 없이 바로 답한다(약 0.2초).
// 성능·동시 모드는 delayMs=0이라 삽입 위치 추론을 호출하지 않는다. 모르는 모드는 사고 없이 묻는다.
const GAP_REQUEST_BY_MODE_MAP = {
  listening: { isThinking: true, thinkingBudget: 1024, timeoutMs: 30000 },
  delayed: { isThinking: false, thinkingBudget: 0, timeoutMs: 6000 },
};
const DEFAULT_GAP_REQUEST = GAP_REQUEST_BY_MODE_MAP.delayed;

const GAP_SOURCE_MAP = {
  gpu: 'gpu',
  fallback: 'fallback',
  none: 'none',
};

// 소리로 잰 후보(source=audio)는 무음 길이에 "(잰 값)"을, 아직 이어지는 무음(isOpen)은 "≥"를 붙인다.
function formatSilenceLabel({ gap }) {
  const silenceSec = (gap.silenceMs / 1000).toFixed(1);
  const measuredSuffix = gap.source === GAP_CANDIDATE_SOURCE_MAP.audio ? '(잰 값)' : '';
  return `무음 ${gap.isOpen ? '≥' : ''}${silenceSec}초${measuredSuffix}`;
}

function formatGapLine({ gap, index }) {
  const offsetSec = (gap.offsetMs / 1000).toFixed(1);
  const sign = gap.offsetMs >= 0 ? '+' : '';
  const kindLabel = BOUNDARY_KIND_LABEL_MAP[gap.kind] || gap.kind;
  return `[${index}] ${sign}${offsetSec}초 · 앞 발화 "${gap.beforeText || '(없음)'}"`
    + ` · 끝맺음=${kindLabel} · ${formatSilenceLabel({ gap })}`
    + ` · 뒤 발화 "${gap.afterText || '(없음)'}"`;
}

// 렌더러가 출처를 싣지 않은 후보(ASR 끝 시각 후보)는 asr 로 센다.
function countGapCandidateSource({ gapList }) {
  return gapList.reduce((count, gap) => {
    count[gap?.source === GAP_CANDIDATE_SOURCE_MAP.audio ? GAP_CANDIDATE_SOURCE_MAP.audio : GAP_CANDIDATE_SOURCE_MAP.asr] += 1;
    return count;
  }, { audio: 0, asr: 0 });
}

function hasMeasuredGap({ gapList }) {
  return gapList.some((gap) => gap.source === GAP_CANDIDATE_SOURCE_MAP.audio || gap.kind === BOUNDARY_KIND_MAP.unknown);
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
    ...(hasMeasuredGap({ gapList }) ? MEASURED_GAP_NOTE_LIST : []),
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

// 끊긴 생각을 원래 입력 뒤에 붙여 다시 물을 user 글을 만든다.
function buildThinkingHandoffText({ userText, reasoning }) {
  return [userText, '', THINKING_HANDOFF_HEADER, '"""', reasoning.trim(), '"""', '선택(JSON 한 줄):'].join('\n');
}

function createGapInferenceAgent({ config, fetchImpl = (...argList) => fetch(...argList) }) {
  async function postChat({ messageList, maxTokens, isThinking, signal }) {
    const response = await fetchImpl(config.judgeGpuUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.judgeGpuModel,
        temperature: 0,
        max_tokens: maxTokens,
        chat_template_kwargs: { enable_thinking: isThinking },
        messages: messageList,
      }),
      signal,
    });
    if (!response.ok) throw new Error(`GPU 삽입 위치 추론 HTTP ${response.status}`);
    const body = await response.json();
    const choice = body?.choices?.[0];
    return {
      content: choice?.message?.content || '',
      reasoning: choice?.message?.reasoning_content || choice?.message?.reasoning || '',
      finishReason: choice?.finish_reason || '-',
    };
  }

  // 사고를 끄고 묻으므로 답은 content 로만 온다. reasoning 칸의 글은 새로 연 생각일 수 있어 답으로 쓰지 않는다.
  async function askWithThinkingHandoff({ baseMessageList, userText, reasoning, signal }) {
    const { content } = await postChat({
      messageList: [...baseMessageList, { role: 'user', content: buildThinkingHandoffText({ userText, reasoning }) }],
      maxTokens: MAX_GAP_TOKENS,
      isThinking: false,
      signal,
    });
    return content;
  }

  // 두 요청(사고 → 생각 넘겨 다시 묻기)이 한 시간 한도를 나눠 쓴다.
  async function requestGapText({ gapRequest, userText }) {
    const signal = AbortSignal.timeout(gapRequest.timeoutMs);
    const baseMessageList = toChatMessageList({ systemPrompt: GAP_SYSTEM_PROMPT, messageList: buildFewShotMessageList() });
    const messageList = [...baseMessageList, ...toChatMessageList({ messageList: [{ role: 'user', content: [{ text: userText }] }] })];
    const first = await postChat({
      messageList, maxTokens: gapRequest.thinkingBudget + MAX_GAP_TOKENS, isThinking: gapRequest.isThinking, signal,
    });
    if (first.content.trim()) return first.content;
    const isThinkingCut = gapRequest.isThinking && first.finishReason === 'length' && Boolean(first.reasoning.trim());
    const text = isThinkingCut
      ? await askWithThinkingHandoff({ baseMessageList, userText, reasoning: first.reasoning, signal })
      : '';
    if (!text.trim()) throw new Error(`GPU 삽입 위치 추론 빈 응답 (finish_reason=${first.finishReason})`);
    return text;
  }

  async function infer({ mode = null, narrationText, narrationType, subKind = null, rationale = '',
    screenSummary = '', beforeTranscript = '', gapList = [] }) {
    if (!gapList.length) return { gapIndex: null, reason: '후보 틈 없음', source: GAP_SOURCE_MAP.none };
    const gapRequest = GAP_REQUEST_BY_MODE_MAP[mode] || DEFAULT_GAP_REQUEST;
    const modelId = `${config.judgeGpuModel}${gapRequest.isThinking ? THINKING_MODEL_SUFFIX : ''}`;
    try {
      const text = await requestGapText({
        gapRequest,
        userText: buildGapInput({
          narrationText, narrationType, subKind, rationale, screenSummary, beforeTranscript, gapList,
        }),
      });
      const parsed = parseGapText({ text, gapCount: gapList.length });

      const chosen = Number.isInteger(parsed.gapIndex) ? gapList[parsed.gapIndex] : null;
      if (chosen && chosen.offsetMs < 0 && !canPickBeforeTrigger({ narrationType })) {
        return {
          gapIndex: selectFallbackGapIndex({ gapList }),
          reason: `앞선 틈은 이 유형에 쓸 수 없어 규칙으로 대체 (모델 사유="${parsed.reason}")`,
          source: GAP_SOURCE_MAP.fallback,
        };
      }
      return { ...parsed, source: GAP_SOURCE_MAP.gpu, modelId };
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
  createGapInferenceAgent, buildGapInput, parseGapText, selectFallbackGapIndex, formatGapLine, countGapCandidateSource,
  canPickBeforeTrigger, buildThinkingHandoffText, GAP_SYSTEM_PROMPT, GAP_SOURCE_MAP, GAP_REQUEST_BY_MODE_MAP,
  BOUNDARY_KIND_MAP,
};
