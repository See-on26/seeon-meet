import { LAB_PLAYER_URL } from '../lab-constants.js';
import { ROI_TYPE_MAP } from '../../core/constants.js';
import { normToContentPx, FULL_NORM_RECT } from './roi-geometry.js';

// Meet roi-scanner 의 SPEAKER_HOLD_MS 와 같은 값. viewer 는 이 칸을 읽지 않지만 같은 모양으로 보낸다.
const SPEAKER_HOLD_MS = 8000;
const LAB_PARTICIPANT_ID = 'lab-player';
const LAB_ROI_LABEL = '실험 재생 화면';

// Meet preload scanRois() 와 같은 모양의 roi-update. 공유 화면 ROI 하나만 싣는다(rect 는 뷰포트 CSS px).
export function buildLabRoiPayload({ nowMs, viewport, contentRect, roiNormRect = FULL_NORM_RECT }) {
  const rect = normToContentPx({ normRect: roiNormRect, contentRect });
  return {
    ts: nowMs,
    url: LAB_PLAYER_URL,
    viewport,
    speakerHoldMs: SPEAKER_HOLD_MS,
    roiList: [{
      type: ROI_TYPE_MAP.screenShare, rect, videoRect: rect, hasVideo: true, hasCamera: false,
      participantId: LAB_PARTICIPANT_ID, name: '', micMuted: false, speakingNow: false, isSelf: false,
      spokeAgoMs: null, label: LAB_ROI_LABEL,
    }],
    debugList: [],
  };
}

export function buildTimeReport({ video, nowMs }) {
  return {
    wallMs: nowMs,
    mediaMs: Math.round((Number(video.currentTime) || 0) * 1000),
    paused: Boolean(video.paused),
    ended: Boolean(video.ended),
  };
}
