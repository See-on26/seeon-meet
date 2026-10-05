import { createDemoState, reduceDemoState, readKeyAction, DEMO_ACTION_MAP } from './demo/demo-state.js';

const cardListElement = document.getElementById('cardList');
let state = createDemoState();

function renderCard(card) {
  const cardElement = document.createElement('div');
  cardElement.className = 'card';
  const badge = document.createElement('div');
  badge.className = 'badge';
  badge.textContent = card.badge;
  const text = document.createElement('div');
  text.className = 'text';
  text.textContent = card.text;
  const rationale = document.createElement('div');
  rationale.className = 'rationale';
  rationale.textContent = card.rationaleText || '';
  cardElement.append(badge, text, rationale);
  return cardElement;
}

function render() {
  document.documentElement.style.setProperty('--font-size', `${state.fontSizePx}px`);
  document.body.classList.toggle('is-rationale-visible', state.isRationaleVisible);
  cardListElement.replaceChildren(...state.cardList.map(renderCard));
  cardListElement.scrollTop = cardListElement.scrollHeight;
}

function dispatch(action) {
  state = reduceDemoState(state, action);
  render();
}

window.labDemo.onCard((card) => dispatch({ type: DEMO_ACTION_MAP.card, card }));
window.addEventListener('keydown', (event) => {
  const actionType = readKeyAction({
    code: event.code, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey,
  });
  if (!actionType) return;
  event.preventDefault();
  dispatch({ type: actionType });
});
render();
