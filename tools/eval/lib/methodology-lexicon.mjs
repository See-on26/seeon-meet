// 회의록 3.1.4 트리거 말주머니. 한국어는 Kiwi 품사 단위로 대조하고(Kiwi 를 못 쓰면 어절 근사),
// 영어는 단어 경계·대소문자 무시로 대조한다. 영어 변화 표현은 적힌 꼴만 잡는다(increased 는 잡고 increase 는 안 잡는다).

// 2-1 지시대명사: 관형사 이·그·저(구어 요), 대명사 이것·그것·저것·여기·거기·저기(구어 요거·요기), 부사 이렇게·그렇게·저렇게.
export const DEMONSTRATIVE_DETERMINER_LIST = ['이', '그', '저', '요'];
export const DEMONSTRATIVE_PRONOUN_LIST = ['이것', '그것', '저것', '이거', '그거', '저거', '여기', '거기', '저기', '요거', '요것', '요기'];
export const DEMONSTRATIVE_ADVERB_LIST = ['이렇게', '그렇게', '저렇게'];
// Kiwi 는 "이렇게" 를 형용사 어간 "이렇" + 연결 어미 "게" 로 나눈다.
export const DEMONSTRATIVE_ADVERB_STEM_LIST = ['이렇', '그렇', '저렇'];
// "이런·그런 거" 는 지시 관형사라서 형용사 + 지시 명사(2-2)로 보지 않는다.
export const DEMONSTRATIVE_ADNOMINAL_LIST = ['이런', '그런', '저런', '요런'];

// 2-2 형용사 + 지시 명사: 형용사 관형형(빨간·싼·어두운·큰 등) + 쪽·부분·거·것·곳.
export const ADJECTIVE_REFERENT_LIST = ['쪽', '부분', '거', '것', '곳'];
// Kiwi 가 형용사인데 동사로 붙이는 낱말("싼" → 싸/VV).
export const ADJECTIVE_LIKE_VERB_LIST = ['싸'];

// 3-1 단순 수치: 숫자 + 단위(%, 배, 명, 원 등).
export const VALUE_UNIT_LIST = [
  '%', '퍼센트', '프로', '배', '명', '원', '개', '건', '회', '번', '위', '등', '점', '곳', '종', '가지', '달러', '톤',
  '억', '만', '천', '조', '년', '월', '일', '시간', '분', '초', '살',
];
export const NATIVE_NUMERAL_LIST = ['한', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉', '열', '하나', '둘', '셋', '넷', '스물', '서른', '마흔', '쉰'];

// 3-2 변화·비교·결론: 올랐다·떨어졌다·늘었다·줄었다, 더 높다·~에 비해, 결국·따라서.
export const CHANGE_VERB_STEM_LIST = ['오르', '떨어지', '늘', '줄', '비하'];
export const CONCLUSION_WORD_LIST = ['결국', '따라서'];
export const COMPARATIVE_ADVERB = '더';
export const CHANGE_WORD_PREFIX_LIST = [
  '올랐', '올라', '오른', '떨어졌', '떨어진', '떨어져', '떨어지', '늘었', '늘어', '늘고', '늘면', '줄었', '줄어', '줄고', '줄면',
  '비해', '비하면', '결국', '따라서',
];
// 변화 어휘로 시작하지만 변화가 아닌 낱말.
export const CHANGE_WORD_EXCLUDE_PREFIX_LIST = ['오른쪽', '오른편', '올라가서', '올라오'];
export const COMPARATIVE_ADJECTIVE_PREFIX_LIST = ['높', '낮', '크', '커', '작', '많', '적', '좋', '나아', '나은', '길', '짧', '넓', '좁', '비싸', '싸'];

// 3-3 추상적 척도: 크다·작다·길다·짧다·넓다·많다·적다.
export const SCALE_ADJECTIVE_STEM_LIST = ['크', '작', '길', '짧', '넓', '많', '적'];
export const SCALE_WORD_LIST = [
  '크다', '큽니다', '커요', '크죠', '크고', '큰', '커서', '작다', '작습니다', '작아요', '작죠', '작고', '작은', '작아서',
  '길다', '깁니다', '길어요', '길죠', '길고', '긴', '길어서', '짧다', '짧습니다', '짧아요', '짧죠', '짧고', '짧은', '짧아서',
  '넓다', '넓습니다', '넓어요', '넓죠', '넓고', '넓은', '넓어서', '많다', '많습니다', '많아요', '많죠', '많고', '많은', '많아서',
  '적다', '적습니다', '적어요', '적죠', '적고', '적은', '적어서',
];

// 어절 근사에서 대명사·지시 명사 뒤에 붙어도 되는 조사. "저기요" 같은 감탄사를 거르려고 "요" 는 넣지 않는다.
export const PRONOUN_PARTICLE_LIST = ['', '은', '는', '이', '가', '을', '를', '에', '에서', '의', '도', '만', '로', '으로', '서', '랑', '하고', '처럼', '부터', '까지'];

// 영어 말주머니.
export const ENGLISH_PATTERN_SOURCE_MAP = {
  demonstrative: String.raw`\b(?:this|that|these|those|here|there)\b`,
  adjectiveNoun: String.raw`\bthe\s+[a-z]+(?:-[a-z]+)?\s+(?:one|ones|side|part)\b`,
  value: String.raw`\b\d[\d,.]*(?:\s?%|\s?(?:percent|times|people|dollars|won|million|billion|thousand|points?|hours?|minutes?|seconds?|days?|weeks?|months?|years?)\b)`,
  change: String.raw`\b(?:increased|dropped|higher than|compared to|so|in the end)\b`,
  scale: String.raw`\b(?:big|small|long|short|wide|many|few)\b`,
};
