const CHROME_UA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
const FIREFOX_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0';
const LOGIN_HOST_LIST = ['accounts.google.com', 'accounts.youtube.com'];

function getUaForUrl(url) {
  try {
    return LOGIN_HOST_LIST.includes(new URL(url).hostname) ? FIREFOX_UA : CHROME_UA;
  } catch {
    return CHROME_UA;
  }
}

module.exports = { CHROME_UA, FIREFOX_UA, LOGIN_HOST_LIST, getUaForUrl };
