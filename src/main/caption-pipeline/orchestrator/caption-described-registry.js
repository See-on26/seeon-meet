const DEFAULT_LIMIT = 100;

// 캡션별로 재설명 금지 목록에 넣은 요소를 기억한다. 그 캡션이 재생되지 않으면(기능 꺼짐·재생 대기 줄에서 버림)
// 사용자가 듣지 못한 요소이므로 되돌려, 다음 지시 해설이 "이미 설명함"으로 건너뛰지 않게 한다.
function createCaptionDescribedRegistry({ describedStore, limit = DEFAULT_LIMIT }) {
  const describedByCaptionMap = new Map();
  const toKey = ({ ts, text }) => `${ts}|${text}`;

  function add({ ts, text, slideLabel, elementList }) {
    describedStore.addDescribed(slideLabel, elementList);
    describedByCaptionMap.set(toKey({ ts, text }), { slideLabel, elementList });
    if (describedByCaptionMap.size > limit) {
      describedByCaptionMap.delete(describedByCaptionMap.keys().next().value);
    }
  }

  function revert({ ts, text }) {
    const key = toKey({ ts, text });
    const described = describedByCaptionMap.get(key);
    if (!described) return null;
    describedStore.removeDescribed(described.slideLabel, described.elementList);
    describedByCaptionMap.delete(key);
    return described;
  }

  return { add, revert, reset: () => describedByCaptionMap.clear() };
}

module.exports = { createCaptionDescribedRegistry };
