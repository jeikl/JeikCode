import { useState } from 'preact/hooks';
import { useT } from '../../settings';
import { todoCounts, type TodoItem } from '../../lib/todos';

/**
 * Todo panel — sticky above the composer (live turn) or embedded at the
 * bottom of a frozen assistant reply (after the user advanced).
 */
export function SessionTodoPanel({
  items,
  embedded = false,
}: {
  items: TodoItem[];
  embedded?: boolean;
}) {
  const t = useT();
  const { completed, inProgress, total } = todoCounts(items);
  // 默认展开以展示完整的多步骤任务树，不再因移动端窄屏默认收起导致误判为「只有单张卡片」
  const [collapsed, setCollapsed] = useState(false);

  const activeTask = items.find((i) => i.status === 'in_progress');

  return (
    <div
      class={'session-todo-panel' + (embedded ? ' is-embedded' : '') + (collapsed ? ' is-collapsed' : '')}
      role="region"
      aria-label={t('todo.panelTitle')}
    >
      <div
        class="session-todo-header"
        onClick={() => setCollapsed(!collapsed)}
        title={t(collapsed ? 'panel.expand' : 'panel.collapse')}
      >
        <span class="session-todo-collapse-icon" aria-hidden="true">
          {collapsed ? '▸' : '▾'}
        </span>
        <span class="session-todo-title">{t('todo.panelTitle')}</span>
        {collapsed && activeTask && (
          <span class="session-todo-active-snippet" title={activeTask.content}>
            • {activeTask.content}
          </span>
        )}
        <span class="session-todo-summary">
          {t('todo.summary', {
            done: String(completed),
            active: String(inProgress),
            total: String(total),
          })}
        </span>
      </div>
      {!collapsed && (
        <div class="session-todo-list">
          {items.map((item, i) => (
            <div class={'session-todo-row status-' + item.status} key={i}>
              <span class="session-todo-glyph" aria-hidden="true">
                {item.status === 'completed' ? '√' : item.status === 'in_progress' ? '•' : '○'}
              </span>
              <span class="session-todo-content">{item.content}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
