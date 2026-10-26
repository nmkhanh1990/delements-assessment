const MIN_TOAST_DURATION_MS = 3000;
const MAX_TOAST_DURATION_MS = 5000;
const MESSAGE_LENGTH_FOR_MAX_DURATION = 120;

export function toastDurationFor(message: string): number {
  const duration =
    MIN_TOAST_DURATION_MS +
    (message.length / MESSAGE_LENGTH_FOR_MAX_DURATION) *
      (MAX_TOAST_DURATION_MS - MIN_TOAST_DURATION_MS);

  return Math.min(MAX_TOAST_DURATION_MS, duration);
}
