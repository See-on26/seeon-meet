const { GROUNDING_NONE_TOKEN } = require('../agents/shared/caption-parser');

// 값 존재 검사의 대조 원본이다. 해석이 섞이면 대조가 무의미해지므로 글자 그대로만 받는다.
function buildSlideTextPrompt() {
  return [
    '이 이미지는 회의에서 공유 중인 화면이다.',
    '화면에 보이는 글자와 숫자를 줄 단위로 그대로 옮겨 적어라. 해석·요약·번역은 하지 마라.',
    '표는 한 행을 한 줄로 적고 칸 사이는 " | " 로 구분한다.',
    '그래프는 제목·축 이름·눈금·범례·데이터 라벨의 글자만 적는다.',
    `읽을 수 있는 글자가 하나도 없으면 ${GROUNDING_NONE_TOKEN} 한 단어만 출력한다.`,
  ].join('\n');
}

module.exports = { buildSlideTextPrompt };
