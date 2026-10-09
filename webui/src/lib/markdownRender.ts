import { marked } from 'marked';
import {
  normalizeCodeLanguage,
  preprocessMarkdown,
  shouldShowCodeLanguage,
  stripLanguageSentinel,
} from './markdownPrep.ts';
import { extractMath, restoreMath } from './markdownMath.ts';

export { preprocessMarkdown } from './markdownPrep.ts';

marked.setOptions({ gfm: true, breaks: false });

// 关闭 GFM 单/双波浪号删除线：模型输出里 `~` 多是字面量（步骤区间 `1~3`、路径
// `~/projects`），而非删除线。开着的话 `步骤 1~3 …继续执行 4~7` 会被当成
// `1<del>3 …4</del>7`，吃掉波浪号且整段加删除线，与 TUI 显示不一致（issue #825）。
marked.use({ tokenizer: { del: () => undefined } });

// 禁用 4 空格缩进代码块（Indented Code Block）：在聊天气泡/模型输出场景中，
// 代码块统一使用围栏代码块（```）。模型输出的多级缩进列表或段落容易被误当成缩进代码块，
// 进而被错误渲染成带 Copy 按钮的冗余代码框。将 indented code 还原为普通文本段落。
marked.use({
  walkTokens(token) {
    if (token.type === 'code' && (token as any).codeBlockStyle === 'indented') {
      token.type = 'paragraph';
      (token as any).tokens = [{ type: 'text', raw: token.text, text: token.text }];
    }
  },
});

const renderer = new marked.Renderer();

export function slugifyHeading(text: string): string {
  const plain = (text ?? '').replace(/<[^>]*>/g, '');
  return plain
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s+/g, '-');
}

renderer.heading = function (text: string, level: number, raw?: string) {
  const plain = (raw || text || '').replace(/<[^>]*>/g, '');
  const slug = slugifyHeading(plain);
  const idAttr = slug ? ` id="${slug}"` : '';
  const altSlug = slug.startsWith('-') ? slug.replace(/^-+/, '') : `-${slug}`;
  const dataAlt = altSlug && altSlug !== slug ? ` data-alt-id="${altSlug}"` : '';
  return `<h${level}${idAttr}${dataAlt}>${text}</h${level}>\n`;
};

const ALERT_TITLES: Record<string, string> = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
};

renderer.blockquote = function (quote: string) {
  const kindMatch = quote.match(
    /^\s*<p>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*/i,
  );
  if (!kindMatch) return `<blockquote>${quote}</blockquote>\n`;
  const kind = kindMatch[1].toLowerCase();
  let body = quote.replace(
    /^\s*<p>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*/i,
    '<p>',
  );
  body = body.replace(/^\s*<p>\s*<\/p>\s*/, '');
  body = body.replace(/^\s*<p>\s+/, '<p>');
  const title = ALERT_TITLES[kind] ?? kindMatch[1];
  return (
    `<blockquote class="md-alert md-alert-${kind}">` +
    `<p class="md-alert-title">${title}</p>${body}</blockquote>\n`
  );
};

renderer.code = function (code: string, infostring?: string) {
  let text = code ?? '';
  if (!text.trim()) return '';
  const rawLang = (infostring ?? '').split(/\s+/)[0]?.toLowerCase() ?? '';
  const isStreamingMermaid = rawLang === 'mermaid-streaming';
  const lang = isStreamingMermaid ? 'mermaid' : rawLang;
  const normalizedLang = normalizeCodeLanguage(lang);
  text = stripLanguageSentinel(text, lang);
  if (!text.trim()) return '';

  // 拦截已闭合的完整 mermaid 代码块，转为现代化交互矢量图挂载节点。
  // 流式生成中尚未闭合的代码块保持普通代码块呈现，彻底避免语法未闭合导致的“MD与图表来回闪烁”
  if (lang === 'mermaid' && !isStreamingMermaid) {
    const encoded = encodeURIComponent(text);
    return `<div class="mermaid-diagram-mount" data-mermaid-code="${encoded}"></div>\n`;
  }

  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const showLang = shouldShowCodeLanguage(lang);
  const langLabel = showLang
    ? `<span class="code-block-lang">${lang.replace(/[<>&"]/g, '')}</span>`
    : '<span class="code-block-lang"></span>';
  return (
    `<div class="code-block-wrapper${showLang ? ' has-language' : ''}">` +
    `<div class="code-block-toolbar">${langLabel}` +
    `<button class="copy-button" type="button" data-copy="${encodeURIComponent(text)}">Copy</button>` +
    `</div>` +
    `<pre><code class="${normalizedLang ? `language-${normalizedLang}` : ''}">${esc}</code></pre>` +
    `</div>`
  );
};

renderer.link = function (href: string, title: string | null | undefined, text: string) {
  const titleAttr = title ? ` title="${title}"` : '';
  const cleanHref = href ?? '';
  if (cleanHref.startsWith('#')) {
    return `<a href="${cleanHref}"${titleAttr}>${text}</a>`;
  }
  return `<a href="${cleanHref}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`;
};

export function markdownToHtml(content: string): string {
  const extracted = extractMath(content ?? '');
  const preprocessed = preprocessMarkdown(extracted.text);
  const html = marked.parse(preprocessed, { renderer }) as string;
  return restoreMath(html, extracted.slots);
}
