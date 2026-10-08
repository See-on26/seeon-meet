# 슬라이드 전사 OCR 엔진(RapidOCR, CPU). 미리 받아 둔 모델 파일만 쓰고 실행 중 내려받지 않는다.
# 모델: fetch-ocr-models.sh 가 ~/gpu-server/ocr-models 에 받는다(SEEON_OCR_MODEL_DIR 로 바꿀 수 있음).
import io
import os
import time
from pathlib import Path

from ocr_lines import build_ocr_response

DET_MODEL_FILE = 'PP-OCRv6_det_small.onnx'
REC_MODEL_FILE = 'korean_PP-OCRv5_rec_mobile.onnx'
CLS_MODEL_FILE = 'ch_ppocr_mobile_v2.0_cls_mobile.onnx'
DEFAULT_MODEL_DIR = Path.home() / 'gpu-server' / 'ocr-models'
# vLLM·ASR 와 같은 CPU 를 쓰므로 스레드를 묶어 둔다.
INTRA_OP_THREAD_COUNT = 4
ENGINE_INFO = {'name': 'rapidocr', 'version': '3.9.2', 'det': 'PP-OCRv6_det_small', 'rec': 'korean_PP-OCRv5_rec_mobile'}


class InvalidImageError(ValueError):
    pass


def resolve_model_dir(model_dir=None):
    return Path(model_dir or os.environ.get('SEEON_OCR_MODEL_DIR') or DEFAULT_MODEL_DIR)


def create_ocr_engine(model_dir=None):
    resolved_dir = resolve_model_dir(model_dir)
    path_map = {name: resolved_dir / name for name in (DET_MODEL_FILE, REC_MODEL_FILE, CLS_MODEL_FILE)}
    missing_list = [name for name, path in path_map.items() if not path.is_file()]
    if missing_list:
        raise FileNotFoundError(f'OCR 모델 없음({resolved_dir}): {", ".join(missing_list)}')
    from rapidocr import RapidOCR  # 패키지가 없으면 여기서만 실패한다
    # 각도 분류기(cls)는 한글 줄을 180° 로 오판해 뒤집으므로 끈다. 인식 모델은 한국어를 명시한다(기본 모델은 한글을 못 읽음).
    return RapidOCR(params={
        'Det.model_path': str(path_map[DET_MODEL_FILE]),
        'Rec.model_path': str(path_map[REC_MODEL_FILE]),
        'Cls.model_path': str(path_map[CLS_MODEL_FILE]),
        'Global.use_cls': False,
        'Global.log_level': 'warning',
        'EngineConfig.onnxruntime.intra_op_num_threads': INTRA_OP_THREAD_COUNT,
    })


def create_ocr_state(model_dir=None):
    """엔진을 만들지 못해도 임베딩 서버는 떠야 하므로 예외 대신 (None, 이유)를 돌려준다."""
    try:
        return create_ocr_engine(model_dir), None
    except Exception as error:  # noqa: BLE001 — 모델·패키지 문제를 모두 /ocr 503 으로 알린다
        return None, f'{type(error).__name__}: {error}'


def decode_image(jpeg_bytes):
    """끝까지 디코딩한 PIL 이미지를 돌려준다.

    헤더만 읽으면(verify·size) 스캔 데이터가 잘린 JPEG 이 통과해 엔진 안에서 OSError(500)가 나므로,
    여기서 한 번 다 읽어 보고 그 이미지를 그대로 엔진에 넘긴다.
    close 하면 픽셀까지 닫히므로 with 로 감싸지 않는다.
    """
    from PIL import Image
    try:
        image = Image.open(io.BytesIO(jpeg_bytes))
        image.load()
    except Exception as error:  # noqa: BLE001 — 어떤 이유든 읽지 못한 이미지는 400
        raise InvalidImageError(f'이미지를 읽지 못했다: {error}') from error
    return image


def recognize(engine, jpeg_bytes):
    image = decode_image(jpeg_bytes)
    image_width, image_height = image.size
    started_at = time.perf_counter()
    # rapidocr 는 bytes 도 PIL 이미지로 열어 같은 경로(RGB→BGR)로 바꾸므로 결과가 같다.
    result = engine(image)
    box_list = [] if result.boxes is None else [
        {'poly': [[float(x), float(y)] for x, y in box], 'text': text, 'score': float(score)}
        for box, text, score in zip(result.boxes, result.txts, result.scores)
    ]
    elapsed_ms = round((time.perf_counter() - started_at) * 1000)
    return build_ocr_response(
        box_list=box_list, image_width=image_width, image_height=image_height,
        elapsed_ms=elapsed_ms, engine_info=ENGINE_INFO,
    )
