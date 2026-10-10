import { useEffect, useState } from 'react';

/**
 * 视口断点。
 *
 * 断点与 styles/responsive.css 保持一致，两处改一处即可：
 *   mobile  < 768  —— 侧栏抽屉、表格转卡片、触控区放大
 *   phone   < 414  —— 主流大屏手机
 *   tiny    < 375  —— iPhone SE / mini
 */
export const BREAKPOINT = {
  mobile: 768,
  phone: 414,
  tiny: 375,
};

function matches(query: string): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(query).matches;
}

export function useIsMobile(): boolean {
  const [v, setV] = useState(() => matches(`(max-width: ${BREAKPOINT.mobile - 1}px)`));
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${BREAKPOINT.mobile - 1}px)`);
    const onChange = (e: MediaQueryListEvent) => setV(e.matches);
    setV(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return v;
}

/** 更细的断点，需要区分 414 / 375 时使用 */
export function useBreakpoint(): { mobile: boolean; phone: boolean; tiny: boolean } {
  const [v, setV] = useState(() => ({
    mobile: matches(`(max-width: ${BREAKPOINT.mobile - 1}px)`),
    phone: matches(`(max-width: ${BREAKPOINT.phone}px)`),
    tiny: matches(`(max-width: ${BREAKPOINT.tiny}px)`),
  }));

  useEffect(() => {
    const list = [
      { key: 'mobile' as const, q: `(max-width: ${BREAKPOINT.mobile - 1}px)` },
      { key: 'phone' as const, q: `(max-width: ${BREAKPOINT.phone}px)` },
      { key: 'tiny' as const, q: `(max-width: ${BREAKPOINT.tiny}px)` },
    ].map((x) => ({ ...x, mq: window.matchMedia(x.q) }));

    const update = () =>
      setV({
        mobile: list[0].mq.matches,
        phone: list[1].mq.matches,
        tiny: list[2].mq.matches,
      });

    update();
    for (const x of list) x.mq.addEventListener('change', update);
    return () => {
      for (const x of list) x.mq.removeEventListener('change', update);
    };
  }, []);

  return v;
}
