import { expect, it } from 'vitest';
import { BACKROOMS_ID, currentDemoId, SILO_ID, STOCKMANN_ID } from './ids';

it('resolves fixed current and obsolete sample links without generating buildings', () => {
  for (const id of ['sample-backrooms-v1', BACKROOMS_ID]) expect(currentDemoId(id)).toBe(BACKROOMS_ID);
  expect(currentDemoId('demo-campus-1')).toBe(STOCKMANN_ID);
  expect(currentDemoId('demo-silo-1')).toBe(SILO_ID);
  for (const id of ['my-building', `${BACKROOMS_ID}-custom-32`, 'demo-campus-abc'])
    expect(currentDemoId(id)).toBeNull();
});
