const SLIDE_TEXT_PROMPT_LIMIT = 1500;

// 질문 검색 색인에 쓸 라벨. 이미지 없이 이미 받아 둔 묘사·글자만 보고 붙인다.
function buildSlideLabelPrompt({ pageTopic = '', description = '', slideText = '' }) {
  return [
    '회의 공유 화면 한 장의 정보다. 시각장애인 사용자가 나중에 이 화면을 찾을 수 있도록 라벨을 붙여라.',
    'JSON 하나만 출력한다. 형식: {"title": "20자 이내 제목", "keywordList": ["키워드 3~6개"], "summary": "한 문장 요약"}',
    '화면 정보에 없는 내용은 지어내지 않는다.',
    '',
    pageTopic ? `화면 주제: ${pageTopic}` : '',
    description ? `화면 묘사: ${description}` : '',
    slideText ? `화면 글자: ${slideText.slice(0, SLIDE_TEXT_PROMPT_LIMIT)}` : '화면 글자: (없음)',
  ].filter(Boolean).join('\n');
}

module.exports = { buildSlideLabelPrompt, SLIDE_TEXT_PROMPT_LIMIT };
