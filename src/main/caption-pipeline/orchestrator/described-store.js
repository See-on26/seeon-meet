const MAX_ELEMENT_PER_SLIDE = 20;

function toMajorKey(slideLabel) {
  return String(slideLabel ?? '').split('-')[0];
}

function createDescribedStore() {
  const elementListBySlideMap = new Map();
  let currentSlideKey = null;

  function setCurrentSlide(slideLabel) {
    const key = toMajorKey(slideLabel);
    currentSlideKey = key || null;
    if (currentSlideKey && !elementListBySlideMap.has(currentSlideKey)) {
      elementListBySlideMap.set(currentSlideKey, []);
    }
  }

  function addDescribed(slideLabel, elementList) {
    const key = toMajorKey(slideLabel) || currentSlideKey;
    if (!key) return;
    if (!elementListBySlideMap.has(key)) elementListBySlideMap.set(key, []);
    const list = elementListBySlideMap.get(key);
    for (const element of elementList || []) {
      const trimmed = typeof element === 'string' ? element.trim() : '';
      if (trimmed && !list.includes(trimmed)) list.push(trimmed);
    }
    while (list.length > MAX_ELEMENT_PER_SLIDE) list.shift();
  }

  function getDescribed(slideLabel) {
    const key = toMajorKey(slideLabel) || currentSlideKey;
    return key && elementListBySlideMap.has(key) ? [...elementListBySlideMap.get(key)] : [];
  }

  function reset() {
    elementListBySlideMap.clear();
    currentSlideKey = null;
  }

  return { setCurrentSlide, addDescribed, getDescribed, reset };
}

module.exports = { createDescribedStore };
