interface CopyFeedbackOptions {
  copyText: (text: string) => Promise<boolean>;
  onCopied: (copied: boolean) => void;
  onError: () => void;
  schedule: (callback: () => void, delay: number) => number;
  cancel: (timer: number) => void;
}

/** Phản hồi copy độc lập UI, chặn kết quả async đã hết vòng đời. */
export function createCopyFeedbackController(options: CopyFeedbackOptions) {
  let disposed = false;
  let generation = 0;
  let timer: number | undefined;

  const clearTimer = () => {
    if (timer !== undefined) options.cancel(timer);
    timer = undefined;
  };

  return {
    async copy(text: string): Promise<void> {
      if (disposed || !text) return;
      const attempt = ++generation;
      let ok = false;
      try {
        ok = await options.copyText(text);
      } catch {
        // Bắt cả lỗi ngoài dự kiến từ clipboard để tránh promise bị reject không xử lý.
      }
      if (disposed || attempt !== generation) return;
      if (!ok) {
        options.onError();
        return;
      }
      clearTimer();
      options.onCopied(true);
      timer = options.schedule(() => {
        timer = undefined;
        if (!disposed) options.onCopied(false);
      }, 1200);
    },
    reset() {
      if (disposed) return;
      ++generation;
      clearTimer();
      options.onCopied(false);
    },
    dispose() {
      disposed = true;
      ++generation;
      clearTimer();
    },
  };
}
