# OCR 상자 목록을 줄 단위 글과 품질 지표로 바꾼다(슬라이드 전사 /ocr 응답).
# rapidocr 없이 돌도록 엔진과 떼어 둔다 — 시험: python3 -m unittest test_ocr_lines

# 직전 줄과 세로로 이만큼(두 높이 중 작은 쪽 대비) 겹치면 같은 줄로 본다.
LINE_OVERLAP_RATIO = 0.5
# 높이가 너비의 이 배수 이상이면 세로 글씨 상자로 센다. 상자가 적으면 비율이 흔들려 셋 이상일 때만 센다.
VERTICAL_ASPECT_RATIO = 2.0
VERTICAL_MIN_BOX_COUNT = 3


def to_rect(poly):
    x_list = [point[0] for point in poly]
    y_list = [point[1] for point in poly]
    return min(x_list), min(y_list), max(x_list), max(y_list)


def to_item_list(box_list):
    item_list = []
    for box in box_list:
        text = (box.get('text') or '').strip()
        if not text:
            continue
        x0, y0, x1, y1 = to_rect(box['poly'])
        item_list.append({
            'x0': x0, 'y0': y0, 'x1': x1, 'y1': y1, 'cy': (y0 + y1) / 2,
            'text': text, 'score': float(box.get('score') or 0.0),
        })
    return item_list


def weighted_mean_score(item_list):
    char_count = sum(len(item['text']) for item in item_list)
    if not char_count:
        return 0.0
    return sum(item['score'] * len(item['text']) for item in item_list) / char_count


def build_line_list(box_list):
    """위에서 아래로, 같은 높이는 왼쪽에서 오른쪽으로 이어 줄을 만든다."""
    item_list = sorted(to_item_list(box_list), key=lambda item: (item['cy'], item['x0']))
    group_list = []
    for item in item_list:
        if group_list:
            group = group_list[-1]
            overlap = min(group['y1'], item['y1']) - max(group['y0'], item['y0'])
            min_height = min(group['y1'] - group['y0'], item['y1'] - item['y0'])
            if min_height > 0 and overlap >= LINE_OVERLAP_RATIO * min_height:
                group['items'].append(item)
                count = len(group['items'])
                group['y0'] = (group['y0'] * (count - 1) + item['y0']) / count
                group['y1'] = (group['y1'] * (count - 1) + item['y1']) / count
                continue
        group_list.append({'y0': item['y0'], 'y1': item['y1'], 'items': [item]})
    line_list = []
    for group in group_list:
        member_list = sorted(group['items'], key=lambda item: item['x0'])
        left = min(item['x0'] for item in member_list)
        top = min(item['y0'] for item in member_list)
        right = max(item['x1'] for item in member_list)
        bottom = max(item['y1'] for item in member_list)
        line_list.append({
            'text': ' '.join(item['text'] for item in member_list),
            'score': round(weighted_mean_score(member_list), 4),
            'left': round(left), 'top': round(top), 'width': round(right - left), 'height': round(bottom - top),
        })
    return line_list


def compute_mean_score(box_list):
    return round(weighted_mean_score(to_item_list(box_list)), 4)


def compute_vertical_box_ratio(box_list):
    item_list = to_item_list(box_list)
    if len(item_list) < VERTICAL_MIN_BOX_COUNT:
        return 0.0
    vertical_count = sum(
        1 for item in item_list
        if (item['y1'] - item['y0']) >= VERTICAL_ASPECT_RATIO * (item['x1'] - item['x0'])
    )
    return round(vertical_count / len(item_list), 4)


def build_ocr_response(box_list, image_width, image_height, elapsed_ms, engine_info):
    line_list = build_line_list(box_list)
    return {
        'text': '\n'.join(line['text'] for line in line_list),
        'lineList': line_list,
        'imageWidth': image_width,
        'imageHeight': image_height,
        'meanScore': compute_mean_score(box_list),
        'verticalBoxRatio': compute_vertical_box_ratio(box_list),
        'elapsedMs': elapsed_ms,
        'engine': engine_info,
    }
