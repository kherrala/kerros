import { expect, it, vi } from 'vitest';
import { ProjectWriter } from './useProjectPersistence';
import { newProject } from '../model/testFixtures';
import type { ProjectRepository } from '../model/types';

it('serializes asynchronous saves and retains the snapshot captured when queued', async () => {
  let release!: () => void;
  const firstPending = new Promise<void>(resolve => {
    release = resolve;
  });
  const save = vi
    .fn()
    .mockImplementationOnce(() => firstPending)
    .mockResolvedValue(undefined);
  const writer = new ProjectWriter({ save } as unknown as ProjectRepository);
  const project = newProject('First');
  const first = writer.save(project);
  project.name = 'Second';
  const second = writer.save(project);
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0][0].name).toBe('First');
  release();
  await first;
  await second;
  expect(save.mock.calls[1][0].name).toBe('Second');
});

it('allows retrying after a failed save', async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error('quota')).mockResolvedValue(undefined);
  const writer = new ProjectWriter({ save } as unknown as ProjectRepository);
  await expect(writer.save(newProject())).rejects.toThrow('quota');
  await expect(writer.save(newProject())).resolves.toBeUndefined();
  expect(save).toHaveBeenCalledTimes(2);
});
