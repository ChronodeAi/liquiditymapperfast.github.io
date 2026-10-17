import test from 'node:test';
import assert from 'node:assert/strict';
import { AIM_SHARE, FIRST_FRAME_BPP, GIF_LIMIT, GIF_SECONDS, LAST_RUNG, PLAN_FLOOR, RUNGS, RungController, STORM, STORM_BPP, TYPICAL, estimateBytes, nextRung, planGif, rungAt } from '../src/app/screenshot/gif-budget.ts';

test('the limit is 15 MB counted the smaller way', () => {
  assert.equal(GIF_LIMIT, 15_000_000);
  assert.ok(GIF_LIMIT <= 15 * 1024 * 1024);
  assert.deepEqual([GIF_SECONDS.min, GIF_SECONDS.max], [1, 15]);
  assert.ok(GIF_SECONDS.start >= GIF_SECONDS.min && GIF_SECONDS.start <= GIF_SECONDS.max);
});

test('the plan floor is the last rung at the full frame rate', () => {
  assert.equal(RUNGS[PLAN_FLOOR]!.fps, 30);
  assert.ok(RUNGS[PLAN_FLOOR + 1]!.fps < 30);
});

test('the rungs run from the best picture to the cheapest: the best is 30 frames a second with little let go, and no rung is dearer than the one before', () => {
  assert.equal(RUNGS[0]!.fps, 30);
  assert.ok(RUNGS[0]!.tolerance <= 2 && RUNGS[0]!.dither === 1 && RUNGS[0]!.colors >= 255, 'the top rung is at its best');
  assert.equal(STORM_BPP.length, RUNGS.length);
  for (let i = 1; i < RUNGS.length; i++) {
    // What a frame costs does not rise down the ladder, and what a second costs (the frame rate counted in) falls or stays.
    assert.ok(STORM_BPP[i]! <= STORM_BPP[i - 1]! * 1.001 || RUNGS[i]!.fps < RUNGS[i - 1]!.fps, `rung ${i}`);
    assert.ok(STORM_BPP[i]! * RUNGS[i]!.fps <= STORM_BPP[i - 1]! * RUNGS[i - 1]!.fps * 1.001, `rung ${i} costs a second more than the one above`);
    assert.ok(RUNGS[i]!.fps <= RUNGS[i - 1]!.fps, 'the frame rate never rises down the ladder');
    assert.ok(RUNGS[i]!.dither >= 0 && RUNGS[i]!.dither <= 1 && RUNGS[i]!.tolerance >= 0);
  }
  assert.equal(rungAt(-3), RUNGS[0]); assert.equal(rungAt(99), RUNGS[LAST_RUNG]);
});

test('a short recording of an area of a few hundred pixels starts at the best rung, at full size', () => {
  for (const [w, h, seconds] of [[400, 300, 5], [560, 350, 5], [300, 200, 15], [868, 598, 3]] as const) {
    const plan = planGif(w, h, seconds, 1);
    assert.equal(plan.rung, 0, `${w}x${h} for ${seconds} s`);
    assert.equal(plan.fps, 30);
    assert.equal(plan.scale, 1);
    assert.deepEqual([plan.width, plan.height], [w, h]);
    assert.ok(!plan.tight);
  }
});

test('a sharp screen gets its device pixels, up to twice the page\'s and 1920 px, when the length lets it', () => {
  const small = planGif(300, 200, 5, 2);
  assert.equal(small.scale, 2); assert.equal(small.rung, 0);
  assert.ok(planGif(300, 200, 5, 3).scale <= 2, 'never more than two GIF pixels a CSS pixel');
  const wide = planGif(1500, 800, 3, 2);
  assert.ok(Math.max(wide.width, wide.height) <= 1920, 'at most 1920 px on the long side');
});

test('no plan is estimated over the limit, even for a storm on the cheapest rung that keeps 30 frames a second, whatever the area, length and screen', () => {
  for (const [w, h] of [[120, 80], [400, 300], [800, 500], [1280, 720], [1600, 1000], [1920, 1080], [2560, 1440], [412, 915]] as const) {
    for (let seconds = GIF_SECONDS.min; seconds <= GIF_SECONDS.max; seconds++) {
      for (const dpr of [1, 1.5, 2, 2.625, 3]) {
        const plan = planGif(w, h, seconds, dpr);
        assert.ok(RUNGS[plan.rung] !== undefined);
        assert.equal(plan.fps, RUNGS[plan.rung]!.fps);
        assert.ok(Math.max(plan.width, plan.height) <= 1920, 'at most 1920 px on the long side');
        const px = plan.width * plan.height;
        assert.equal(plan.estimate, estimateBytes(px, seconds, plan.rung, TYPICAL));
        assert.ok(plan.tight || estimateBytes(px, seconds, PLAN_FLOOR, STORM) <= GIF_LIMIT * 0.97 + 1, `${w}x${h} ${seconds}s @${dpr}: ${estimateBytes(px, seconds, PLAN_FLOOR, STORM)}`);
        assert.ok(plan.tight || estimateBytes(px, seconds, plan.rung, TYPICAL) <= GIF_LIMIT * 0.88 + 1 || plan.rung === LAST_RUNG, `${w}x${h} ${seconds}s @${dpr}`);
      }
    }
  }
});

test('a longer recording never gets a larger picture or a better rung', () => {
  for (const [w, h, dpr] of [[500, 350, 1], [900, 600, 2], [1600, 1000, 1], [412, 915, 2.625]] as const) {
    let last = planGif(w, h, GIF_SECONDS.min, dpr);
    for (let s = GIF_SECONDS.min + 1; s <= GIF_SECONDS.max; s++) {
      const plan = planGif(w, h, s, dpr);
      assert.ok(plan.scale <= last.scale + 1e-9 && (plan.scale < last.scale - 1e-9 || plan.rung >= last.rung), `${w}x${h} at ${s}s: ${plan.scale}/${plan.rung} after ${last.scale}/${last.rung}`);
      last = plan;
    }
  }
});

test('the whole page for 15 seconds is planned smaller than its device size allows, and it still fits', () => {
  const plan = planGif(1600, 1000, 15, 2), short = planGif(1600, 1000, 2, 2);
  assert.ok(plan.scale < short.scale, `${plan.scale} for 15 s against ${short.scale} for 2 s`);
  assert.ok(!plan.tight);
});

// ---- the controller, in a closed loop with a made-up recording -----------------------------------------------------------------------

interface Run { bytes: number; written: number; rungs: number[]; reversals: number; fpsSeen: Set<number>; limitHit: boolean; finalRung: number }

/**
 * A recording of `seconds` of an area of `px` pixels, frame after frame as the controller asks: each costs a share (`activity`, from a
 * function of time) of what a storm costs on its rung; frames come back `lag` frames after they were taken, as from a pool.
 */
function simulate(px: number, seconds: number, activity: (t: number) => number, lag = 4, limit = GIF_LIMIT, start = 0): Run {
  const total = seconds * 1000, controller = new RungController({ limit, total, rung: start });
  const queue: { bytes: number }[] = [];
  let fileSize = 2000 + px * FIRST_FRAME_BPP, t = 0, written = 0, limitHit = false, reversals = 0, previous = start, lastChange = -100, lastDirection = 0;
  const rungs: number[] = [], fpsSeen = new Set<number>();
  while (t < total && !limitHit) {
    const rung = controller.decide(t);
    rungs.push(rung); fpsSeen.add(controller.fps);
    if (rung !== previous) {
      // Going back the way it came within a dozen frames of the last change is hunting; down in a burst and up when it ends is not.
      const direction = Math.sign(rung - previous);
      if (direction !== lastDirection && lastDirection !== 0 && rungs.length - lastChange < 12) reversals++;
      lastDirection = direction; lastChange = rungs.length; previous = rung;
    }
    // The first frame is the whole picture.
    queue.push({ bytes: queue.length === 0 && rungs.length === 1 ? 0 : px * STORM_BPP[rung]! * activity(t) });
    while (queue.length > lag) {
      const f = queue.shift()!;
      if (fileSize + f.bytes > limit) { limitHit = true; break; }
      fileSize += f.bytes; written++; controller.committed(f.bytes, fileSize);
    }
    t += 1000 / controller.fps;
  }
  while (queue.length && !limitHit) { const f = queue.shift()!; if (fileSize + f.bytes > limit) { limitHit = true; break; } fileSize += f.bytes; written++; controller.committed(f.bytes, fileSize); }
  return { bytes: fileSize, written, rungs, reversals, fpsSeen, limitHit, finalRung: controller.rung };
}

test('a calm recording stays on the best rung from the first frame to the last, and uses what it needs', () => {
  const run = simulate(868 * 598, 5, () => 0.08);
  assert.ok(run.rungs.every(r => r === 0), 'the best rung throughout');
  assert.ok(!run.limitHit);
  assert.ok(run.bytes < GIF_LIMIT * 0.5);
});

test('a short recording of a busy area stays at its best when the bytes allow, which a few seconds of it do', () => {
  // Four seconds of a storm over 300 x 200: 30 frames a second of 60,000 pixels at the best rung's cost fit with room.
  const run = simulate(300 * 200, 4, () => 1);
  assert.ok(run.rungs.every(r => r === 0));
});

/** A recording of an area of `w` × `h` CSS px for `seconds`, planned as the editor plans it and run as the recorder runs it. */
function planned(w: number, h: number, seconds: number, activity: (t: number) => number, dpr = 1, lag = 4): Run & { plan: ReturnType<typeof planGif> } {
  const plan = planGif(w, h, seconds, dpr);
  return { ...simulate(plan.width * plan.height, seconds, activity, lag, GIF_LIMIT, plan.rung), plan };
}

test('a long recording of a storm gives quality up a rung at a time, uses nearly all of the 15 MB, and does not end early', () => {
  for (const [w, h, seconds] of [[868, 598, 15], [868, 598, 10], [600, 400, 15], [1200, 750, 15], [1600, 1000, 15]] as const) {
    // A storm as heavy as a plan allows for (`STORM` of the heaviest measured): the plan makes room for it on the cheapest rung.
    const run = planned(w, h, seconds, () => STORM);
    assert.ok(!run.limitHit, `${w}x${h} for ${seconds} s hit the limit at ${run.bytes}`);
    assert.ok(run.bytes <= GIF_LIMIT);
    assert.ok(run.bytes >= GIF_LIMIT * 0.5, `${w}x${h} for ${seconds} s used only ${(run.bytes / GIF_LIMIT * 100).toFixed(0)} %`);
    // Rungs go down a few at a time, never from the best to the worst in a step.
    for (let i = 1; i < run.rungs.length; i++) assert.ok(Math.abs(run.rungs[i]! - run.rungs[i - 1]!) <= 5, `a jump of ${run.rungs[i]! - run.rungs[i - 1]!} rungs`);
  }
});

test('a busy recording of a few seconds is spent in full: the rungs go down only as far as the bytes need, and it comes out near the limit', () => {
  const run = planned(868, 598, 6, () => 0.6);
  assert.ok(!run.limitHit);
  assert.ok(run.bytes > GIF_LIMIT * 0.8, `${(run.bytes / GIF_LIMIT * 100).toFixed(0)} % used`);
});

test('whatever the activity does, the file stays under its limit and the controller does not hunt up and down', () => {
  // Up to the heaviest recording measured (the map under constant heavy waves), which is what a plan makes room for on the cheapest rung.
  const profiles: [string, (t: number) => number][] = [
    ['bursts', t => (Math.floor(t / 700) % 3 === 0 ? 1 : 0.1)],
    ['rising', t => 0.05 + t / 15000],
    ['falling', t => 1 - t / 15000],
    ['a storm after calm', t => (t < 6000 ? 0.05 : 1)],
    ['a calm after storm', t => (t < 6000 ? 1 : 0.05)],
    ['random', (() => { let s = 7; return () => { s = (s * 1664525 + 1013904223) >>> 0; return 0.05 + (s / 2 ** 32) * 0.95; }; })()],
  ];
  for (const [name, activity] of profiles) {
    for (const [w, h] of [[400, 300], [868, 598], [1500, 900]] as const) {
      const run = planned(w, h, 15, activity);
      assert.ok(!run.limitHit, `${name} at ${w}x${h}: hit the limit`);
      assert.ok(run.bytes <= GIF_LIMIT);
      // Down in a burst and back up when it passes is no hunting; a rung that turns back within a dozen frames is.
      assert.ok(run.reversals <= 4, `${name} at ${w}x${h}: ${run.reversals} quick reversals`);
    }
  }
});

test('beyond what a plan makes room for the controller runs for the cheapest rungs and the file still never passes its limit', () => {
  const heavier = planned(1500, 900, 15, t => (t < 6000 ? 0.05 : 1.6));
  assert.ok(heavier.bytes <= GIF_LIMIT);
  assert.ok(heavier.finalRung >= 11);
});

test('the guard still holds if the controller is wrong: the bytes left, not the plan, decide', () => {
  // The recording is started on the best rung over an area far too large for it: the controller runs for the cheaper rungs at once.
  const run = simulate(1900 * 1000, 15, () => 1, 6, GIF_LIMIT, 0);
  assert.ok(run.rungs.slice(0, 20).some(r => r >= 3), 'down the ladder at once');
  assert.ok(run.bytes <= GIF_LIMIT);
});

test('the controller acts on a few frames that cost a little too much, on the first one when it costs far too much, and only on frames made at the rung', () => {
  // The allowance at the start: (94 % of 15 MB) over 300 frames of a 10 s recording, about 47 KB each.
  const c = new RungController({ limit: GIF_LIMIT, total: 10_000, rung: 0 });
  c.decide(0); c.committed(500_000, 2000 + 500_000);
  assert.equal(c.rung, 0, 'the first frame is the whole picture and is not judged');
  for (let i = 0; i < 8; i++) c.decide((i + 1) * 33);
  for (let i = 0; i < 3; i++) c.committed(70_000, 2000 + 70_000 * (i + 1));
  assert.equal(c.rung, 0, 'three frames a half over are not enough to judge by');
  c.committed(70_000, 2000 + 70_000 * 4);
  assert.ok(c.rung > 0, 'the fourth is');
  const after = c.rung;
  // The four more that were taken at the old rung are not judged against the new one.
  for (let i = 0; i < 4; i++) c.committed(900_000, 2000 + 70_000 * 4 + 900_000 * (i + 1));
  assert.equal(c.rung, after);
  const far = new RungController({ limit: GIF_LIMIT, total: 10_000, rung: 0 });
  far.decide(0); far.committed(400_000, 2000 + 400_000);
  far.decide(33); far.committed(400_000, 2000 + 800_000);
  assert.ok(far.rung >= 3, 'a first frame eight times over is acted on at once');
  // Going back up waits for the rung to have held (a third of a second).
  const calm = new RungController({ limit: GIF_LIMIT, total: 10_000, rung: 6 });
  calm.decide(0); calm.committed(300_000, 302_000);
  let size = 302_000;
  for (let i = 1; i < 8; i++) { calm.decide(i * 33); size += 1000; calm.committed(1000, size); }
  assert.equal(calm.rung, 6, 'a quarter of a second of calm is not yet long enough');
  for (let i = 8; i < 20; i++) { calm.decide(i * 33); size += 1000; calm.committed(1000, size); }
  assert.ok(calm.rung < 6, 'a little more is');
});

test('nextRung goes down, at once, to the first rung the bytes left can pay for, up by up to three, and to the cheapest when nothing is left', () => {
  const base = { limit: GIF_LIMIT, share: AIM_SHARE, bytes: 1_000_000, pending: 0, elapsed: 1000, total: 15_000 };
  const seconds = (base.total - base.elapsed) / 1000, budget = GIF_LIMIT * AIM_SHARE - base.bytes;
  const allowance = (rung: number): number => budget / (seconds * rungAt(rung).fps);
  assert.equal(nextRung(4, { ...base, recent: allowance(4) }), 4, 'on budget');
  assert.equal(nextRung(4, { ...base, recent: allowance(4) * 1.02 }), 4, 'a little over is let be');
  const over = nextRung(4, { ...base, recent: allowance(4) * 1.3 });
  assert.ok(over > 4 && over <= 6, `a third over: ${over}`);
  // The rung chosen is the first that fits, and the one before it does not.
  for (const factor of [1.5, 2, 4, 8, 16]) {
    const to = nextRung(4, { ...base, recent: allowance(4) * factor });
    assert.ok(to > 4);
    assert.ok(allowance(4) * factor * STORM_BPP[to]! / STORM_BPP[4]! <= allowance(to) * 1.0, `factor ${factor} goes to ${to}, which fits`);
    if (to < LAST_RUNG && to > 5) assert.ok(allowance(4) * factor * STORM_BPP[to - 1]! / STORM_BPP[4]! > allowance(to - 1) * 0.97 - 1, `and ${to - 1} did not`);
  }
  assert.equal(nextRung(4, { ...base, recent: allowance(4) * 1e6 }), LAST_RUNG, 'hopelessly over: the cheapest');
  const back = nextRung(4, { ...base, recent: allowance(4) * 0.3 });
  assert.ok(back < 4 && back >= 1, `room to spare: up to three rungs back (${back})`);
  assert.ok(allowance(4) * 0.3 * STORM_BPP[back]! / STORM_BPP[4]! <= allowance(back) * 0.8 + 1, 'and the rung it goes to has room');
  assert.equal(nextRung(4, { ...base, recent: allowance(4) * 0.3 }, false), 4, 'but not before the rung has held');
  assert.equal(nextRung(0, { ...base, recent: allowance(0) * 0.01 }), 0, 'already the best');
  assert.equal(nextRung(2, { ...base, bytes: GIF_LIMIT, recent: 10 }), LAST_RUNG, 'nothing left');
  assert.equal(nextRung(2, { ...base, recent: 0 }), 2, 'nothing known yet');
});
