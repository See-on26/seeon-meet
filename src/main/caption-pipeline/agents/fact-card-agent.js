const { requestVlmContent } = require('./shared/vlm-gateway');
const { buildFactCardPrompt, FACT_CARD_KIND_LIST } = require('../prompts/fact-card');

const AGENT_LABEL = '사실카드';
const FACT_CARD_MAX_TOKENS = 900;
// 카드 JSON 은 프롬프트로만 받는다. vLLM 의 json_schema 출력 모드는 이 서버에서 시험한 적이 없어 쓰지 않는다.
const FACT_CARD_JSON_MODE_MAP = { prompt: 'prompt' };

// VLM 이 낸 카드를 코드에서 자르는 상한. 글자 칸은 패널 제목·항목 이름·값 한 칸의 길이다.
const FACT_CARD_LIMIT_MAP = { cardCount: 6, itemCount: 12, legendCount: 8, headerCount: 8, axisCount: 2, fieldChars: 40 };

const CODE_FENCE_PATTERN = /```(?:json)?/gi;
const SCREEN_TITLE_PATTERN = /"screenTitle"\s*:\s*("(?:[^"\\]|\\.)*")/;

// start 의 여는 괄호({·[)와 짝이 맞는 닫는 괄호 위치. 따옴표 안의 괄호는 세지 않는다. 끝까지 닫히지 않으면 -1.
function findClosingIndex(text, start) {
  let depth = 0;
  let isInString = false;
  let isEscaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (isInString) {
      if (isEscaped) isEscaped = false;
      else if (char === '\\') isEscaped = true;
      else if (char === '"') isInString = false;
    } else if (char === '"') {
      isInString = true;
    } else if (char === '{' || char === '[') {
      depth += 1;
    } else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readScreenTitle(text) {
  const match = text.match(SCREEN_TITLE_PATTERN);
  const title = match ? tryParseJson(match[1]) : '';
  return typeof title === 'string' ? title : '';
}

// 출력 상한에서 잘린 답은 cardList 배열 안에서 끝까지 닫힌 카드만 살린다.
function salvageTruncatedCardList(text, start) {
  const keyIndex = text.indexOf('"cardList"', start);
  if (keyIndex < 0) return null;
  const arrayStart = text.indexOf('[', keyIndex);
  if (arrayStart < 0) return null;
  const cardList = [];
  let index = arrayStart + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === ']') break;
    if (char !== '{') {
      index += 1;
      continue;
    }
    const end = findClosingIndex(text, index);
    if (end < 0) break;
    const card = tryParseJson(text.slice(index, end + 1));
    if (card !== undefined) cardList.push(card);
    index = end + 1;
  }
  if (!cardList.length) return null;
  return { screenTitle: readScreenTitle(text), cardList, isTruncated: true };
}

// 모델 답에서 카드 JSON 을 꺼낸다. 코드펜스·앞뒤 설명 문장을 허용하고, 잘린 답은 닫힌 카드까지 살린다. 못 꺼내면 null.
function parseFactCardResponse(content) {
  if (typeof content !== 'string') return null;
  const text = content.replace(CODE_FENCE_PATTERN, '');
  const start = text.indexOf('{');
  if (start < 0) return null;
  const end = findClosingIndex(text, start);
  const parsed = end < 0 ? undefined : tryParseJson(text.slice(start, end + 1));
  if (isPlainObject(parsed) && Array.isArray(parsed.cardList)) {
    return {
      screenTitle: typeof parsed.screenTitle === 'string' ? parsed.screenTitle : '',
      cardList: parsed.cardList,
      isTruncated: false,
    };
  }
  if (parsed !== undefined) return null;
  return salvageTruncatedCardList(text, start);
}

// 글자 칸을 상한에서 자른다. 숫자 가운데서 끊으면 다른 값이 되므로("1234" → "12") 그 숫자는 통째로 뺀다.
function clipFieldText(value) {
  const text = value.replace(/\s+/g, ' ').trim();
  const maxChars = FACT_CARD_LIMIT_MAP.fieldChars;
  if (text.length <= maxChars) return text;
  let clipped = text.slice(0, maxChars);
  if (/^\d|^[.,]\d/.test(text.slice(maxChars, maxChars + 2))) clipped = clipped.replace(/[\d.,]+$/, '');
  return clipped.replace(/[\s,·/|]+$/, '');
}

function toFieldText(value) {
  return typeof value === 'string' ? clipFieldText(value) : '';
}

function toFieldTextList(list, maxCount) {
  return (Array.isArray(list) ? list : []).map(toFieldText).filter(Boolean).slice(0, maxCount);
}

function normalizeAxis(axis) {
  if (!isPlainObject(axis)) return null;
  const normalized = { name: toFieldText(axis.name), from: toFieldText(axis.from), to: toFieldText(axis.to) };
  return normalized.name || normalized.from || normalized.to ? normalized : null;
}

function normalizeItem(item) {
  if (!isPlainObject(item)) return null;
  const normalized = { label: toFieldText(item.label), value: toFieldText(item.value), note: toFieldText(item.note) };
  return normalized.label || normalized.value ? normalized : null;
}

// 항목이 상한보다 적으면 옮긴 항목 수가 개수다. 상한에 닿았을 때만 VLM 이 센 수(상한 이상)를 쓰고, 그 밖에는 모른다고 둔다.
function resolveItemCount({ itemCount, vlmItemCount }) {
  if (itemCount < FACT_CARD_LIMIT_MAP.itemCount) return itemCount;
  return Number.isInteger(vlmItemCount) && vlmItemCount >= FACT_CARD_LIMIT_MAP.itemCount ? vlmItemCount : null;
}

function normalizeCard(rawCard) {
  if (!isPlainObject(rawCard)) return null;
  const itemList = (Array.isArray(rawCard.itemList) ? rawCard.itemList : []).map(normalizeItem).filter(Boolean);
  const card = {
    kind: FACT_CARD_KIND_LIST.includes(rawCard.kind) ? rawCard.kind : '',
    title: toFieldText(rawCard.title),
    position: toFieldText(rawCard.position),
    period: toFieldText(rawCard.period),
    unit: toFieldText(rawCard.unit),
    axisList: (Array.isArray(rawCard.axisList) ? rawCard.axisList : []).map(normalizeAxis).filter(Boolean)
      .slice(0, FACT_CARD_LIMIT_MAP.axisCount),
    legendList: toFieldTextList(rawCard.legendList, FACT_CARD_LIMIT_MAP.legendCount),
    headerList: toFieldTextList(rawCard.headerList, FACT_CARD_LIMIT_MAP.headerCount),
    itemList: itemList.slice(0, FACT_CARD_LIMIT_MAP.itemCount),
    count: resolveItemCount({ itemCount: itemList.length, vlmItemCount: rawCard.itemCount }),
  };
  const isEmpty = !card.title && !card.itemList.length && !card.axisList.length
    && !card.legendList.length && !card.headerList.length;
  return isEmpty ? null : card;
}

function normalizeFactCardList(rawCardList) {
  return (Array.isArray(rawCardList) ? rawCardList : []).map(normalizeCard).filter(Boolean)
    .slice(0, FACT_CARD_LIMIT_MAP.cardCount);
}

function createFactCardAgent({ config }) {
  async function build({ jpegBuffer }) {
    const content = await requestVlmContent({
      config, jpegBuffer, label: AGENT_LABEL, prompt: buildFactCardPrompt(),
      temperature: 0, maxTokens: FACT_CARD_MAX_TOKENS,
    });
    const parsed = parseFactCardResponse(content);
    if (!parsed) throw new Error(`사실 카드 JSON 해석 실패 (${String(content ?? '').length}자)`);
    return {
      screenTitle: clipFieldText(parsed.screenTitle),
      cardList: normalizeFactCardList(parsed.cardList),
      isTruncated: parsed.isTruncated,
      rawLength: content.length,
      jsonMode: FACT_CARD_JSON_MODE_MAP.prompt,
    };
  }

  return { build };
}

module.exports = {
  createFactCardAgent, parseFactCardResponse, normalizeFactCardList,
  FACT_CARD_LIMIT_MAP, FACT_CARD_MAX_TOKENS, FACT_CARD_JSON_MODE_MAP,
};
