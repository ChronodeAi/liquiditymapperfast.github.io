import test from 'node:test';
import assert from 'node:assert/strict';
import { GIF_FPS, GIF_LIMIT, GIF_SECONDS, GIF_TOLERANCE, PLAN_SHARE, adaptRate, estimateBytes, planGif } from '../src/app/screenshot/gif-budget.ts';

test('the limit is 15 MB counted the smaller way', () => {
  assert.equal(GIF_LIMIT, 15_000_000);
  assert.ok(GIF_LIMIT <= 15 * 1024 * 1024);
  assert.deepEqual([GIF_SECONDS.min, GIF_SECONDS.max], [1, 15]);
  assert.ok(GIF_SECONDS.start >= GIF_SECONDS.min && GIF_SECONDS.start <= GIF_SECONDS.max);
});

test('an area of a few hundred pixels keeps 30 frames a second at full size', () => {
  const plan = planGif(400, 300, 5, 1);
  assert.equal(plan.fps, 30);
  assert.equal(plan.scale, 1);
  assert.deepEqual([plan.width, plan.height], [400, 300]);
  assert.ok(!plan.tight);
  assert.equal(planGif(300, 200, 15, 1).fps, 30, 'even for the longest recording');
});

test('a sharp screen gets its extra pixels when they fit, and gives them up before the frame rate', () => {
  const small = planGif(300, 200, 5, 2);
  assert.equal(small.scale, 2); assert.equal(small.fps, 30);
  const larger = planGif(600, 400, 10, 2);
  assert.ok(larger.scale <= 1 || larger.fps >= 25, `${larger.scale} at ${larger.fps} fps`);
  assert.ok(planGif(300, 200, 5, 3).scale <= 2, 'never more than two GIF pixels a CSS pixel');
});

test('no plan is estimated over its share of the limit, whatever the area and length', () => {
  for (const [w, h] of [[120, 80], [400, 300], [800, 500], [1280, 720], [1600, 1000], [1920, 1080], [2560, 1440]] as const) {
    for (let seconds = GIF_SECONDS.min; seconds <= GIF_SECONDS.max; seconds++) {
      for (const dpr of [1, 1.5, 2, 3]) {
        const plan = planGif(w, h, seconds, dpr);
        assert.ok(GIF_FPS.includes(plan.fps), `${plan.fps} fps`);
        assert.ok(plan.fps >= 10 && plan.fps <= 30);
        assert.ok(Math.max(plan.width, plan.height) <= 1920, 'at most 1920 px on the long side');
        assert.equal(plan.estimate, estimateBytes(plan.width, plan.height, seconds, plan.fps, plan.colors));
        assert.ok(plan.estimate <= GIF_LIMIT * PLAN_SHARE || plan.scale <= 0.25, `${w}x${h} ${seconds}s @${dpr}: ${plan.estimate} at scale ${plan.scale}`);
      }
    }
  }
});

test('the whole page for 15 seconds is planned smaller and slower, and still under the limit', () => {
  const plan = planGif(1600, 1000, 15, 1);
  assert.ok(plan.fps >= 10 && plan.fps <= 15, `${plan.fps} fps`);
  assert.ok(plan.scale < 1, `scale ${plan.scale}`);
  assert.ok(plan.estimate <= GIF_LIMIT * PLAN_SHARE);
});

test('a longer recording never gets a larger or faster plan', () => {
  for (const [w, h, dpr] of [[500, 350, 1], [900, 600, 2], [1600, 1000, 1]] as const) {
    let last = planGif(w, h, GIF_SECONDS.min, dpr);
    for (let s = GIF_SECONDS.min + 1; s <= GIF_SECONDS.max; s++) {
      const plan = planGif(w, h, s, dpr);
      assert.ok(plan.scale <= last.scale && (plan.scale < last.scale || plan.fps <= last.fps), `${w}x${h} at ${s}s: ${plan.scale}/${plan.fps} after ${last.scale}/${last.fps}`);
      last = plan;
    }
  }
});

test('while recording, small changes are let go first and then the frame rate halves, when the bytes so far would pass the limit', () => {
  const start = { fps: 30, tolerance: GIF_TOLERANCE.start }, raised = { fps: 30, tolerance: GIF_TOLERANCE.raised };
  assert.equal(planGif(400, 300, 5).tolerance, GIF_TOLERANCE.start, 'a plan starts with the small tolerance');
  assert.deepEqual(adaptRate(500_000, 200_000, 2000, 10_000, start), start, 'on course');
  assert.deepEqual(adaptRate(4_000_000, 200_000, 2000, 10_000, start), raised, '19 MB at this rate: the tolerance first');
  assert.deepEqual(adaptRate(4_000_000, 200_000, 2000, 10_000, raised), { fps: 15, tolerance: GIF_TOLERANCE.raised }, 'then the frame rate');
  assert.deepEqual(adaptRate(4_000_000, 200_000, 2000, 10_000, { fps: 15, tolerance: GIF_TOLERANCE.raised }).fps, 10, 'never below 10');
  assert.deepEqual(adaptRate(4_000_000, 200_000, 2000, 10_000, { fps: 10, tolerance: GIF_TOLERANCE.raised }).fps, 10);
  assert.deepEqual(adaptRate(9_000_000, 200_000, 500, 10_000, start), start, 'not judged in the first second');
  assert.deepEqual(adaptRate(9_000_000, 200_000, 10_000, 10_000, start), start, 'nor at the end');
});
