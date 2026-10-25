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
