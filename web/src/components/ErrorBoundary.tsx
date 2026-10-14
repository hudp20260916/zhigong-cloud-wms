import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Alert, Button } from 'antd';

/**
 * 渲染错误兜底。
 *
 * 背景：React 子组件在渲染期抛错会一路冒泡，导致**整个页面白屏**（连报错原因都看不到）。
 * 本系统踩过两次：一次是 DatePicker 拿到字符串日期（应传 dayjs），
 * 一次是弹窗表单回填时序问题。两处的共同点是——错误只在特定数据下触发，本地很难复现。
 *
 * 用法：把「可能因为脏数据炸掉」的区块包起来（弹窗内容、详情区等），
 * 出错时就地提示并给出重试入口，而不是整页变白。
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; /** 出错时展示的区块名，便于定位 */ label?: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 保留控制台堆栈，方便定位；界面上只暴露摘要，避免把技术细节甩给用户
    console.error(`[ErrorBoundary]${this.props.label ? ` ${this.props.label}` : ''}`, error, info);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <Alert
        type="error"
        showIcon
        message={`${this.props.label ?? '此区块'}加载失败`}
        description={
          <span>
            {error.message || '渲染时发生异常'}
            <Button
              type="link"
              size="small"
              style={{ paddingInline: 4 }}
              onClick={() => this.setState({ error: null })}
            >
              重试
            </Button>
          </span>
        }
      />
    );
  }
}

export default ErrorBoundary;
