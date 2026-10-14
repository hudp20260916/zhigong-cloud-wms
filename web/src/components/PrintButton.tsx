import { Button } from 'antd';
import { PrinterOutlined } from '@ant-design/icons';
import { printApi } from '../api';

/**
 * 单据打印按钮。
 * 新开窗口加载服务端渲染好的 HTML（含打印样式），由用户触发浏览器打印。
 * 渲染必须在服务端完成，这样「入库单号不出现在打印件」只有一个出口可控。
 */
export function PrintButton({
  docType,
  id,
  size = 'small',
  type = 'link',
  label = '打印',
  className,
}: {
  docType: string;
  id: number;
  size?: 'small' | 'middle' | 'large';
  /** 默认 link（行内轻量样式）；移到顶部按钮组时可传 'default' 与其它按钮视觉一致 */
  type?: 'link' | 'text' | 'default' | 'primary' | 'dashed';
  label?: string;
  /** 额外类名：用于套用统一按钮尺寸 / 高亮样式（如 btn-key） */
  className?: string;
}) {
  return (
    <Button
      type={type}
      size={size}
      className={className}
      icon={<PrinterOutlined />}
      onClick={() => {
        const w = window.open(printApi.renderUrl(docType, id), '_blank');
        if (!w) {
          // 弹出窗口被拦截时给出明确提示，而不是静默失败
          window.alert('浏览器拦截了弹出窗口，请允许本站点弹出窗口后重试');
        }
      }}
    >
      {label}
    </Button>
  );
}
