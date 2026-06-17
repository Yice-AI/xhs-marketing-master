export type LogoFixTaskSnapshot = {
  task_id?: string;
  status?: string;
  message?: string;
  error?: string;
  result?: {
    images?: unknown;
    [key: string]: unknown;
  } | null;
  metadata?: Record<string, unknown>;
};

const TERMINAL_LOGO_FIX_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export const normalizeLogoFixTaskStatus = (status: unknown) => (
  typeof status === 'string' ? status.trim().toLowerCase() : ''
);

export const getLogoFixTaskImage = (task: LogoFixTaskSnapshot | null | undefined) => {
  const images = task?.result?.images;
  if (!Array.isArray(images)) {
    return '';
  }
  const firstImage = images.find((image): image is string => typeof image === 'string' && image.trim().length > 0);
  return firstImage || '';
};

export const isLogoFixTaskCompleted = (task: LogoFixTaskSnapshot | null | undefined) => (
  normalizeLogoFixTaskStatus(task?.status) === 'completed'
);

export const isLogoFixTaskTerminal = (task: LogoFixTaskSnapshot | null | undefined) => (
  TERMINAL_LOGO_FIX_STATUSES.has(normalizeLogoFixTaskStatus(task?.status))
);

export const shouldCancelLogoFixTask = (task: LogoFixTaskSnapshot | null | undefined) => (
  !isLogoFixTaskTerminal(task)
);

export const removeLogoFixActiveTaskId = (taskIds: string[], taskId: string) => (
  taskIds.filter((currentTaskId) => currentTaskId !== taskId)
);
