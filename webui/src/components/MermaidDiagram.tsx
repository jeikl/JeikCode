import { useT } from '../settings';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
import {
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Maximize2,
  Minimize2,
  Copy,
  Check,
  Code2,
  Eye,
  Download,
  AlertTriangle,
} from 'lucide-react';

interface MermaidDiagramProps {
  code: string;
  isDark?: boolean;
}

// 全局 SVG 渲染缓存，避免流式后续文本输出或会话切换触发二次重复渲染与闪烁
const svgRenderCache = new Map<string, string>();

// 动态单例加载官方 mermaid 核心
let mermaidPromise: Promise<any> | null = null;
function getMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => {
      const instance = m.default || m;
      instance.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        fontFamily: 'var(--app-sans-font-family, ui-sans-serif, sans-serif)',
        logLevel: 'error',
      });
      return instance;
    });
  }
  return mermaidPromise;
}

export function MermaidDiagram({ code, isDark = false }: MermaidDiagramProps) {
  const t = useT();
  const cleanCode = code.trim();
  const cacheKey = `${isDark ? 'dark' : 'light'}:${cleanCode}`;
  const cachedSvg = svgRenderCache.get(cacheKey) || '';

  const [svgContent, setSvgContent] = useState<string>(cachedSvg);
  const [loading, setLoading] = useState<boolean>(!cachedSvg && !!cleanCode);
  const [error, setError] = useState<string | null>(null);
  const [showCode, setShowCode] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [isCopied, setIsCopied] = useState<boolean>(false);

  // 渲染 Mermaid 图表
  useEffect(() => {
    let canceled = false;
    const clean = code.trim();
    if (!clean) {
      setSvgContent('');
      setLoading(false);
      setError(null);
      return;
    }

    const key = `${isDark ? 'dark' : 'light'}:${clean}`;
    if (svgRenderCache.has(key)) {
      setSvgContent(svgRenderCache.get(key)!);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);

    // 160ms 防抖，过滤连续快速变动或流式微小片段
    const timer = setTimeout(() => {
      getMermaid()
        .then(async (mermaid) => {
          if (canceled) return;
          mermaid.initialize({
            theme: isDark ? 'dark' : 'neutral',
            themeVariables: isDark
              ? {
                  background: '#131314',
                  primaryColor: '#282a2c',
                  primaryTextColor: '#e3e3e3',
                  primaryBorderColor: 'rgba(255, 255, 255, 0.16)',
                  lineColor: '#60a5fa',
                  secondaryColor: '#1e1f20',
                  tertiaryColor: '#282a2c',
                  fontFamily: 'var(--app-sans-font-family)',
                }
              : {
                  background: '#f8f9fb',
                  primaryColor: '#f1f3f6',
                  primaryTextColor: '#1f2328',
                  primaryBorderColor: 'rgba(0, 0, 0, 0.12)',
                  lineColor: '#2563eb',
                  secondaryColor: '#ffffff',
                  tertiaryColor: '#f8f9fb',
                  fontFamily: 'var(--app-sans-font-family)',
                },
          });

          const id = 'mermaid-svg-' + Math.random().toString(36).substring(2, 9);
          try {
            const { svg } = await mermaid.render(id, clean);
            if (!canceled) {
              svgRenderCache.set(key, svg);
              setSvgContent(svg);
              setLoading(false);
              setError(null);
            }
          } catch (err: any) {
            // 清理 mermaid 错误可能遗留在 document.body 的临时节点
            const strayEl = document.getElementById(id) || document.getElementById('d' + id);
            if (strayEl) {
              strayEl.remove();
            }
            if (!canceled) {
              setLoading(false);
              // 关键容灾防线：如果已有成功渲染的 SVG，保留原图表，绝不闪退到报错代码块造成跳跃闪烁
              if (!svgContent) {
                console.warn('[MermaidDiagram] syntax or parse error:', err?.message || err);
                setError(err?.message || 'Diagram syntax error');
              }
            }
          }
        })
        .catch((err) => {
          if (!canceled) {
            setLoading(false);
            if (!svgContent) {
              setError(err?.message || 'Failed to initialize Mermaid');
            }
          }
        });
    }, 160);

    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [code, isDark]);

  // 复制 Mermaid 源代码
  const handleCopyCode = useCallback(() => {
    navigator.clipboard?.writeText(code).then(() => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 1400);
    });
  }, [code]);

  // 导出下载 SVG 矢量文件
  const handleDownloadSvg = useCallback(() => {
    if (!svgContent) return;
    const blob = new Blob([svgContent], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mermaid-diagram-${Date.now()}.svg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [svgContent]);

  // 监听全屏模式下的 Escape 键退出
  useEffect(() => {
    if (!isFullscreen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsFullscreen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isFullscreen]);

  return (
    <div
      class={
        'mermaid-wrapper' +
        (isFullscreen ? ' is-fullscreen' : '') +
        (error && !svgContent ? ' has-error' : '')
      }
    >
      <TransformWrapper
        initialScale={1}
        minScale={0.35}
        maxScale={4}
        centerOnInit={true}
        limitToBounds={false}
        smooth={true}
        wheel={{
          step: 0.0008,
          wheelDisabled: false,
        }}
        pinch={{ step: 5 }}
        panning={{ velocityDisabled: true }}
      >
        {({ zoomIn, zoomOut, resetTransform }: any) => (
          <>
            {/* 头部毛玻璃悬浮操作栏 / Floating Action Pill */}
            <div class="mermaid-toolbar">
              <div class="mermaid-badge">
                <span class="mermaid-badge-dot" />
                <span class="mermaid-badge-text">{t('diagram.title')}</span>
              </div>

              <div class="mermaid-actions">
                {/* 切换代码与图表 */}
                <button
                  type="button"
                  class={'mermaid-btn' + (showCode ? ' is-active' : '')}
                  onClick={() => setShowCode(!showCode)}
                  title={showCode ? t('diagram.view') : t('diagram.code')}
                  aria-label={showCode ? t('diagram.view') : t('diagram.code')}
                >
                  {showCode ? <Eye size={13} /> : <Code2 size={13} />}
                  <span class="mermaid-btn-label">{showCode ? t('diagram.label') : t('common.code')}</span>
                </button>

                {!showCode && !error && svgContent && (
                  <>
                    {/* 放大 */}
                    <button
                      type="button"
                      class="mermaid-btn"
                      onClick={() => zoomIn(0.2)}
                      title={t('common.zoomIn')}
                      aria-label={t('common.zoomIn')}
                    >
                      <ZoomIn size={13} />
                    </button>

                    {/* 缩小 */}
                    <button
                      type="button"
                      class="mermaid-btn"
                      onClick={() => zoomOut(0.2)}
                      title={t('common.zoomOut')}
                      aria-label={t('common.zoomOut')}
                    >
                      <ZoomOut size={13} />
                    </button>

                    {/* 重置 */}
                    <button
                      type="button"
                      class="mermaid-btn"
                      onClick={() => resetTransform()}
                      title={t('diagram.reset')}
                      aria-label={t('diagram.reset')}
                    >
                      <RotateCcw size={13} />
                    </button>

                    {/* 全屏切换 */}
                    <button
                      type="button"
                      class={'mermaid-btn' + (isFullscreen ? ' is-active' : '')}
                      onClick={() => {
                        setIsFullscreen(!isFullscreen);
                        resetTransform();
                      }}
                      title={isFullscreen ? t('diagram.exitFullscreen') : t('diagram.fullscreen')}
                      aria-label={isFullscreen ? t('diagram.exitFullscreen') : t('diagram.fullscreen')}
                    >
                      {isFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                    </button>

                    {/* 下载 SVG 矢量 */}
                    <button
                      type="button"
                      class="mermaid-btn"
                      onClick={handleDownloadSvg}
                      title={t('diagram.download')}
                      aria-label={t('diagram.download')}
                    >
                      <Download size={13} />
                    </button>
                  </>
                )}

                {/* 复制源码 */}
                <button
                  type="button"
                  class="mermaid-btn"
                  onClick={handleCopyCode}
                  title={t('diagram.copy')}
                  aria-label={t('diagram.copy')}
                >
                  {isCopied ? <Check size={13} class="text-green" /> : <Copy size={13} />}
                  {isCopied && <span class="mermaid-copied-hint">{t('copy.copied')}</span>}
                </button>
              </div>
            </div>

            {/* 主视图区域 (带 Subtle Grid 背景) */}
            <div class="mermaid-viewport">
              {showCode ? (
                /* 代码模式 */
                <div class="mermaid-code-view">
                  <pre class="mermaid-code-pre">
                    <code>{code}</code>
                  </pre>
                </div>
              ) : error && !svgContent ? (
                /* 语法错误容灾视图（仅在没有有效图表可展示时降级） */
                <div class="mermaid-error-fallback">
                  <div class="mermaid-error-banner">
                    <AlertTriangle size={14} />
                    <span>{t('diagram.parsing')}</span>
                  </div>
                  <pre class="mermaid-code-pre is-fallback">
                    <code>{code}</code>
                  </pre>
                </div>
              ) : loading && !svgContent ? (
                /* 加载中骨架屏（仅在无缓存初次加载时展示） */
                <div class="mermaid-loading-state">
                  <span class="mermaid-spinner" />
                  <span>{t('diagram.drawing')}</span>
                </div>
              ) : (
                /* 交互式平移缩放渲染区 */
                <TransformComponent
                  wrapperClass="mermaid-transform-wrapper"
                  contentClass="mermaid-transform-content"
                >
                  <div
                    class="mermaid-svg-render-root"
                    dangerouslySetInnerHTML={{ __html: svgContent }}
                  />
                </TransformComponent>
              )}
            </div>

            {/* 底部轻量交互指引 */}
            {!showCode && svgContent && (
              <div class="mermaid-footer-hint">
                <span>{t('diagram.hint')}</span>
              </div>
            )}
          </>
        )}
      </TransformWrapper>
    </div>
  );
}
