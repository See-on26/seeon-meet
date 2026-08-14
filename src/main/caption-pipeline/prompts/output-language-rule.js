const { CAPTION_LANGUAGE_MAP } = require('../contracts/caption-language');

// 사용자에게 들리는 글을 만드는 프롬프트 끝에 붙이는 출력 언어 규칙. 프롬프트 본문은 한국어 그대로 두고
// 이 규칙만 덧붙여도 VLM 이 영어 값을 낸다. 한국어 캡션이면 아무것도 붙이지 않아 프롬프트가 지금과 같다.
const OUTPUT_LANGUAGE_RULE_MAP = {
  [CAPTION_LANGUAGE_MAP.en]: '[출력 언어] 사용자는 영어 캡션을 고른 영어 사용자다.'
    + ' 사용자에게 들려줄 글(JSON 값·답 문장·거절 이유)은 모두 자연스러운 영어로 쓴다(화면 글자가 한국어여도 영어로 옮긴다).'
    + ' 어절 수 규칙은 영어 단어 수로 읽는다. 한국어·한자를 쓰지 마라. 고유명사는 영어 표기(로마자)로.',
};

// detailLineList 는 그 프롬프트에만 필요한 영어 출력 보충 규칙이다(예: 머리말은 시스템이 붙인다).
function buildOutputLanguageRuleList({ language = CAPTION_LANGUAGE_MAP.ko, detailLineList = [] } = {}) {
  const rule = OUTPUT_LANGUAGE_RULE_MAP[language];
  return rule ? ['', rule, ...detailLineList] : [];
}

module.exports = { buildOutputLanguageRuleList, OUTPUT_LANGUAGE_RULE_MAP };
