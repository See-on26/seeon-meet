const { requestVlmContent } = require('./shared/vlm-gateway');
const { salvageSlotMap } = require('./shared/caption-parser');

const AGENT_LABEL = '슬라이드 재캡션';

const RECAPTION_MAX_TOKENS = 3000;

const RECAPTION_TIMEOUT_MS = 90000;
const RECAPTION_TEMPERATURE = 0.2;

const RECAPTION_REPETITION_PENALTY = 1.05;

const TRUNCATED_BODY_PATTERN = /"bodyText"\s*:\s*"([^"]+)$/;

function buildSlideRecaptionPrompt({ hasAnnotation }) {
  const imageRoleLineList = hasAnnotation
    ? [
      '이미지는 두 장이다.',
      '  · 첫 번째: 이 슬라이드가 처음 표시된 순간의 원본 화면',
      '  · 두 번째: 같은 슬라이드에 발표자가 필기·표시를 마친 최종 화면',
      '두 장은 같은 슬라이드다. 두 번째에만 새로 생긴 표시(밑줄·동그라미·화살표·별표·강조 등)를 찾아라.',
    ]
    : ['이미지는 회의에서 공유된 슬라이드 한 장이다.'];

  const slotLineList = hasAnnotation
    ? [
      '  · annotationText: 두 번째 이미지에만 새로 생긴 표시와, 그 표시가 무엇을 가리키는지.',
      '      발표자가 어디를 강조했는지가 회의에서 중요한 신호다. 새 표시가 없으면 빈 문자열.',
    ]
    : [];

  return [
    ...imageRoleLineList,
    '',
    '이 캡션은 회의가 끝난 뒤 시각장애인 참석자에게 줄 요약본의 재료다.',
    '실시간 고지가 아니므로 길이를 아끼지 마라. 화면을 볼 수 없는 사람이 이 글만 읽고도',
    '그 슬라이드에 무엇이 있었는지 재구성할 수 있어야 한다.',
    '',
    '적을 것:',
    '  · title: 슬라이드 제목. 화면에 제목이 없으면 빈 문자열.',
    '  · bodyText: 화면에 있는 내용을 남김없이 적는다.',
    '      - 소제목·항목·글머리표의 문구를 실제 표현 그대로 옮긴다.',
    '      - 표가 있으면 어떤 항목과 어떤 값이 있는지 문장으로 풀어 쓴다.',
    '      - 그래프·다이어그램은 무엇을 나타내며 어떤 경향인지 적는다. 축과 단위도 밝힌다.',
    '      - 사진·그림은 무엇이 찍혀 있는지 적는다.',
    '      - 숫자와 고유명사는 화면에 적힌 그대로 옮긴다. 반올림하거나 바꾸지 마라.',
    '      - 로고·배경·페이지 장식 같은 꾸밈 요소는 제외한다.',
    ...slotLineList,
    '',
    '화면에 실제로 보이는 것만 쓴다. 읽을 수 없는 글자는 추측해 지어내지 말고 그렇다고 밝혀라.',
    '표나 도형을 글자로 그리지 마라(괘선·막대·정렬 공백 금지). 반드시 문장으로 풀어 쓴다.',
    '',
    'JSON 한 줄로만 출력한다(다른 텍스트 금지):',
    hasAnnotation
      ? '{ "title": "제목", "bodyText": "화면 내용 서술", "annotationText": "새로 생긴 표시 서술" }'
      : '{ "title": "제목", "bodyText": "화면 내용 서술" }',
  ].join('\n');
}

function parseSlideRecaptionText(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const cleaned = text.replace(/```(?:json)?/g, '').trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const bodyText = String(parsed.bodyText ?? '').trim();
      if (bodyText) {
        return {
          title: String(parsed.title ?? '').trim(),
          bodyText,
          annotationText: String(parsed.annotationText ?? '').trim(),
        };
      }
    } catch {  }
  }

  const salvaged = salvageSlotMap({ text: cleaned });
  if (salvaged?.bodyText) {
    return {
      title: String(salvaged.title ?? '').trim(),
      bodyText: salvaged.bodyText,
      annotationText: String(salvaged.annotationText ?? '').trim(),
    };
  }

  const truncatedBody = cleaned.match(TRUNCATED_BODY_PATTERN);
  if (truncatedBody) {
    const bodyText = truncatedBody[1].replace(/\\$/, '').trim();
    if (bodyText) {
      return { title: String(salvaged?.title ?? '').trim(), bodyText, annotationText: '' };
    }
  }

  if (!cleaned.includes('{')) return { title: '', bodyText: cleaned, annotationText: '' };
  return null;
}

function createSlideRecaptionAgent({ config }) {
  async function generate({ baseJpegBuffer, annotationJpegBuffer = null, slideMajor }) {
    function requestOnce({ hasAnnotation }) {
      return requestVlmContent({
        config,
        jpegBufferList: hasAnnotation ? [baseJpegBuffer, annotationJpegBuffer] : [baseJpegBuffer],
        prompt: buildSlideRecaptionPrompt({ hasAnnotation }),
        label: `${AGENT_LABEL} ${slideMajor}`,
        temperature: RECAPTION_TEMPERATURE,
        maxTokens: RECAPTION_MAX_TOKENS,
        timeoutMs: RECAPTION_TIMEOUT_MS,
        extraBodyMap: { repetition_penalty: RECAPTION_REPETITION_PENALTY },
      });
    }

    let hasAnnotation = Boolean(annotationJpegBuffer);
    let content;
    try {
      content = await requestOnce({ hasAnnotation });
    } catch (error) {
      if (!hasAnnotation) throw error;
      console.warn(`[summary] 슬라이드 ${slideMajor} 2장 요청 실패, 원본 1장으로 재시도: ${error.message}`);
      hasAnnotation = false;
      content = await requestOnce({ hasAnnotation });
    }

    const parsed = parseSlideRecaptionText(content);
    if (!parsed) throw new Error(`VLM(${AGENT_LABEL}) 응답 파싱 실패 (슬라이드 ${slideMajor})`);
    return { ...parsed, isAnnotationIncluded: hasAnnotation };
  }

  return { generate };
}

module.exports = {
  createSlideRecaptionAgent, buildSlideRecaptionPrompt, parseSlideRecaptionText,
  RECAPTION_MAX_TOKENS,
};
