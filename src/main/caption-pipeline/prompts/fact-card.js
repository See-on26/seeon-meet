// 새 슬라이드가 확정될 때 화면을 패널별 사실 카드(JSON)로 정리하게 하는 프롬프트. 해설 순간에는 이 카드에서 발화와 가까운 것만 골라 넣는다.
// 값은 화면에 적힌 것만 옮기게 한다. 카드의 숫자는 코드가 슬라이드 전사 글자와 다시 대조해 거른다.
const FACT_CARD_KIND_LIST = ['chart', 'table', 'list', 'diagram', 'text', 'map', 'image'];

const FACT_CARD_SCHEMA_EXAMPLE = '{"screenTitle":"화면 전체 제목(적힌 그대로, 없으면 빈 문자열)","cardList":[{'
  + `"kind":"${FACT_CARD_KIND_LIST.join(' | ')}","title":"패널 제목(적힌 그대로)",`
  + '"position":"위 | 아래 | 왼쪽 | 오른쪽 | 가운데 | 왼쪽 위 | 오른쪽 위 | 왼쪽 아래 | 오른쪽 아래",'
  + '"period":"기간·시점(제목·축·각주에 적힌 연도·분기·날짜)","unit":"단위(적힌 그대로)",'
  + '"axisList":[{"name":"축 이름","from":"처음 눈금","to":"끝 눈금"}],"legendList":["범례 계열 이름"],"headerList":["표 머리글 칸"],'
  + '"itemList":[{"label":"항목·행 이름","value":"적힌 값(없으면 빈 문자열)","note":"조건·비교 기준·각주"}],"itemCount":0}]}';

const FACT_CARD_EXAMPLE = '{"screenTitle":"국내 판매 현황","cardList":[{"kind":"chart","title":"지역별 판매량","position":"왼쪽","period":"2023~2024","unit":"천 대",'
  + '"axisList":[{"name":"지역","from":"서울","to":"강원"},{"name":"판매량","from":"0","to":"800"}],"legendList":["2023","2024"],"headerList":[],'
  + '"itemList":[{"label":"서울","value":"2023 410, 2024 520","note":""}],"itemCount":5}]}';

function buildFactCardPrompt() {
  return [
    '이 이미지는 회의에서 공유 중인 화면이다. 나중에 발표자의 말과 맞춰 쓰도록, 화면을 패널별 사실 카드로 정리하라.',
    '· 패널 = 제목이 붙은 그래프·표·목록·도식·글 상자 하나. 패널마다 카드 하나, 최대 6개. 화면 전체 제목은 screenTitle 에 쓴다.',
    '· 모든 글자는 화면에 적힌 그대로 옮긴다. 번역·요약·풀어쓰기를 하지 않는다.',
    '· 값은 화면에 숫자·글자로 적혀 있는 것만 쓴다. 막대 높이·선 위치·면적으로 값을 어림하지 않는다 — 적힌 값이 없으면 value 를 빈 문자열로 둔다.',
    '· 그래프는 축 이름과 처음·끝 눈금, 범례 계열 이름, 데이터 라벨을 옮긴다. 표는 머리글 행과 각 행(첫 칸=label, 나머지는 value 에 "머리글 값" 꼴로).',
    '· 기간·시점·단위·조건(전년 대비, 추정치, 기준일 등)이 제목·축·각주에 적혀 있으면 period·unit·note 에 옮긴다.',
    '· 글자가 없는 사진·그림뿐이면 {"screenTitle":"","cardList":[]} 만 출력한다.',
    `JSON 하나만 출력한다. 형식: ${FACT_CARD_SCHEMA_EXAMPLE}`,
    '예) 지역별 판매량 막대그래프(2023·2024 두 계열, 세로축 0~800, 단위 천 대) →',
    FACT_CARD_EXAMPLE,
  ].join('\n');
}

module.exports = { buildFactCardPrompt, FACT_CARD_KIND_LIST };
