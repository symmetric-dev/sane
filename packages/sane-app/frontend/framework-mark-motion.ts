type Point = { x: number; y: number };

export type FrameworkParticle = {
  home: Point;
  range: Point;
  phase: Point;
  period: Point;
};
export type FrameworkConnection = { from: number; to: number };
export type FrameworkFormation = { shape: number; started: number; next: number };

const formations: Partial<Record<number, Point>>[] = [
  // Diamond outline above the logo.
  {
    0: { x: 10.6, y: -.4 },
    1: { x: 9.2, y: -1.6 },
    5: { x: 13.4, y: -.4 },
    6: { x: 14.8, y: -1.6 },
    10: { x: 10.6, y: -2.8 },
    11: { x: 12, y: -4 },
    12: { x: 13.4, y: -2.8 },
    13: { x: 12, y: .8 },
  },
  // Triangle outline to the left.
  {
    0: { x: -4.1, y: 10 },
    1: { x: -4.85, y: 11.3 },
    2: { x: -4.1, y: 12.6 },
    3: { x: -5.6, y: 12.6 },
    4: { x: -2.6, y: 12.6 },
    10: { x: -3.35, y: 11.3 },
  },
  // Staircase to the right.
  {
    5: { x: 26, y: 10.5 },
    6: { x: 26, y: 11.6 },
    7: { x: 27.1, y: 11.6 },
    8: { x: 26, y: 12.7 },
    9: { x: 27.1, y: 12.7 },
    13: { x: 28.2, y: 12.7 },
  },
  // Square outline above the logo, using the same safe approach paths.
  {
    0: { x: 10, y: .4 },
    1: { x: 10, y: -1.6 },
    5: { x: 14, y: .4 },
    6: { x: 14, y: -1.6 },
    10: { x: 10, y: -3.6 },
    11: { x: 12, y: -3.6 },
    12: { x: 14, y: -3.6 },
    13: { x: 12, y: .4 },
  },
  // Plus to the left.
  {
    0: { x: -4.1, y: 11.3 },
    1: { x: -5.25, y: 11.3 },
    2: { x: -2.95, y: 11.3 },
    3: { x: -4.1, y: 10.15 },
    4: { x: -4.1, y: 12.45 },
  },
];

function randomBetween(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function randomHome(index: number, particles: FrameworkParticle[]): Point {
  // Irregular clouds, rather than rows. Separate regions keep both the drift
  // and the paths into formations clear of the logo and the viewport edges.
  // The two top particles that visit side formations start near that side,
  // so gathering them cannot cut through a triangle face.
  // Preserve formation participants; distribute extra squares across all three clouds.
  const region = index < 5 ? 0 : index < 10 ? 1 : index < 14 ? 2 : (index - 14) % 3;
  const bounds = region === 0 ? [-5.8, -1.5, 1.5, 19.4]
    : region === 1 ? [25.5, 29.8, 1.5, 19.4]
    : index === 10 ? [1.5, 6, -4.2, .3]
    : index === 13 ? [18, 22.5, -4.2, .3] : [1.5, 22.5, -4.2, .3];
  let best = { x: bounds[0], y: bounds[2] };
  let bestDistance = -Infinity;
  for (let attempt = 0; attempt < 80; attempt++) {
    const candidate = { x: randomBetween(bounds[0], bounds[1]), y: randomBetween(bounds[2], bounds[3]) };
    const distance = Math.min(...particles.map(({ home }) => Math.hypot(candidate.x - home.x, candidate.y - home.y)));
    if (distance >= 2) return candidate;
    if (distance > bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

export function createFrameworkParticles(): FrameworkParticle[] {
  const particles: FrameworkParticle[] = [];
  for (let index = 0; index < 20; index++) {
    particles.push({
      home: randomHome(index, particles),
      range: { x: randomBetween(.45, .9), y: randomBetween(.3, .6) },
      phase: { x: randomBetween(0, Math.PI * 2), y: randomBetween(0, Math.PI * 2) },
      period: { x: randomBetween(6500, 11500), y: randomBetween(7500, 12500) },
    });
  }
  return particles;
}

export function createFrameworkConnections(count: number): FrameworkConnection[] {
  return Array.from({ length: count }, (_, from) =>
    Array.from({ length: count - from - 1 }, (_, offset) => ({ from, to: from + offset + 1 }))).flat();
}

function ease(value: number) {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped * clamped * (3 - 2 * clamped);
}

export function createFrameworkFormation(elapsed: number, previous: FrameworkFormation | null): FrameworkFormation {
  const choices = formations.map((_, index) => index).filter(index => index !== previous?.shape);
  return {
    shape: choices[Math.floor(Math.random() * choices.length)],
    started: elapsed,
    next: elapsed + randomBetween(6000, 7000),
  };
}

export function frameworkPositions(particles: FrameworkParticle[], elapsed: number, formation: FrameworkFormation | null) {
  const ambient = Math.max(0, elapsed - 3300);
  const phase = elapsed - (formation?.started ?? elapsed);
  // Gather for 1.2s, hold for 1.6s, disperse for 1.2s, then float freely.
  const strength = !formation ? 0 : phase < 1200 ? ease(phase / 1200)
    : 1 - ease((phase - 2800) / 1200);
  const targets = formation ? formations[formation.shape] : undefined;
  const positions = particles.map(({ home, range, period, phase: offset }, index) => {
    const floating = {
      x: home.x + Math.sin(ambient / period.x * Math.PI * 2 + offset.x) * range.x,
      y: home.y + Math.sin(ambient / period.y * Math.PI * 2 + offset.y) * range.y,
    };
    const target = targets?.[index];
    return target ? {
      x: floating.x + (target.x - floating.x) * strength,
      y: floating.y + (target.y - floating.y) * strength,
    } : floating;
  });
  return { positions, strength };
}

export function chooseFrameworkConnections(
  connections: FrameworkConnection[], positions: Point[], previous: Set<number>,
): Set<number> {
  const limits = positions.map(() => {
    const chance = Math.random();
    return chance < .05 ? 0 : chance < .75 ? 2 : chance < .93 ? 3 : 4;
  });
  const degrees = positions.map(() => 0);
  const chosen = new Set<number>();
  const candidates = connections.map(({ from, to }, index) => {
    const distance = Math.hypot(positions[from].x - positions[to].x, positions[from].y - positions[to].y);
    return { index, from, to, distance,
      score: distance * randomBetween(.8, 1.2) * (previous.has(index) ? .7 : 1) };
  });
  const add = ({ index, from, to }: typeof candidates[number]) => {
    chosen.add(index);
    degrees[from]++;
    degrees[to]++;
  };

  // At most one intentional cross-logo link per selection. Local links below
  // never bridge the opposite clouds merely to fill a neighbor quota.
  if (Math.random() < .25) {
    const long = candidates.filter(({ from, to, distance }) => distance > 18 && limits[from] && limits[to]
      && Math.min(positions[from].x, positions[to].x) < 2
      && Math.max(positions[from].x, positions[to].x) > 22);
    if (long.length) add(long[Math.floor(Math.random() * long.length)]);
  }
  for (const candidate of candidates.sort((a, b) => a.score - b.score)) {
    if (candidate.distance > 12 || degrees[candidate.from] >= limits[candidate.from]
      || degrees[candidate.to] >= limits[candidate.to]) continue;
    add(candidate);
  }
  return chosen;
}
