import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchKoreanTokenList, matchKoreanRegex, matchEnglishLexicon, createMethodologyMatcher, listWord, hasNieunFinal,
  REGEX_MATCHER, MATCHER_KIND_MAP,
} from '../tools/eval/lib/methodology-matcher.mjs';
import { hasKiwiModel } from '../tools/eval/lib/kiwi-analyzer.mjs';

const summarize = (candidateList) => candidateList.map(({ type, trigger, start, end }) => `${type}:${trigger}@${start}-${end}`);

// Kiwi 0.24.0 이 실제로 낸 토큰을 옮겨 적었다. 형태소 경계(빨갛+ㄴ, 이렇+게, 싸/VV+ㄴ)가 대조 규칙의 근거다.
const token = (form, tag, position, length) => ({ form, tag, position, length });

test('품사 단위로 지시대명사를 잡고 "저는"·"저기요" 는 잡지 않는다', () => {
  const text = '이렇게 보시면 저는 좋습니다';
  const tokenList = [
    token('이렇', 'VA-I', 0, 2), token('게', 'EC', 2, 1), token('보', 'VV', 4, 1), token('시', 'EP', 5, 1), token('면', 'EC', 6, 1),
    token('저', 'NP', 8, 1), token('는', 'JX', 9, 1), token('좋', 'VA', 11, 1), token('습니다', 'EF', 12, 3),
  ];
  assert.deepEqual(summarize(matchKoreanTokenList({ text, tokenList })), ['demonstrative:이렇게@0-3']);
  assert.deepEqual(matchKoreanTokenList({ text: '저기요', tokenList: [token('저기요', 'IC', 0, 3)] }), []);
});

test('형용사 관형형 + 쪽·부분·거·것·곳 은 2-2 이고 "싼" 처럼 동사로 붙은 형용사도 잡는다', () => {
  const text = '두 안 중에 싼 쪽으로 가죠. 어두운 부분을 큰 거';
  const tokenList = [
    token('두', 'MM', 0, 1), token('안', 'NNG', 2, 1), token('중', 'NNB', 4, 1), token('에', 'JKB', 5, 1),
    token('싸', 'VV', 7, 1), token('ᆫ', 'ETM', 7, 1), token('쪽', 'NNB', 9, 1), token('으로', 'JKB', 10, 2),
    token('가', 'VV', 13, 1), token('죠', 'EF', 14, 1), token('.', 'SF', 15, 1),
    token('어둡', 'VA-I', 17, 3), token('은', 'ETM', 19, 1), token('부분', 'NNG', 21, 2), token('을', 'JKO', 23, 1),
    token('크', 'VA', 25, 1), token('ᆫ', 'ETM', 25, 1), token('거', 'NNB', 27, 1),
  ];
  assert.deepEqual(summarize(matchKoreanTokenList({ text, tokenList })), [
    'adjective_noun:싼 쪽@7-10', 'adjective_noun:어두운 부분@17-23', 'adjective_noun:큰 거@25-28', 'scale:큰@25-26',
  ]);
  const verbTokenList = [token('말하', 'VV', 0, 2), token('는', 'ETM', 2, 1), token('것', 'NNB', 4, 1)];
  assert.deepEqual(matchKoreanTokenList({ text: '말하는 것', tokenList: verbTokenList }), [], '동사 관형형은 2-2 가 아니다');
});

test('숫자+단위는 3-1, 변화·비교·결론은 3-2, 척도 형용사는 3-3 이다', () => {
  const text = '더 높다 결국 두 배 넓죠';
  const tokenList = [
    token('더', 'MAG', 0, 1), token('높', 'VA', 2, 1), token('다', 'EF', 3, 1),
    token('결국', 'NNG', 5, 2), token('두', 'MM', 8, 1), token('배', 'NNG', 10, 1), token('넓', 'VA', 12, 1), token('죠', 'EF', 13, 1),
  ];
  assert.deepEqual(summarize(matchKoreanTokenList({ text, tokenList })), [
    'change:더 높@0-3', 'change:결국@5-7', 'value:두 배@8-11', 'scale:넓@12-13',
  ]);
  const verbTokenList = [
    token('많이', 'MAG', 0, 2), token('오르', 'VV', 3, 1), token('었', 'EP', 4, 1), token('고', 'EC', 5, 1),
    token('줄', 'NNB', 7, 1), token('알', 'VV', 9, 1), token('었', 'EP', 10, 1), token('다', 'EF', 11, 1),
  ];
  assert.deepEqual(summarize(matchKoreanTokenList({ text: '많이 올랐고 줄 알았다', tokenList: verbTokenList })), ['change:올@3-4']);
});

test('한국어 어절 근사는 낱말 목록·받침으로 대조하고 isApproximate 를 붙인다', () => {
  const candidateList = matchKoreanRegex({ text: '이렇게 보시면 30% 올랐습니다. 두 안 중에 싼 쪽으로 가죠. 오른쪽을 보면 더 높다.' });
  assert.deepEqual(summarize(candidateList), [
    'demonstrative:이렇게@0-3', 'value:30%@8-11', 'change:올랐@12-14', 'adjective_noun:싼 쪽@26-29', 'change:더 높다@44-48',
  ]);
  assert.ok(candidateList.every((candidate) => candidate.isApproximate === true && candidate.source === 'methodology'));
  assert.deepEqual(summarize(matchKoreanRegex({ text: '저기요 저기를 보세요. 대기 시간이 꽤 길죠. 그런 거, 한 곳' })), [
    'demonstrative:저기@4-6', 'scale:길죠@22-24', 'value:한 곳@32-35',
  ], '"그런 거" 는 지시 관형사, "한 곳" 은 수사+단위라서 2-2 가 아니다');
  assert.equal(hasNieunFinal('싼'), true);
  assert.equal(hasNieunFinal('어두운'), true);
  assert.equal(hasNieunFinal('보다'), false);
});

test('영어는 단어 경계·대소문자 무시로 대조하고 적힌 꼴만 잡는다', () => {
  const text = 'This part rose 30% and the cheap one increased. Compared to last year, so it is wide. We increase it.';
  assert.deepEqual(summarize(matchEnglishLexicon({ text })), [
    'demonstrative:This@0-4', 'value:30%@15-18', 'adjective_noun:the cheap one@23-36', 'change:increased@37-46',
    'change:Compared to@48-59', 'change:so@71-73', 'scale:wide@80-84',
  ]);
  assert.ok(matchEnglishLexicon({ text }).every((candidate) => candidate.isApproximate === false));
  assert.deepEqual(summarize(matchEnglishLexicon({ text: 'about 5 times and 120 people, those few' })), [
    'value:5 times@6-13', 'value:120 people@18-28', 'demonstrative:those@30-35', 'scale:few@36-39',
  ]);
});

test('어절은 앞뒤 문장 부호를 뗀 위치로 읽는다', () => {
  assert.deepEqual(listWord('"이것," 그리고.'), [{ word: '이것', start: 1, end: 3 }, { word: '그리고', start: 6, end: 9 }]);
});

test('언어에 따라 한국어 매처와 영어 대조를 고르고 Kiwi 를 못 쓰면 auto 는 근사로 내려간다', async () => {
  assert.deepEqual(summarize(REGEX_MATCHER.match({ text: 'This part', language: 'en' })), ['demonstrative:This@0-4']);
  assert.deepEqual(summarize(REGEX_MATCHER.match({ text: '이것은', language: 'ko' })), ['demonstrative:이것@0-2']);
  const failingAnalyzer = async () => { throw new Error('모델 없음'); };
  const warnList = [];
  const matcher = await createMethodologyMatcher({ createAnalyzer: failingAnalyzer, onWarn: (message) => warnList.push(message) });
  assert.equal(matcher.kind, MATCHER_KIND_MAP.regex);
  assert.equal(matcher.isApproximate, true);
  assert.match(warnList[0], /근사/);
  await assert.rejects(() => createMethodologyMatcher({ kind: MATCHER_KIND_MAP.kiwi, createAnalyzer: failingAnalyzer }), /모델 없음/);
});

test('Kiwi 모델이 있으면 실제 형태소 분석으로 샘플 트리거를 잡는다', { skip: hasKiwiModel() ? false : 'Kiwi 모델 없음 (tools/eval/setup-kiwi.sh)' }, async () => {
  const matcher = await createMethodologyMatcher({ kind: MATCHER_KIND_MAP.kiwi });
  assert.equal(matcher.isApproximate, false);
  assert.deepEqual(summarize(matcher.match({ text: '두 안 중에 싼 쪽으로 가죠.', language: 'ko' })), ['adjective_noun:싼 쪽@7-10']);
  assert.deepEqual(summarize(matcher.match({ text: '피해 지역이 꽤 넓죠. 여의도의 열 배쯤 됩니다.', language: 'ko' })), [
    'scale:넓@9-10', 'value:열 배@18-21',
  ]);
  assert.deepEqual(summarize(matcher.match({ text: '저기요 잠깐만요, 보여서 좋네요', language: 'ko' })), []);
});
