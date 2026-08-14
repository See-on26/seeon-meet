const { NARRATION_TYPE_MAP, DEIXIS_FORM_MAP } = require('../contracts/narration-types');
const {
  GROUNDING_NONE_TOKEN, computeMaxChars, buildSlotOutputInstruction, SPEECH_GAP_DECIDED_RULE,
} = require('../agents/shared/caption-parser');
const { DEFAULT_CAPTION_LANGUAGE } = require('../contracts/caption-language');
const { buildOutputLanguageRuleList } = require('./output-language-rule');

const DEFAULT_DEIXIS_MIN_WORD_COUNT = 4;
const DEFAULT_DEIXIS_MAX_WORD_COUNT = 8;

// 출력은 seen(가리킨 곳에 보이는 것, 읽지 않음) + caption(청자에게 읽어 줄 대상의 이름·내용)이다.
// 완전형은 라우터가 한 발화에서 지시 공백을 둘 이상 찾은 경우라 대상마다 밝히게 한다.
const DEIXIS_FORM_RULE_MAP = {
  [DEIXIS_FORM_MAP.simple]: [
    '형식: caption 하나에 "무엇의 무슨 자료인지"를 함께 담는다. 자료 종류를 따로 쪼개지 마라.',
    '  예) "여기를 보시면" → seen="2년간 매출 추이 표, 2023·2024년 월별 막대", caption="2년간 매출 추이 표"',
    '  예) "오른쪽 것을 주목해 주십쇼" → seen="설문 결과 표, 만족·보통·불만 세 줄", caption="설문 결과 표"',
  ],
  [DEIXIS_FORM_MAP.complete]: [
    '형식: 발표자가 이 발화에서 대상을 둘 이상 가리켰다. 가리킨 순서대로 각각이 무엇인지 caption 에 쉼표로 이어 적는다.',
    '  예) "이거랑 이게 같이 있는 거거든요" → seen="워드 파일 속 본문 글, 글자를 찍은 사진", caption="워드 파일 속 본문 글, 글자를 찍은 사진"',
  ],
};

// 앞선 해설 목록(describedElementList)은 모델에 보이지 않는다. 목록을 주면 앞선 해설의 이름·연도를 이번 화면 해설에
// 옮겨 적고, 같은 내용이어도 거절하지 않았다. 같은 대상의 겹친 해설은 재생 전 중복 거르기(narration-history)가 맡는다.
function buildGroundingPrompt({ utterance, recentTranscript, maxChars,
  hasPointingRegion = false, pointingOrderHint = '',
  minWordCount = DEFAULT_DEIXIS_MIN_WORD_COUNT, maxWordCount = DEFAULT_DEIXIS_MAX_WORD_COUNT,
  subKind = null, mergedAnchorList = [], language = DEFAULT_CAPTION_LANGUAGE }) {
  const trimmedUtterance = (utterance || '').trim();
  const formRuleList = DEIXIS_FORM_RULE_MAP[subKind]
    || [...DEIXIS_FORM_RULE_MAP.simple, ...DEIXIS_FORM_RULE_MAP.complete];
  return [
    hasPointingRegion
      ? '이 이미지는 회의 공유화면에서 발표자가 방금 필기하거나 포인터로 가리킨 영역을 확대한 것이다.'
      : '이 이미지는 회의에서 공유 중인 화면이다.',
    `발표자가 방금 이렇게 말하며 화면의 무언가를 가리켰다: "${trimmedUtterance}"`,
    recentTranscript
      ? `발표자의 인접 발화(트리거 직전 1분 이내 + 직후 발화)는 다음과 같다: ${recentTranscript}`
      : '',
    pointingOrderHint
      ? `발표자가 화면을 다음 순서로 표시(필기/포인터)했다: ${pointingOrderHint}. 이 선후관계를 반영해 설명하라.`
      : '',
    mergedAnchorList.length
      ? `발표자가 지시한 표현: ${mergedAnchorList.join(', ')}. 이 대상이 무엇인지도 caption 안에 함께 밝혀라.`
      : '',
    '청자는 화면을 볼 수 없다. 발표자가 가리킨 대상 중, 말로는 아직 설명되지 않은 시각 정보를 보충하는 캡션을 만들어라.',
    SPEECH_GAP_DECIDED_RULE,
    '가리킨 대상의 이름(지명·항목명·제품명 등)은 화면에서 읽어 반드시 밝힌다 — 지시어로만 들은 청자는 그것이 어느 것인지 모른다.',
    '',
    '가리킨 대상을 화면에서 특정할 수 없다 — 가리킨 곳에 읽을 글자·그림이 없다. 이때만 캡션을 만들지 않는다.',
    '',
    ...formRuleList,
    '',
    '규칙:',
    '(1) **화면에서 읽은 낱말만 쓴다.** 발화에서 들린 이름이라도 화면에 없으면 쓰지 마라.',
    '    발표자의 말은 잘못 들린 것일 수 있다 — 화면 글자와 다르면 화면 쪽을 믿어라.',
    '(2) **지시어는 쓰지 않는다.**',
    '    "이거·이런 식으로·여기·저기·이쪽"은 캡션에 옮기지 마라 — 청자는 그것을 볼 수 없다.',
    '    발화가 "이런 식으로 엑셀을 쓰신다"면 대상은 "표 형태로 쓴 엑셀 파일"이다.',
    '    발화가 대상 둘을 견주면("여기는 A인데 여기는 B") 그 대비를 살려라 —',
    '    한쪽으로 뭉뚱그리면 뜻이 무너진다.',
    '(3) 대상을 명사로 끝나는 짧은 구로 쓴다. 존댓말·설명체를 쓰지 않는다.',
    '(4) 지시 대상은 **화면을 봐야만 알 수 있는 내용**으로 적는다.',
    '    화면에 적힌 글자·수치·항목명을 실제로 읽어서 넣어라. 범주 이름으로 때우지 마라.',
    '      나쁨: "각종 비정형 데이터 표"   ← 발표자가 이미 말한 이름이다',
    '      좋음: "엑셀·스캔 문서·모바일 화면이 뒤섞인 자료"',
    '      나쁨: "관리 항목"               좋음: "서버·DB 종류, 방화벽, DRM 등 11개 항목"',
    '    스스로 물어라 — 눈을 감은 사람이 이 말을 듣고 화면을 그려 볼 수 있는가?',
    '    **화면에 적힌 문구를 그대로 가져다 쓴다.** 뜻을 풀어 새 낱말을 만들지 마라.',
    '      나쁨: "개인정보 유무 확인 가능한 지식"  ← "지식"은 화면에도 발화에도 없다',
    '      좋음: "민감정보 포함 여부 항목"        ← 화면에 그대로 적혀 있다',
    '    수식을 길게 잇지 마라("~할 수 있는 ~하는 ~"). 화면 문구 + 자료 종류면 충분하다.',
    '    대상은 무엇인지(이름·값·뜻)로 쓴다. 상자·박스·도형·색 같은 화면 요소 이름으로 때우지 마라.',
    '(5) "가리키며 설명함·보는 중·주목 중" 같은 동작 말을 붙이지 않는다. 가리켰다는 사실은 청자에게 아무 정보도 아니다 — 대상만 적는다.',
    '(6) 가리킨 대상에 항목명과 수치가 같이 있으면 둘 다 넣는다.',
    '    **대상 자신에 붙은 글자·수치만 쓴다.** 옆에 있는 상자·목록이라도 제목이 다른 지명·항목이면 그 내용은 대상의 것이 아니다'
      + ' — 대상에 붙이지 마라. 대상에 더 적힌 내용이 없으면 자료 맥락(예: 지도에 표시된 지역)으로 채운다.',
    '    값·항목 여러 개의 묶음을 가리켰으면 하나하나 늘어놓지 말고 묶음 이름과 개수로 말한다(예: "기준보다 작은 값 네 개").'
      + ' 늘어놓으면 칸 어절 수를 넘어 목록이 중간에서 잘린다.',
    `(7) 가리킨 대상을 화면에서 특정할 수 없을 때만 "${GROUNDING_NONE_TOKEN}"이다. 그 밖에는 반드시 캡션을 만든다.`,
    `(참고: 총 ${minWordCount}~${maxWordCount}어절, 최대 ${maxChars}자 분량이다.)`,
    '',
    buildSlotOutputInstruction({
      narrationType: NARRATION_TYPE_MAP.deixis,
      subKind: subKind || DEIXIS_FORM_MAP.simple,
      language,
    }),
    ...buildOutputLanguageRuleList({
      language,
      detailLineList: ['caption 은 대상의 이름·내용을 담은 자연스러운 영어 명사구로 쓴다. 시스템은 caption 만 읽는다.',
        '영어에서도 지시어(This·That·Here)로 시작하지 말고 대상 이름으로 말한다. "Looking at"·"Pointing at" 같은 동작 말을 붙이지 않는다.'
        + ' 가리킨 표시(circle·dot·marker)는 말하지 않는다.'],
    }),
  ].filter(Boolean).join('\n');
}

module.exports = { buildGroundingPrompt, DEIXIS_FORM_RULE_MAP, DEFAULT_DEIXIS_MIN_WORD_COUNT, DEFAULT_DEIXIS_MAX_WORD_COUNT };
