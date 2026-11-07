/**
 * 移动端可视视口同步。
 *
 * 背景：`html` 原来用 `100vh`（大视口，含被浏览器底部工具栏占掉的高度），
 * `#app` 用 `100dvh`，两者差出一条恰好等于工具栏高度的 body 区域。
 * 软键盘弹出时，浏览器为了露出输入框会把页面/可视区向下平移；键盘收起后
 * 这段平移不会自动回位 —— 顶部被裁掉、底部露出黑边，必须刷新才能恢复。
 *
 * 处理方式：
 * 1. 把 `visualViewport.height` 同步到 `--app-vvh`，让布局在键盘弹出时真正变矮
 *    （输入框始终停在键盘上方），收起时恢复，document 不再高于可见区域。
 * 2. 键盘收起或可视区仍被平移时，把页面/可视区滚动归零，消除顶部裁切与底部黑边。
 */

/** 可视视口是否仍处于“被平移/被键盘压缩”的残留状态，需要归零。 */
export function shouldResetViewportScroll(input: {
  offsetTop: number;
  height: number;
  /** 本次会话见过的最大可视高度（即无键盘时的可用高度）。 */
  fullHeight: number;
}): boolean {
  // offsetTop > 0：浏览器把可视区向下平移过（顶部被裁、底部露黑边）。
  if (input.offsetTop > 0.5) return true;
  // 高度回到无键盘时的满高：键盘已收起，顺手把残留的布局滚动也归零。
  return input.fullHeight > 0 && input.height >= input.fullHeight - 1;
}

/**
 * 安装可视视口同步，返回卸载函数。
 * 在 main.tsx 启动时调用一次；桌面端同样生效（visualViewport 始终存在）。
 */
export function installViewportSync(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  const root = document.documentElement;
  const viewport = window.visualViewport;
  let frame = 0;
  let fullHeight = 0;

  const resetScroll = () => {
    try {
      if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
    } catch {
      /* ignore */
    }
    if (root.scrollTop !== 0) root.scrollTop = 0;
    if (document.body && document.body.scrollTop !== 0) document.body.scrollTop = 0;
  };

  const apply = () => {
    frame = 0;
    const height = viewport ? viewport.height : window.innerHeight;
    if (!Number.isFinite(height) || height <= 0) return;
    // 记录无键盘时的满高：键盘弹出会让可视高度变小，收起后恢复到这个值。
    if (height > fullHeight) fullHeight = height;
    root.style.setProperty('--app-vvh', `${Math.round(height)}px`);

    if (
      viewport &&
      shouldResetViewportScroll({ offsetTop: viewport.offsetTop, height, fullHeight })
    ) {
      resetScroll();
    }
  };

  const schedule = () => {
    if (frame) return;
    frame = window.requestAnimationFrame(apply);
  };

  const onOrientationChange = () => {
    // 横竖屏切换后旧的“满高”不再成立，重新学习。
    fullHeight = 0;
    schedule();
  };

  apply();
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', onOrientationChange);
  // 键盘弹起/收起在部分输入法上不触发 resize，焦点变化后补一帧同步。
  window.addEventListener('focusin', schedule);
  window.addEventListener('focusout', schedule);
  viewport?.addEventListener('resize', schedule);
  viewport?.addEventListener('scroll', schedule);

  return () => {
    if (frame) window.cancelAnimationFrame(frame);
    window.removeEventListener('resize', schedule);
    window.removeEventListener('orientationchange', onOrientationChange);
    window.removeEventListener('focusin', schedule);
    window.removeEventListener('focusout', schedule);
    viewport?.removeEventListener('resize', schedule);
    viewport?.removeEventListener('scroll', schedule);
  };
}
