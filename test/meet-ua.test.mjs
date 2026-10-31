import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  CHROME_UA, FIREFOX_UA, buildChromeUa, buildFirefoxUa, getUaForUrl,
} = require('../src/main/meeting/ua.js');

// Meet 은 UA 의 OS 와 브라우저가 따로 알리는 OS(navigator.platform·Sec-CH-UA-Platform)가 어긋나면
// 발표 단추를 끄고 "브라우저에서 화면을 공유할 수 없습니다"를 띄운다. UA 는 앱이 도는 OS 를 말해야 한다.
test('Windows 에서는 Windows Chrome UA 를 쓴다', () => {
  assert.equal(
    buildChromeUa({ platform: 'win32', chromeVersion: '140.0.7339.41' }),
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.41 Safari/537.36',
  );
});

test('맥에서는 지금까지 쓰던 맥 Chrome UA 를 그대로 쓴다', () => {
  assert.equal(
    buildChromeUa({ platform: 'darwin', chromeVersion: '140.0.7339.41' }),
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.41 Safari/537.36',
  );
});

test('리눅스에서는 리눅스 Chrome UA 를 쓴다', () => {
  assert.match(buildChromeUa({ platform: 'linux', chromeVersion: '140.0.7339.41' }), /\(X11; Linux x86_64\)/);
});

test('로그인용 Firefox UA 도 앱이 도는 OS 를 말한다', () => {
  assert.equal(
    buildFirefoxUa({ platform: 'win32' }),
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
  );
  assert.equal(
    buildFirefoxUa({ platform: 'darwin' }),
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0',
  );
});

test('앱이 쓰는 UA 는 지금 도는 OS 로 만든다', () => {
  assert.equal(CHROME_UA, buildChromeUa({ platform: process.platform, chromeVersion: process.versions.chrome }));
  assert.equal(FIREFOX_UA, buildFirefoxUa({ platform: process.platform }));
});

test('구글 로그인 화면만 Firefox UA, 나머지는 Chrome UA', () => {
  assert.equal(getUaForUrl('https://accounts.google.com/signin'), FIREFOX_UA);
  assert.equal(getUaForUrl('https://meet.google.com/abc-defg-hij'), CHROME_UA);
  assert.equal(getUaForUrl('잘못된 주소'), CHROME_UA);
});
