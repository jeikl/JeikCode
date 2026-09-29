import DOMPurify from 'dompurify';
import { useMemo } from 'preact/hooks';
import { markdownToHtml } from '../lib/markdownRender';

export { preprocessMarkdown, markdownToHtml } from '../lib/markdownRender';

function highlightHtml(html: string, search: string): string {
  if (!search.trim()) return html;
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const walk = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, null);
  const nodes: Text[] = [];
  let node: Node | null;
  while ((node = walk.nextNode())) {
    nodes.push(node as Text);
  }
  const searchLower = search.toLowerCase();
  for (const textNode of nodes) {
    const text = textNode.nodeValue ?? '';
    if (!text.toLowerCase().includes(searchLower)) continue;

    const parent = textNode.parentNode;
    if (!parent) continue;

    const parentTag = (parent as HTMLElement).tagName?.toLowerCase();
    if (parentTag === 'script' || parentTag === 'style') continue;

    const newFragment = doc.createDocumentFragment();
    let lastIndex = 0;
    let index = text.toLowerCase().indexOf(searchLower);
    while (index !== -1) {
      if (index > lastIndex) {
        newFragment.appendChild(doc.createTextNode(text.substring(lastIndex, index)));
      }
      const mark = doc.createElement('mark');
      mark.className = 'msg-search-highlight';
      mark.textContent = text.substring(index, index + search.length);
      newFragment.appendChild(mark);
      lastIndex = index + search.length;
      index = text.toLowerCase().indexOf(searchLower, lastIndex);
    }
    if (lastIndex < text.length) {
      newFragment.appendChild(doc.createTextNode(text.substring(lastIndex)));
    }
    parent.replaceChild(newFragment, textNode);
  }
  return doc.body.innerHTML;
}

export function Markdown({ content, search }: { content: string; search?: string }) {
  const html = useMemo(() => {
    const raw = markdownToHtml(content ?? '');
    // SECURITY: model output is untrusted — sanitize before injecting as HTML.
    const sanitized = DOMPurify.sanitize(raw, {
      ADD_TAGS: ['math', 'annotation', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'ms', 'mtext', 'mspace', 'mfrac', 'msqrt', 'mroot', 'msub', 'msup', 'msubsup', 'munder', 'mover', 'munderover', 'mtable', 'mtr', 'mtd', 'mstyle'],
      ADD_ATTR: ['id', 'data-alt-id', 'data-copy', 'class', 'checked', 'disabled', 'type', 'align', 'start', 'colspan', 'rowspan', 'style', 'aria-hidden', 'encoding', 'target', 'rel'],
    });
    if (search && search.trim()) {
      return highlightHtml(sanitized, search);
    }
    return sanitized;
  }, [content, search]);

  function onClick(e: MouseEvent) {
    const targetEl = e.target as HTMLElement;

    // 1. 处理内部锚点平滑跳转（如 [中文更新日志](#-中文更新日志-chinese)）
    const anchor = targetEl?.closest('a[href^="#"]') as HTMLAnchorElement | null;
    if (anchor) {
      const rawHash = anchor.getAttribute('href')?.slice(1);
      if (rawHash) {
        e.preventDefault();
        const hash = decodeURIComponent(rawHash);
        const altHash = hash.startsWith('-') ? hash.slice(1) : `-${hash}`;
        const container = (e.currentTarget as HTMLElement)?.closest('.messages-container') || document;
        let target = container.querySelector(`[id="${CSS.escape(hash)}"]`) ||
          container.querySelector(`[id="${CSS.escape(altHash)}"]`) ||
          container.querySelector(`[data-alt-id="${CSS.escape(hash)}"]`) ||
          container.querySelector(`[data-alt-id="${CSS.escape(altHash)}"]`);
        if (!target && container !== document) {
          target = document.querySelector(`[id="${CSS.escape(hash)}"]`) ||
            document.querySelector(`[id="${CSS.escape(altHash)}"]`);
        }
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }
      return;
    }

    // 2. 处理代码块 Copy 按钮
    const t = targetEl?.closest('.copy-button') as HTMLElement | null;
    if (t?.dataset.copy) {
      const text = decodeURIComponent(t.dataset.copy);
      const prev = t.textContent;
      const mark = (ok: boolean) => {
        t.textContent = ok ? 'Copied' : 'Failed';
        setTimeout(() => {
          t.textContent = prev;
        }, 1200);
      };
      void (async () => {
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            mark(true);
            return;
          }
        } catch {
          /* fall through */
        }
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand('copy');
          document.body.removeChild(ta);
          mark(ok);
        } catch {
          mark(false);
        }
      })();
    }
  }

  return (
    <div
      class="markdown-root assistant-message-content"
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
