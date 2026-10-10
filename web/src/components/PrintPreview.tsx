import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, Segmented, Space, Tooltip, Empty } from 'antd';
import '../styles/print-preview.css';

/**
 * 打印预览器。
 *
 * 三件事必须同时满足，否则模板没法调：
 *  1. **真实比例**：纸张宽度按 mm 换算成 px（96dpi），iframe 用真实宽度渲染，
 *     再用 transform: scale() 缩放 —— 缩放只改视觉大小，不改版式，所见即所印。
 *  2. **分页效果**：服务端返回的是单个 .page 容器（min-height 一张纸），内容超长时它会长高。
 *     这里测出真实内容高度后，按纸张高度画虚线分页线并标注页码，
 *     让你在编辑期就能看到「这一页装不下、会断在第几行」。
 *  3. **自适应缩放**：容器宽度变化时自动重算 fit 比例，窄屏也能整页塞进去，永不出现横向滚动。
 */

const PX_PER_MM = 96 / 25.4; // ≈3.7795，CSS 里 1in = 96px 的标准换算

/** 纸张尺寸（mm），与服务端 PRINT_CSS 里的 .page 规则一一对应 */
const PAPER_MM: Record<string, [number, number]> = {
  A4: [210, 297],
  A5: [148, 210],
  P241: [241, 140],
};

export interface PrintPreviewProps {
  html: string;
  paper: string;
  orientation: 'portrait' | 'landscape';
  /** 顶部右侧插槽：放「打印」之类的外部操作 */
  extra?: React.ReactNode;
}

export default function PrintPreview({ html, paper, orientation, extra }: PrintPreviewProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const [boxW, setBoxW] = useState(0); // 可视区可用宽度
  const [contentH, setContentH] = useState(0); // 文档真实内容高度（px，未缩放）
  const [mode, setMode] = useState<'fit' | number>('fit');
  const [ready, setReady] = useState(false);

  // 纸张尺寸（px）。横向时宽高互换
  const [pageW, pageH] = useMemo(() => {
    const [w, h] = PAPER_MM[paper] ?? PAPER_MM.A4;
    return orientation === 'landscape' ? [h * PX_PER_MM, w * PX_PER_MM] : [w * PX_PER_MM, h * PX_PER_MM];
  }, [paper, orientation]);

  // 容器宽度：跟随窗口/侧栏折叠变化
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      setBoxW(entries[0].contentRect.width);
    });
    ro.observe(el);
    setBoxW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const stageW = Math.max(0, boxW - 24); // 留一点内边距
  const fitScale = stageW > 0 && pageW > 0 ? Math.min(1, stageW / pageW) : 1;
  const scale = mode === 'fit' ? fitScale : mode;

  /** 量真实内容高度：srcdoc 与父页面同源，可直接读 contentDocument */
  const measure = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    try {
      const doc = iframe.contentDocument;
      if (!doc) return;
      const h = Math.max(
        doc.documentElement.scrollHeight,
        (doc.body?.scrollHeight ?? 0),
        pageH,
      );
      setContentH(Math.ceil(h));
      setReady(true);
    } catch {
      // 极少数环境（如 file:// 下）读不到，降级为一张纸的高度
      setContentH(Math.ceil(pageH));
      setReady(true);
    }
  }, [pageH]);

  useEffect(() => {
    if (!html) {
      setContentH(Math.ceil(pageH));
      return;
    }
    // srcDoc 变化后 iframe 会重新触发 onLoad，那里再量一次；这里兜底防抖
    const t = setTimeout(measure, 120);
    return () => clearTimeout(t);
  }, [html, measure, pageH]);

  // 内容超长时按纸张高度切页
  const pages = useMemo(() => {
    const n = Math.max(1, Math.ceil((contentH || pageH) / pageH));
    return Array.from({ length: n }, (_, i) => i);
  }, [contentH, pageH]);

  const iframeH = Math.max(contentH || pageH, pageH);

  return (
    <div className="pp" ref={wrapRef}>
      <div className="pp-bar">
        <Space size={4} wrap>
          <Segmented
            size="small"
            value={mode === 'fit' ? 'fit' : 'custom'}
            onChange={(v) => setMode(v === 'fit' ? 'fit' : 1)}
            options={[
              { label: '适应宽度', value: 'fit' },
              { label: '100%', value: 'custom' },
            ]}
          />
          <Button size="small" disabled={mode === 'fit'} onClick={() => setMode(Math.max(0.25, Number(mode) - 0.25))}>
            −
          </Button>
          <span className="pp-zoom">{Math.round(scale * 100)}%</span>
          <Button size="small" disabled={mode === 'fit'} onClick={() => setMode(Math.min(2, Number(mode) + 0.25))}>
            ＋
          </Button>
          <Button size="small" type="link" onClick={() => setMode('fit')} disabled={mode === 'fit'}>
            重置
          </Button>
        </Space>
        <Space size={6} wrap>
          <span className="pp-meta">
            {paper} · {orientation === 'portrait' ? '纵向' : '横向'} · {Math.round(pageW)}×
            {Math.round(pageH)}px · {pages.length} 页
          </span>
          {extra}
        </Space>
      </div>

      <div className="pp-stage" style={{ height: iframeH * scale + 32 }}>
        {!html ? (
          <div className="pp-empty">
            <Empty description="暂无预览内容" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          </div>
        ) : (
          <div
            className="pp-pagebox"
            style={{
              width: pageW * scale,
              height: iframeH * scale,
            }}
          >
            <div
              className="pp-scaled"
              style={{ width: pageW, height: iframeH, transform: `scale(${scale})` }}
            >
              <iframe
                ref={iframeRef}
                title="print-preview"
                srcDoc={html}
                onLoad={measure}
                style={{ width: pageW, height: iframeH, border: 0, background: '#fff' }}
              />
              {/* 分页线：从第 2 页起，在每张纸的分界处画一条虚线并标页码 */}
              {pages.slice(1).map((i) => (
                <Tooltip title={`第 ${i + 1} 页开始`} key={i}>
                  <div className="pp-break" style={{ top: i * pageH }}>
                    <span>第 {i + 1} 页</span>
                  </div>
                </Tooltip>
              ))}
            </div>
          </div>
        )}
      </div>
      {!ready && html ? <div className="pp-tip">渲染中…</div> : null}
    </div>
  );
}
