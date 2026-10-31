import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  extractSpeechTermList, pickLastSentence, TERM_KIND_MAP, TERM_SOURCE_MAP, TERM_SOURCE_WEIGHT_MAP, ANCHOR_NEAR_BOOST,
} = require('../src/main/caption-pipeline/orchestrator/speech-roi/term-extractor.js');
const { createKiwiTokenizer } = require('../src/main/caption-pipeline/trigger/kiwi-tokenizer.js');
const { DEV_KIWI_MODEL_DIR, KIWI_MODEL_FILE_LIST } = require('../src/main/caption-pipeline/trigger/kiwi-model.js');

// Kiwi 가 내는 모양(form·tag·원문 위치)을 문장별로 흉내 낸다. 표에 없는 문장은 null(준비 전과 같음)이다.
function fakeTokenize(specByTextMap) {
  return (text) => {
    const spec = specByTextMap[text];
    if (!spec) return null;
    let cursor = 0;
    return spec.map(([form, tag]) => {
      const at = text.indexOf(form, cursor);
      if (at < 0) return { form, tag, start: cursor, end: cursor };
      cursor = at + form.length;
      return { form, tag, start: at, end: at + form.length };
    });
  };
}

const SALES_SENTENCE = '이 매출액 그래프를 보시면 서울 지역이 2024년에 35퍼센트 늘었습니다';
const GDP_SENTENCE = 'GDP 성장률이 3.5%로 떨어졌고 AI 투자는 1,234억 원입니다';
const GENERIC_SENTENCE = '이 화면의 부분을 보시면 여러분 이게 가장 큰 거죠';
const SINGLE_SENTENCE = '여기 5 하고 7 그리고 땅 정도 보시면';
const tokenSpecMap = {
  [SALES_SENTENCE]: [['이', 'MM'], ['매출액', 'NNG'], ['그래프', 'NNG'], ['를', 'JKO'], ['보', 'VV'], ['시', 'EP'], ['면', 'EC'],
    ['서울', 'NNP'], ['지역', 'NNG'], ['이', 'JKS'], ['2024', 'SN'], ['년', 'NNB'], ['에', 'JKB'], ['35', 'SN'], ['퍼센트', 'NNB'],
    ['늘', 'VV'], ['었', 'EP'], ['습니다', 'EF']],
  [GDP_SENTENCE]: [['GDP', 'SL'], ['성장', 'NNG'], ['률', 'XSN'], ['이', 'JKS'], ['3.5', 'SN'], ['%', 'SW'], ['로', 'JKB'],
    ['떨어지', 'VV'], ['고', 'EC'], ['AI', 'SL'], ['투자', 'NNG'], ['는', 'JX'], ['1,234', 'SN'], ['억', 'NR'], ['원', 'NNB'],
    ['이', 'VCP'], ['ᆸ니다', 'EF']],
  [GENERIC_SENTENCE]: [['이', 'MM'], ['화면', 'NNG'], ['의', 'JKG'], ['부분', 'NNG'], ['을', 'JKO'], ['보', 'VV'], ['시', 'EP'],
    ['면', 'EC'], ['여러분', 'NP'], ['이것', 'NP'], ['이', 'JKS'], ['가장', 'MAG'], ['크', 'VA'], ['ᆫ', 'ETM'], ['거', 'NNB'],
    ['이', 'VCP'], ['죠', 'EF']],
  [SINGLE_SENTENCE]: [['여기', 'NP'], ['5', 'SN'], ['하', 'VV'], ['고', 'EC'], ['7', 'SN'], ['그리고', 'MAJ'], ['땅', 'NNG'],
    ['정도', 'NNG'], ['보', 'VV'], ['시', 'EP'], ['면', 'EC']],
};

const toMap = (termList) => Object.fromEntries(termList.map((term) => [term.norm, term]));

test('낱말: 명사·명사+접미사·이웃 어절 복합어를 뽑고 숫자+단위·%·영문 약어를 남긴다', () => {
  const tokenize = fakeTokenize(tokenSpecMap);
  const salesMap = toMap(extractSpeechTermList({ tokenize, utterance: SALES_SENTENCE }));
  assert.deepEqual(Object.keys(salesMap).sort(), ['2024년', '35%', '매출액', '서울', '서울지역', '지역'].sort());
  assert.equal(salesMap['매출액'].kind, TERM_KIND_MAP.word);
  assert.equal(salesMap['서울지역'].text, '서울 지역');
  assert.equal(salesMap['35%'].kind, TERM_KIND_MAP.number);
  assert.equal(salesMap['35%'].text, '35퍼센트');
  assert.equal(salesMap['2024년'].kind, TERM_KIND_MAP.number);

  const gdpMap = toMap(extractSpeechTermList({ tokenize, utterance: GDP_SENTENCE }));
  assert.deepEqual(Object.keys(gdpMap).sort(), ['1234억', '3.5%', 'ai', 'gdp', '성장률', '투자'].sort());
  assert.equal(gdpMap.gdp.kind, TERM_KIND_MAP.acronym);
  assert.equal(gdpMap.gdp.text, 'GDP');
  assert.equal(gdpMap.ai.kind, TERM_KIND_MAP.acronym);
  assert.equal(gdpMap['성장률'].kind, TERM_KIND_MAP.word);
  assert.equal(gdpMap['1234억'].text, '1,234억');
});

test('낱말: 화면·발표 일반어, 대명사·의존명사, 시간·정도 말, 한 음절 한글, 한 자리 맨숫자는 뺀다', () => {
  const tokenize = fakeTokenize(tokenSpecMap);
  assert.deepEqual(extractSpeechTermList({ tokenize, utterance: GENERIC_SENTENCE }), []);
  assert.deepEqual(extractSpeechTermList({ tokenize, utterance: SINGLE_SENTENCE }), []);
});

test('낱말: 원문별 가중치는 문장 1.0·뒤 발화 0.8·앞 발화 마지막 문장 0.6, 같은 말은 높은 쪽을 남긴다', () => {
  assert.deepEqual(TERM_SOURCE_WEIGHT_MAP, { utterance: 1, after: 0.8, before: 0.6 });
  const termList = extractSpeechTermList({
    tokenize: () => null,
    utterance: '서울 매출 보시면',
    after: '부산 매출도 있고요',
    before: '대전 이야기는 끝났습니다. 다음으로 대구 지점을 봅니다.',
  });
  const termMap = toMap(termList);
  assert.equal(termMap['서울'].weight, 1);
  assert.equal(termMap['서울'].source, TERM_SOURCE_MAP.utterance);
  assert.equal(termMap['매출'].weight, 1);
  assert.equal(termMap['부산'].weight, 0.8);
  assert.equal(termMap['부산'].source, TERM_SOURCE_MAP.after);
  assert.equal(termMap['대구'].weight, 0.6);
  assert.equal(termMap['대구'].source, TERM_SOURCE_MAP.before);
  assert.equal(termMap['대전'], undefined, '앞 발화는 마지막 한 문장만 본다');
});

test('낱말: 앞 발화 마지막 문장은 40자 이내로 자른다(앞 60초 전체를 쓰지 않는다)', () => {
  assert.equal(pickLastSentence('첫 문장. 둘째 문장이다'), '둘째 문장이다');
  assert.equal(pickLastSentence('처음 말입니다. 마지막 말입니다.'), '마지막 말입니다.');
  const longSentence = `${'가나다 '.repeat(20)}서울 마지막`;
  const picked = pickLastSentence(longSentence);
  assert.ok(picked.length <= 40, picked);
  assert.ok(picked.endsWith('서울 마지막'));
  assert.ok(picked.startsWith('가나다 '), `어절 중간에서 시작하지 않는다: ${picked}`);
  assert.equal(pickLastSentence(''), '');
});

test('낱말: 근거 표현 안이나 바로 앞뒤 어절의 낱말은 ×1.2', () => {
  assert.equal(ANCHOR_NEAR_BOOST, 1.2);
  const termMap = toMap(extractSpeechTermList({
    tokenize: () => null,
    utterance: '이 매출 그래프 보시면 서울이 제일 높습니다',
    anchor: '이 매출 그래프',
  }));
  assert.equal(termMap['매출'].isNearAnchor, true);
  assert.equal(termMap['매출'].weight, 1.2);
  assert.equal(termMap['서울'].isNearAnchor, false);
  assert.equal(termMap['서울'].weight, 1);
});

test('낱말: Kiwi 준비 전에는 규칙으로 같은 모양을 돌려준다(조사 떼기·일반어·풀이말 빼기·숫자+단위)', () => {
  const termList = extractSpeechTermList({ tokenize: () => null, utterance: SALES_SENTENCE });
  const termMap = toMap(termList);
  for (const norm of ['매출액', '서울', '지역', '2024년', '35%']) assert.ok(termMap[norm], norm);
  for (const norm of ['그래프', '보시면', '늘었습니다']) assert.equal(termMap[norm], undefined, norm);
  for (const term of termList) {
    assert.deepEqual(Object.keys(term).sort(), ['isNearAnchor', 'kind', 'norm', 'source', 'text', 'weight'].sort());
  }
  assert.equal(termMap['35%'].kind, TERM_KIND_MAP.number);
});

test('낱말: 영어 문장은 Kiwi 가 있어도 규칙으로 뽑고 대문자 약어를 더한다', () => {
  let calledCount = 0;
  const termMap = toMap(extractSpeechTermList({
    tokenize: () => { calledCount += 1; return []; },
    utterance: 'Look at the GDP growth in Seoul here',
  }));
  assert.equal(calledCount, 0);
  assert.equal(termMap.gdp.kind, TERM_KIND_MAP.acronym);
  assert.equal(termMap.growth.kind, TERM_KIND_MAP.word);
  assert.ok(termMap.seoul);
  assert.equal(termMap.the, undefined);
});

const hasKiwiModel = KIWI_MODEL_FILE_LIST.every((name) => fs.existsSync(path.join(DEV_KIWI_MODEL_DIR, name)));
test('낱말: 실제 Kiwi 로도 명사·숫자+단위·약어를 뽑는다', { skip: !hasKiwiModel }, async () => {
  const tokenizer = createKiwiTokenizer({ modelDir: DEV_KIWI_MODEL_DIR });
  await tokenizer.load();
  const termMap = toMap(extractSpeechTermList({ tokenize: tokenizer.tokenize, utterance: GDP_SENTENCE }));
  for (const norm of ['gdp', '성장률', '3.5%', 'ai', '투자', '1234억']) assert.ok(termMap[norm], norm);
});
