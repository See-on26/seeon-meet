# ASR 언어 판정 — 쿼리 검증과 ko/en 고르기. faster_whisper 를 import 하지 않아 로컬에서 시험할 수 있다.
from typing import Callable, Iterable, Optional, Tuple

DEFAULT_LANGUAGE = "ko"
AUTO_LANGUAGE = "auto"
ALLOWED_LANGUAGE_LIST = ("ko", "en", AUTO_LANGUAGE)
# auto 는 회의에서 쓰는 두 언어 중에서만 고른다. 짧은 조각에서 일본어 등으로 오감지되는 것을 막는다.
CANDIDATE_LANGUAGE_LIST = ("ko", "en")


def parse_language_query(value: Optional[str]) -> str:
    """쿼리 language 를 검증한다. 없거나 비면 ko, 허용값이 아니면 ValueError."""
    if not value:
        return DEFAULT_LANGUAGE
    if value not in ALLOWED_LANGUAGE_LIST:
        raise ValueError(f"language 는 {'/'.join(ALLOWED_LANGUAGE_LIST)} 중 하나여야 합니다: {value!r}")
    return value


def pick_ko_or_en(
    language_probability_list: Iterable[Tuple[str, float]],
) -> Tuple[str, Optional[float]]:
    """감지 확률 목록에서 ko·en 중 확률이 높은 쪽과 그 확률. 같으면 ko, 둘 다 없으면 (ko, None)."""
    probability_map = {
        language: probability
        for language, probability in language_probability_list
        if language in CANDIDATE_LANGUAGE_LIST
    }
    if not probability_map:
        return DEFAULT_LANGUAGE, None
    # CANDIDATE_LANGUAGE_LIST 순서상 ko 가 먼저라 max 는 동률일 때 ko 를 고른다.
    language = max(
        (language for language in CANDIDATE_LANGUAGE_LIST if language in probability_map),
        key=lambda language: probability_map[language],
    )
    return language, probability_map[language]


def resolve_language(
    requested_language: str,
    detect_probability_list: Callable[[], Iterable[Tuple[str, float]]],
) -> Tuple[str, Optional[float]]:
    """전사에 쓸 언어와 감지 확률. 고정 언어면 감지하지 않고 확률은 None.
    auto 에서 감지가 실패하면(무음이라 VAD 가 전부 잘라 낸 조각 등) ko 로 전사한다."""
    if requested_language != AUTO_LANGUAGE:
        return requested_language, None
    try:
        probability_list = detect_probability_list()
    except Exception:
        return DEFAULT_LANGUAGE, None
    return pick_ko_or_en(probability_list)
