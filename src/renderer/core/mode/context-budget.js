export const VLM_CONTEXT_LIMIT_TOKEN = 8192;

export const VLM_IMAGE_TOKEN_RESERVE = 2700;

export const VLM_PROMPT_TOKEN_RESERVE = 1000;

export const VLM_OUTPUT_TOKEN_RESERVE = 300;

export const CONTEXT_TOKEN_BUDGET = VLM_CONTEXT_LIMIT_TOKEN
  - VLM_IMAGE_TOKEN_RESERVE - VLM_PROMPT_TOKEN_RESERVE - VLM_OUTPUT_TOKEN_RESERVE;

export const CHARS_PER_TOKEN_ESTIMATE = 1;

export const CONTEXT_KEEP_MAP = {
  newest: 'newest',
  oldest: 'oldest',
};

export function estimateTokenCount({ text }) {
  const length = String(text || '').length;
  return Math.ceil(length / CHARS_PER_TOKEN_ESTIMATE);
}

export function fitTextListToTokenBudget({
  textList, maxTokenCount, keep = CONTEXT_KEEP_MAP.newest,
}) {
  const inputList = Array.isArray(textList) ? textList : [];
  if (!Number.isFinite(maxTokenCount) || maxTokenCount <= 0) {
    return { textList: [], tokenCount: 0, droppedCount: inputList.length };
  }

  const orderedList = keep === CONTEXT_KEEP_MAP.oldest ? inputList : [...inputList].reverse();
  const keptList = [];
  let tokenCount = 0;
  for (const text of orderedList) {
    const cost = estimateTokenCount({ text }) + (keptList.length ? 1 : 0);
    if (tokenCount + cost > maxTokenCount) break;
    keptList.push(text);
    tokenCount += cost;
  }
  const resultList = keep === CONTEXT_KEEP_MAP.oldest ? keptList : keptList.reverse();
  return { textList: resultList, tokenCount, droppedCount: inputList.length - resultList.length };
}
