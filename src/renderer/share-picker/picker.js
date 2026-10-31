import { createCaptionLanguageStore } from '../core/mode/caption-language-store.js';
import { createUiText } from '../core/i18n/ui-text.js';
import { describeShareItem } from './share-item.js';

// Meet 발표에서 공유할 화면·창을 고르는 창. 글자는 앱과 같은 캡션 언어를 따른다(같은 localStorage).
function readLocalStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const languageStore = createCaptionLanguageStore({ storage: readLocalStorage() });
const t = createUiText({ getLanguage: () => languageStore.get() });
const $ = (id) => document.getElementById(id);
let isChosen = false;

// 한 번만 고른다. 두 번 누르거나 고른 뒤 Esc 를 눌러도 다시 보내지 않는다.
function choose(id) {
  if (isChosen) return;
  isChosen = true;
  window.sharePicker.choose(id).catch(() => window.close());
}

function renderItem(item) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'item';
  button.setAttribute('aria-label', describeShareItem({ item, t }));
  const image = document.createElement('img');
  image.alt = '';
  image.src = item.thumbnailDataUrl;
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = item.name;
  button.append(image, name);
  button.addEventListener('click', () => choose(item.id));
  return button;
}

function renderSection({ headingKey, itemList }) {
  if (!itemList.length) return null;
  const section = document.createElement('section');
  const heading = document.createElement('h2');
  heading.textContent = t(headingKey);
  const grid = document.createElement('div');
  grid.className = 'grid';
  grid.append(...itemList.map(renderItem));
  section.append(heading, grid);
  return section;
}

async function start() {
  document.documentElement.lang = languageStore.get();
  document.title = t('sharePicker.title');
  $('heading').textContent = t('sharePicker.heading');
  $('cancelBtn').textContent = t('sharePicker.cancel');
  $('cancelBtn').addEventListener('click', () => choose(null));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') choose(null); });

  const itemList = await window.sharePicker.getSourceList();
  const sectionList = [
    renderSection({ headingKey: 'sharePicker.screenHeading', itemList: itemList.filter((item) => item.kind === 'screen') }),
    renderSection({ headingKey: 'sharePicker.windowHeading', itemList: itemList.filter((item) => item.kind === 'window') }),
  ].filter(Boolean);
  $('list').append(...sectionList);
  document.querySelector('.item')?.focus();
}

start();
