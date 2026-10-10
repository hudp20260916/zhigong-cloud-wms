/**
 * 软键盘弹起检测。
 *
 * 手机端输入框聚焦后，可视高度会被键盘压缩。此时：
 *  1. 给 <body> 加 `kb-open`，CSS 里据此隐藏右下角悬浮按钮 —— 否则 fixed 元素会被键盘
 *     顶到输入框上方，正好挡住正在输入的内容；
 *  2. 页面上原有的 fixed/sticky 元素也能用同样方式规避。
 *
 * 用 visualViewport 而不是 window.resize：后者在 iOS 上不一定触发，且无法区分键盘与旋转。
 */
const THRESHOLD = 180; // 视口高度减少超过该值即认为键盘弹起

function setup(): void {
  const vv = window.visualViewport;
  if (!vv) return;

  let baseline = vv.height;

  const update = () => {
    const h = vv.height;
    // 竖屏下键盘会让高度明显减少；旋转屏幕时宽高互换，这里顺手更新基线
    const shrunk = baseline - h > THRESHOLD;
    document.body.classList.toggle('kb-open', shrunk);
    if (!shrunk) baseline = h;
  };

  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
}

setup();

export {};
