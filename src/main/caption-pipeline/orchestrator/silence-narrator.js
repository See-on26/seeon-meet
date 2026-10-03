const {
  DESCRIPTION_TAIL_NOUN_LIST, cutAtTailNoun, hasCompleteTailNoun,
} = require('../agents/shared/narration-format');

const DESCRIPTION_PREFIX = '이미지 제시';
const DESCRIPTION_PREFIX_PATTERN = /^\s*이미지 제시\s*,?\s*/;
const MIN_DESCRIPTION_WORD_COUNT = 3;
// "사진들이" → "사진이": 복수 '들'을 떼야 뒤 조사까지 떼어 자료 명사 지점을 찾을 수 있다. 낱말 하나에만 쓴다.
const PLURAL_TAIL_NOUN_PATTERN = new RegExp(
  `(${DESCRIPTION_TAIL_NOUN_LIST.join('|')})들((?:으로|이|가|을|를|은|는|과|와|의|에|도|로)?)$`,
);
const TRAILING_PUNCTUATION_PATTERN = /[\s.,!?…·]+$/;
// VLM 이 형식 예시를 흉내 내 "타임라인 제시, …"처럼 머리말을 직접 쓰는 경우.
const SELF_PREFIX_PATTERN = /^[^,]{1,20}?\s*제시\s*,\s*/;

function countWordOf(phrase) {
  return phrase.split(/\s+/).filter(Boolean).length;
}

// 자료 명사 지점까지 자른다. 끝 판정에만 복수형을 낱말별로 정리한 사본을 쓰고,
// 잘린 지점 앞 낱말은 원문 그대로 둔다("그래프들이 나란히 놓인 비교 화면"의 조사를 깨지 않기 위해서다).
function cutAtMaterialNoun({ body }) {
  if (hasCompleteTailNoun({ text: body })) return body;
  const wordList = body.split(/\s+/).filter(Boolean);
  const normalizedText = wordList.map((word) => word.replace(PLURAL_TAIL_NOUN_PATTERN, '$1$2')).join(' ');
  const normalizedCut = hasCompleteTailNoun({ text: normalizedText })
    ? normalizedText
    : cutAtTailNoun({ text: normalizedText, maxWordCount: wordList.length, minWordCount: MIN_DESCRIPTION_WORD_COUNT });
  if (!normalizedCut) return null;
  const cutWordList = normalizedCut.split(' ');
  return [...wordList.slice(0, cutWordList.length - 1), cutWordList[cutWordList.length - 1]].join(' ');
}

// 무발화 해설은 "보라고 한 자료"를 알려 주는 것이라 자료 명사(사진·그래프·표…)로 끝맺어야 한다.
// 끝이 흐리면("검은 배경에 하얀") 자료 명사 지점까지 자르고, 그런 지점이 없으면 버린다.
function finalizeSilenceDescription({ text }) {
  const body = String(text || '').replace(DESCRIPTION_PREFIX_PATTERN, '').replace(TRAILING_PUNCTUATION_PATTERN, '').trim();
  if (!body) return null;
  const cut = cutAtMaterialNoun({ body });
  if (!cut) return null;
  // 자른 뒤에도 머리말 뒤가 자료 명사로 끝나면 머리말을 뗀다. 자료 명사가 머리말 안에만 있으면("…그래프 제시,") 그대로 둔다.
  const afterSelfPrefix = cut.replace(SELF_PREFIX_PATTERN, '');
  const isSelfPrefixDroppable = afterSelfPrefix !== cut && hasCompleteTailNoun({ text: afterSelfPrefix })
    && countWordOf(afterSelfPrefix) >= MIN_DESCRIPTION_WORD_COUNT;
  const finalized = isSelfPrefixDroppable ? afterSelfPrefix : cut;
  if (countWordOf(finalized) < MIN_DESCRIPTION_WORD_COUNT) return null;
  return `${DESCRIPTION_PREFIX}, ${finalized}`;
}

const SILENCE_RESULT_MAP = {
  gated: 'gated',
  blocked: 'blocked',
  none: 'none',
  dropped: 'dropped',
  emitted: 'emitted',
  failed: 'failed',
};

// 무발화 해설 한 건: 억제 확인 → 침묵 유형 판정 → 화면 묘사 → 내보내기.
// 묘사·내보내기는 요청마다 화면·예산이 달라 호출부가 넘긴다. 어느 단계에서 끝나든 게이트는 반드시 반납한다.
function createSilenceNarrator({ gate, judge }) {
  async function run({ slideLabel, transcript, silenceMs, describe, emit }) {
    const acquired = gate.tryAcquire({ slideLabel });
    if (!acquired.isAllowed) return { status: SILENCE_RESULT_MAP.gated, reason: acquired.reason };
    let isEmitted = false;
    try {
      const verdict = await judge.judge({ transcript, silenceMs });
      if (!verdict.hasCue) {
        return { status: SILENCE_RESULT_MAP.blocked, reason: verdict.reason, source: verdict.source };
      }
      const described = await describe();
      if (!described?.isGrounded || !described.text) return { status: SILENCE_RESULT_MAP.none };
      const text = finalizeSilenceDescription({ text: described.text });
      if (!text) return { status: SILENCE_RESULT_MAP.none, rawText: described.text };
      const sent = await emit({ text });
      isEmitted = Boolean(sent?.isEmitted);
      return { status: isEmitted ? SILENCE_RESULT_MAP.emitted : SILENCE_RESULT_MAP.dropped, text };
    } catch (error) {
      return { status: SILENCE_RESULT_MAP.failed, reason: error.message };
    } finally {
      gate.release({ ticket: acquired.ticket, slideLabel, isEmitted });
    }
  }

  return { run };
}

module.exports = { createSilenceNarrator, finalizeSilenceDescription, SILENCE_RESULT_MAP };
