// 발화 낱말과 화면 라벨을 맞출 때 쓰는 작은 일반어 사전과 알파벳 글자 이름 표.
// 묶음은 통계·업무 공통어, 국가·지역의 한영 표기, 월·분기 표기만 담는다. 특정 자료의 낱말은 넣지 않는다.
// 한 말은 한 묶음에만 든다(시험으로 막는다). 비교는 정규화한 글(공백·문장부호 없음, 영문 소문자)로 한다.

const ALIAS_GROUP_LIST = [
  // 통계·업무 공통어
  ['매출', '매출액', '판매액', 'sales', 'revenue'],
  ['영업이익', 'operating profit', 'operating income'],
  ['순이익', '당기순이익', 'net income', 'net profit'],
  ['이익', '수익', 'profit'],
  ['비용', '지출', 'cost', 'expense'],
  ['비율', '비중', 'ratio', 'proportion'],
  ['점유율', '시장점유율', 'share', 'market share'],
  ['증가율', '성장률', 'growth', 'growth rate'],
  ['감소율', '하락률', 'decline rate'],
  ['합계', '총계', '총합', 'total', 'sum'],
  ['평균', '평균값', 'avg', 'average', 'mean'],
  ['중앙값', '중간값', 'median'],
  ['최대', '최댓값', '최대치', 'max', 'maximum'],
  ['최소', '최솟값', '최소치', 'min', 'minimum'],
  ['전년', '작년', '지난해', '전년도', 'last year', 'previous year'],
  ['올해', '금년', '금년도', 'this year'],
  ['내년', '다음해', '명년', 'next year'],
  ['전월', '지난달', 'last month', 'previous month'],
  ['전년 대비', '전년 동기 대비', 'yoy'],
  ['고객', '손님', 'customer', 'client'],
  ['사용자', '이용자', 'user'],
  ['직원', '임직원', '종업원', 'employee', 'staff'],
  ['가격', '단가', 'price'],
  ['수량', '개수', 'quantity', 'qty'],
  ['목표', '목푯값', 'target', 'goal'],
  ['실적', '성과', 'performance'],
  ['예산', 'budget'],
  ['투자', '투자액', 'investment'],
  ['시장', 'market'],
  ['인구', 'population'],
  ['추이', '추세', 'trend'],
  // 국가·지역
  ['미국', 'us', 'usa', 'united states'],
  ['한국', '대한민국', 'korea', 'south korea'],
  ['중국', 'china'],
  ['일본', 'japan'],
  ['유럽', 'europe'],
  ['유럽연합', 'eu', 'european union'],
  ['영국', 'uk', 'britain', 'united kingdom'],
  ['독일', 'germany'],
  ['프랑스', 'france'],
  ['인도', 'india'],
  ['베트남', 'vietnam'],
  ['아시아', 'asia'],
  ['서울', 'seoul'],
  ['부산', 'busan'],
  // 월
  ['1월', 'jan', 'january'],
  ['2월', 'feb', 'february'],
  ['3월', 'mar', 'march'],
  ['4월', 'apr', 'april'],
  ['5월', 'may'],
  ['6월', 'jun', 'june'],
  ['7월', 'jul', 'july'],
  ['8월', 'aug', 'august'],
  ['9월', 'sep', 'sept', 'september'],
  ['10월', 'oct', 'october'],
  ['11월', 'nov', 'november'],
  ['12월', 'dec', 'december'],
  // 분기·반기
  ['1분기', '1q', 'q1', '1사분기'],
  ['2분기', '2q', 'q2', '2사분기'],
  ['3분기', '3q', 'q3', '3사분기'],
  ['4분기', '4q', 'q4', '4사분기'],
  ['상반기', 'h1', '1h'],
  ['하반기', 'h2', '2h'],
];

// 대문자 약어를 소리 나는 대로 읽은 한글(GDP ↔ 지디피). 받아쓰기·화면 표기가 갈리는 글자는 다른 읽기도 둔다.
const LETTER_NAME_MAP = {
  A: ['에이'], B: ['비'], C: ['씨', '시'], D: ['디'], E: ['이'], F: ['에프'], G: ['지', '쥐'], H: ['에이치', '에치'],
  I: ['아이'], J: ['제이'], K: ['케이'], L: ['엘'], M: ['엠'], N: ['엔'], O: ['오'], P: ['피'], Q: ['큐'], R: ['알', '아르'],
  S: ['에스'], T: ['티'], U: ['유'], V: ['브이', '비'], W: ['더블유', '더블류'], X: ['엑스'], Y: ['와이'], Z: ['지', '제트', '젯'],
};

const MAX_ACRONYM_READING_COUNT = 16;

// 약어 하나의 한글 읽기 목록. 글자별 읽기의 조합이 많아지면 앞쪽(흔한 읽기)부터 상한까지만 만든다.
function readAcronymReadingList(acronym) {
  const letterList = String(acronym || '').toUpperCase().split('');
  if (!letterList.length || letterList.some((letter) => !LETTER_NAME_MAP[letter])) return [];
  let readingList = [''];
  for (const letter of letterList) {
    const nextList = [];
    for (const reading of readingList) {
      for (const name of LETTER_NAME_MAP[letter]) {
        if (nextList.length < MAX_ACRONYM_READING_COUNT) nextList.push(reading + name);
      }
    }
    readingList = nextList;
  }
  return readingList;
}

module.exports = { ALIAS_GROUP_LIST, LETTER_NAME_MAP, readAcronymReadingList };
