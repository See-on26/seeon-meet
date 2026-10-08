# ocr_engine 단위 시험 — 모델·rapidocr 없이 도는 부분만 본다.
# 실행: cd tools/gpu-server && python3 -m unittest test_ocr_engine
import tempfile
import unittest

from ocr_engine import create_ocr_state


class CreateOcrStateTest(unittest.TestCase):
    def test_모델이_없으면_엔진_없이_이유를_돌려준다(self):
        with tempfile.TemporaryDirectory() as empty_dir:
            engine, error_message = create_ocr_state(model_dir=empty_dir)
        self.assertIsNone(engine)
        self.assertIn('PP-OCRv6_det_small.onnx', error_message)


if __name__ == '__main__':
    unittest.main()
