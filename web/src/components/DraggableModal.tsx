import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { Modal as AntdModal } from 'antd';
import type { ModalProps } from 'antd';

/**
 * 可拖拽弹窗（全系统统一）。
 *
 * 为什么自己写而不用 react-draggable：项目不引入新的第三方依赖，
 * 而 antd 官方示例里那套拖拽本来也是「自己算偏移 + 包一层」，逻辑并不复杂。
 *
 * 实现要点：
 * - 拖拽把手 = 标题栏。用 `titleRender` 包一层 div 并绑 onMouseDown，
 *   标题栏里的关闭按钮 / 链接 / 表单控件不触发拖拽（closest 过滤）。
 * - 位移落在 `.ant-modal` 的 inline transform 上，**不额外套容器**：
 *   包一层 div 会改变 `.ant-modal-wrap`（position:fixed; inset:0）的定位基准，
 *   把居中布局撑坏；transform 只做视觉偏移，mask 与点击行为完全不受影响。
 * - 边界：按下时按弹窗当前 rect + 视口尺寸算出可移动区间，拖动过程 clamp，
 *   保证弹窗不会被拖出可视区（弹窗比视口还大时取区间中点，避免抖动）。
 * - 拖拽期间置 body 的 userSelect='none'，否则会把页面文字刷成蓝色。
 * - 关闭（open 变 false）即复位偏移，下次打开回到默认居中位置；
 *   窗口 resize 后同样复位，防止拖过的弹窗被尺寸变化挤到屏幕外。
 *
 * 用法：把 `import { Modal } from 'antd'` 换成 `import { Modal } from '../../components'`，
 * 其余写法（含 Modal.confirm 等静态方法）完全不变。
 */

/** 拖拽时弹窗与视口之间保留的最小可见边距（px），保证标题栏始终抓得到 */
const EDGE = 8;

function clamp(v: number, min: number, max: number) {
  // 弹窗比视口还大时 min > max，取中点，避免出现来回抖动
  if (min > max) return (min + max) / 2;
  return Math.min(Math.max(v, min), max);
}

export interface DraggableModalProps extends ModalProps {}

function DraggableModal({
  open,
  style,
  modalRender,
  title,
  ...rest
}: DraggableModalProps) {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{
    px: number;
    py: number;
    ox: number;
    oy: number;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  } | null>(null);
  const cleanup = useRef<(() => void) | null>(null);

  const stopDrag = useCallback(() => {
    cleanup.current?.();
    cleanup.current = null;
    drag.current = null;
  }, []);

  /** 关闭即复位：下次打开回到默认居中（关闭动画期间也在复位态，不会「飞着关」） */
  useEffect(() => {
    if (!open) setOffset({ x: 0, y: 0 });
  }, [open]);

  /** 视口变化后原偏移可能把弹窗挤出屏幕，直接复位最省心 */
  useEffect(() => {
    if (!open) return;
    const onResize = () => setOffset({ x: 0, y: 0 });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open]);

  /** 卸载时兜底清理，避免鼠标监听与 body 样式泄漏 */
  useEffect(() => stopDrag, [stopDrag]);

  function beginDrag(e: ReactMouseEvent) {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement | null;
    // 标题栏上的关闭按钮 / 链接 / 表单控件保持原有点击行为，不触发拖拽
    if (t?.closest('.ant-modal-close, button, a, input, textarea, select, [role="button"]')) return;

    // ⚠️ modalRender 传进来的节点在 antd 5.29 实测是 `.ant-modal-content`（不是外层 .ant-modal），
    //    所以要往上找；拿不到尺寸就没法算边界，这里必须兼容两种层级。
    const wrapEl = wrapRef.current;
    const modalEl =
      (wrapEl?.closest('.ant-modal') as HTMLElement | null) ??
      (wrapEl?.querySelector('.ant-modal') as HTMLElement | null);
    if (!modalEl) return;

    const rect = modalEl.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    // rect 已含当前偏移，减掉后得到「未偏移」时的位置，据此算可移动区间
    const baseLeft = rect.left - offset.x;
    const baseTop = rect.top - offset.y;

    drag.current = {
      px: e.clientX,
      py: e.clientY,
      ox: offset.x,
      oy: offset.y,
      minX: -baseLeft + EDGE,
      maxX: vw - (baseLeft + rect.width) - EDGE,
      minY: -baseTop + EDGE,
      maxY: vh - (baseTop + rect.height) - EDGE,
    };

    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'move';

    const onMove = (ev: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      setOffset({
        x: clamp(d.ox + ev.clientX - d.px, d.minX, d.maxX),
        y: clamp(d.oy + ev.clientY - d.py, d.minY, d.maxY),
      });
    };
    const onUp = () => stopDrag();

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    cleanup.current = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }

  /** 只用来拿弹窗 DOM 做测量，display:contents 保证不产生盒子、不影响布局 */
  const mergedModalRender = (node: ReactNode) => (
    <div ref={wrapRef} className="dm-measure" style={{ display: 'contents' }}>
      {modalRender ? modalRender(node) : node}
    </div>
  );

  /**
   * 把手 = 标题栏本身。antd 5 的 ModalProps 没有 titleRender，
   * 所以直接把 title 包一层 div（渲染进 .ant-modal-title，宽度撑满即可整条可拖）。
   * 没有 title 的弹窗本来也不渲染 header，跳过即可。
   */
  const mergedTitle =
    title == null ? (
      title
    ) : (
      <div
        className="dm-drag-handle"
        onMouseDown={beginDrag}
        title="按住标题栏可拖动"
        style={{ cursor: 'move', userSelect: 'none', width: '100%' }}
      >
        {title}
      </div>
    );

  return (
    <AntdModal
      {...rest}
      open={open}
      title={mergedTitle}
      modalRender={mergedModalRender}
      style={{
        ...style,
        transform: offset.x || offset.y ? `translate(${offset.x}px, ${offset.y}px)` : undefined,
      }}
    />
  );
}

/**
 * 对外导出名就叫 Modal：各页面只改 import 行即可零改动接入。
 * 静态方法（confirm / info / success / error / warning / destroyAll）沿用 antd 原实现。
 */
export const Modal = Object.assign(DraggableModal, AntdModal);
export default Modal;
