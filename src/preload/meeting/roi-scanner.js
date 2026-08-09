const ROI_TYPE_MAP = {
  screenShare: 'screen_share',
  speaker: 'speaker',
  audience: 'audience',
};

const HINT_MAP = {
  tile: '[data-participant-id]',
  presentationKeywordList: ['발표', 'presenting', 'presentation', '프레젠테이션'],
  speakingSelector: '.MSqqjf',
  speakingBars: '.IisKdb',
  speakingBarsHiddenClass: 'kssMZb',
  micMutedAria: '마이크가 꺼져',
  micOffLigature: 'mic_off',
  micSlashPathPrefixList: ['M19 11h-1.7', 'M2.81 2.81'],
  selfAriaKeywordList: ['배경 및 효과', '프레임 재조정'],
  // 실측(2026-08-09): 아이콘 리거처도 .notranslate를 쓴다. 이름은 span, 아이콘은 i 태그로 갈린다
  nameSelectorList: ['span.notranslate', 'span.zWGUib', '[data-self-name]'],
  nameMaxLength: 24,
  nameSuffixStripList: ['님', '(나)', '(You)', '(you)', '(호스트)', '(발표자)'],
  nameStopWordList: [
    '프레젠테이션', '고정', '마이크', '카메라', '발표', '화면 공유', '음소거',
    'mic_off', 'more_vert', 'push_pin', 'present_to_all', 'devices', 'volume_up',
    'frame_person', 'visual_effects', 'devices_fold', 'pin', 'flip_camera',
  ],
};

const MIN_TILE_PX = 60;

const SPEAKER_HOLD_MS = 8000;
const lastSpokeAtMap = new Map();

const participantNameMap = new Map();

function getVisibleRect(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width < MIN_TILE_PX || rect.height < MIN_TILE_PX) return null;
  if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) return null;
  return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
}

function collectAriaLabelText(el, maxLen = 120) {
  const labelList = [];
  if (el.getAttribute) {
    const ownLabel = el.getAttribute('aria-label');
    if (ownLabel) labelList.push(ownLabel);
  }
  el.querySelectorAll('[aria-label]').forEach((node) => {
    if (labelList.length < 4) labelList.push(node.getAttribute('aria-label'));
  });
  return labelList.join(' | ').slice(0, maxLen);
}

function extractParticipantName({ candidateTextList, innerText, maxLength, stopWordList, suffixStripList }) {
  const rawList = [...(candidateTextList || []), String(innerText || '').split('\n')[0]];
  for (const raw of rawList) {
    if (typeof raw !== 'string') continue;
    let name = raw.replace(/\s+/g, ' ').trim();
    for (const suffix of suffixStripList) {
      if (name.endsWith(suffix)) name = name.slice(0, -suffix.length).trim();
    }
    if (!name || name.length > maxLength) continue;
    if (stopWordList.some((word) => name.includes(word))) continue;
    if (!/[\p{L}]/u.test(name)) continue;
    return name;
  }
  return '';
}

// 캐시를 먼저 믿으면 안 된다 — 타일이 재배치되는 순간 읽힌 이름이 그 참가자에게 영구히 눌어붙는다.
// 실측(2026-08-09): hyun 타일이 세션 내내 "이재현"으로 고지됐다. 매번 새로 읽고, 캐시는 읽기가
// 실패한 과도기에만 쓴다
function readParticipantName({ tile, participantId }) {
  const candidateTextList = HINT_MAP.nameSelectorList
    .flatMap((selector) => [...tile.querySelectorAll(selector)].map((el) => el.textContent || ''));
  const name = extractParticipantName({
    candidateTextList,
    innerText: tile.innerText || '',
    maxLength: HINT_MAP.nameMaxLength,
    stopWordList: HINT_MAP.nameStopWordList,
    suffixStripList: HINT_MAP.nameSuffixStripList,
  });

  if (name) {
    if (participantId) participantNameMap.set(participantId, name);
    return name;
  }
  return participantId ? (participantNameMap.get(participantId) || '') : '';
}

function hasPresentationHint(tile, label) {
  const haystack = (label + ' ' + (tile.getAttribute('data-participant-id') || '')).toLowerCase();
  return HINT_MAP.presentationKeywordList.some((keyword) => haystack.includes(keyword.toLowerCase()));
}

function isElVisible(el) {
  return !!el && el.getClientRects().length > 0;
}

function hasSpeakingHint(tile) {
  if (tile.querySelector(HINT_MAP.speakingSelector)) return true;
  const bars = tile.querySelector(HINT_MAP.speakingBars);
  if (bars && bars.offsetParent !== null) {
    const wrap = bars.closest('.lH9pqf');
    if (wrap && !wrap.classList.contains(HINT_MAP.speakingBarsHiddenClass)) return true;
  }
  return false;
}

function isSelfTile(tile) {
  for (const el of tile.querySelectorAll('[aria-label]')) {
    const label = el.getAttribute('aria-label');
    if (HINT_MAP.selfAriaKeywordList.some((keyword) => label.includes(keyword))) return true;
  }
  return false;
}

function isMicMuted(tile) {
  for (const el of tile.querySelectorAll('[aria-label]')) {
    if (el.getAttribute('aria-label').includes(HINT_MAP.micMutedAria) && isElVisible(el)) return true;
  }
  for (const icon of tile.querySelectorAll('i')) {
    if (icon.textContent.trim() === HINT_MAP.micOffLigature && isElVisible(icon)) return true;
  }
  for (const path of tile.querySelectorAll('svg path')) {
    const d = path.getAttribute('d') || '';
    if (HINT_MAP.micSlashPathPrefixList.some((prefix) => d.startsWith(prefix)) && isElVisible(path.closest('svg'))) {
      return true;
    }
  }
  return false;
}

function scanRois() {
  const tileList = [...document.querySelectorAll(HINT_MAP.tile)];
  const roiList = [];
  const debugList = [];

  const entryList = [];
  for (const tile of tileList) {
    const rect = getVisibleRect(tile);
    if (!rect) continue;

    const video = tile.querySelector('video');
    const videoRect = video ? getVisibleRect(video) : null;
    const hasCamera = !!(video && video.videoWidth > 0 && videoRect);
    const label = collectAriaLabelText(tile);
    const participantId = tile.getAttribute('data-participant-id') || null;
    const isShare = hasPresentationHint(tile, label);
    const isMuted = !isShare && isMicMuted(tile);

    const isSpeakingNow = !isShare && !isMuted && hasCamera && hasSpeakingHint(tile);

    if (isSpeakingNow && participantId) lastSpokeAtMap.set(participantId, performance.now());
    entryList.push({
      rect, videoRect, hasCamera, label, participantId, isShare, isMuted, isSpeakingNow,
      isSelf: !isShare && isSelfTile(tile),
      name: isShare ? '' : readParticipantName({ tile, participantId }),
    });
  }

  const now = performance.now();
  for (const entry of entryList) {
    const spokeAgoMs = entry.participantId && lastSpokeAtMap.has(entry.participantId)
      ? Math.round(now - lastSpokeAtMap.get(entry.participantId)) : null;

    let type;
    if (entry.isShare) type = ROI_TYPE_MAP.screenShare;
    else if (entry.isMuted) type = ROI_TYPE_MAP.audience;
    else if (spokeAgoMs !== null && spokeAgoMs < SPEAKER_HOLD_MS) type = ROI_TYPE_MAP.speaker;
    else type = ROI_TYPE_MAP.audience;

    roiList.push({
      type,
      rect: entry.rect,
      videoRect: entry.videoRect,
      hasVideo: !!entry.videoRect,
      hasCamera: entry.hasCamera,
      participantId: entry.participantId,
      name: entry.name,
      micMuted: entry.isMuted,
      speakingNow: entry.isSpeakingNow,
      isSelf: entry.isSelf,
      spokeAgoMs,
      label: entry.label,
    });
    if (debugList.length < 8) {
      debugList.push({
        participantId: entry.participantId,
        name: entry.name,
        label: entry.label,
        hasCamera: entry.hasCamera,
        muted: entry.isMuted,
        speakingNow: entry.isSpeakingNow,
        area: Math.round(entry.rect.w * entry.rect.h),
      });
    }
  }

  const hasScreenShare = roiList.some((roi) => roi.type === ROI_TYPE_MAP.screenShare);
  const videoRoiList = roiList.filter((roi) => roi.hasVideo);
  if (!hasScreenShare && videoRoiList.length >= 2) {
    const sortedList = [...videoRoiList]
      .sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h);
    const [first, second] = sortedList;
    // 크기만 보면 2인 회의에서 상대 카메라 타일이 항상 걸린다(내 썸네일이 작으므로).
    // 실측(2026-08-09): 공유가 없는데도 상대 얼굴이 공유화면으로 승격돼 슬라이드로 등록됐다.
    // 사람 타일에만 있는 신호(이름·마이크 표시·본인 표시)가 하나라도 있으면 승격하지 않는다
    const isPersonTile = Boolean(first.name) || first.micMuted || first.isSelf || first.speakingNow;
    if (!isPersonTile
      && first.rect.w * first.rect.h > 2.5 * second.rect.w * second.rect.h
      && first.rect.w * first.rect.h > 0.3 * innerWidth * innerHeight) {
      first.type = ROI_TYPE_MAP.screenShare;
      first.lowConfidence = true;
    }
  }

  return {
    ts: Date.now(),
    url: location.href,
    viewport: { vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio },
    speakerHoldMs: SPEAKER_HOLD_MS,
    roiList,
    debugList,
  };
}

module.exports = { scanRois, extractParticipantName, ROI_TYPE_MAP, HINT_MAP };
