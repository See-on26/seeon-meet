import { ROI_COLOR_MAP, ROI_TYPE_MAP } from '../../core/constants.js';
import { pxToContentNorm, rectFromPoints, isUsableNormRect, normToContentPx } from './roi-geometry.js';

const ROI_LABEL = '공유 화면';

// 재생 화면 위에서 공유 화면 ROI 를 드래그로 정한다. 편집 중에만 테두리를 그린다(캡처 이미지에 들어가면 안 된다).
export class RoiEditOverlay {
  constructor({ canvas, getContentRect, getRoiNormRect, onChange }) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.getContentRect = getContentRect;
    this.getRoiNormRect = getRoiNormRect;
    this.onChange = onChange;
    this.isEditing = false;
    this.dragStart = null;
    this.dragRect = null;
    canvas.addEventListener('pointerdown', (event) => this.handlePointerDown(event));
    canvas.addEventListener('pointermove', (event) => this.handlePointerMove(event));
    canvas.addEventListener('pointerup', (event) => this.handlePointerUp(event));
    canvas.addEventListener('pointerleave', () => this.handlePointerCancel());
    window.addEventListener('resize', () => this.redraw());
  }

  setEditing(isEditing) {
    this.isEditing = isEditing;
    this.canvas.style.display = isEditing ? 'block' : 'none';
    this.dragStart = null;
    this.dragRect = null;
    this.redraw();
  }

  toNormPoint(event) {
    const bounds = this.canvas.getBoundingClientRect();
    return pxToContentNorm({ point: { x: event.clientX - bounds.left, y: event.clientY - bounds.top }, contentRect: this.getContentRect() });
  }

  handlePointerDown(event) {
    if (!this.isEditing) return;
    this.canvas.setPointerCapture?.(event.pointerId);
    this.dragStart = this.toNormPoint(event);
    this.dragRect = null;
  }

  handlePointerMove(event) {
    if (!this.dragStart) return;
    this.dragRect = rectFromPoints({ from: this.dragStart, to: this.toNormPoint(event) });
    this.redraw();
  }

  handlePointerUp(event) {
    if (!this.dragStart) return;
    const rect = rectFromPoints({ from: this.dragStart, to: this.toNormPoint(event) });
    this.dragStart = null;
    this.dragRect = null;
    if (isUsableNormRect(rect)) this.onChange(rect);
    this.redraw();
  }

  handlePointerCancel() {
    this.dragStart = null;
    this.dragRect = null;
    this.redraw();
  }

  strokeRect({ normRect, isDragging }) {
    const { x, y, w, h } = normToContentPx({ normRect, contentRect: this.getContentRect() });
    const color = ROI_COLOR_MAP[ROI_TYPE_MAP.screenShare];
    this.context.strokeStyle = color;
    this.context.lineWidth = 3;
    this.context.setLineDash(isDragging ? [8, 6] : []);
    this.context.strokeRect(x, y, w, h);
    this.context.setLineDash([]);
    this.context.fillStyle = color;
    this.context.font = '14px sans-serif';
    this.context.fillRect(x, y, this.context.measureText(ROI_LABEL).width + 12, 20);
    this.context.fillStyle = '#fff';
    this.context.fillText(ROI_LABEL, x + 6, y + 15);
  }

  redraw() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(window.innerWidth * dpr);
    this.canvas.height = Math.round(window.innerHeight * dpr);
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.context.clearRect(0, 0, window.innerWidth, window.innerHeight);
    if (!this.isEditing) return;
    this.strokeRect({ normRect: this.getRoiNormRect(), isDragging: false });
    if (this.dragRect) this.strokeRect({ normRect: this.dragRect, isDragging: true });
  }
}
