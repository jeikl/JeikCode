import { useT } from '../../settings';
import type { PendingAttach } from '../../lib/attachments';
import { MsgImage } from './ImageLightbox';

export function AttachmentTray({
  attach,
  onRemove,
}: {
  attach: PendingAttach[];
  onRemove: (id: string) => void;
}) {
  const t = useT();
  if (attach.length === 0) return null;
  return (
    <div class="input-thumbs">
      {attach.map((item) => (
        <div key={item.id} class={'input-thumb' + (item.kind === 'file' ? ' input-thumb-file' : '')}>
          {item.kind === 'image' ? (
            <MsgImage img={item.image} />
          ) : (
            <>
              <span class="input-thumb-file-icon" aria-hidden="true">📄</span>
              <span class="input-thumb-file-name" title={item.name}>{item.name}</span>
            </>
          )}
          <button
            class="input-thumb-remove"
            onClick={() => onRemove(item.id)}
            title={item.kind === 'image' ? t('attach.removeImage') : t('attach.removeFile')}
            aria-label={item.kind === 'image' ? t('attach.removeImage') : t('attach.removeFile')}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
