const SPEAKER_ANNOUNCE_COOLDOWN_MS = 5000;

const SPEAKER_SKIP_REASON_MAP = {
  noSpeaker: 'no_speaker',
  sameSpeaker: 'same_speaker',
  cooldown: 'cooldown',
};

function createSpeakerRegistry({ cooldownMs = SPEAKER_ANNOUNCE_COOLDOWN_MS } = {}) {
  let currentSpeakerKey = '';
  let lastAnnouncedAt = -Infinity;

  function judgeAnnouncement({ speakerKey, ts = Date.now() }) {
    const previousSpeakerKey = currentSpeakerKey;
    if (!speakerKey) {
      return { shouldAnnounce: false, reason: SPEAKER_SKIP_REASON_MAP.noSpeaker, previousSpeakerKey };
    }
    if (speakerKey === currentSpeakerKey) {
      return { shouldAnnounce: false, reason: SPEAKER_SKIP_REASON_MAP.sameSpeaker, previousSpeakerKey };
    }
    if (ts - lastAnnouncedAt < cooldownMs) {
      return { shouldAnnounce: false, reason: SPEAKER_SKIP_REASON_MAP.cooldown, previousSpeakerKey };
    }
    currentSpeakerKey = speakerKey;
    lastAnnouncedAt = ts;
    return {
      shouldAnnounce: true,
      reason: previousSpeakerKey ? 'speaker_changed' : 'first_speaker',
      previousSpeakerKey,
    };
  }

  function getCurrentSpeakerKey() {
    return currentSpeakerKey;
  }

  function reset() {
    currentSpeakerKey = '';
    lastAnnouncedAt = -Infinity;
  }

  return { judgeAnnouncement, getCurrentSpeakerKey, reset };
}

module.exports = {
  createSpeakerRegistry, SPEAKER_ANNOUNCE_COOLDOWN_MS, SPEAKER_SKIP_REASON_MAP,
};
