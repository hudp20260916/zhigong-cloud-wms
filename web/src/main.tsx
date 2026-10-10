import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import 'antd/dist/reset.css';
import './styles.css';
import './styles/responsive.css';
import './utils/keyboard';
import App from './App';
import { BRAND_FULL_TITLE } from './brand';

// 浏览器标签标题统一取自 brand.ts，避免 index.html 里还要再改一遍
document.title = BRAND_FULL_TITLE;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: '#1677ff' } }}>
      <App />
    </ConfigProvider>
  </React.StrictMode>,
);
