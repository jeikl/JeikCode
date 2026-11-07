/**
 * 会话图片画廊：把画布里已渲染的图片按出现顺序收成一张可切换的列表。
 *
 * 灯箱里的「上一张 / 下一张」只在当前会话内切换。用 DOM 收集而不是重新解析
 * 消息，是为了拿到与用户点击完全一致的 `src`（Markdown 会把相对路径重写成
 * `/fs/raw?...`，重新推导容易和渲染结果对不上）。
 */

/** 只依赖 `<img>` 的最小形状，便于在无 DOM 的单元测试里构造假节点。 */
export interface GalleryImageLike {
  currentSrc?: string;
  src?: string;
}

export interface GalleryImageRoot {
  querySelectorAll(selector: string): ArrayLike<unknown>;
}

/**
 * 收集 `root` 内全部图片的 src：按 DOM 顺序去重，并保证 `current`（用户刚点开的
 * 那张）一定在列表里 —— 即使它来自画布之外（例如输入框里的待发附件）。
 */
export function collectImageSrcs(
  root: GalleryImageRoot | null | undefined,
  current?: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (src?: string | null) => {
    const value = (src ?? '').trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };

  const nodes = root?.querySelectorAll('img');
  if (nodes) {
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i] as GalleryImageLike | null | undefined;
      if (!node) continue;
      // `currentSrc` 是懒加载/响应式图片的真实地址；未加载时回退到 src。
      push(node.currentSrc || node.src);
    }
  }
  push(current);
  return out;
}

/**
 * 循环取下一张：到头回到第一张（相册式切换，永不死按钮）。
 * 返回 `undefined` 表示没有可切换的图片。
 */
export function stepImageIndex(
  index: number,
  length: number,
  delta: number,
): number | undefined {
  if (!Number.isFinite(index) || length <= 0) return undefined;
  if (length === 1) return undefined;
  return ((Math.trunc(index) + delta) % length + length) % length;
}
