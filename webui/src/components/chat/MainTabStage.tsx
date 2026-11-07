import { Suspense, lazy } from 'preact/compat';
import { useT } from '../../settings';
import { mainEditorStateKey } from '../../lib/editorTabState';
import type { OpenDiffTab } from '../../lib/openDiffTab';
import { CodeEditorTab } from '../CodeEditorTab';

const DiffViewer = lazy(() => import('../DiffViewer').then((m) => ({ default: m.DiffViewer })));

export function MainTabStage({
  tabs,
  activeTabId,
  cwd,
  onCloseTab,
}: {
  tabs: OpenDiffTab[];
  activeTabId: string;
  cwd?: string;
  onCloseTab?: (id: string) => void;
}) {
  const t = useT();
  const currentDiffTab = tabs.find((tab) => tab.id === activeTabId);
  return (
    <>
      {tabs.map((tab) => {
        if (tab.type !== 'editor') return null;
        const isActiveEditorTab = activeTabId === tab.id;
        return (
          <div
            key={tab.id}
            class="vscode-diff-view-stage"
            style={{ display: isActiveEditorTab ? 'flex' : 'none' }}
          >
            <CodeEditorTab
              key={tab.id}
              filePath={tab.filePath}
              cwd={cwd}
              startLine={tab.startLine}
              endLine={tab.endLine}
              stateKey={mainEditorStateKey(tab.filePath)}
              active={isActiveEditorTab}
              onClose={() => onCloseTab?.(tab.id)}
            />
          </div>
        );
      })}

      {activeTabId !== 'chat' && currentDiffTab && currentDiffTab.type !== 'editor' && (
        <div class="vscode-diff-view-stage">
          {currentDiffTab.loading ? (
            <div class="diff-loading-wrap">
              <div class="git-spinner" />
              <span>{t('git.loading')}</span>
            </div>
          ) : (
            <Suspense
              fallback={
                <div class="diff-loading-wrap">
                  <div class="git-spinner" />
                  <span>{t('git.loading')}</span>
                </div>
              }
            >
              <DiffViewer
                diffText={currentDiffTab.diffText}
                filePath={currentDiffTab.filePath}
                commitHash={currentDiffTab.commitHash}
                commitMessage={currentDiffTab.commitMessage}
              />
            </Suspense>
          )}
        </div>
      )}
    </>
  );
}
