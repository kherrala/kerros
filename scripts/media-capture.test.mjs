import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleChapters } from './media-capture.mjs';

test('samples timestamps, holds static frames, and excludes setup gaps', () => {
  const frames = [0, 1, 1.5, 2, 3, 4].map(time => ({ time, file: `${time}.png` }));
  const result = sampleChapters(frames, [
    { start: 1, end: 2, speed: 1, label: 'First' },
    { start: 3, end: 5, speed: 2, label: 'Second' },
  ], 4);
  assert.deepEqual(result.selected, ['1.png', '1.png', '1.5.png', '1.5.png', '3.png', '3.png', '4.png', '4.png']);
  assert.deepEqual(result.chapters, [
    { start: 0, end: 1, label: 'First' },
    { start: 1, end: 2, label: 'Second' },
  ]);
  assert.equal(result.duration, 2);
});

test('caption boundaries follow the encoded 30 fps frame count', () => {
  const result = sampleChapters([{ time: 0, file: 'still.png' }], [
    { start: 0, end: 0.045, speed: 1, label: 'First' },
    { start: 1, end: 1.075, speed: 1, label: 'Second' },
  ]);
  assert.equal(result.selected.length, 3);
  assert.equal(result.chapters[0].end, 1 / 30);
  assert.equal(result.chapters[1].start, 1 / 30);
  assert.equal(result.chapters[1].end, 3 / 30);
  assert.equal(result.duration, 3 / 30);
});

test('rejects unusable capture parameters', () => {
  const frames = [{ time: 0, file: 'still.png' }];
  const phase = { start: 0, end: 1, speed: 1, label: 'Valid' };
  assert.throws(() => sampleChapters([], [phase]));
  assert.throws(() => sampleChapters(frames, []));
  assert.throws(() => sampleChapters(frames, [phase], 0));
  assert.throws(() => sampleChapters(frames, [{ ...phase, speed: 0 }]));
  assert.throws(() => sampleChapters(frames, [{ ...phase, end: 0 }]));
});
