import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { copyTextToClipboard } from './clipboard';
import { createCopyFeedbackController } from './copyFeedback';

/** Dùng chung phản hồi copy; component giữ nhãn và thuộc tính accessibility riêng. */
export function useCopyFeedback(onError: () => void) {
  const [copied, setCopied] = useState(false);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const controllerRef = useRef<ReturnType<typeof createCopyFeedbackController> | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createCopyFeedbackController({
      copyText: copyTextToClipboard,
      onCopied: setCopied,
      onError: () => errorRef.current(),
      schedule: (callback, delay) => window.setTimeout(callback, delay),
      cancel: (timer) => window.clearTimeout(timer),
    });
  }
  const controller = controllerRef.current;
  useLayoutEffect(() => () => controller.dispose(), [controller]);

  const handleCopy = (event: Pick<MouseEvent, 'stopPropagation'>, text: string) => {
    event.stopPropagation();
    void controller.copy(text);
  };
  return { copied, handleCopy };
}
