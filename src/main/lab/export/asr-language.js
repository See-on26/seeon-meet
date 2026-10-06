// 고른 회의 언어가 실제로 파이프라인에 실렸는지 결과 폴더에 남긴다.
// - sessionLanguage: viewer 가 캡처 시작 때 main 에 넘긴 회의 언어(pipeline-session-start 요청).
// - requestLanguageCountMap: asr 기록의 language(그 조각을 ASR 에 보낼 때 실은 언어)별 조각 수.
// - detectedLanguageCountMap: asr 기록의 detectedLanguage(서버가 고른 언어, auto 면 조각마다 ko·en 중 하나)별 조각 수.
const isLanguageText = (value) => typeof value === 'string' && value !== '';

function countLanguage(recordList, key) {
  const countMap = {};
  for (const record of recordList) {
    if (isLanguageText(record[key])) countMap[record[key]] = (countMap[record[key]] || 0) + 1;
  }
  return countMap;
}

// isMatched: 세션 시작 언어와 ASR 요청 언어가 모두 고른 언어면 true, 하나라도 다르면 false, 근거가 없으면 null.
function summarizeAsrLanguage({ requestedLanguage, sessionLanguage = null, asrRecordList }) {
  const requestLanguageCountMap = countLanguage(asrRecordList, 'language');
  const observedLanguageList = [
    ...(isLanguageText(sessionLanguage) ? [sessionLanguage] : []), ...Object.keys(requestLanguageCountMap),
  ];
  const isMatched = isLanguageText(requestedLanguage) && observedLanguageList.length
    ? observedLanguageList.every((language) => language === requestedLanguage) : null;
  return {
    sessionLanguage: isLanguageText(sessionLanguage) ? sessionLanguage : null,
    requestLanguageCountMap,
    detectedLanguageCountMap: countLanguage(asrRecordList, 'detectedLanguage'),
    isMatched,
  };
}

// viewer 가 받은 asr 이벤트에는 언어가 없다. 같은 조각의 asr 기록(조각 시작 시각 ts 가 같다)에서 서버가 고른 언어를 붙인다.
function attachDetectedLanguage({ asrEventList, asrRecordList }) {
  const detectedLanguageByTsMap = new Map();
  for (const record of asrRecordList) {
    if (isLanguageText(record.detectedLanguage)) detectedLanguageByTsMap.set(record.ts, record.detectedLanguage);
  }
  return asrEventList.map((event) => (detectedLanguageByTsMap.has(event.ts)
    ? { ...event, detectedLanguage: detectedLanguageByTsMap.get(event.ts) } : event));
}

module.exports = { summarizeAsrLanguage, attachDetectedLanguage };
