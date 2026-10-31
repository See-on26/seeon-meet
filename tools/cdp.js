const puppeteer = require('puppeteer-core');

async function connect(port = 9222) {
  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${port}`,
    defaultViewport: null,
  });
  const pageList = await browser.pages();
  const isViewerUrl = (url) => url.includes('/renderer/app/');
  const viewer = pageList.find((page) => isViewerUrl(page.url())) || null;

  const meet = pageList.find((page) => !isViewerUrl(page.url())) || null;
  return { browser, pageList, viewer, meet };
}

module.exports = { connect };
