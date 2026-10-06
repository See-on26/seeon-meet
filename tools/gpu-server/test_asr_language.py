# asr_language 단위 시험 — faster_whisper 없이 돈다.
# 실행: cd tools/gpu-server && python3 -m unittest test_asr_language
import unittest

from asr_language import parse_language_query, pick_ko_or_en, resolve_language


class ParseLanguageQueryTest(unittest.TestCase):
    def test_없으면_ko(self):
        self.assertEqual(parse_language_query(None), "ko")
        self.assertEqual(parse_language_query(""), "ko")

    def test_허용값은_그대로(self):
        for language in ("ko", "en", "auto"):
            self.assertEqual(parse_language_query(language), language)

    def test_그_밖의_값은_오류(self):
        for language in ("ja", "EN", "korean", " ko"):
            with self.assertRaises(ValueError, msg=language):
                parse_language_query(language)


class PickKoOrEnTest(unittest.TestCase):
    def test_en_이_높으면_en(self):
        probability_list = [("en", 0.71), ("ja", 0.2), ("ko", 0.05)]
        self.assertEqual(pick_ko_or_en(probability_list), ("en", 0.71))

    def test_ko_가_높으면_ko(self):
        probability_list = [("ja", 0.5), ("ko", 0.3), ("en", 0.1)]
        self.assertEqual(pick_ko_or_en(probability_list), ("ko", 0.3))

    def test_다른_언어가_1위여도_ko_en_중에서만_고른다(self):
        probability_list = [("ja", 0.9), ("en", 0.06), ("ko", 0.04)]
        self.assertEqual(pick_ko_or_en(probability_list), ("en", 0.06))

    def test_하나만_있으면_그_언어(self):
        self.assertEqual(pick_ko_or_en([("ja", 0.8), ("en", 0.1)]), ("en", 0.1))

    def test_둘_다_없으면_ko(self):
        self.assertEqual(pick_ko_or_en([("ja", 0.8), ("zh", 0.2)]), ("ko", None))
        self.assertEqual(pick_ko_or_en([]), ("ko", None))

    def test_같으면_ko(self):
        self.assertEqual(pick_ko_or_en([("en", 0.4), ("ko", 0.4)]), ("ko", 0.4))


class ResolveLanguageTest(unittest.TestCase):
    def test_고정_언어는_감지하지_않는다(self):
        def detect():
            raise AssertionError("고정 언어에서 감지를 부르면 안 된다")

        self.assertEqual(resolve_language("ko", detect), ("ko", None))
        self.assertEqual(resolve_language("en", detect), ("en", None))

    def test_auto_는_감지_결과에서_고른다(self):
        self.assertEqual(
            resolve_language("auto", lambda: [("en", 0.8), ("ko", 0.1)]), ("en", 0.8)
        )

    def test_auto_감지가_실패하면_ko(self):
        def detect():
            raise ValueError("need at least one array to concatenate")

        self.assertEqual(resolve_language("auto", detect), ("ko", None))


if __name__ == "__main__":
    unittest.main()
