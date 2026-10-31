# ocr_lines 단위 시험 — rapidocr 없이 돈다.
# 실행: cd tools/gpu-server && python3 -m unittest test_ocr_lines
import unittest

from ocr_lines import (
    build_line_list, build_ocr_response, compute_mean_score, compute_vertical_box_ratio,
)


def box(x0, y0, x1, y1, text, score=0.9):
    return {'poly': [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], 'text': text, 'score': score}


class BuildLineListTest(unittest.TestCase):
    def test_같은_높이_상자는_왼쪽부터_한_줄(self):
        line_list = build_line_list([box(300, 100, 400, 140, '매출'), box(100, 102, 280, 142, '3분기')])
        self.assertEqual([line['text'] for line in line_list], ['3분기 매출'])

    def test_세로_겹침이_절반_미만이면_다른_줄(self):
        line_list = build_line_list([box(100, 100, 300, 140, '첫 줄'), box(100, 125, 300, 165, '둘째 줄')])
        self.assertEqual([line['text'] for line in line_list], ['첫 줄', '둘째 줄'])

    def test_위에서_아래로_정렬(self):
        line_list = build_line_list([box(100, 300, 300, 340, '아래'), box(100, 100, 300, 140, '위')])
        self.assertEqual([line['text'] for line in line_list], ['위', '아래'])

    def test_빈_글자_상자는_뺀다(self):
        line_list = build_line_list([box(100, 100, 300, 140, '  '), box(100, 200, 300, 240, '글자')])
        self.assertEqual([line['text'] for line in line_list], ['글자'])

    def test_줄_사각형과_글자수_가중_점수(self):
        line_list = build_line_list([box(100, 100, 200, 140, '가나', 1.0), box(220, 100, 420, 150, '다라마바', 0.7)])
        self.assertEqual(len(line_list), 1)
        line = line_list[0]
        self.assertEqual((line['left'], line['top'], line['width'], line['height']), (100, 100, 320, 50))
        self.assertAlmostEqual(line['score'], 0.8, places=4)


class MetricTest(unittest.TestCase):
    def test_평균_점수는_글자수_가중(self):
        self.assertAlmostEqual(compute_mean_score([box(0, 0, 10, 10, '가', 1.0), box(0, 20, 10, 30, '나다라', 0.6)]), 0.7)

    def test_상자가_없으면_평균_점수_0(self):
        self.assertEqual(compute_mean_score([]), 0.0)

    def test_세로_상자_비율(self):
        box_list = [box(0, 0, 100, 20, 'a'), box(0, 30, 100, 50, 'b'), box(0, 60, 100, 80, 'c'), box(200, 0, 210, 100, '세로')]
        self.assertAlmostEqual(compute_vertical_box_ratio(box_list), 0.25)

    def test_상자가_셋_미만이면_세로_비율_0(self):
        self.assertEqual(compute_vertical_box_ratio([box(200, 0, 210, 100, '세로'), box(0, 0, 100, 20, 'a')]), 0.0)


class BuildOcrResponseTest(unittest.TestCase):
    def test_응답_형식(self):
        engine_info = {'name': 'rapidocr', 'version': '3.9.2', 'det': 'd', 'rec': 'r'}
        response = build_ocr_response(
            box_list=[box(100, 100, 300, 140, '제목'), box(100, 200, 300, 240, '본문')],
            image_width=1920, image_height=1080, elapsed_ms=321, engine_info=engine_info,
        )
        self.assertEqual(response['text'], '제목\n본문')
        self.assertEqual([line['text'] for line in response['lineList']], ['제목', '본문'])
        self.assertEqual((response['imageWidth'], response['imageHeight'], response['elapsedMs']), (1920, 1080, 321))
        self.assertAlmostEqual(response['meanScore'], 0.9)
        self.assertEqual(response['verticalBoxRatio'], 0.0)
        self.assertEqual(response['engine'], engine_info)


if __name__ == '__main__':
    unittest.main()
