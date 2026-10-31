// 지시 대상·발화 기반 트리거는 main 이 전사 직후 형태소 분석으로 뽑아 'asr' 이벤트에 후보 구로 실어 보낸다
// (main/caption-pipeline/trigger/speech-trigger.js). 여기서는 후보가 있는 조각을 지시 후보 이벤트로 바꾼다.
// 바로 뒤 조각의 후보도 버리지 않는다. 진행 중인 결정에 합칠지 새로 판단할지는 후보 스케줄러가 정한다.
// 후보가 공백인지는 main 의 판단 LLM 이 가린다.
export function describeTriggerCandidateList(candidateList = []) {
  return candidateList.map((candidate) => candidate.phrase).filter(Boolean).join(', ');
}

export class DeixisDetector {
  constructor({ onDeixis }) {
    this.onDeixis = onDeixis;
  }

  handleTranscript({ text, candidateList = [], captureTs, eventWallTs = null, resolveEventWallTs = null }) {
    const validList = (candidateList || []).filter((candidate) => candidate && candidate.phrase);
    if (!validList.length) return null;
    const deixisEvent = {
      text: String(text || '').trim(), trigger: describeTriggerCandidateList(validList), candidateList: validList, captureTs,
      eventWallTs: resolveEventWallTs ? resolveEventWallTs({ trigger: validList[0].phrase }) : eventWallTs,
    };
    this.onDeixis?.(deixisEvent);
    return deixisEvent;
  }
}
