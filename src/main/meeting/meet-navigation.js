const MEET_HOME_URL = 'https://meet.google.com/';

// 회의 코드(abc-defg-hij)가 도메인 바로 뒤나 meet/ 아래(meet/abc-defg-hij)에 붙은 Meet 주소.
// 렌더러 constants.js 의 MEET_MEETING_URL_PATTERN 과 같은 규칙이다.
const MEET_MEETING_URL_PATTERN = /^https:\/\/meet\.google\.com\/(?:meet\/)?[a-z]{3}-[a-z]{4}-[a-z]{3}/;

// 회의 화면 안에서 열어도 되는 곳. 로그인은 회의 화면 안에서 끝나야 쿠키가 회의 세션에 남는다.
const IN_VIEW_HOST_SET = new Set(['meet.google.com', 'accounts.google.com']);

const EXTERNAL_PROTOCOL_SET = new Set(['https:', 'http:']);

function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isMeetingUrl(url) {
  return MEET_MEETING_URL_PATTERN.test(url || '');
}

function isInViewUrl(url) {
  const parsed = parseUrl(url);
  return Boolean(parsed) && parsed.protocol === 'https:' && IN_VIEW_HOST_SET.has(parsed.hostname);
}

// 회의 화면은 주소 창이 없어 다른 사이트로 바뀌면 돌아오기 어렵다. 새 창 링크는 Meet·로그인만 회의 화면에 열고,
// 그 밖의 웹 주소는 기본 브라우저로 보낸다. 웹 주소가 아닌 링크(mailto·javascript·file 등)는 열지 않는다.
function handleMeetWindowOpen({ url, loadInView, openExternal }) {
  if (isInViewUrl(url)) loadInView(url);
  else if (EXTERNAL_PROTOCOL_SET.has(parseUrl(url)?.protocol)) openExternal(url);
  return { action: 'deny' };
}

module.exports = { MEET_HOME_URL, isMeetingUrl, isInViewUrl, handleMeetWindowOpen };
