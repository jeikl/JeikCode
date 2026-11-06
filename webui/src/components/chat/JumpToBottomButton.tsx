import { useT } from '../../settings';

export function JumpToBottomButton({
  visible,
  busy,
  onClick,
}: {
  visible: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  const t = useT();
  if (!visible) return null;
  return (
    <button
      type="button"
      class={'jump-to-bottom' + (busy ? ' is-streaming' : '')}
      onClick={onClick}
      title={t('chat.jumpToBottom')}
      aria-label={t('chat.jumpToBottom')}
    >
      <span class="jump-to-bottom-arrow" aria-hidden="true">↓</span>
    </button>
  );
}
