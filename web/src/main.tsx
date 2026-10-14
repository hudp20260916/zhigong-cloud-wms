import React, { useMemo, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, theme as antdTheme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import 'antd/dist/reset.css';
import './styles.css';
import './styles/responsive.css';
import './styles/theme.css';
import './utils/keyboard';
import App from './App';
import './brand'; // 品牌名：模块导入时即按缓存值刷标题，并异步拉取服务端最新公司名称
import { useThemeStore, type ThemeMode } from './stores/theme';

/** 高亮色：单一蓝/青，全站共用，避免撞色 */
const HIGHLIGHT = '#22d3ee'; // 青
const HIGHLIGHT_ALT = '#3b82f6'; // 蓝

/** 全局主题 token。暗黑极简为默认主风格。 */
function buildTheme(mode: ThemeMode) {
  if (mode === 'light') {
    return {
      algorithm: antdTheme.defaultAlgorithm,
      token: {
        colorPrimary: HIGHLIGHT_ALT,
        colorInfo: HIGHLIGHT_ALT,
        colorTextBase: '#1f2328',
        colorBgLayout: '#f5f6f8',
      },
    };
  }
  return {
    algorithm: [antdTheme.darkAlgorithm, antdTheme.compactAlgorithm],
    token: {
      colorPrimary: HIGHLIGHT,
      colorInfo: HIGHLIGHT,
      colorTextBase: '#e6edf3',
      colorBgBase: '#0e1116',
      colorBgLayout: '#0e1116',
      colorBgContainer: '#161b22',
      colorBgElevated: '#1a2028',
      colorBorder: '#30363d',
      colorBorderSecondary: '#21262d',
      colorText: '#e6edf3',
      colorTextSecondary: '#8b949e',
      colorTextDisabled: '#6e7681',
      colorSplit: '#21262d',
      borderRadius: 6,
      wireframe: false,
    },
    components: {
      Layout: {
        bodyBg: '#0e1116',
        siderBg: '#0b0e13',
        headerBg: '#0b0e13',
      },
      Card: {
        colorBgContainer: '#161b22',
      },
      Table: {
        headerBg: '#1a2028',
        colorBgContainer: '#161b22',
      },
      Menu: {
        itemBg: 'transparent',
        subMenuItemBg: 'transparent',
        itemSelectedBg: 'rgba(34, 211, 238, 0.12)',
        itemSelectedColor: HIGHLIGHT,
        itemHoverBg: 'rgba(34, 211, 238, 0.08)',
      },
    },
  };
}

/** 把主题写进 body class，让 CSS 变量层（theme.css）与 antd token 保持一致 */
function ThemeRoot({ children }: { children: React.ReactNode }) {
  const mode = useThemeStore((s) => s.mode);
  const theme = useMemo(() => buildTheme(mode), [mode]);

  useEffect(() => {
    document.body.className = document.body.className.replace(/(theme-dark|theme-light)\s*/g, '');
    document.body.classList.add(mode === 'dark' ? 'theme-dark' : 'theme-light');
  }, [mode]);

  return (
    <ConfigProvider locale={zhCN} theme={theme}>
      {children}
    </ConfigProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeRoot>
      <App />
    </ThemeRoot>
  </React.StrictMode>,
);
