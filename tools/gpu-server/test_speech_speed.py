# speech_speed 단위 시험 — 모델 없이 돈다.
# 실행: cd tools/gpu-server && python3 -m unittest test_speech_speed
import unittest

from speech_speed import resolve_speech_speed


class ResolveSpeechSpeedTest(unittest.TestCase):
    def test_요청한_속도를_쓰고_없으면_서버_기본_속도를_쓴다(self):
        self.assertEqual(resolve_speech_speed(1.4, default_speed=2.0), 1.4)
        self.assertEqual(resolve_speech_speed(None, default_speed=2.0), 2.0)

    def test_범위_밖이나_숫자가_아닌_값은_1배에서_2배_사이로_둔다(self):
        self.assertEqual(resolve_speech_speed(0.3, default_speed=2.0), 1.0)
        self.assertEqual(resolve_speech_speed(5, default_speed=2.0), 2.0)
        self.assertEqual(resolve_speech_speed(float("nan"), default_speed=2.0), 2.0)


if __name__ == "__main__":
    unittest.main()
