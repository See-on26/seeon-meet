import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeKoreanSpeechText } = require('../src/main/caption-pipeline/output/korean-speech-text.js');
const { createTtsClient } = require('../src/main/caption-pipeline/output/tts-client.js');

// TTS 로 보내는 한국어 글만 숫자·세는 말·단위를 읽는 말로 바꾼다. 음성 엔진(MeloTTS·Ming·Qwen)마다 읽는 규칙이 달라
// "카드 4장"을 "사장"으로, "10.9g"를 "십.9g"로 읽는 일이 생기므로, 앱에서 한 번 맞춰 같은 글을 보낸다.

function assertCaseList(caseList) {
  for (const [input, expected] of caseList) assert.equal(normalizeKoreanSpeechText(input), expected, input);
}

test('세는 말 앞의 1~99 는 고유어로 읽는다', () => {
  assertCaseList([
    ['카드 4장', '카드 네 장'],
    ['4장의 카드가 있습니다.', '네 장의 카드가 있습니다.'],
    ['카드 4 장', '카드 네 장'],
    ['카드4장', '카드 네 장'],
    ['2명', '두 명'],
    ['3개', '세 개'],
    ['20개', '스무 개'],
    ['21개', '스물한 개'],
    ['99명', '아흔아홉 명'],
    ['1번째', '첫 번째'],
    ['11번째 줄', '열한 번째 줄'],
    ['3시 30분', '세 시 삼십분'],
    ['12시', '열두 시'],
    ['2시간', '두 시간'],
    ['5가지', '다섯 가지'],
    ['3살', '세 살'],
    ['2마리', '두 마리'],
    ['3권', '세 권'],
    ['2잔', '두 잔'],
    ['3병', '세 병'],
    ['2곳', '두 곳'],
    ['3군데', '세 군데'],
    ['2켤레', '두 켤레'],
    ['4그루', '네 그루'],
    ['5송이', '다섯 송이'],
    ['2벌', '두 벌'],
    ['문제3개', '문제 세 개'],
  ]);
});

test('고유어로 바꾸지 않을 것: 100 이상·0·앞자리 0·개월·개국·개년·제N·번·대·조사 가·쉼표 수·소수', () => {
  assertCaseList([
    ['120개', '백이십 개'],
    ['슬라이드 54장', '슬라이드 쉰네 장'],
    ['0명', '0명'],
    ['05장', '05장'],
    ['3개월 뒤 20개국', '삼개월 뒤 이십개국'],
    ['3개년 계획', '삼 개년 계획'],
    ['제4장 결론', '제사 장 결론'],
    ['제3회 대회', '제삼 회 대회'],
    ['3번 슬라이드', '3번 슬라이드'],
    ['20대 남성', '이십대 남성'],
    ['4가 적힌', '사가 적힌'],
    ['3,000명', '삼천 명'],
    ['1.5명', '일 점 오명'],
    ['13시', '십삼 시'],
    ['2시즌', '2시즌'],
  ]);
});

test('글자 목록 속 숫자는 세는 말이 아니고, 뒤의 "카드 4장"만 고유어가 된다', () => {
  assert.equal(
    normalizeKoreanSpeechText('A, 3, J, 4가 적힌 분홍색 카드 4장이 있습니다.'),
    '에이, 삼, 제이, 사가 적힌 분홍색 카드 네 장이 있습니다.',
  );
});

// Ming 은 낱자 영문이 섞인 문장에서 끝맺지 못하고 웅얼거리는 일이 잦았다("A, 삼, J, 사가 적힌 카드 네 장"은 출발 값 8개 모두 첫 시도가 깨짐).
test('낱자로 떨어진 영문자는 한글 이름으로 읽고, 단어형 약어·영문·숫자에 붙은 글자는 그대로 둔다', () => {
  assert.equal(normalizeKoreanSpeechText('A사와 B사의 점유율'), '에이사와 비사의 점유율');
  assert.equal(normalizeKoreanSpeechText('보기 X, Y, Z 가운데'), '보기 엑스, 와이, 제트 가운데');
  for (const text of ['GPU 서버', 'Q3 매출', 'A100 서버', '5G 통신', 'e-mail 주소', 'AT&T']) {
    assert.equal(normalizeKoreanSpeechText(text), text, text);
  }
});

test('단위는 한자어 수 + 단위 말로 읽고, 단위 뒤 조사는 받침에 맞춘다', () => {
  assertCaseList([
    ['10.9g', '십 점 구 그램'],
    ['그런데 보시면 10.9g, 9.3g입니다.', '그런데 보시면 십 점 구 그램, 구 점 삼 그램입니다.'],
    ['9.3g는 여성 섭취량', '구 점 삼 그램은 여성 섭취량'],
    ['10.9 g', '십 점 구 그램'],
    ['1,200kcal', '천이백 킬로칼로리'],
    ['500ml 생수', '오백 밀리리터 생수'],
    ['500mL 생수', '오백 밀리리터 생수'],
    ['1.5L로 늘었다', '일 점 오 리터로 늘었다'],
    ['5km', '오 킬로미터'],
    ['170cm은', '백칠십 센티미터는'],
    ['3mm', '삼 밀리미터'],
    ['3kg를 뺐다', '삼 킬로그램을 뺐다'],
    ['20mg', '이십 밀리그램'],
    ['12.5km 구간', '십이 점 오 킬로미터 구간'],
    ['10g이 들었다', '십 그램이 들었다'],
    ['1L이 남았다', '일 리터가 남았다'],
    ['2L이다', '이 리터이다'],
    ['100g가량', '백 그램가량'],
    ['약10g', '약 십 그램'],
    ['10~20g', '십에서 이십 그램'],
  ]);
});

test('단위로 보지 않을 것: 대문자 G·K·D, GB, 영문·숫자에 붙은 수', () => {
  for (const text of ['5G 통신', '3D 화면', '4K 화질', '6.5GB', 'RE100', 'A100 서버', 'Q3 매출', 'GPT-4o', 'COVID-19', '2.5GHz']) {
    assert.equal(normalizeKoreanSpeechText(text), text, text);
  }
});

test('퍼센트·퍼센트포인트는 한자어로 읽는다', () => {
  assertCaseList([
    ['생과즙 30%', '생과즙 삼십 퍼센트'],
    ['3.2%p 상승', '삼 점 이 퍼센트포인트 상승'],
    ['12.5%', '십이 점 오 퍼센트'],
  ]);
});

test('범위 + 세는 말: 붙은 작은 수 짝은 관용형, 그 밖은 "~에서 ~"로 읽는다', () => {
  assertCaseList([
    ['2~3개', '두세 개'],
    ['1~2시간', '한두 시간'],
    ['3~4명이 맡습니다.', '서너 명이 맡습니다.'],
    ['2-3개', '두세 개'],
    ['10~20개', '열 개에서 스무 개'],
    ['100~200개', '백에서 이백 개'],
  ]);
});

test('날짜·시각·번호처럼 읽을 말을 정할 수 없는 꼴은 그대로 둔다', () => {
  for (const text of ['2025년 9월 15일', '40:02 지점', '010-1234-5678', '버전 1.2.3']) {
    assert.equal(normalizeKoreanSpeechText(text), text, text);
  }
  assert.equal(normalizeKoreanSpeechText(''), '');
  assert.equal(normalizeKoreanSpeechText(null), '');
});

// 음성 엔진은 낱말 사이 " - "를 "마이너스"로 읽는다. 항목과 내용을 가르는 표시라 쉼표로 바꿔 읽는다.
test('낱말 사이에 띄어 쓴 하이픈·대시(" - ", " – ", " — ")는 쉼표로 읽는다', () => {
  assertCaseList([
    ['항목 - 내용', '항목, 내용'],
    ['현재 섭취량 – 권장량의 두 배', '현재 섭취량, 권장량의 두 배'],
    ['결론 — 지출을 줄인다', '결론, 지출을 줄인다'],
    ['여성 권장량 - 10.9g', '여성 권장량, 십 점 구 그램'],
    ['1분기 - 2분기 - 3분기 막대', '일분기, 이분기, 삼분기 막대'],
    ['비교표: - 왼쪽 열', '비교표: 왼쪽 열'],
  ]);
});

test('음수·범위·낱말 속 하이픈과 양쪽이 숫자인 띄어 쓴 하이픈은 그대로 둔다', () => {
  assertCaseList([
    ['변화율 -0.11%', '변화율 마이너스 영 점 일일 퍼센트'],
    ['-0.11% 하락', '마이너스 영 점 일일 퍼센트 하락'],
    ['2~3개', '두세 개'],
    ['2 - 3개', '두세 개'],
    ['2 – 3개', '두세 개'],
    ['2020 - 2025년', '2020 - 2025년'],
    ['COVID-19 확진', 'COVID-19 확진'],
    ['e-mail 주소', 'e-mail 주소'],
    ['3월-6월', '3월-6월'],
    ['010-1234-5678', '010-1234-5678'],
    ['- 항목', '- 항목'],
  ]);
});

// 영문 풀이를 소리 나는 대로 이어 읽어 "섭취량(Current Status)을"이 "…킛스테이터스를"처럼 들린다. 앞 한글 낱말이 같은 뜻을 이미 말한다.
test('한글 낱말 바로 뒤 괄호 속 영문 풀이는 읽지 않는다', () => {
  assertCaseList([
    ['현재 소금 섭취량(Current Status)을 의미', '현재 소금 섭취량을 의미'],
    ['금융불안지수(FSI)의 변화', '금융불안지수의 변화'],
    ['섭취량 (Current Status)을 의미', '섭취량을 의미'],
    ['인공지능(AI) 도입률', '인공지능 도입률'],
    ['전년 대비(Year-over-Year) 증가', '전년 대비 증가'],
    ['매출(Revenue) - 비용(Cost) 비교', '매출, 비용 비교'],
  ]);
});

test('한글이 든 괄호, 글 맨 앞·영문 뒤 괄호, 숫자로 시작하거나 낱자 하나뿐인 괄호는 그대로 둔다', () => {
  assertCaseList([
    ['섭취량(하루 기준)', '섭취량(하루 기준)'],
    ['나트륨(Na 성분)', '나트륨(Na 성분)'],
    ['(Current Status) 현재 섭취량', '(Current Status) 현재 섭취량'],
    ['GDP(Gross Domestic Product) 성장', 'GDP(Gross Domestic Product) 성장'],
    ['나트륨(10.9g)', '나트륨(십 점 구 그램)'],
    ['매출(Q3)', '매출(Q3)'],
    ['보기(A)', '보기(에이)'],
  ]);
});

test('두 번 씌워도 같다', () => {
  const textList = [
    'A, 3, J, 4가 적힌 분홍색 카드 4장이 있습니다.', '그런데 보시면 10.9g, 9.3g입니다.', '제4장 결론', '2~3개',
    '10~20개', '3시 30분', '1,200kcal', '3.2%p 상승', '3번 슬라이드', '2025년 9월', '05장',
    '항목 - 내용', '현재 소금 섭취량(Current Status)을 의미', '변화율 -0.11%', '2020 - 2025년', '매출(Revenue) - 비용(Cost) 비교',
  ];
  for (const text of textList) {
    const once = normalizeKoreanSpeechText(text);
    assert.equal(normalizeKoreanSpeechText(once), once, text);
  }
});

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function mockFetch() {
  const bodyList = [];
  globalThis.fetch = async (_url, option) => {
    bodyList.push(JSON.parse(option.body));
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4), text: async () => '' };
  };
  return bodyList;
}

test('TTS 요청: 한국어(기본 포함)는 읽는 말로 바꿔 보내고, 영어는 그대로 보낸다', async () => {
  const bodyList = mockFetch();
  const client = createTtsClient({ config: { ttsUrl: 'http://tts', ttsLongUrl: 'http://tts-long' } });
  await client.synthesize({ text: '카드 4장, 10.9g', language: 'ko' });
  await client.synthesize({ text: '카드 4장' });
  await client.synthesize({ text: '4 cards, 10.9g', language: 'en' });
  await client.synthesizeLong({ text: '카드 4장\n10.9g 입니다', language: 'ko' });
  await client.synthesizeLong({ text: '4 cards\n10.9g', language: 'en' });
  assert.deepEqual(bodyList.map((body) => body.text), [
    '카드 네 장, 십 점 구 그램', '카드 네 장', '4 cards, 10.9g', '카드 네 장\n십 점 구 그램 입니다', '4 cards\n10.9g',
  ]);
});

test('TTS 요청: 기호 읽기(달러)를 거친 뒤 숫자를 읽는다', async () => {
  const bodyList = mockFetch();
  const client = createTtsClient({ config: { ttsUrl: 'http://tts', ttsLongUrl: 'http://tts-long' } });
  await client.synthesize({ text: 'Q&A = $30', language: 'ko' });
  // 기호 읽기로 "Q앤드A"가 된 뒤 낱자 영문도 한글 이름으로 읽는다.
  assert.equal(bodyList[0].text, '큐앤드에이 는 삼십달러');
});

test('TTS 요청: 한국어는 영문 풀이 괄호를 빼고 낱말 사이 하이픈을 쉼표로 읽으며, 영어는 그대로 보낸다', async () => {
  const bodyList = mockFetch();
  const client = createTtsClient({ config: { ttsUrl: 'http://tts', ttsLongUrl: 'http://tts-long' } });
  await client.synthesize({ text: '현재 섭취량(Current Status) - 권장량의 2배', language: 'ko' });
  await client.synthesizeLong({ text: '항목 - 내용\n금융불안지수(FSI)의 변화', language: 'ko' });
  await client.synthesize({ text: 'Revenue - Cost (FY24)', language: 'en' });
  assert.deepEqual(bodyList.map((body) => body.text), [
    '현재 섭취량, 권장량의 2배', '항목, 내용\n금융불안지수의 변화', 'Revenue - Cost (FY24)',
  ]);
});
