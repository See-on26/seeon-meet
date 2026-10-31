const crypto = require('crypto');

const FINGERPRINT_PREFIX = 'SHA256:';

// OpenSSH 와 같은 표기: 호스트 공개 키 blob 의 SHA256 을 base64 로, 끝의 = 는 뗀다.
function computeHostKeyFingerprint(hostKey) {
  const digest = crypto.createHash('sha256').update(hostKey).digest('base64');
  return `${FINGERPRINT_PREFIX}${digest.replace(/=+$/, '')}`;
}

function normalizeFingerprint(fingerprint) {
  return String(fingerprint || '').trim().replace(/=+$/, '');
}

function isHostKeyFingerprintMatch({ hostKey, expectedFingerprint }) {
  const expected = normalizeFingerprint(expectedFingerprint);
  if (!expected || !hostKey || hostKey.length === 0) return false;
  return computeHostKeyFingerprint(hostKey) === expected;
}

module.exports = { computeHostKeyFingerprint, isHostKeyFingerprintMatch };
