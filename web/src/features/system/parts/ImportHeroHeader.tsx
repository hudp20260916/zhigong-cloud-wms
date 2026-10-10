import { forwardRef, memo } from 'react';
import { Progress, Tag } from 'antd';

export interface StageStat {
  label: string;
  value: number;
  color: string;
}

export interface ImportHeroHeaderProps {
  /** 当前导入类型的名称，如「物料档案」 */
  kindName: string;
  /** 服务端给的字段说明 */
  hint?: string;
  /** 已经解析出的数据行数 */
  rowCount: number;
  /** 有问题的行数 */
  errorCount: number;
}

/**
 * 导入页顶部的渐变头图。
 *
 * 这个组件不含任何状态和副作用，纯展示，所以用 forwardRef + memo 包一层：
 * 父级（ImportPage）每次输入都要重渲染，但头图只有 rowCount / errorCount 变化才需要重建。
 */
export const ImportHeroHeader = memo(
  forwardRef<HTMLDivElement, ImportHeroHeaderProps>(function ImportHeroHeader(
    { kindName, hint, rowCount, errorCount },
    ref,
  ) {
    const healthy = rowCount > 0 && errorCount === 0;

    return (
      <div
        ref={ref}
        style={{
          position: 'relative',
          overflow: 'hidden',
          borderRadius: 16,
          padding: '22px 24px',
          marginBottom: 18,
          background: 'linear-gradient(120deg, #2563eb 0%, #4f46e5 55%, #7c3aed 100%)',
          boxShadow: '0 10px 30px -12px rgba(79, 70, 229, 0.75)',
          color: '#fff',
        }}
      >
        {/* 装饰性光斑，纯视觉，不参与交互 */}
        <span
          aria-hidden
          style={{
            position: 'absolute',
            right: -40,
            top: -60,
            width: 220,
            height: 220,
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(255,255,255,0.28), rgba(255,255,255,0) 70%)',
          }}
        />
        <span
          aria-hidden
          style={{
            position: 'absolute',
            right: 120,
            bottom: -80,
            width: 180,
            height: 180,
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(255,255,255,0.18), rgba(255,255,255,0) 70%)',
          }}
        />

        <div style={{ position: 'relative', display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
          <div style={{ flex: '1 1 240px', minWidth: 220 }}>
            <div style={{ fontSize: 12, letterSpacing: 2, opacity: 0.85 }}>EXCEL 批量导入</div>
            <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>{kindName || '请选择导入类型'}</div>
            <div style={{ marginTop: 6, fontSize: 13, opacity: 0.9, lineHeight: 1.6 }}>
              {hint || '首行需为表头，支持中文表头或英文字段名'}
            </div>
          </div>

          <div style={{ flex: '0 0 auto', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <div
              style={{
                minWidth: 96,
                padding: '10px 14px',
                borderRadius: 12,
                background: 'rgba(255,255,255,0.16)',
                border: '1px solid rgba(255,255,255,0.24)',
                backdropFilter: 'blur(6px)',
              }}
            >
              <div style={{ fontSize: 12, opacity: 0.85 }}>已解析</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{rowCount}</div>
            </div>
            <div
              style={{
                minWidth: 96,
                padding: '10px 14px',
                borderRadius: 12,
                background: errorCount > 0 ? 'rgba(255,77,79,0.28)' : 'rgba(255,255,255,0.16)',
                border: `1px solid ${errorCount > 0 ? 'rgba(255,120,120,0.6)' : 'rgba(255,255,255,0.24)'}`,
                backdropFilter: 'blur(6px)',
              }}
            >
              <div style={{ fontSize: 12, opacity: 0.9 }}>异常行</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{errorCount}</div>
            </div>
          </div>
        </div>

        {rowCount > 0 && (
          <div style={{ position: 'relative', marginTop: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
            <Progress
              percent={healthy ? 100 : Math.max(0, Math.round(((rowCount - errorCount) / rowCount) * 100))}
              size="small"
              status={healthy ? 'success' : 'exception'}
              strokeColor={healthy ? '#b7f5c2' : '#ffd6d6'}
              style={{ flex: 1, margin: 0 }}
              showInfo={false}
            />
            {healthy ? (
              <Tag color="success" style={{ marginInlineEnd: 0 }}>格式校验通过</Tag>
            ) : (
              <Tag color="error" style={{ marginInlineEnd: 0 }}>需修正后导入</Tag>
            )}
          </div>
        )}
      </div>
    );
  }),
);

export default ImportHeroHeader;
