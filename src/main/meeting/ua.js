// UA 의 OS 는 앱이 실제로 도는 OS 와 같아야 한다. 브라우저는 navigator.platform·Sec-CH-UA-Platform 으로
// 실제 OS 를 따로 알리므로, 둘이 어긋나면 Meet 이 지원하지 않는 브라우저로 보고 발표(화면 공유)를 막는다.
const CHROME_OS_TOKEN_MAP = {
  darwin: 'Macintosh; Intel Mac OS X 10_15_7',
  win32: 'Windows NT 10.0; Win64; x64',
  linux: 'X11; Linux x86_64',
};
const FIREFOX_OS_TOKEN_MAP = {
  darwin: 'Macintosh; Intel Mac OS X 10.15',
  win32: 'Windows NT 10.0; Win64; x64',
  linux: 'X11; Linux x86_64',
};
const FIREFOX_VERSION = '132.0';
const LOGIN_HOST_LIST = ['accounts.google.com', 'accounts.youtube.com'];

function buildChromeUa({ platform, chromeVersion }) {
  const osToken = CHROME_OS_TOKEN_MAP[platform] || CHROME_OS_TOKEN_MAP.linux;
  return `Mozilla/5.0 (${osToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
}

function buildFirefoxUa({ platform }) {
  const osToken = FIREFOX_OS_TOKEN_MAP[platform] || FIREFOX_OS_TOKEN_MAP.linux;
  return `Mozilla/5.0 (${osToken}; rv:${FIREFOX_VERSION}) Gecko/20100101 Firefox/${FIREFOX_VERSION}`;
}

const CHROME_UA = buildChromeUa({ platform: process.platform, chromeVersion: process.versions.chrome });
const FIREFOX_UA = buildFirefoxUa({ platform: process.platform });

function getUaForUrl(url) {
  try {
    return LOGIN_HOST_LIST.includes(new URL(url).hostname) ? FIREFOX_UA : CHROME_UA;
  } catch {
    return CHROME_UA;
  }
}

module.exports = { CHROME_UA, FIREFOX_UA, LOGIN_HOST_LIST, buildChromeUa, buildFirefoxUa, getUaForUrl };
