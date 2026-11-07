import { createPortal } from 'preact/compat';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ImageData } from '../../api';
import { copyImageSrcToClipboard } from '../../lib/clipboard';
import { stepImageIndex } from '../../lib/imageGallery';
import { useT } from '../../settings';
import { showToast } from '../Toast';

export interface ImageLightboxProps {
  /** 当前大图。 */
  src: string;
  /** 会话内全部图片（按出现顺序，已去重）。缺省 = 只看单张。 */
  images?: string[];
  /** 切换到另一张：上层更新 src，灯箱内部负责重置缩放。 */
  onNavigate?: (src: string) => void;
  onClose: () => void;
}

export function ImageLightbox({ src, images, onNavigate, onClose }: ImageLightboxProps) {
  const t = useT();
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [isInteracting, setIsInteracting] = useState(false);
  const [swipingY, setSwipingY] = useState(0);
  // 右键菜单（桌面截图工具式「复制图片」）与复制中的忙碌态。
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [copying, setCopying] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // 高性能手势追踪引用（避免频繁闭包捕获延迟）
  const gRef = useRef({
    scale: 1,
    pos: { x: 0, y: 0 },
    startDist: 0,
    startScale: 1,
    startMidpoint: { x: 0, y: 0 },
    startPos: { x: 0, y: 0 },
    startTouch: { x: 0, y: 0 },
    isPanning: false,
    isSwipingDown: false,
    swipeY: 0,
    lastTapTime: 0,
    lastTapPos: { x: 0, y: 0 },
    isMouseDown: false,
    mouseStart: { x: 0, y: 0 },
    mouseStartPos: { x: 0, y: 0 },
  });

  gRef.current.scale = scale;
  gRef.current.pos = pos;

  // 边界自适应限制：确保拖拽平移时用户能看清图片任意边缘细节，且不会将图片拖出屏幕视口
  const clampOffset = (targetScale: number, targetPos: { x: number; y: number }) => {
    if (targetScale <= 1.02) return { x: 0, y: 0 };
    const img = imgRef.current;
    if (!img) return targetPos;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const baseW = img.offsetWidth || Math.min(vw * 0.95, 1100);
    const baseH = img.offsetHeight || Math.min(vh * 0.88, 800);
    const visualW = baseW * targetScale;
    const visualH = baseH * targetScale;
    const maxX = Math.max(0, (visualW - vw) / 2 + 30);
    const maxY = Math.max(0, (visualH - vh) / 2 + 30);
    return {
      x: Math.max(-maxX, Math.min(maxX, targetPos.x)),
      y: Math.max(-maxY, Math.min(maxY, targetPos.y)),
    };
  };

  const resetZoom = useCallback(() => {
    setScale(1);
    setPos({ x: 0, y: 0 });
    setSwipingY(0);
  }, []);

  /** 当前会话可切换的全部图片：保证用户点开的那张一定在列表里。 */
  const gallery = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of images ?? []) {
      const value = (item ?? '').trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
    if (src && !seen.has(src)) out.push(src);
    return out;
  }, [images, src]);
  const index = gallery.indexOf(src);
  const hasMultiple = gallery.length > 1 && !!onNavigate;

  /** 相册式循环切换：到头回到另一头，永不死按钮。 */
  const go = useCallback((delta: number) => {
    const nextIndex = stepImageIndex(index, gallery.length, delta);
    if (nextIndex === undefined) return;
    const next = gallery[nextIndex];
    if (!next || next === src) return;
    resetZoom();
    onNavigate?.(next);
  }, [gallery, index, onNavigate, resetZoom, src]);

  // 切到另一张时重置缩放/位移，避免带着上一张的 3x 视口打开新图。
  useEffect(() => {
    resetZoom();
  }, [src, resetZoom]);

  const openMenu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // 菜单固定宽度，贴边时向内收，避免被视口裁掉。
    const menuW = 176;
    const menuH = 56;
    setMenu({
      x: Math.min(e.clientX, Math.max(8, window.innerWidth - menuW - 8)),
      y: Math.min(e.clientY, Math.max(8, window.innerHeight - menuH - 8)),
    });
  };

  const copyCurrent = useCallback(async () => {
    if (copying) return;
    setMenu(null);
    setCopying(true);
    try {
      const ok = await copyImageSrcToClipboard(src);
      showToast(ok ? t('preview.copyImageSuccess') : t('copy.failed'), ok ? 'info' : 'error');
    } finally {
      setCopying(false);
    }
  }, [copying, src, t]);

  // 右键菜单：点空白、滚轮、缩放窗口都关闭。
  useEffect(() => {
    if (!menu) return;
    const closeOnOutside = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setMenu(null);
    };
    window.addEventListener('pointerdown', closeOnOutside);
    window.addEventListener('resize', closeOnOutside);
    window.addEventListener('scroll', closeOnOutside, true);
    return () => {
      window.removeEventListener('pointerdown', closeOnOutside);
      window.removeEventListener('resize', closeOnOutside);
      window.removeEventListener('scroll', closeOnOutside, true);
    };
  }, [menu]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 菜单开着时先收菜单，再按一次才关灯箱。
        if (menu) {
          e.stopPropagation();
          setMenu(null);
          return;
        }
        onClose();
        return;
      }
      if (e.key === 'ArrowLeft' && hasMultiple) {
        e.preventDefault();
        go(-1);
      } else if (e.key === 'ArrowRight' && hasMultiple) {
        e.preventDefault();
        go(1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, hasMultiple, menu, onClose]);

  // 原生相册级手势监听：双手捏合缩放 (Pinch-to-zoom)、单指拖动查看细节、双击放大
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const getTouchDist = (t1: Touch, t2: Touch) => Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
    const getTouchMid = (t1: Touch, t2: Touch) => ({
      x: (t1.clientX + t2.clientX) / 2,
      y: (t1.clientY + t2.clientY) / 2,
    });

    const onTouchStart = (e: TouchEvent) => {
      const g = gRef.current;
      if (e.touches.length === 2) {
        // 双手触屏：开启原生相册级捏合缩放 (Pinch-to-zoom)
        e.preventDefault();
        setIsInteracting(true);
        g.startDist = getTouchDist(e.touches[0], e.touches[1]);
        g.startMidpoint = getTouchMid(e.touches[0], e.touches[1]);
        g.startScale = g.scale;
        g.startPos = { ...g.pos };
        g.isPanning = false;
        g.isSwipingDown = false;
      } else if (e.touches.length === 1) {
        const touch = e.touches[0];
        const now = Date.now();
        const distFromLastTap = Math.hypot(touch.clientX - g.lastTapPos.x, touch.clientY - g.lastTapPos.y);

        // 双击放大/还原检测（像相册一样双击任意细节处直接放大到 2.8x）
        if (now - g.lastTapTime < 280 && distFromLastTap < 40) {
          e.preventDefault();
          g.lastTapTime = 0;
          setIsInteracting(false);
          if (g.scale > 1.1) {
            resetZoom();
          } else {
            const nextScale = 2.8;
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const focalX = (vw / 2 - touch.clientX) * 1.5;
            const focalY = (vh / 2 - touch.clientY) * 1.5;
            const clamped = clampOffset(nextScale, { x: focalX, y: focalY });
            setScale(nextScale);
            setPos(clamped);
          }
          return;
        }

        g.lastTapTime = now;
        g.lastTapPos = { x: touch.clientX, y: touch.clientY };
        g.startTouch = { x: touch.clientX, y: touch.clientY };
        g.startPos = { ...g.pos };
        setIsInteracting(true);

        if (g.scale > 1.05) {
          // 放大状态下：单指自由拖拽平移查看图片细节 (像相册一样全方位拖拽)
          g.isPanning = true;
          g.isSwipingDown = false;
        } else {
          // 1x 状态下：单指向下滑动退出预览
          g.isPanning = false;
          g.isSwipingDown = true;
          g.swipeY = 0;
        }
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      const g = gRef.current;
      if (e.touches.length === 2) {
        // 双手触控捏合缩放：以两指几何中心为锚点实时动态拉伸
        e.preventDefault();
        const currentDist = getTouchDist(e.touches[0], e.touches[1]);
        if (g.startDist <= 0) return;
        const ratio = currentDist / g.startDist;
        const nextScale = Math.min(8, Math.max(0.65, g.startScale * ratio));

        const currentMid = getTouchMid(e.touches[0], e.touches[1]);
        const midDeltaX = currentMid.x - g.startMidpoint.x;
        const midDeltaY = currentMid.y - g.startMidpoint.y;

        const nextPos = {
          x: g.startPos.x + midDeltaX,
          y: g.startPos.y + midDeltaY,
        };

        setScale(nextScale);
        setPos(nextPos);
      } else if (e.touches.length === 1) {
        const touch = e.touches[0];
        const dx = touch.clientX - g.startTouch.x;
        const dy = touch.clientY - g.startTouch.y;

        if (g.isPanning && g.scale > 1.05) {
          // 放大状态下查看细节：直接拖拽平移，带轻度弹性边界
          e.preventDefault();
          const targetPos = {
            x: g.startPos.x + dx,
            y: g.startPos.y + dy,
          };
          setPos(targetPos);
        } else if (g.isSwipingDown && dy > 0) {
          // 1x 下滑随手关闭
          e.preventDefault();
          g.swipeY = dy;
          setSwipingY(dy);
        }
      }
    };

    const onTouchEnd = () => {
      setIsInteracting(false);
      const g = gRef.current;

      // 1x 下滑超过 80px 触发关闭
      if (g.isSwipingDown && g.swipeY > 80) {
        onClose();
        return;
      }
      setSwipingY(0);

      // 缩放边界回弹与贴边校正
      if (g.scale < 1) {
        resetZoom();
      } else if (g.scale > 8) {
        setScale(8);
        setPos(clampOffset(8, g.pos));
      } else {
        setPos(clampOffset(g.scale, g.pos));
      }

      g.startDist = 0;
      g.isPanning = false;
      g.isSwipingDown = false;
    };

    // 鼠标滚轮平滑缩放
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsInteracting(true);
      const factor = e.deltaY > 0 ? 0.85 : 1.18;
      const nextScale = Math.min(8, Math.max(1, gRef.current.scale * factor));
      setScale(nextScale);
      if (nextScale <= 1.02) {
        resetZoom();
      } else {
        setPos(clampOffset(nextScale, gRef.current.pos));
      }
      setTimeout(() => setIsInteracting(false), 50);
    };

    container.addEventListener('touchstart', onTouchStart, { passive: false });
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    container.addEventListener('touchend', onTouchEnd, { passive: false });
    container.addEventListener('touchcancel', onTouchEnd, { passive: false });
    container.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
      container.removeEventListener('touchcancel', onTouchEnd);
      container.removeEventListener('wheel', onWheel);
    };
  }, [onClose, resetZoom]);

  // 桌面端鼠标拖拽平移查看细节
  const handleMouseDown = (e: MouseEvent) => {
    if (scale <= 1.05) return;
    e.preventDefault();
    const g = gRef.current;
    g.isMouseDown = true;
    g.mouseStart = { x: e.clientX, y: e.clientY };
    g.mouseStartPos = { ...pos };
    setIsInteracting(true);

    const onMouseMove = (ev: MouseEvent) => {
      if (!g.isMouseDown) return;
      const dx = ev.clientX - g.mouseStart.x;
      const dy = ev.clientY - g.mouseStart.y;
      setPos({
        x: g.mouseStartPos.x + dx,
        y: g.mouseStartPos.y + dy,
      });
    };

    const onMouseUp = () => {
      g.isMouseDown = false;
      setIsInteracting(false);
      setPos(clampOffset(gRef.current.scale, gRef.current.pos));
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const isZoomed = scale > 1.05;
  const opacity = swipingY > 0 ? Math.max(0.2, 1 - swipingY / 280) : 1;

  const content = (
    <div
      ref={containerRef}
      class={'img-lightbox' + (isZoomed ? ' is-zoomed' : '')}
      role="dialog"
      aria-modal="true"
      style={{
        zIndex: 99999,
        opacity,
      }}
      onClick={(e) => {
        // 菜单开着时，点空白只收菜单；再次点击才关灯箱。
        if (menu) {
          setMenu(null);
          return;
        }
        // 点击遮罩空白区域（非缩放/平移状态）直接关闭
        if (e.target === containerRef.current && scale <= 1.05) {
          onClose();
        }
      }}
    >
      {/* 左上角：当前张数 / 总数，快速确认自己在相册中的位置 */}
      {hasMultiple && (
        <div class="img-lightbox-counter" onClick={(e) => e.stopPropagation()}>
          {index + 1} / {gallery.length}
        </div>
      )}

      {/* 顶部常驻控制栏：1:1 复原按钮 + 复制 + 固定关闭按钮（永不随图片缩放而偏移跑掉） */}
      <div class="img-lightbox-topbar" onClick={(e) => e.stopPropagation()}>
        {isZoomed && (
          <button
            type="button"
            class="img-lightbox-reset-btn"
            onClick={resetZoom}
            title={t('preview.reset1x')}
          >
            {Math.round(scale * 100)}% · {t('preview.reset1x')}
          </button>
        )}
        <button
          type="button"
          class="img-lightbox-copy-btn"
          onClick={() => void copyCurrent()}
          title={t('preview.copyImage')}
          aria-label={t('preview.copyImage')}
          disabled={copying}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="9" y="9" width="11" height="11" rx="2.2" />
            <path d="M6 15H5.2A2.2 2.2 0 0 1 3 12.8V5.2A2.2 2.2 0 0 1 5.2 3h7.6A2.2 2.2 0 0 1 15 5.2V6" />
          </svg>
        </button>
        <button
          type="button"
          class="img-lightbox-close-fixed"
          onClick={onClose}
          title={t('preview.close')}
          aria-label={t('settings.close')}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* 图片舞台视口：绝对定位平滑渲染，支持 120fps 无延迟触屏跟随 */}
      <div
        class="img-lightbox-viewport"
        style={{
          transform: `translate3d(${pos.x}px, ${pos.y + swipingY}px, 0) scale(${scale})`,
          transition: isInteracting ? 'none' : 'transform 0.22s cubic-bezier(0.16, 1, 0.3, 1)',
          cursor: isZoomed ? (isInteracting ? 'grabbing' : 'grab') : 'zoom-in',
        }}
        onMouseDown={handleMouseDown}
        onContextMenu={openMenu}
        onDblClick={() => {
          if (scale > 1.05) resetZoom();
          else {
            setScale(2.5);
            setPos({ x: 0, y: 0 });
          }
        }}
      >
        <img
          ref={imgRef}
          class="img-lightbox-img"
          src={src}
          alt=""
          draggable={false}
        />
      </div>

      {/* 上一张 / 下一张：左右悬浮，手机与桌面都可点，到头循环 */}
      {hasMultiple && (
        <>
          <button
            type="button"
            class="img-lightbox-nav img-lightbox-nav-prev"
            onClick={(e) => {
              e.stopPropagation();
              go(-1);
            }}
            title={t('preview.prev')}
            aria-label={t('preview.prev')}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M15 5l-7 7 7 7" />
            </svg>
          </button>
          <button
            type="button"
            class="img-lightbox-nav img-lightbox-nav-next"
            onClick={(e) => {
              e.stopPropagation();
              go(1);
            }}
            title={t('preview.next')}
            aria-label={t('preview.next')}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </>
      )}

      {/* 底部友好提示栏：移动端显示双指缩放提示，桌面端显示滚轮提示 */}
      <div class="img-lightbox-hint" onClick={(e) => e.stopPropagation()}>
        <span class="lightbox-hint-mobile">{t('preview.mobilePinch')}</span>
        <span class="lightbox-hint-desktop">
          <kbd>Ctrl</kbd> + {t('preview.wheel')} · {t('preview.reset')}
        </span>
      </div>

      {/* 右键菜单：像 Windows 截图工具一样把当前图复制到剪贴板 */}
      {menu && (
        <div
          ref={menuRef}
          class="img-lightbox-menu"
          style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <button type="button" onClick={() => void copyCurrent()}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="9" y="9" width="11" height="11" rx="2.2" />
              <path d="M6 15H5.2A2.2 2.2 0 0 1 3 12.8V5.2A2.2 2.2 0 0 1 5.2 3h7.6A2.2 2.2 0 0 1 15 5.2V6" />
            </svg>
            {t('preview.copyImage')}
          </button>
        </div>
      )}
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(content, document.body) : content;
}

export function MsgImage({ img }: { img: ImageData }) {
  const src = imageDataUrl(img);
  // 所有图片统一交给 Chat 的全局灯箱：那里才有整个会话的图片画廊。
  return (
    <img
      class="msg-image"
      src={src}
      alt=""
      onClick={() => {
        window.dispatchEvent(new CustomEvent('jeikcode:preview:image', { detail: { src } }));
      }}
    />
  );
}

/** Build a displayable data URL from an ImageData. */
export function imageDataUrl(img: ImageData): string {
  return `data:${img.media_type};base64,${img.data}`;
}
