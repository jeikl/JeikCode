/**
 * 移动端可视视口同步。
 *
 * 背景：`html` 原来用 `100vh`（大视口，含被浏览器底部工具栏占掉的高度），
 * `#app` 用 `100dvh`，两者差出一条恰好等于工具栏高度的 body 区域。
 * 软键盘弹出时，浏览器为了露出输入框会把页面/可视区向下平移；键盘收起后
 * 这段平移不会自动回位 —— 顶部被裁掉、底部露出黑边，必须刷新才能恢复。
 *
 * 处理方式：
 * 1. 把可见高度同步到 `--app-vvh`，把可视区平移量同步到 `--app-vv-top`；
 *    `#app` 用相对定位贴住可视区，输入框始终停在键盘上方。
 * 2. 区分两种键盘缩放模型：
 *    - `resizes-content` / 原生 WebView 已经把布局视口缩到键盘上方 → 以
 *      `innerHeight` 为准。部分 Chrome 版本会在 `visualViewport.height`
 *      上再把底部工具栏/迷你来源栏减一次；若继续用它，输入框和键盘之间
 *      会空出一条“死区”（本文件修复的那个大空隙）。
 *    - `resizes-visual`（iOS Safari / 旧版 Chromium）布局视口不变 → 以
 *      `visualViewport.height` 为准，并用 `offsetTop` 对齐浏览器自动平移。
 * 3. 键盘占据底部时设置 `data-keyboard-open`，让 CSS 清掉底部安全区
 *    （导航条/Home 指示条已经被输入法覆盖），避免再抬高一条 bar 的高度。
 * 4. 键盘收起或可视区仍被平移时，把页面/可视区的布局滚动归零。
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

export interface ViewportMetrics {
  /** 布局视口高度（`window.innerHeight`）。resizes-content 下键盘弹起会直接变小。 */
  layoutHeight: number;
  /** 可视视口高度（`visualViewport.height`）。resizes-visual 下键盘弹起会变小。 */
  visualHeight: number;
  /** 可视视口相对布局视口的平移量（`visualViewport.offsetTop`）。 */
  visualOffsetTop: number;
  /** 双指缩放比例；> 1 时视口变小属于缩放，不应当成键盘。 */
  visualScale?: number;
  /** 本次会话见过的最大布局视口高度。 */
  fullLayoutHeight: number;
  /** 本次会话见过的最大可视视口高度（不含 offsetTop，避免平移把基线抬高）。 */
  fullVisualHeight: number;
}

export interface ViewportLayout {
  /** `#app` 应占用的高度（未除以页面缩放）。 */
  height: number;
  /** `#app` 为贴合可视区需要下移的量（未除以页面缩放）。 */
  offsetTop: number;
  /** 键盘是否占据屏幕底部（用于清掉底部安全区留白）。 */
  keyboardOpen: boolean;
  /** 布局视口是否已经被浏览器/原生窗口缩到键盘上方。 */
  layoutResized: boolean;
}

/** 键盘/浏览器控件至少遮住这么多才按“键盘弹起”处理，避免把地址栏伸缩误判。 */
const KEYBOARD_MIN_INSET = 80;

/**
 * 计算 `#app` 应贴合的可见矩形。
 *
 * 核心约束：布局视口一旦变小（resizes-content / adjustResize），它本身就是
 * 键盘上方的真实内容区。此时 `visualViewport.height` 在部分 Chrome 版本上
 * 会再把底部浏览器控件减一次，不能继续作为高度来源。
 */
export function resolveViewportLayout(input: ViewportMetrics): ViewportLayout {
  const layoutHeight = Math.max(0, Math.round(input.layoutHeight));
  const visualHeight = Math.max(0, Math.round(input.visualHeight));
  const visualOffsetTop = Math.max(0, Math.round(input.visualOffsetTop));
  const scale = input.visualScale ?? 1;

  // 双指缩放不是键盘：保持整窗布局，由用户自己平移页面。
  if (scale > 1.01) {
    return {
      height: Math.max(layoutHeight, Math.round(input.fullLayoutHeight)),
      offsetTop: 0,
      keyboardOpen: false,
      layoutResized: false,
    };
  }

  const layoutResized =
    input.fullLayoutHeight > 0 && layoutHeight < input.fullLayoutHeight - 1;
  const layoutInset = input.fullLayoutHeight > 0 ? input.fullLayoutHeight - layoutHeight : 0;
  const visualInset = input.fullVisualHeight > 0 ? input.fullVisualHeight - visualHeight : 0;
  const keyboardOpen =
    layoutInset >= KEYBOARD_MIN_INSET ||
    visualInset >= KEYBOARD_MIN_INSET ||
    // 非缩放状态下可视区被平移，只可能是浏览器为键盘让位。
    visualOffsetTop > 0.5;

  if (layoutResized) {
    // 布局视口已缩短：直接采用它，忽略可能被二次扣减的可视视口高度。
    return { height: layoutHeight, offsetTop: 0, keyboardOpen, layoutResized: true };
  }

  // 布局视口未变：以可视视口为准，并把它被浏览器平移的量还原成顶部位移。
  return {
    height: visualHeight || layoutHeight,
    offsetTop: visualOffsetTop,
    keyboardOpen,
    layoutResized: false,
  };
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
  let fullLayoutHeight = 0;
  let fullVisualHeight = 0;
  let lastLayoutWidth = 0;

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
    const layoutWidth = window.innerWidth;
    const layoutHeight = window.innerHeight;
    if (!Number.isFinite(layoutHeight) || layoutHeight <= 0) return;

    // 横竖屏或窗口宽度变化后，旧的“满高”基线不再成立，重新学习。
    if (layoutWidth !== lastLayoutWidth) {
      lastLayoutWidth = layoutWidth;
      fullLayoutHeight = 0;
      fullVisualHeight = 0;
    }

    const visualHeight = viewport ? viewport.height : layoutHeight;
    const visualOffsetTop = viewport ? viewport.offsetTop : 0;
    if (!Number.isFinite(visualHeight) || visualHeight <= 0) return;

    if (layoutHeight > fullLayoutHeight) fullLayoutHeight = layoutHeight;
    if (visualHeight > fullVisualHeight) fullVisualHeight = visualHeight;

    const layout = resolveViewportLayout({
      layoutHeight,
      visualHeight,
      visualOffsetTop,
      visualScale: viewport?.scale ?? 1,
      fullLayoutHeight,
      fullVisualHeight,
    });

    root.style.setProperty('--app-vvh', `${layout.height}px`);
    root.style.setProperty('--app-vv-top', `${layout.offsetTop}px`);
    // 键盘占住底部时，安全区留白会变成输入框与键盘之间的空隙。
    root.toggleAttribute('data-keyboard-open', layout.keyboardOpen);

    if (
      viewport &&
      shouldResetViewportScroll({
        offsetTop: viewport.offsetTop,
        height: layout.height,
        fullHeight: fullLayoutHeight,
      })
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
    fullLayoutHeight = 0;
    fullVisualHeight = 0;
    lastLayoutWidth = 0;
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
