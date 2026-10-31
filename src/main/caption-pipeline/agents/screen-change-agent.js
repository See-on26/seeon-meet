const { NARRATION_TYPE_MAP, SCREEN_CHANGE_KIND_MAP } = require('../contracts/narration-types');
const { computeMaxChars, parseSlotCaption, REJECT_KIND_MAP } = require('./shared/caption-parser');
const { requestVlmContent } = require('./shared/vlm-gateway');
const { scaleWordBudget } = require('./shared/narration-format');
const { buildScreenChangePrompt } = require('../prompts/screen-change');
const { DEFAULT_CAPTION_LANGUAGE } = require('../contracts/caption-language');

const AGENT_LABEL = '화면변화';
const SCREEN_CHANGE_AGENT_TEMPERATURE = 0.2;
// 칸이 둘(대상·값)뿐인 짧은 답과 한 문장 거절 이유가 들어가는 상한. 길게 늘어놓는 답이 해설을 늦추지 않게 낮게 둔다.
const SCREEN_CHANGE_AGENT_MAX_TOKENS = 120;
const DEFAULT_SCREEN_CHANGE_MAX_WORD_COUNT = 8;
const RAW_CONTENT_MAX_CHARS = 400;

// 같은 슬라이드 안에서 새로 나타난 것을 VLM 한 번으로 짧게 알린다. 칸(JSON) 없이 쓴 글은 값을 확인할 수 없어 형식 오류로 버린다.
function createScreenChangeAgent({ config, getCaptionLanguage = () => DEFAULT_CAPTION_LANGUAGE }) {
  async function generate({ jpegBuffer, eventKind = SCREEN_CHANGE_KIND_MAP.newText, lineList = [], recentTranscript = '',
    describedElementList = [], minWordCount, maxWordCount, imageMode = 'outline', language = getCaptionLanguage() }) {
    ({ maxWordCount } = scaleWordBudget({
      minWordCount, maxWordCount: Number.isFinite(maxWordCount) ? maxWordCount : DEFAULT_SCREEN_CHANGE_MAX_WORD_COUNT, language,
    }));
    const maxChars = computeMaxChars({ maxWordCount, language });
    const content = await requestVlmContent({
      config, jpegBuffer, label: AGENT_LABEL,
      temperature: SCREEN_CHANGE_AGENT_TEMPERATURE, maxTokens: SCREEN_CHANGE_AGENT_MAX_TOKENS,
      prompt: buildScreenChangePrompt({ eventKind, lineList, recentTranscript, describedElementList, imageMode, language }),
    });
    const parsed = parseSlotCaption({
      content, narrationType: NARRATION_TYPE_MAP.screenChange, subKind: eventKind, maxChars, maxWordCount, language,
    });
    if (parsed.isGrounded && !parsed.slotMap) {
      return {
        text: '', isGrounded: false, slotMap: null, rejectKind: REJECT_KIND_MAP.format, rejectReason: '',
        rawContent: String(content || '').slice(0, RAW_CONTENT_MAX_CHARS),
      };
    }
    return parsed;
  }

  return { generate };
}

module.exports = {
  createScreenChangeAgent, SCREEN_CHANGE_AGENT_TEMPERATURE, SCREEN_CHANGE_AGENT_MAX_TOKENS,
};
