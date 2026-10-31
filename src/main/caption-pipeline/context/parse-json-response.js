// 모델 응답에서 JSON 객체 하나를 꺼낸다. 코드펜스와 앞뒤 설명 문장을 허용한다.
function parseJsonObject(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

module.exports = { parseJsonObject };
