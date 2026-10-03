const { NARRATION_TYPE_MAP } = require('../contracts/narration-types');
const { toNarrationClass } = require('../contracts/narration-class');
const { resolveCandidateList } = require('./arbiter');

const GENERATABLE_TYPE_LIST = [
  NARRATION_TYPE_MAP.deixis, NARRATION_TYPE_MAP.interpretation, NARRATION_TYPE_MAP.visualDescription,
];

// 라우터가 내는 시각 묘사 후보는 척도뿐이다. 척도는 보류 중이라 기본으로 걸러 낸다.
// 중재 전에 거르므로, 척도에 흡수됐을 지시 후보가 남아 대신 선택된다.
// 사용자가 끈 분류(C15)도 중재 전에 걸러 생성하지 않는다. 값·의미가 꺼지면 흡수됐을 지시 후보가 대신 선택된다.
function filterGeneratableCandidateList({ candidateList, isScaleEnabled, disabledClassList = [] }) {
  const keptList = [];
  const excludedList = [];
  for (const candidate of candidateList) {
    if (!GENERATABLE_TYPE_LIST.includes(candidate.type)) continue;
    if (disabledClassList.includes(toNarrationClass({ narrationType: candidate.type }))) continue;
    if (!isScaleEnabled && candidate.type === NARRATION_TYPE_MAP.visualDescription) {
      excludedList.push(candidate);
      continue;
    }
    keptList.push(candidate);
  }
  return { keptList, excludedList };
}

function selectGeneratableCandidate({ candidateList, isScaleEnabled = false, disabledClassList = [] }) {
  const { keptList, excludedList } = filterGeneratableCandidateList({
    candidateList, isScaleEnabled, disabledClassList,
  });
  if (!keptList.length) return { selected: null, excludedList };
  const { resolvedList } = resolveCandidateList({ candidateList: keptList });
  return { selected: resolvedList[0] || null, excludedList };
}

module.exports = { selectGeneratableCandidate, GENERATABLE_TYPE_LIST };
