// Terrain + map definitions. Pure math, no rendering.
// World axes: +Y up, riders travel downhill toward -Z.  s = -z is distance downhill.

export const D2R = Math.PI / 180;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------------------
// Profile builder: describes a jump/hill as a chain of arcs and lines
// ("turtle" walk) along the fall line, stored as an offset above the base slope.
// ---------------------------------------------------------------------------
// piece types:
//   { arc: [a0, a1], R }        angles in degrees (positive = up)
//   { line: a, L }
//   { solve: a }                straight line whose length is solved so the
//                               profile ends back on the base slope (offset 0)
// optional on any piece: inner:true (narrow kicker mask), lip:true (mark lip at end)
export function buildFeature({ alpha, s0, xc = 0, pieces, wIn = 7, wOut = 18, fIn = 1.4, fOut = 7, endOffset = 0, name = '' }) {
  const ta = Math.tan(alpha * D2R);
  const STEP = 0.08;

  // Pass 1: offset gained by every piece except the solved one.
  const pieceGain = (p, L) => {
    // returns [ds, dOffset] for a piece
    let ds = 0, dy = 0;
    if (p.arc) {
      const a0 = p.arc[0] * D2R, a1 = p.arc[1] * D2R;
      const len = p.R * Math.abs(a1 - a0);
      const n = Math.max(2, Math.ceil(len / STEP));
      for (let i = 0; i < n; i++) {
        const a = a0 + (a1 - a0) * ((i + 0.5) / n);
        ds += Math.cos(a) * (len / n);
        dy += Math.sin(a) * (len / n);
      }
    } else {
      const a = (p.line !== undefined ? p.line : p.solve) * D2R;
      ds = Math.cos(a) * L;
      dy = Math.sin(a) * L;
    }
    return [ds, dy + ds * ta];
  };
  let off = 0;
  let solveIdx = -1;
  pieces.forEach((p, i) => {
    if (p.solve !== undefined) { solveIdx = i; return; }
    off += pieceGain(p, p.L)[1];
  });
  if (solveIdx >= 0) {
    const a = pieces[solveIdx].solve * D2R;
    const per = Math.sin(a) + Math.cos(a) * ta; // offset change per meter
    let L = (endOffset - off) / per;
    if (!(L > 0)) L = 0.5;
    pieces[solveIdx].L = L;
  }

  // Pass 2: walk and record points.
  const pts = []; // {s, off, inner, side, lip}
  let s = s0, o = 0, innerSide = null;
  const lips = [];
  const push = (inner) => {
    if (inner && innerSide === null) innerSide = o;
    if (!inner) innerSide = null;
    pts.push({ s, off: o, inner, side: inner ? innerSide : o });
  };
  push(false);
  for (const p of pieces) {
    const inner = !!p.inner;
    if (inner && innerSide === null) innerSide = o;
    if (p.arc) {
      const a0 = p.arc[0] * D2R, a1 = p.arc[1] * D2R;
      const len = p.R * Math.abs(a1 - a0);
      const n = Math.max(2, Math.ceil(len / STEP));
      for (let i = 0; i < n; i++) {
        const a = a0 + (a1 - a0) * ((i + 0.5) / n);
        s += Math.cos(a) * (len / n);
        o += (Math.sin(a) + Math.cos(a) * ta) * (len / n);
        push(inner);
      }
    } else {
      const a = (p.line !== undefined ? p.line : p.solve) * D2R;
      const L = p.L;
      const n = Math.max(1, Math.ceil(L / STEP));
      for (let i = 0; i < n; i++) {
        s += Math.cos(a) * (L / n);
        o += (Math.sin(a) + Math.cos(a) * ta) * (L / n);
        push(inner);
      }
    }
    if (p.lip) lips.push({ s, off: o, angle: p.arc ? p.arc[1] : p.line, w: wIn });
  }

  // Resample at uniform spacing.
  const ds = 0.1;
  const sEnd = pts[pts.length - 1].s;
  const n = Math.ceil((sEnd - s0) / ds) + 1;
  const main = new Float32Array(n), side = new Float32Array(n), inn = new Uint8Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const si = s0 + i * ds;
    while (j < pts.length - 2 && pts[j + 1].s < si) j++;
    const A = pts[j], B = pts[j + 1] || A;
    const t = B.s > A.s ? clamp((si - A.s) / (B.s - A.s), 0, 1) : 0;
    main[i] = A.off + (B.off - A.off) * t;
    side[i] = A.side + (B.side - A.side) * t;
    inn[i] = (A.inner || B.inner) ? 1 : 0;
  }
  const feat = { name, xc, s0, s1: s0 + (n - 1) * ds, ds, n, main, side, inn, wIn, wOut, fIn, fOut, lips, alpha };
  // Landing info for speed assist: knuckle = first point after lip where profile begins steep descent
  return feat;
}

function featureOffset(f, x, s) {
  if (s <= f.s0 || s >= f.s1) return 0;
  const fi = (s - f.s0) / f.ds;
  const i = fi | 0, t = fi - i;
  const m = f.main[i] + (f.main[i + 1] - f.main[i]) * t;
  const sd = f.side[i] + (f.side[i + 1] - f.side[i]) * t;
  const dx = Math.abs(x - f.xc);
  const mo = 1 - smoothstep(f.wOut * 0.5, f.wOut * 0.5 + f.fOut, dx);
  if (mo <= 0) return 0;
  const mi = 1 - smoothstep(f.wIn * 0.5, f.wIn * 0.5 + f.fIn, dx);
  return mo * (sd + mi * (m - sd));
}

// ---------------------------------------------------------------------------
// Map factory
// ---------------------------------------------------------------------------
function makeMap(def) {
  const ta = Math.tan(def.alpha * D2R);
  const base = def.base || ((x, s) => -s * ta);
  const feats = def.features || [];
  const extra = def.extra || null;
  const H = (x, z) => {
    const s = -z;
    let h = base(x, s);
    for (let k = 0; k < feats.length; k++) h += featureOffset(feats[k], x, s);
    if (extra) h += extra(x, s);
    // soft side berms keep riders in bounds
    const ax = Math.abs(x) - def.halfWidth;
    if (ax > 0) h += 7 * smoothstep(0, 16, ax) + Math.min(ax, 200) * 0.04;
    return h;
  };
  const E = 0.04;
  const normal = (x, z, out) => {
    const dx = (H(x + E, z) - H(x - E, z)) / (2 * E);
    const dz = (H(x, z + E) - H(x, z - E)) / (2 * E);
    let nx = -dx, ny = 1, nz = -dz;
    const l = Math.hypot(nx, ny, nz);
    out = out || { x: 0, y: 0, z: 0 };
    out.x = nx / l; out.y = ny / l; out.z = nz / l;
    return out;
  };
  const m = Object.assign({ H, normal, base, rails: [], lips: [], jumps: [] }, def);
  // collect lips in world coords
  for (const f of feats) {
    for (const L of f.lips) {
      const z = -L.s;
      m.lips.push({ x: f.xc, z, y: H(f.xc, z), w: f.wIn, angle: L.angle, feature: f });
    }
  }
  // rails: pts given as [x, s, heightAboveSurface]
  m.rails = (def.railDefs || []).map((r) => {
    const pts = r.pts.map(([x, s, h]) => ({ x, y: H(x, -s) + h, z: -s, h }));
    return { type: r.type || 'rail', name: r.name || '', pts, width: r.type === 'box' ? 0.55 : 0.09, supports: r.supports !== false };
  });
  return m;
}

// Build a list of x / z sample positions for the terrain mesh.
function samples(a, b, coarse, dense) {
  // dense: list of [from,to,step]
  const out = [];
  let v = a;
  while (v < b) {
    out.push(v);
    let step = coarse;
    for (const [d0, d1, st] of dense) if (v >= d0 - coarse && v < d1) step = Math.min(step, st);
    v += step;
  }
  out.push(b);
  return out;
}

// ---------------------------------------------------------------------------
// SLOPESTYLE
// ---------------------------------------------------------------------------
function tableJump(alpha, s0, o) {
  const { theta, R, table, beta, approach, wIn, wOut, name } = o;
  return buildFeature({
    alpha, s0, name, wIn, wOut, fIn: 1.2, fOut: 9,
    pieces: [
      { arc: [-alpha, -2], R: 40 },
      { line: -2, L: approach },
      { arc: [-2, theta], R, inner: true, lip: true },
      { line: -62, L: 0.9, inner: true },
      { line: 0, L: table },
      { arc: [0, -beta], R: 8 },
      { solve: -beta },
      { arc: [-beta, -alpha], R: 30 },
    ],
  });
}

function slopestyle() {
  const alpha = 12;
  const specs = [
    { name: 'Jump 1', theta: 27, R: 13, table: 8, beta: 30, approach: 20, wIn: 7.5, wOut: 22 },
    { name: 'Jump 2', theta: 30, R: 17, table: 12, beta: 32, approach: 25, wIn: 8.5, wOut: 24 },
    { name: 'Jump 3', theta: 33, R: 21, table: 16, beta: 33, approach: 30, wIn: 9.5, wOut: 26 },
  ];
  const features = [];
  let s0 = 70;
  for (const sp of specs) {
    const f = tableJump(alpha, s0, sp);
    features.push(f);
    s0 = f.s1 + 22;
  }
  const sRail2 = s0 + 10;
  const sQP = sRail2 + 70;
  features.push(
    // finale quarter pipe
    buildFeature({
      alpha, s0: sQP, name: 'Quarter', wIn: 90, wOut: 90, fIn: 1, fOut: 6,
      pieces: [
        { line: -alpha, L: 4 },
        { arc: [-alpha, 0], R: 30 },
        { line: 0, L: 10 },
        { arc: [0, 82], R: 6, lip: true },
        { line: 0, L: 5 },
      ],
      endOffset: 999,
    }),
  );
  // quarter pipe should not fall back to base at its end: hold the deck level
  const qp = features[3];
  const qpDeck = qp.main[qp.n - 1];
  const ta = Math.tan(alpha * D2R);
  const base = (x, s) => {
    let y = -s * ta;
    if (s >= qp.s1) y = -qp.s1 * ta + qpDeck; // flat deck beyond quarter pipe
    return y;
  };
  const railDefs = [
    // first rail garden
    { type: 'box', name: 'Ride-on Box', pts: [[-8, 26, 0.0], [-8, 28.5, 0.55], [-8, 44, 0.55]] },
    { type: 'rail', name: 'Straight Rail', pts: [[0, 30, 0.85], [0, 46, 0.85]] },
    { type: 'rail', name: 'Kinked Rail', pts: [[8, 28, 0.75], [8, 35, 0.75], [8, 43, 0.35]] },
    // second rail garden
    { type: 'rail', name: 'Rainbow Rail', pts: rainbow(-8, sRail2 + 8, 16, 1.6, 0.6) },
    { type: 'box', name: 'Long Box', pts: [[0, sRail2, 0.0], [0, sRail2 + 2.5, 0.6], [0, sRail2 + 23, 0.6]] },
    { type: 'rail', name: 'Down Rail', pts: [[8, sRail2 + 2, 1.1], [8, sRail2 + 20, 0.5]] },
    // flat-bar to quarter
    { type: 'rail', name: 'Gap Rail', pts: [[-6, sRail2 + 42, 0.9], [-6, sRail2 + 56, 0.9]] },
    { type: 'box', name: 'Wall Box', pts: [[6, sRail2 + 40, 0.0], [6, sRail2 + 42, 0.5], [6, sRail2 + 58, 0.5]] },
  ];
  const zs = samples(-(qp.s1 + 30), 30, 0.9, [
    [-(qp.s1 + 2), -(qp.s0 - 2), 0.25],
    ...features.slice(0, 3).map((f) => [-(f.s1), -(f.s0), 0.3]),
  ]);
  const xs = samples(-170, 170, 6, [[-50, 50, 0.9], [-16, 16, 0.5]]);
  const map = makeMap({
    id: 'slopestyle', name: 'Slopestyle', alpha, halfWidth: 34, features, base, railDefs,
    spawn: { x: 0, s: 4, speed: 4 },
    checkpoints: [4, ...features.slice(0, 3).map((f) => f.s0 - 8), sRail2 - 12],
    finish: { s: qp.s0 + 8, mode: 'stop' },
    xs, zs, sRange: [-30, qp.s1 + 30],
  });
  return map;
}

function rainbow(x, sMid, len, rise, h0) {
  const pts = [];
  const N = 10;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const s = sMid - len / 2 + len * t;
    const y = h0 + rise * Math.sin(Math.PI * t);
    pts.push([x, s, y]);
  }
  return pts;
}

// ---------------------------------------------------------------------------
// BIG AIR
// ---------------------------------------------------------------------------
function bigair() {
  const alpha = 0;
  const hill = buildFeature({
    alpha, s0: -40, name: 'Big Air', wIn: 9, wOut: 34, fIn: 1.3, fOut: 26,
    pieces: [
      { line: 80, L: 72 },     // back of the tower (out of play)
      { line: 0, L: 34 },      // start deck
      { arc: [0, -30], R: 25 },
      { line: -30, L: 46 },
      { arc: [-30, 0], R: 30 },
      { line: 0, L: 10 },
      { arc: [0, 36], R: 16, inner: true, lip: true },
      { line: -60, L: 1.0, inner: true },
      { line: 0, L: 15 },
      { arc: [0, -33], R: 7 },
      { solve: -33 },
      { arc: [-33, 0], R: 45 },
      { line: 0, L: 150 },
    ],
  });
  const zs = samples(-420, 50, 1.0, [[-(hill.s0 + 260), -(hill.s0 + 160), 0.3]]);
  const xs = samples(-190, 190, 6, [[-75, 75, 1.2], [-12, 12, 0.4]]);
  // locate deck & spawn
  return makeMap({
    id: 'bigair', name: 'Big Air', alpha, halfWidth: 60, features: [hill],
    spawn: { x: 0, s: 5, speed: 4 },
    checkpoints: [5],
    finish: { s: 300, mode: 'pass' },
    xs, zs, sRange: [-40, 420],
  });
}

// ---------------------------------------------------------------------------
// SUPERPIPE
// ---------------------------------------------------------------------------
function superpipe() {
  const alpha = 16;
  const fb = 4.0;          // half width of flat bottom
  const R = 6.2;           // transition radius
  const maxA = 84 * D2R;   // steepest angle before the coping
  const dmax = R * Math.sin(maxA);
  const wallH = R * (1 - Math.cos(maxA));
  const deckW = 6;
  const pipeLen = 220;
  const cross = (x) => {
    const ax = Math.abs(x);
    if (ax <= fb) return 0;
    const d = ax - fb;
    if (d < dmax) return R - Math.sqrt(R * R - d * d);
    const e = d - dmax;
    if (e < deckW) return wallH;
    return wallH * (1 - smoothstep(0, 16, e - deckW)) - (e - deckW) * 0.05;
  };
  const ramp = (s) => smoothstep(-14, 6, s) * (1 - smoothstep(pipeLen, pipeLen + 20, s));
  const extra = (x, s) => cross(x) * ramp(s);
  const wallStart = fb + dmax;
  const zs = samples(-(pipeLen + 60), 40, 0.7, []);
  const xs = samples(-170, 170, 6, [[-50, 50, 1.0], [-wallStart - 0.8, -fb + 0.2, 0.12], [fb - 0.2, wallStart + 0.8, 0.12], [-fb, fb, 0.5], [-wallStart, -wallStart + 8, 0.5], [wallStart, wallStart + 8, 0.5]]);
  return makeMap({
    id: 'pipe', name: 'Superpipe', alpha, halfWidth: 40, extra,
    pipe: { fb, R, maxA, dmax, wallH, len: pipeLen, wallStart },
    spawn: { x: 0, s: 6, speed: 9 },
    checkpoints: [6],
    finish: { s: pipeLen + 30, mode: 'pass' },
    xs, zs, sRange: [-40, pipeLen + 60],
  });
}

export function createMap(id) {
  if (id === 'bigair') return bigair();
  if (id === 'pipe') return superpipe();
  return slopestyle();
}

export const MAP_LIST = [
  { id: 'slopestyle', name: 'Slopestyle', desc: 'Rails, boxes, three table-top jumps and a quarter pipe finale.' },
  { id: 'bigair', name: 'Big Air', desc: 'One huge kicker off a tall start tower. Go big.' },
  { id: 'pipe', name: 'Superpipe', desc: '220 m competition halfpipe. Boost out of the walls.' },
];
