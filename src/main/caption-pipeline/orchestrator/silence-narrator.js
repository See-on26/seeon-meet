const {
  DESCRIPTION_TAIL_NOUN_LIST, cutAtTailNoun, hasCompleteTailNoun,
} = require('../agents/shared/narration-format');

const DESCRIPTION_PREFIX = '이미지 제시';
const DESCRIPTION_PREFIX_PATTERN = /^\s*이미지 제시\s*,?\s*/;
const MIN_DESCRIPTION_WORD_COUNT = 3;
// "사진들이" → "사진이": 복수 '들'을 떼야 뒤 조사까지 떼어 자료 명사 지점을 찾을 수 있다.
const PLURAL_TAIL_NOUN_PATTERN = new RegExp(
  `(${DESCRIPTION_TAIL_NOUN_LIST.join('|')})들(?=(?:으로|이|가|을|를|은|는|과|와|의|에|도|로)?(?:\\s|$))`, 'g',
);
// VLM 이 형식 예시를 흉내 내 "타임라인 제시, …"처럼 머리말을 직접 쓰는 경우.
const SELF_PREFIX_PATTERN = /^[^,]{1,20}?\s*제시\s*,\s*/;

// 무발화 해설은 "보라고 한 자료"를 알려 주는 것이라 자료 명사(사진·그래프·표…)로 끝맺어야 한다.
// 끝이 흐리면("검은 배경에 하얀") 자료 명사 지점까지 자르고, 그런 지점이 없으면 버린다.
function finalizeSilenceDescription({ text }) {
  const body = String(text || '').replace(DESCRIPTION_PREFIX_PATTERN, '').replace(PLURAL_TAIL_NOUN_PATTERN, '$1').trim();
  if (!body) return null;
  const countWordOf = (phrase) => phrase.split(/\s+/).length;
  const cut = hasCompleteTailNoun({ text: body })
    ? body
    : cutAtTailNoun({ text: body, maxWordCount: countWordOf(body), minWordCount: MIN_DESCRIPTION_WORD_COUNT });
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
