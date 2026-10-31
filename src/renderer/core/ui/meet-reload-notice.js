import { MEET_RELOAD_TARGET_MAP } from '../constants.js';
import { defaultUiText } from '../i18n/ui-text.js';

export function buildMeetReloadNotice({ target, isCaptureActive, t = defaultUiText }) {
  const head = t(target === MEET_RELOAD_TARGET_MAP.home ? 'meetReload.homeHead' : 'meetReload.reloadedHead');
  if (isCaptureActive) return `${head} ${t('meetReload.rejoinAndRestart')}`;
  return target === MEET_RELOAD_TARGET_MAP.home
    ? `${head} ${t('meetReload.joinWithCode')}`
    : `${head} ${t('meetReload.rejoin')}`;
}
