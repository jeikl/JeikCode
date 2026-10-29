/**
 * 画布内搜索的内容口径（Ctrl+F）。
 *
 * 这里维护一条铁律：**计数与渲染必须同源**。
 * 搜索框显示的 `1/N` 由 [`messageSearchableFullText`] 统计，页面上能否“看见”
 * 由各渲染组件（正文 / 思考块 / 工具行 / 通知 / 子任务）决定。两边一旦用不同的
 * 字段集合，就会出现用户报的两种症状：
 *  - 计数说命中，页面上找不到（工具输出被折叠、思考块收起、命中在参数里却不高亮）；
 *  - 页面看得见，却搜不到（渲染层多渲染了一个字段）。
 *
 * 因此：新增任何参与搜索的字段，都必须同时出现在这里和对应组件的渲染里。
 */

export type SearchableTool = {
  name?: string;
  args?: string;
  output?: string;
  progress?: string;
  subtasks?: Array<{ label?: string; activity?: string; description?: string }> | null;
};

export type SearchablePart = {
  kind: string;
  text?: string;
  tool?: SearchableTool;
};

export type SearchableMessage = { parts: SearchablePart[] };

/** 工具行参与搜索的全部文本：名称 / 参数 / 输出 / 进度 / 子任务。 */
export function toolSearchText(tool: SearchableTool): string {
  const pieces: string[] = [];
  if (tool.name) pieces.push(tool.name);
  if (tool.args) pieces.push(tool.args);
  if (tool.output) pieces.push(tool.output);
  if (tool.progress) pieces.push(tool.progress);
  for (const item of tool.subtasks ?? []) {
    if (item.label) pieces.push(item.label);
    if (item.activity) pieces.push(item.activity);
    if (item.description) pieces.push(item.description);
  }
  return pieces.join(' ');
}

/** 一条画布消息参与搜索的全部文本（统一小写，调用方按小写关键词比对）。 */
export function messageSearchableFullText(message: SearchableMessage): string {
  const parts: string[] = [];
  for (const part of message.parts) {
    if (part.kind === 'tool') {
      if (part.tool) parts.push(toolSearchText(part.tool));
      continue;
    }
    // text / reasoning / notice / rate_limited：渲染层都是原样（或高亮后）显示。
    if (typeof part.text === 'string' && part.text) parts.push(part.text);
  }
  return parts.join(' ').toLowerCase();
}

/** 规范化关键词：空字符串表示“未在搜索”。 */
export function normalizeSearchQuery(query: string | undefined): string {
  return (query ?? '').trim().toLowerCase();
}

/** 工具行是否命中当前关键词（决定搜索时是否强制展开）。 */
export function toolMatchesSearch(tool: SearchableTool, query: string): boolean {
  const needle = normalizeSearchQuery(query);
  if (!needle) return false;
  return toolSearchText(tool).toLowerCase().includes(needle);
}

/** 折叠块（思考 / 工具）是否必须因搜索而展开。 */
export function textMatchesSearch(text: string | undefined, query: string): boolean {
  const needle = normalizeSearchQuery(query);
  if (!needle || !text) return false;
  return text.toLowerCase().includes(needle);
}
