import path from 'node:path';
import {
  TARGET_TYPE_LIST, TARGET_TYPE_MAP, RESOLUTION_LIST, CANDIDATE_SOURCE_LIST, LANGUAGE_LIST,
  QUESTION_SUBCATEGORY_CATEGORY_MAP, UNKNOWN_CHOICE_TEXT,
} from './eval-types.mjs';
import { listSilenceMarker } from './silence-marker.mjs';
import { SILENCE_TRIGGER_MS } from '../../../src/renderer/core/trigger/silence-trigger.js';

export const ISSUE_LEVEL_MAP = { error: 'error', warning: 'warning' };

export const DATASET_KIND_MAP = { detection: 'detection', question: 'question' };

const CHOICE_COUNT = 4;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function createIssueCollector({ lineNumber = null }) {
  const issueList = [];
  return {
    issueList,
    error(field, message) { issueList.push({ level: ISSUE_LEVEL_MAP.error, lineNumber, field, message }); },
    warn(field, message) { issueList.push({ level: ISSUE_LEVEL_MAP.warning, lineNumber, field, message }); },
  };
}

export function parseJsonl(text) {
  const rowList = [];
  const issueList = [];
  String(text).split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    const lineNumber = index + 1;
    try {
      rowList.push({ lineNumber, value: JSON.parse(line) });
    } catch (error) {
      issueList.push({
        level: ISSUE_LEVEL_MAP.error, lineNumber, field: '(줄 전체)', message: `JSON 으로 읽을 수 없다: ${error.message}`,
      });
    }
  });
  return { rowList, issueList };
}

function validateUtteranceList({ item, collector }) {
  if (item.utteranceList === undefined) return;
  if (!Array.isArray(item.utteranceList)) {
    collector.error('utteranceList', '배열이어야 한다');
    return;
  }
  let cursor = 0;
  let previousStartMs = -1;
  item.utteranceList.forEach((utterance, index) => {
    const field = `utteranceList[${index}]`;
    if (!isPlainObject(utterance) || !isNonEmptyString(utterance.text)) {
      collector.error(field, 'text 가 빈 발화다');
      return;
    }
    if (!isNonNegativeNumber(utterance.startMs) || !isNonNegativeNumber(utterance.endMs)) {
      collector.error(field, 'startMs·endMs 는 0 이상의 숫자여야 한다');
    } else if (utterance.endMs < utterance.startMs) {
      collector.error(field, 'endMs 가 startMs 보다 앞선다');
    } else if (utterance.startMs < previousStartMs) {
      collector.error(field, '발화는 시작 시각 순서로 적어야 한다');
    }
    if (isNonNegativeNumber(utterance.startMs)) previousStartMs = utterance.startMs;
    const foundAt = typeof item.transcript === 'string' ? item.transcript.indexOf(utterance.text, cursor) : -1;
    if (foundAt < 0) {
      collector.error(field, `전사에서 "${utterance.text}" 를 앞 발화 뒤에서 찾지 못했다`);
      return;
    }
    cursor = foundAt + utterance.text.length;
  });
}

function validatePositionList({ item, collector, isLabeledRequired }) {
  if (item.positionList === undefined) {
    if (isLabeledRequired) collector.error('positionList', '라벨 파일인데 positionList 가 없다');
    return;
  }
  if (!Array.isArray(item.positionList)) {
    collector.error('positionList', '배열이어야 한다');
    return;
  }
  const posIdSet = new Set();
  const transcript = typeof item.transcript === 'string' ? item.transcript : '';
  item.positionList.forEach((position, index) => {
    const field = `positionList[${index}]`;
    if (!isPlainObject(position)) {
      collector.error(field, '객체여야 한다');
      return;
    }
    if (!isNonEmptyString(position.posId)) collector.error(`${field}.posId`, '빈 값이다');
    else if (posIdSet.has(position.posId)) collector.error(`${field}.posId`, `같은 항목 안에서 겹친다: ${position.posId}`);
    else posIdSet.add(position.posId);
    if (!TARGET_TYPE_LIST.includes(position.type)) {
      collector.error(`${field}.type`, `${TARGET_TYPE_LIST.join('·')} 중 하나여야 한다 (지금: ${position.type})`);
    }
    const isSpanValid = Number.isInteger(position.start) && Number.isInteger(position.end)
      && position.start >= 0 && position.start < position.end && position.end <= transcript.length;
    if (!isSpanValid) {
      collector.error(`${field}.start/end`, `0 ≤ start < end ≤ 전사 길이(${transcript.length}) 인 정수여야 한다`);
    } else if (position.trigger !== transcript.slice(position.start, position.end)) {
      collector.error(`${field}.trigger`, `전사의 ${position.start}~${position.end} 글자("${transcript.slice(position.start, position.end)}")와 다르다`);
    }
    if (!Array.isArray(position.sourceList)
      || position.sourceList.some((source) => !CANDIDATE_SOURCE_LIST.includes(source))) {
      collector.error(`${field}.sourceList`, `${CANDIDATE_SOURCE_LIST.join('·')} 만 담은 배열이어야 한다`);
    }
    if (!(position.isGap === true || position.isGap === false || position.isGap === null)) {
      collector.error(`${field}.isGap`, 'true·false·null 중 하나여야 한다 (아직 안 붙였으면 null)');
    }
    if (position.rationale !== undefined && typeof position.rationale !== 'string') {
      collector.error(`${field}.rationale`, '문자열이어야 한다');
    }
  });
}

export function validateDetectionItem({ item, lineNumber = null, isLabeledRequired = false }) {
  const collector = createIssueCollector({ lineNumber });
  if (!isPlainObject(item)) {
    collector.error('(줄 전체)', '객체여야 한다');
    return collector.issueList;
  }
  for (const field of ['id', 'domain', 'pairId', 'transcript']) {
    if (!isNonEmptyString(item[field])) collector.error(field, '빈 값이다');
  }
  if (!TARGET_TYPE_LIST.includes(item.targetType)) {
    collector.error('targetType', `${TARGET_TYPE_LIST.join('·')} 중 하나여야 한다 (지금: ${item.targetType})`);
  }
  if (!LANGUAGE_LIST.includes(item.language)) {
    collector.error('language', `${LANGUAGE_LIST.join('·')} 중 하나여야 한다 (지금: ${item.language})`);
  }
  if (!RESOLUTION_LIST.includes(item.resolution)) {
    collector.error('resolution', `${RESOLUTION_LIST.join('·')} 중 하나여야 한다 (지금: ${item.resolution})`);
  }
  if (item.generatorModel === undefined) {
    collector.warn('generatorModel', '생성 모델을 적어 두면 판정 모델과 같은지 확인할 수 있다');
  } else if (!isNonEmptyString(item.generatorModel)) {
    collector.error('generatorModel', '빈 값이다');
  }
  const transcript = typeof item.transcript === 'string' ? item.transcript : '';
  if (item.targetType === TARGET_TYPE_MAP.silence
    && !listSilenceMarker(transcript).some((marker) => marker.silenceMs >= SILENCE_TRIGGER_MS)) {
    collector.error('transcript', `무발화 유형인데 ${SILENCE_TRIGGER_MS / 1000}초 이상 [무발화 N초] 표시가 없다`);
  }
  if (item.targetTrigger !== undefined) {
    if (!isNonEmptyString(item.targetTrigger)) collector.error('targetTrigger', '빈 값이다');
    else if (!transcript.includes(item.targetTrigger)) collector.error('targetTrigger', `전사에 "${item.targetTrigger}" 가 없다`);
  }
  if (item.isTargetGap !== undefined) {
    if (typeof item.isTargetGap !== 'boolean') collector.error('isTargetGap', 'true·false 중 하나여야 한다');
    if (item.targetTrigger === undefined) collector.error('isTargetGap', 'targetTrigger 없이 정답만 적었다');
  }
  if (item.targetRationale !== undefined && typeof item.targetRationale !== 'string') {
    collector.error('targetRationale', '문자열이어야 한다');
  }
  validateUtteranceList({ item, collector });
  validatePositionList({ item, collector, isLabeledRequired });
  return collector.issueList;
}

export function validateDetectionItemList({ text, isLabeledRequired = false }) {
  const { rowList, issueList } = parseJsonl(text);
  const idLineMap = new Map();
  const itemList = [];
  for (const { lineNumber, value } of rowList) {
    issueList.push(...validateDetectionItem({ item: value, lineNumber, isLabeledRequired }));
    if (isPlainObject(value) && isNonEmptyString(value.id)) {
      if (idLineMap.has(value.id)) {
        issueList.push({
          level: ISSUE_LEVEL_MAP.error, lineNumber, field: 'id',
          message: `id "${value.id}" 가 ${idLineMap.get(value.id)}번째 줄과 겹친다`,
        });
      } else {
        idLineMap.set(value.id, lineNumber);
      }
    }
    itemList.push(value);
  }
  issueList.sort((issueA, issueB) => (issueA.lineNumber ?? 0) - (issueB.lineNumber ?? 0));
  return { itemList, issueList };
}

// JSON 문서 안에서 "id": "<id>" 가 처음 나오는 줄. 문항 셋 오류를 줄 번호로 알려 주려고 쓴다.
export function findLineNumberOfId({ text, id }) {
  const escapedId = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`"(?:id|videoId)"\\s*:\\s*"${escapedId}"`).exec(text);
  if (!match) return null;
  return text.slice(0, match.index).split('\n').length;
}

function validateVideoList({ questionSet, text, issueList }) {
  const videoIdSet = new Set();
  if (!Array.isArray(questionSet.videoList) || !questionSet.videoList.length) {
    issueList.push({ level: ISSUE_LEVEL_MAP.error, lineNumber: null, field: 'videoList', message: '영상이 하나 이상 있어야 한다' });
    return videoIdSet;
  }
  questionSet.videoList.forEach((video, index) => {
    const lineNumber = isPlainObject(video) ? findLineNumberOfId({ text, id: video.videoId }) : null;
    const collector = createIssueCollector({ lineNumber });
    const field = `videoList[${index}]`;
    if (!isPlainObject(video)) {
      collector.error(field, '객체여야 한다');
      issueList.push(...collector.issueList);
      return;
    }
    if (!isNonEmptyString(video.videoId)) collector.error(`${field}.videoId`, '빈 값이다');
    else if (videoIdSet.has(video.videoId)) collector.error(`${field}.videoId`, `겹친다: ${video.videoId}`);
    else videoIdSet.add(video.videoId);
    for (const key of ['domain', 'file']) {
      if (!isNonEmptyString(video[key])) collector.error(`${field}.${key}`, '빈 값이다');
    }
    if (video.runDir !== undefined && typeof video.runDir !== 'string') collector.error(`${field}.runDir`, '문자열이어야 한다');
    if (video.language !== undefined && !LANGUAGE_LIST.includes(video.language)) {
      collector.error(`${field}.language`, `${LANGUAGE_LIST.join('·')} 중 하나여야 한다`);
    }
    if (video.humanAdList !== undefined) {
      if (!Array.isArray(video.humanAdList)) {
        collector.error(`${field}.humanAdList`, '배열이어야 한다');
      } else {
        video.humanAdList.forEach((ad, adIndex) => {
          if (!isPlainObject(ad) || !isNonNegativeNumber(ad.startMs) || !isNonEmptyString(ad.text)) {
            collector.error(`${field}.humanAdList[${adIndex}]`, '{ startMs: 0 이상의 숫자, text: 빈 값 아님 } 이어야 한다');
          }
        });
      }
    }
    issueList.push(...collector.issueList);
  });
  return videoIdSet;
}

function validateQuestionList({ questionSet, text, videoIdSet, issueList }) {
  if (!Array.isArray(questionSet.questionList) || !questionSet.questionList.length) {
    issueList.push({ level: ISSUE_LEVEL_MAP.error, lineNumber: null, field: 'questionList', message: '문항이 하나 이상 있어야 한다' });
    return;
  }
  const questionIdSet = new Set();
  questionSet.questionList.forEach((question, index) => {
    const lineNumber = isPlainObject(question) ? findLineNumberOfId({ text, id: question.id }) : null;
    const collector = createIssueCollector({ lineNumber });
    const field = `questionList[${index}]`;
    if (!isPlainObject(question)) {
      collector.error(field, '객체여야 한다');
      issueList.push(...collector.issueList);
      return;
    }
    if (!isNonEmptyString(question.id)) collector.error(`${field}.id`, '빈 값이다');
    else if (questionIdSet.has(question.id)) collector.error(`${field}.id`, `겹친다: ${question.id}`);
    else questionIdSet.add(question.id);
    if (!videoIdSet.has(question.videoId)) collector.error(`${field}.videoId`, `videoList 에 없는 영상이다: ${question.videoId}`);
    const expectedCategory = QUESTION_SUBCATEGORY_CATEGORY_MAP[question.subcategory];
    if (!expectedCategory) {
      collector.error(`${field}.subcategory`, `${Object.keys(QUESTION_SUBCATEGORY_CATEGORY_MAP).join('·')} 중 하나여야 한다`);
    } else if (question.category !== expectedCategory) {
      collector.error(`${field}.category`, `소분류 "${question.subcategory}" 는 "${expectedCategory}" 이다 (지금: ${question.category})`);
    }
    if (!isNonEmptyString(question.question)) collector.error(`${field}.question`, '빈 값이다');
    const choiceList = question.choiceList;
    if (!Array.isArray(choiceList) || choiceList.length !== CHOICE_COUNT || !choiceList.every(isNonEmptyString)) {
      collector.error(`${field}.choiceList`, `빈 값 없는 보기 ${CHOICE_COUNT}개여야 한다`);
    } else {
      if (choiceList.some((choice) => choice.trim() === UNKNOWN_CHOICE_TEXT)) {
        collector.error(`${field}.choiceList`, `"${UNKNOWN_CHOICE_TEXT}" 는 도구가 5번째 보기로 붙인다. 보기에서 빼야 한다`);
      }
      if (new Set(choiceList.map((choice) => choice.trim())).size !== choiceList.length) {
        collector.error(`${field}.choiceList`, '같은 보기가 두 번 있다');
      }
    }
    if (!Number.isInteger(question.answerIndex) || question.answerIndex < 0 || question.answerIndex >= CHOICE_COUNT) {
      collector.error(`${field}.answerIndex`, `0~${CHOICE_COUNT - 1} 정수여야 한다 (보기 순서, 0부터)`);
    }
    issueList.push(...collector.issueList);
  });
}

export function validateQuestionSet({ text }) {
  const issueList = [];
  let questionSet = null;
  try {
    questionSet = JSON.parse(text);
  } catch (error) {
    issueList.push({ level: ISSUE_LEVEL_MAP.error, lineNumber: null, field: '(파일 전체)', message: `JSON 으로 읽을 수 없다: ${error.message}` });
    return { questionSet: null, issueList };
  }
  if (!isPlainObject(questionSet)) {
    issueList.push({ level: ISSUE_LEVEL_MAP.error, lineNumber: null, field: '(파일 전체)', message: '객체여야 한다' });
    return { questionSet: null, issueList };
  }
  if (!isNonEmptyString(questionSet.generatorModel)) {
    issueList.push({ level: ISSUE_LEVEL_MAP.error, lineNumber: null, field: 'generatorModel', message: '문항을 만든 모델을 적어야 한다' });
  }
  const videoIdSet = validateVideoList({ questionSet, text, issueList });
  validateQuestionList({ questionSet, text, videoIdSet, issueList });
  return { questionSet, issueList };
}

export function detectDatasetKind({ filePath }) {
  return path.extname(filePath).toLowerCase() === '.jsonl' ? DATASET_KIND_MAP.detection : DATASET_KIND_MAP.question;
}

export function validateFile({ filePath, text, isLabeledRequired = false }) {
  const kind = detectDatasetKind({ filePath });
  if (kind === DATASET_KIND_MAP.detection) {
    const { itemList, issueList } = validateDetectionItemList({ text, isLabeledRequired });
    return { kind, kindLabel: '3.1 탐지 항목', count: itemList.length, issueList };
  }
  const { questionSet, issueList } = validateQuestionSet({ text });
  return { kind, kindLabel: '3.2 문항 셋', count: questionSet?.questionList?.length ?? 0, issueList };
}

export function formatIssueList(issueList) {
  return issueList.map((issue) => {
    const levelText = issue.level === ISSUE_LEVEL_MAP.error ? '오류' : '참고';
    const lineText = issue.lineNumber ? `${issue.lineNumber}번째 줄` : '위치 미상';
    return `  [${levelText}] ${lineText} · ${issue.field} — ${issue.message}`;
  }).join('\n');
}
