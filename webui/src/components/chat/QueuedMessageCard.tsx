import { useT } from '../../settings';
import type { QueuedMessage } from '../../lib/queuedMessage';
import { QueuedCardActions } from '../QueuedCardActions';
import { MsgImage } from './ImageLightbox';

export function QueuedMessageCard({
  q,
  focusCardId,
  onAutoFocusDone,
  onSteer,
  onSendNow,
  onCancel,
  onReturnToComposer,
}: {
  q: QueuedMessage;
  focusCardId: number | null;
  onAutoFocusDone: () => void;
  onSteer: () => void;
  onSendNow: () => void;
  onCancel: () => void;
  onReturnToComposer: (typedChar?: string) => void;
}) {
  const t = useT();
  return (
    <div class="user-message-wrapper queued">
      <div class="user-message-bubble queued-bubble">
        {q.images && q.images.length > 0 && (
          <div class="msg-images">
            {q.images.map((img, i) => (
              <MsgImage key={i} img={img} />
            ))}
          </div>
        )}
        <div class="queued-head">
          <span class="queued-tag">
            {q.kind === 'steer'
              ? t('chat.steered')
              : q.kind === 'steering'
                ? t('chat.steering')
                : t('chat.queued')}
          </span>
        </div>
        <div class="queued-text-content">{q.text}</div>
        <QueuedCardActions
          cardId={q.id}
          kind={q.kind}
          labels={{
            steer: t('chat.steerAction'),
            sendNow: t('chat.sendNow'),
            cancel: t('chat.cancelAction'),
            steerTitle: t('chat.steerQueued'),
            sendNowTitle: t('chat.sendNowTitle'),
            cancelTitle: t('chat.removeQueued'),
            groupTitle: t('chat.queuedCardActions'),
          }}
          autoFocus={q.id === focusCardId}
          onAutoFocusDone={onAutoFocusDone}
          onSteer={onSteer}
          onSendNow={onSendNow}
          onCancel={onCancel}
          onReturnToComposer={onReturnToComposer}
        />
      </div>
    </div>
  );
}
