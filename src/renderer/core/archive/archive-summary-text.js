import { defaultUiText } from '../i18n/ui-text.js';

// 회의 요약은 회의 뒤 백그라운드로 만든다. 지난 회의 상세의 요약 자리에 글이 아직 없으면 만드는 중·실패를 알린다.
const SUMMARY_STATUS_TEXT_KEY_MAP = {
  pending: 'archive.summaryPending',
  failed: 'archive.summaryFailed',
};

export function pickArchiveSummaryText({ summaryText, summaryStatus, t = defaultUiText }) {
  if (summaryText) return summaryText;
  if (Object.hasOwn(SUMMARY_STATUS_TEXT_KEY_MAP, summaryStatus)) return t(SUMMARY_STATUS_TEXT_KEY_MAP[summaryStatus]);
  return t('archive.noSummary');
}

// 요약 저장·실패·음성 저장 고지가 온 회의의 상세가 지난 회의 창에 열려 있으면 그 회의 기록 id 다.
// 목록을 보는 중이거나 다른 회의 상세면 null 이다 — 그 상세의 요약 칸만 다시 채운다.
export function pickArchiveRefreshMeetingId({ isDetailShown, detailMeetingId, detailSessionId, summarySessionId }) {
  if (!isDetailShown || !detailMeetingId || !summarySessionId) return null;
  return detailSessionId === summarySessionId ? detailMeetingId : null;
}
