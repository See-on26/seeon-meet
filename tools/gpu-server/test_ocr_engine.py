# ocr_engine 단위 시험 — 모델·rapidocr 없이 도는 부분만 본다.
# 실행: cd tools/gpu-server && python3 -m unittest test_ocr_engine
import io
import tempfile
import unittest

from ocr_engine import InvalidImageError, create_ocr_state, recognize

try:
    from PIL import Image
except ImportError:  # Pillow 가 없는 로컬 python3 에서는 이미지 시험만 건너뛴다
    Image = None


class CreateOcrStateTest(unittest.TestCase):
    def test_모델이_없으면_엔진_없이_이유를_돌려준다(self):
        with tempfile.TemporaryDirectory() as empty_dir:
            engine, error_message = create_ocr_state(model_dir=empty_dir)
        self.assertIsNone(engine)
        self.assertIn('PP-OCRv6_det_small.onnx', error_message)


@unittest.skipUnless(Image is not None, 'Pillow 가 없다')
class RecognizeInvalidImageTest(unittest.TestCase):
    def test_끝이_잘린_JPEG_은_엔진에_넘기기_전에_InvalidImageError(self):
        buffer = io.BytesIO()
        Image.effect_noise((320, 240), 64).convert('RGB').save(buffer, 'JPEG')
        jpeg_bytes = buffer.getvalue()
        truncated = jpeg_bytes[:len(jpeg_bytes) // 3]
        # 헤더는 멀쩡해 크기까지는 읽히는, 스캔 데이터만 잘린 경우다.
        self.assertEqual(Image.open(io.BytesIO(truncated)).size, (320, 240))
        with self.assertRaises(InvalidImageError):
            recognize(None, truncated)


if __name__ == '__main__':
    unittest.main()
