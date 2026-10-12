import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * 风格需求（2026-10-12）：系统级主题与页面级视觉风格。
 *
 * 两层设计，各管各的，避免「切了监控页把整站都改花」：
 *  1. 全局主题 `mode`：dark（暗黑极简，默认）/ light。驱动 antd 换肤 + 全站背景。
 *  2. 监控页视觉 `dashboard`：minimal（暗黑极简，默认）/ hud（HUD 工业风）/ neon（暗黑极简+霓虹描边）。
 *     只在 DashboardPage 容器上生效，是可切换的「视觉皮肤」，不改全局。
 *
 * 配色层级规范（避免多彩撞色）：
 *  - 深背景（多层灰阶，从 #0e1116 到 #1a2028）
 *  - 单一蓝/青高亮（#22d3ee 青 为主、#3b82f6 蓝 为辅）
 *  - 灰阶文本（#e6edf3 主 / #8b949e 次 / #6e7681 弱）
 */

export type ThemeMode = 'dark' | 'light';

export type DashboardStyle = 'minimal' | 'hud' | 'neon';

export const DASHBOARD_STYLE_META: Record<DashboardStyle, { label: string; desc: string }> = {
  minimal: { label: '暗黑极简', desc: '深背景 · 蓝青高亮 · 灰阶文本' },
  hud: { label: 'HUD 工业风', desc: '等宽字 · 角标 · 网格扫描' },
  neon: { label: '霓虹描边', desc: '暗黑极简 + 青色霓虹描边' },
};

interface ThemeState {
  mode: ThemeMode;
  dashboard: DashboardStyle;
  setMode: (m: ThemeMode) => void;
  setDashboard: (d: DashboardStyle) => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      // 默认暗黑极简（需求：暗黑极简作为默认主风格）
      mode: 'dark',
      dashboard: 'minimal',
      setMode: (mode) => set({ mode }),
      setDashboard: (dashboard) => set({ dashboard }),
    }),
    {
      name: 'zhigong.theme',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
