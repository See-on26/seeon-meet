// 탐지 단계 LLM 판정(통합 라우터·무발화 판정·지시 판정)은 GPU 서버의 판정 LLM 만 쓴다.
// 실패해도 다른 서비스로 넘기지 않는다(그 판정은 해설하지 않음으로 끝난다).
const JUDGE_SOURCE_MAP = { gpu: 'gpu' };

// 판정 답은 짧은 JSON 이라 GPU 는 보통 1초 안에 답한다(실측 p95 약 0.65초). 이보다 오래 걸리면 판정을 포기한다(늦은 해설은 쓸모가 없다).
const GPU_JUDGE_TIMEOUT_MS = 6000;

function toMessageText({ content }) {
  if (typeof content === 'string') return content;
  return (content || []).map((part) => part?.text).filter((text) => typeof text === 'string').join('\n');
}

// Converse 형식(system 별도, content 는 text 블록 목록)을 OpenAI chat 형식으로 옮긴다. few-shot 순서는 그대로다.
function toChatMessageList({ systemPrompt, messageList }) {
  return [
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
    ...messageList.map((message) => ({ role: message.role, content: toMessageText(message) })),
  ];
}

function createJudgeLlm({ config, fetchImpl = (...argList) => fetch(...argList) }) {
  async function requestText({ systemPrompt, messageList, maxTokens, timeoutMs, label }) {
    const response = await fetchImpl(config.judgeGpuUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.judgeGpuModel,
        temperature: 0,
        max_tokens: maxTokens,
        chat_template_kwargs: { enable_thinking: false },
        messages: toChatMessageList({ systemPrompt, messageList }),
      }),
      signal: AbortSignal.timeout(Math.min(timeoutMs, GPU_JUDGE_TIMEOUT_MS)),
    });
    if (!response.ok) throw new Error(`GPU 판정(${label}) HTTP ${response.status}`);
    const body = await response.json();
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error(`GPU 판정(${label}) 빈 응답`);
    return { text: content, source: JUDGE_SOURCE_MAP.gpu };
  }

  return { requestText };
}

module.exports = { createJudgeLlm, toChatMessageList, JUDGE_SOURCE_MAP, GPU_JUDGE_TIMEOUT_MS };
