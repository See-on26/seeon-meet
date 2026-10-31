const { parseJsonObject } = require('./parse-json-response');
const { buildSlideLabelPrompt } = require('../prompts/slide-label');

const TITLE_MAX_LENGTH = 20;
const KEYWORD_MAX_COUNT = 6;
const LABEL_MAX_TOKENS = 200;
const AGENT_LABEL = '슬라이드 라벨';

function parseSlideLabel(text) {
  const parsed = parseJsonObject(text);
  if (!parsed) return null;
  const title = typeof parsed.title === 'string' ? parsed.title.trim().slice(0, TITLE_MAX_LENGTH) : '';
  const keywordList = Array.isArray(parsed.keywordList)
    ? [...new Set(parsed.keywordList
      .filter((keyword) => typeof keyword === 'string')
      .map((keyword) => keyword.trim())
      .filter(Boolean))].slice(0, KEYWORD_MAX_COUNT)
    : [];
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  if (!title && !keywordList.length) return null;
  return { title, keywordList, summary };
}

function createSlideLabeler({ requestText }) {
  async function label({ slide }) {
    const text = await requestText({
      prompt: buildSlideLabelPrompt({
        pageTopic: slide.pageTopic, description: slide.description, slideText: slide.slideText,
      }),
      label: AGENT_LABEL,
      maxTokens: LABEL_MAX_TOKENS,
    });
    const parsed = parseSlideLabel(text);
    if (!parsed) throw new Error(`라벨 응답 해석 실패: ${String(text).slice(0, 80)}`);
    return parsed;
  }
  return { label };
}

module.exports = { createSlideLabeler, parseSlideLabel };
