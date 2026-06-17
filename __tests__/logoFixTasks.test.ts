import { describe, expect, it } from 'vitest';
import {
  getLogoFixTaskImage,
  isLogoFixTaskCompleted,
  isLogoFixTaskTerminal,
  removeLogoFixActiveTaskId,
  shouldCancelLogoFixTask,
} from '../lib/logoFixTasks';

describe('logo fix task helpers', () => {
  it('treats completed logo fix tasks as terminal and not cancelable', () => {
    const task = {
      task_id: 'task-1',
      status: 'completed',
      result: { images: ['/static/images/fixed.png'] },
    };

    expect(isLogoFixTaskCompleted(task)).toBe(true);
    expect(isLogoFixTaskTerminal(task)).toBe(true);
    expect(shouldCancelLogoFixTask(task)).toBe(false);
    expect(getLogoFixTaskImage(task)).toBe('/static/images/fixed.png');
  });

  it('only allows cancelling non-terminal logo fix tasks', () => {
    expect(shouldCancelLogoFixTask({ task_id: 'task-2', status: 'running' })).toBe(true);
    expect(shouldCancelLogoFixTask({ task_id: 'task-3', status: 'pending' })).toBe(true);
    expect(shouldCancelLogoFixTask({ task_id: 'task-4', status: 'failed' })).toBe(false);
    expect(shouldCancelLogoFixTask({ task_id: 'task-5', status: 'cancelled' })).toBe(false);
  });

  it('removes completed task ids from the active cancel list', () => {
    expect(removeLogoFixActiveTaskId(['task-1', 'task-2', 'task-1'], 'task-1')).toEqual(['task-2']);
  });
});
