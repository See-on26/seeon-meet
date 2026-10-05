import fs from 'node:fs';
import {
  buildMaterialBlockList, selectSlideList, MATERIAL_KIND_MAP, MATERIAL_SKIP_REASON_MAP, DEFAULT_MAX_SLIDE_COUNT,
} from './e2e-material.mjs';
import { buildAnswerRequest, buildChoiceList, INSTRUCTION_KIND_MAP } from './e2e-prompt.mjs';
import { parseAnswerText, scoreAnswer } from './answer-parse.mjs';
import { hashInput } from './cache-store.mjs';
import { mapWithConcurrency } from './concurrency.mjs';

// Bedrock Converse 한도: 메시지 하나에 이미지 20장, 한 장 3.75MB·8000px, 요청 전체 20MB.
// 이미지가 20장을 넘으면 Claude 가 장마다 더 작은 크기(긴 변 2000px)를 요구하므로 20장에서 멈춘다.
// 자료 블록 상한은 20MB 에서 시스템 프롬프트·문항·JSON 틀 몫을 넉넉히 뺀 값이다(base64 로 1.33배 커진 크기로 잰다).
export const BEDROCK_REQUEST_LIMIT_MAP = {
  maxImageCount: 20,
  maxImageBytes: 3_750_000,
  maxMaterialBytes: 18_000_000,
};

// 자료가 없어 돌릴 수 없는 조합의 이유. 결과 폴더를 읽다 실패한 영상과 자료를 만들다 실패한 조합을 더한다.
export const TASK_SKIP_REASON_MAP = {
  ...MATERIAL_SKIP_REASON_MAP,
  runDirUnreadable: 'run_dir_unreadable',
  materialError: 'material_error',
};

const SCREEN_KIND_LIST = [MATERIAL_KIND_MAP.screen, MATERIAL_KIND_MAP.screenOnly];

const formatBytes = (byteCount) => (byteCount >= 1_000_000
  ? `${(byteCount / 1_000_000).toFixed(2)}MB` : `${(byteCount / 1000).toFixed(1)}KB`);

// 캐시 키에 이미지 원본 대신 해시를 넣는다. 같은 이미지·같은 프롬프트면 같은 키다.
function toCacheableMessageList(messageList, hashImage) {
  return messageList.map((message) => ({
    ...message,
    content: message.content.map((block) => (block.image
      ? { image: { format: block.image.format, sha256: hashImage(block.image.source.bytes) } } : block)),
  }));
}

function buildQuestionContext({ question, video }) {
  return {
    questionId: question.id, videoId: question.videoId, domain: video.domain, language: video.language || null,
    category: question.category, subcategory: question.subcategory,
  };
}

// 화면 자료(C·V)를 Bedrock 한도에 맞춘다. 읽지 못하거나 한 장 한도를 넘는 슬라이드는 빼고,
// 장수는 이미지 한도로 자른 뒤 요청 크기가 넘으면 비율만큼 줄인다. 이미지를 다시 만들지는 않는다.
function fitScreenMaterial({ kind, material, maxSlideCount, readImage, requestLimitMap }) {
  const noteList = [];
  const imageMap = new Map();
  const readOnce = (filePath) => {
    if (!imageMap.has(filePath)) imageMap.set(filePath, readImage(filePath));
    return imageMap.get(filePath);
  };
  const usableSlideList = [];
  for (const slide of material.slideList) {
    let byteCount = 0;
    try {
      byteCount = readOnce(slide.filePath).length;
    } catch (error) {
      noteList.push(`슬라이드 ${slide.label} 이미지를 읽지 못해 뺐다 (${error.code || error.message})`);
      continue;
    }
    if (byteCount > requestLimitMap.maxImageBytes) {
      noteList.push(`슬라이드 ${slide.label} 이미지가 ${formatBytes(byteCount)} 로 한 장 한도 ${formatBytes(requestLimitMap.maxImageBytes)} 를 넘어 뺐다`);
      continue;
    }
    usableSlideList.push(slide);
  }
  let slideCount = maxSlideCount;
  if (slideCount > requestLimitMap.maxImageCount) {
    noteList.push(`슬라이드 최대 ${maxSlideCount}장을 Bedrock 이미지 한도 ${requestLimitMap.maxImageCount}장으로 줄였다`);
    slideCount = requestLimitMap.maxImageCount;
  }
  const usableMaterial = { ...material, slideList: usableSlideList };
  const summary = { availableSlideCount: material.slideList.length, sentSlideCount: 0, sentSlideLabelList: [], materialBytes: 0, noteList };
  let firstOverBytes = null;
  let firstOverSlideCount = null;
  for (;;) {
    const result = buildMaterialBlockList({ kind, material: usableMaterial, maxSlideCount: slideCount, readImage: readOnce });
    if (!result.blockList) return { ...result, screenSummary: summary };
    const materialBytes = Buffer.byteLength(JSON.stringify(result.blockList));
    const sentSlideList = selectSlideList({ slideList: usableSlideList, maxSlideCount: slideCount });
    const isOver = materialBytes > requestLimitMap.maxMaterialBytes;
    if (!isOver || sentSlideList.length <= 1) {
      if (firstOverBytes !== null) {
        noteList.push(`요청 크기 ${formatBytes(firstOverBytes)} 가 한도 ${formatBytes(requestLimitMap.maxMaterialBytes)} 를 넘어`
          + ` 슬라이드를 ${firstOverSlideCount}장 → ${sentSlideList.length}장으로 줄였다`);
      }
      if (isOver) noteList.push(`슬라이드 ${sentSlideList.length}장으로도 요청 크기 ${formatBytes(materialBytes)} 가 한도를 넘는다`);
      Object.assign(summary, {
        sentSlideCount: sentSlideList.length, sentSlideLabelList: sentSlideList.map((slide) => slide.label), materialBytes,
      });
      return { ...result, screenSummary: summary };
    }
    if (firstOverBytes === null) {
      firstOverBytes = materialBytes;
      firstOverSlideCount = sentSlideList.length;
    }
    slideCount = Math.max(1, Math.min(sentSlideList.length - 1,
      Math.floor((sentSlideList.length * requestLimitMap.maxMaterialBytes) / materialBytes)));
  }
}

function buildVideoMaterial({ video, kind, materialMap, materialErrorMap, maxSlideCount, readImage, requestLimitMap }) {
  const material = materialMap.get(video.videoId) || null;
  if (kind !== MATERIAL_KIND_MAP.questionOnly && !material && materialErrorMap.has(video.videoId)) {
    return { blockList: null, skipReason: TASK_SKIP_REASON_MAP.runDirUnreadable, detail: materialErrorMap.get(video.videoId) };
  }
  try {
    if (material && SCREEN_KIND_LIST.includes(kind)) {
      return fitScreenMaterial({ kind, material, maxSlideCount, readImage, requestLimitMap });
    }
    return buildMaterialBlockList({ kind, material, humanAdList: video.humanAdList || [], maxSlideCount, readImage });
  } catch (error) {
    return { blockList: null, skipReason: TASK_SKIP_REASON_MAP.materialError, detail: error.message };
  }
}

// 문항 × 조건(또는 필터) × 반복 작업 목록. 자료가 없어 돌릴 수 없는 조합은 skippedList 로 뺀다.
// 자료 블록은 영상·조건마다 한 번만 만들어 같은 영상의 문항이 함께 쓴다(슬라이드 이미지를 문항마다 다시 읽지 않는다).
// screenMaterialList 는 영상·화면 조건마다 슬라이드를 몇 장 보냈고 왜 줄였는지다.
export function buildAnswerTaskList({
  questionSet, materialMap, materialErrorMap = new Map(), kindList, instructionKind, repeatCount = 1,
  maxSlideCount = DEFAULT_MAX_SLIDE_COUNT, readImage = (filePath) => fs.readFileSync(filePath),
  requestLimitMap = BEDROCK_REQUEST_LIMIT_MAP,
}) {
  const videoMap = new Map(questionSet.videoList.map((video) => [video.videoId, video]));
  const materialResultMap = new Map();
  const screenMaterialList = [];
  const resolveMaterial = ({ video, kind }) => {
    const key = `${video.videoId}#${kind}`;
    if (!materialResultMap.has(key)) {
      const result = buildVideoMaterial({ video, kind, materialMap, materialErrorMap, maxSlideCount, readImage, requestLimitMap });
      materialResultMap.set(key, result);
      if (result.screenSummary) screenMaterialList.push({ videoId: video.videoId, condition: kind, ...result.screenSummary });
    }
    return materialResultMap.get(key);
  };
  const taskList = [];
  const skippedList = [];
  for (const question of questionSet.questionList) {
    const video = videoMap.get(question.videoId);
    for (const kind of kindList) {
      const { blockList, skipReason, detail } = resolveMaterial({ video, kind });
      if (!blockList) {
        skippedList.push({ ...buildQuestionContext({ question, video }), condition: kind, reason: skipReason, ...(detail ? { detail } : {}) });
        continue;
      }
      const request = buildAnswerRequest({ instructionKind, materialBlockList: blockList, question });
      for (let repeatIndex = 0; repeatIndex < repeatCount; repeatIndex += 1) {
        taskList.push({ question, video, condition: kind, repeatIndex, request });
      }
    }
  }
  return { taskList, skippedList, screenMaterialList };
}

// 답을 읽을 때 보인 보기 5개를 함께 넘겨 보기 글로 낸 답도 번호로 읽는다. 읽은 곳(json·text)을 답에 남긴다.
// 요청이 실패하거나 답을 못 읽은 응답은 캐시에 넣지 않아 다시 돌리면 다시 묻는다.
export async function runAnswerTaskList({ taskList, requestAnswer, cache, modelId, concurrency, onProgress = () => {} }) {
  let doneCount = 0;
  const imageHashMap = new Map();
  const hashImage = (bytes) => {
    if (!imageHashMap.has(bytes)) imageHashMap.set(bytes, hashInput(bytes));
    return imageHashMap.get(bytes);
  };
  return mapWithConcurrency({
    itemList: taskList,
    concurrency,
    run: async (task) => {
      const choiceTextList = buildChoiceList({ question: task.question });
      const key = hashInput({
        kind: 'e2e', modelId, systemPrompt: task.request.systemPrompt,
        messageList: toCacheableMessageList(task.request.messageList, hashImage), repeatIndex: task.repeatIndex,
      });
      let response = cache.read(key);
      const isCacheHit = Boolean(response);
      if (!response) {
        try {
          response = await requestAnswer({ modelId, ...task.request });
          if (parseAnswerText(response.text, { choiceTextList }).choiceNumber !== null) cache.write(key, response);
        } catch (error) {
          response = { text: '', stopReason: null, usage: null, errorMessage: error.message };
        }
      }
      const parsed = parseAnswerText(response.text, { choiceTextList });
      doneCount += 1;
      onProgress({ doneCount, totalCount: taskList.length });
      return {
        ...buildQuestionContext({ question: task.question, video: task.video }),
        condition: task.condition,
        repeatIndex: task.repeatIndex,
        answerIndex: task.question.answerIndex,
        choiceNumber: parsed.choiceNumber,
        ...scoreAnswer({ question: task.question, choiceNumber: parsed.choiceNumber, source: parsed.source }),
        reason: parsed.reason,
        rawText: typeof response.text === 'string' ? response.text : '',
        stopReason: response.stopReason ?? null,
        usage: response.usage ?? null,
        errorMessage: response.errorMessage ?? null,
        isCacheHit,
      };
    },
  });
}

export const FILTER_DECISION_MAP = { keep: 'keep', discard: 'discard', undecided: 'undecided' };

const FILTER_REASON_MAP = {
  [MATERIAL_KIND_MAP.questionOnly]: '문항만으로 풀림 — 사전지식으로 풀린다',
  [MATERIAL_KIND_MAP.screenOnly]: '화면만으로 풀림 — 화면만으로 충분하다',
  [MATERIAL_KIND_MAP.screen]: '전사+화면으로 못 풂 — 문항 결함',
};

// N·V 는 풀리면 폐기, C 는 못 풀면 폐기(회의록 3.2.3). 응답 오류는 판단하지 않고 남긴다.
export function decideFilter({ answer }) {
  if (answer.isResponseError) return { decision: FILTER_DECISION_MAP.undecided, reason: '응답 오류' };
  const isDiscard = answer.condition === MATERIAL_KIND_MAP.screen ? !answer.isCorrect : answer.isCorrect;
  return isDiscard
    ? { decision: FILTER_DECISION_MAP.discard, reason: FILTER_REASON_MAP[answer.condition] }
    : { decision: FILTER_DECISION_MAP.keep, reason: null };
}

// 문항 결정: 폐기 사유가 하나라도 있으면 폐기, 없는데 판단하지 못한 필터(응답 오류·자료 없음)가 있으면 판단 못 함,
// 모든 필터가 판단해 폐기 사유가 없을 때만 유지다. 판단 못 한 문항을 유지로 세면 토큰이 만료된 실행이 "모두 유지" 로 보인다.
export function summarizeFilterDecision({ questionSet, answerList, skippedList = [] }) {
  return questionSet.questionList.map((question) => {
    const filterResultList = answerList.filter((answer) => answer.questionId === question.id)
      .map((answer) => ({ filter: answer.condition, choiceNumber: answer.choiceNumber, ...decideFilter({ answer }) }));
    const skippedFilterList = skippedList.filter((skipped) => skipped.questionId === question.id)
      .map((skipped) => ({ filter: skipped.condition, decision: FILTER_DECISION_MAP.undecided, reason: `자료 없음(${skipped.reason})` }));
    const resultList = [...filterResultList, ...skippedFilterList];
    const hasDecision = (decision) => resultList.some((result) => result.decision === decision);
    let decision = FILTER_DECISION_MAP.keep;
    if (hasDecision(FILTER_DECISION_MAP.discard)) decision = FILTER_DECISION_MAP.discard;
    else if (hasDecision(FILTER_DECISION_MAP.undecided)) decision = FILTER_DECISION_MAP.undecided;
    return {
      questionId: question.id,
      decision,
      reasonList: resultList.filter((result) => result.reason).map((result) => `${result.filter}: ${result.reason}`),
      filterResultList: resultList,
    };
  });
}

export function countFilterDecision({ decisionList }) {
  return Object.fromEntries(Object.values(FILTER_DECISION_MAP).map((decision) => [
    decision, decisionList.filter((item) => item.decision === decision).length,
  ]));
}

export { INSTRUCTION_KIND_MAP };
