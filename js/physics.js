// Rider physics: carving, airtime, rotations, rails, landings and crashes.
import * as THREE from '../lib/three.module.min.js';
import { clamp } from './terrain.js';
import { GRABS, nameAirTrick, scoreAirTrick, nameRailTrick, scoreRailTrick } from './tricks.js';

const V3 = THREE.Vector3;
const Y = new V3(0, 1, 0);
export const G = 12.5;
const DRAG = 0.0019;     // air drag per m of speed^2
const FRICTION = 0.02;   // snow friction
const TAU = Math.PI * 2;
const wrap = (a) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };

const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const tmpV = new V3(), tmpV2 = new V3(), tmpV3 = new V3();
const nTmp = { x: 0, y: 1, z: 0 };

function baseQuat(up, out) { return out.setFromUnitVectors(Y, up); }
// yaw angle of a direction within the frame whose up is `up`
function yawOf(dir, up) {
  baseQuat(up, tmpQ2).invert();
  const l = tmpV3.copy(dir).applyQuaternion(tmpQ2);
  return Math.atan2(l.x, l.z);
}
function rotateAround(v, axis, ang) { return v.applyAxisAngle(axis, ang); }

const SPORT = {
  snowboard: { turnRate: 2.1, carve: 3.2, spinMax: 7.2, flipMax: 6.4, rollMax: 6.0, ollie: 4.4 },
  ski: { turnRate: 2.5, carve: 3.8, spinMax: 7.6, flipMax: 6.4, rollMax: 6.0, ollie: 4.2 },
};

export class Rider {
  constructor(map, opts) {
    this.map = map;
    this.sport = opts.sport || 'snowboard';
    this.goofy = !!opts.goofy;
    this.assist = opts.assist !== false;
    this.p = SPORT[this.sport];
    this.pos = new V3();
    this.prevPos = new V3();
    this.vel = new V3();
    this.heading = new V3(0, 0, -1);
    this.n = new V3(0, 1, 0);
    this.upBase = new V3(0, 1, 0);
    this.quat = new THREE.Quaternion();
    this.events = [];
    this.combo = [];
    this.comboTimer = 0;
    this.runScore = 0;
    this.trickCounts = {};
    this.computeLipSpeeds();
    this.reset(map.spawn.s);
  }

  // ---------------------------------------------------------------- setup
  computeLipSpeeds() {
    const m = this.map;
    for (const lip of m.lips) {
      lip.ideal = null;
      if (lip.angle > 60) continue;
      // find landing zone: first steep-downhill stretch after the lip
      const ang = (s) => Math.atan2(m.H(lip.x, -(s + 0.5)) - m.H(lip.x, -(s - 0.5)), 1) * 180 / Math.PI;
      const sLip = -lip.z;
      let a = null, b = null;
      for (let s = sLip + 2; s < sLip + 140; s += 0.5) {
        const g = ang(s);
        if (a === null && g < -20) a = s;
        if (a !== null && g > -12) { b = s; break; }
      }
      if (a === null) continue;
      if (b === null) b = a + 30;
      lip.landA = a; lip.landB = b;
      const target = a + (b - a) * 0.38;
      const th = lip.angle * Math.PI / 180;
      let best = 12, bestErr = 1e9;
      for (let v = 6; v < 40; v += 0.1) {
        let s = sLip, y = lip.y + 0.02, vs = v * Math.cos(th), vy = v * Math.sin(th);
        let land = null;
        for (let t = 0; t < 8; t += 0.01) {
          s += vs * 0.01; vy -= G * 0.01; y += vy * 0.01;
          if (y < m.H(lip.x, -s)) { land = s; break; }
        }
        if (land === null) continue;
        const e = Math.abs(land - target);
        if (e < bestErr) { bestErr = e; best = v; }
      }
      lip.ideal = best;
    }
  }

  reset(s) {
    const m = this.map;
    const x = m.spawn.x;
    const z = -s;
    this.pos.set(x, m.H(x, z), z);
    this.prevPos.copy(this.pos);
    m.normal(x, z, nTmp);
    this.n.set(nTmp.x, nTmp.y, nTmp.z);
    this.heading.set(0, 0, -1).projectOnPlane(this.n).normalize();
    this.vel.copy(this.heading).multiplyScalar(m.spawn.speed);
    this.mode = 'ground';
    this.switch = false;
    this.charge = 0;
    this.jumpHeld = false;
    this.spin = this.flip = this.roll = 0;
    this.spinRate = this.flipRate = this.rollRate = 0;
    this.yawNat = 0; this.yawOffset = 0;
    this.lean = 0; this.crouch = 0; this.landSquash = 0;
    this.grabIdx = -1; this.grabs = []; this.grabBlend = 0;
    this.airTime = 0;
    this.crashT = 0;
    this.groundTime = 1;
    this.brake = 0; this.tuck = 0;
    this.butter = 0; this.butterRec = null;
    this.press = 0;
    this.rail = null;
    this.combo = [];
    this.comboTimer = 0;
    this.finished = false;
    this.lastRailExit = -10;
    this.time = 0;
    this.updateQuat(1);
  }

  respawn() {
    // last checkpoint behind current position
    const s = -this.pos.z;
    let cp = this.map.checkpoints[0];
    for (const c of this.map.checkpoints) if (c <= s - 5) cp = c;
    this.reset(cp);
    this.events.push({ type: 'respawn' });
  }

  get speed() { return this.vel.length(); }

  // ---------------------------------------------------------------- main step
  step(dt, inp) {
    this.time += dt;
    this.prevPos.copy(this.pos);
    if (this.mode === 'ground') this.stepGround(dt, inp);
    else if (this.mode === 'air') this.stepAir(dt, inp);
    else if (this.mode === 'rail') this.stepRail(dt, inp);
    else if (this.mode === 'crash') this.stepCrash(dt, inp);
    this.jumpHeld = inp.jump;

    // combo bank timer
    if (this.combo.length && this.mode === 'ground') {
      this.comboTimer += dt;
      if (this.comboTimer > 1.4) this.bankCombo();
    }
    // map finish
    const s = -this.pos.z;
    const f = this.map.finish;
    if (!this.finished && f) {
      if (f.mode === 'pass' && s > f.s) this.finishRun();
      if (f.mode === 'stop' && s > f.s && this.mode === 'ground' && this.speed < 2.5) this.finishRun();
    }
    this.updateQuat(dt);
  }

  finishRun() {
    this.finished = true;
    if (this.combo.length) this.bankCombo();
    this.events.push({ type: 'finish', score: this.runScore });
  }

  // ---------------------------------------------------------------- ground
  stepGround(dt, inp) {
    const m = this.map, P = this.p;
    const n = this.n;
    this.groundTime += dt;
    const steer = (inp.left ? 1 : 0) - (inp.right ? 1 : 0);
    const sp = this.vel.length();

    // gravity
    this.vel.y -= G * dt;

    // nose butter: press on the nose, steer to spin the board around while the body keeps sliding
    const buttering = !!inp.butter && sp > 2;
    if (buttering) {
      if (!this.butterRec) this.butterRec = { time: 0, rot: 0 };
      this.butterRec.time += dt;
    }
    this.butter += ((buttering ? 1 : 0) - this.butter) * Math.min(1, dt * 10);

    // steering rotates the board heading
    const turn = buttering ? steer * 5.5 : steer * P.turnRate * (0.55 + 0.45 * clamp(1 - sp / 30, 0, 1)) * (this.brake > 0.5 ? 1.4 : 1);
    rotateAround(this.heading, n, turn * dt);
    this.heading.projectOnPlane(n).normalize();

    // carve: velocity follows the board
    const vn = this.vel.dot(n);
    const vt = tmpV.copy(this.vel).addScaledVector(n, -vn);
    const vtl = vt.length();
    if (buttering) {
      this.butterRec.rot += turn * dt;
      this.vel.multiplyScalar(1 - 0.15 * dt);
    } else if (this.butterRec) {
      this.finishButter();
    }
    if (vtl > 0.3 && !buttering) {
      const dirSign = vt.dot(this.heading) >= 0 ? 1 : -1;
      this.switch = dirSign < 0;
      const fwd = tmpV2.copy(this.heading).multiplyScalar(dirSign);
      const cross = tmpV3.crossVectors(vt, fwd);
      const ang = Math.atan2(cross.dot(n), vt.dot(fwd) / 1);
      const maxRot = P.carve * dt * (this.brake > 0.5 ? 0.3 : 1);
      const rot = clamp(ang, -maxRot, maxRot);
      rotateAround(this.vel, n, rot);
      this.vel.multiplyScalar(1 - Math.abs(rot) * 0.06);
      // board slowly realigns with travel when not steering
      if (!steer) {
        const back = clamp(-ang, -1.8 * dt, 1.8 * dt);
        rotateAround(this.heading, n, back);
      }
      this.lean += (clamp(ang * 2 + steer * 0.35, -0.7, 0.7) * Math.min(1, sp / 8) - this.lean) * Math.min(1, dt * 8);
    }

    // drag + friction + brake / tuck
    this.tuck += ((inp.up && !inp.jump ? 1 : 0) - this.tuck) * Math.min(1, dt * 6);
    this.brake += ((inp.down && !inp.jump ? 1 : 0) - this.brake) * Math.min(1, dt * 6);
    const spd = this.vel.length();
    if (spd > 0.01) {
      const k = DRAG * (1 - 0.5 * this.tuck);
      let decel = k * spd * spd + FRICTION * G * n.y + this.brake * 7.5;
      this.vel.multiplyScalar(Math.max(0, spd - decel * dt) / spd);
    }
    // push off at low speed
    if (inp.up && spd < 7) this.vel.addScaledVector(this.heading, (this.switch ? -1 : 1) * 3.2 * dt);
    // tucking adds a little extra push so speed keeps building
    if (this.tuck > 0.5 && spd > 1) this.vel.addScaledVector(this.vel, (1.2 * this.tuck / spd) * dt);

    // pipe / quarter pump: gain energy dropping down steep transitions
    if (n.y < 0.9 && this.vel.y < 0) {
      const pump = (1.6 + this.tuck * 2.0) * (1 - n.y) * 3;
      this.vel.addScaledVector(tmpV.copy(this.vel).normalize(), pump * dt);
    }

    // speed assist toward the next jump
    if (this.assist && !inp.up && !inp.down) this.applyAssist(dt);

    // jump charge / ollie
    if (inp.jump) {
      this.charge = Math.min(0.6, this.charge + dt);
    } else if (this.jumpHeld && this.charge > 0) {
      const up = n.y < 0.6 ? tmpV.copy(Y) : tmpV.copy(n).add(Y).normalize();
      this.vel.addScaledVector(up, P.ollie + this.charge * 2.4);
      this.charge = 0;
      this.pos.addScaledVector(up, 0.04);
      this.takeoff(inp, true);
      return;
    } else this.charge = 0;

    // integrate
    this.pos.addScaledVector(this.vel, dt);
    this.checkRails(inp);
    if (this.mode !== 'ground') return;

    // contact
    const h = m.H(this.pos.x, this.pos.z);
    m.normal(this.pos.x, this.pos.z, nTmp);
    const nn = tmpV.set(nTmp.x, nTmp.y, nTmp.z);
    if (this.pos.y <= h + 0.001) {
      this.resolvePenetration();
      n.set(nTmp.x, nTmp.y, nTmp.z);
      const d = this.vel.dot(n);
      if (d < 0) this.vel.addScaledVector(n, -d);
    } else {
      const gap = this.pos.y - h;
      const d = this.vel.dot(nn);
      if (gap < 0.4 && d < 1.4) {
        this.pos.y = h;
        n.copy(nn);
        const d2 = this.vel.dot(n);
        this.vel.addScaledVector(n, -d2);
      } else {
        this.takeoff(inp, false);
      }
    }
    this.heading.projectOnPlane(this.n).normalize();
    this.crouch += ((this.charge > 0 ? 0.55 + this.charge * 0.6 : this.tuck * 0.6 + this.brake * 0.25) - this.crouch) * Math.min(1, dt * 10);
    this.landSquash *= Math.exp(-dt * 6);
  }

  finishButter() {
    const b = this.butterRec;
    this.butterRec = null;
    if (!b || b.time < 0.35) return;
    const deg = Math.round(Math.abs(b.rot) * 180 / Math.PI / 180) * 180;
    const name = 'Nose Butter' + (deg >= 180 ? ' ' + deg : '');
    const pts = Math.round(120 + b.time * 160 + deg * 0.9);
    const rec = { kind: 'butter', name, basePts: pts, landing: 'clean' };
    this.addTrick(rec);
  }

  applyAssist(dt) {
    const m = this.map;
    const s = -this.pos.z;
    let lip = null;
    for (const L of m.lips) {
      if (!L.ideal) continue;
      const ds = -L.z - s;
      if (ds > 0 && ds < 32 && Math.abs(this.pos.x - L.x) < L.w * 0.5 + 2.5) { lip = L; break; }
    }
    if (!lip) return;
    const sp = this.vel.length();
    // energy needed now to arrive at the lip with the ideal speed (gravity + rough friction/drag losses)
    const dist = -lip.z + this.pos.z;
    const loss = (FRICTION * G + DRAG * lip.ideal * lip.ideal) * dist;
    const need = Math.sqrt(Math.max(16, lip.ideal * lip.ideal + 2 * G * (lip.y - this.pos.y) + 2 * loss));
    const a = clamp((need - sp) * 2.0, -7, 6);
    if (sp > 0.5) this.vel.multiplyScalar((sp + a * dt) / sp);
  }

  resolvePenetration() {
    const m = this.map;
    for (let i = 0; i < 3; i++) {
      const h = m.H(this.pos.x, this.pos.z);
      if (this.pos.y >= h) break;
      m.normal(this.pos.x, this.pos.z, nTmp);
      const depth = (h - this.pos.y) * nTmp.y;
      this.pos.x += nTmp.x * depth;
      this.pos.y += nTmp.y * depth;
      this.pos.z += nTmp.z * depth;
    }
    const h = m.H(this.pos.x, this.pos.z);
    if (this.pos.y < h) this.pos.y = h;
    m.normal(this.pos.x, this.pos.z, nTmp);
  }

  // ---------------------------------------------------------------- takeoff / air
  takeoff(inp, ollie) {
    if (this.butterRec) this.finishButter();
    this.butter = 0;
    const n = this.n;
    this.mode = 'air';
    this.airTime = 0;
    this.upBase.copy(n);
    // vert assist: launching off a near-vertical wall sends you back into the transition
    if (n.y < 0.45) {
      const hn = tmpV.set(n.x, 0, n.z);
      if (hn.lengthSq() > 1e-4) {
        hn.normalize();
        const along = this.vel.dot(hn);
        this.vel.addScaledVector(hn, 1.1 - along);
      }
      this.vertAir = true;
    } else this.vertAir = false;
    this.computeYawNat(true);
    // board yaw relative to travel (keeps current sideways/switch state)
    const boardYaw = yawOf(this.heading, this.upBase);
    this.yawOffset = wrap(boardYaw - this.yawNat);
    this.takeoffSwitch = this.switch;
    this.fromSideways = false;
    if (this.fromRail) { this.fromSideways = this.fromRail.sideways; this.fromRail = null; }
    this.spin = 0; this.flip = 0; this.roll = 0;
    const steer = (inp.left ? 1 : 0) - (inp.right ? 1 : 0);
    const fl = (inp.up ? 1 : 0) - (inp.down ? 1 : 0);
    // pre-wind gives an instant rotation kick
    this.spinRate = steer * this.p.spinMax * 0.55;
    this.flipRate = fl * this.p.flipMax * 0.4;
    this.rollRate = 0;
    this.grabs = [];
    this.grabIdx = -1;
    this.charge = 0;
    this.predictT = 0;
    this.landingNormal = new V3().copy(Y);
    this.timeToLand = 1;
    this.events.push({ type: 'takeoff', ollie });
  }

  computeYawNat(force) {
    const up = this.upBase;
    const vp = tmpV.copy(this.vel).projectOnPlane(up);
    if (vp.lengthSq() < 1.0) return;
    const target = yawOf(vp, up);
    if (force) { this.yawNat = target; return; }
    const d = wrap(target - this.yawNat);
    this.yawNat = wrap(this.yawNat + clamp(d, -0.2, 0.2));
  }

  predictLanding() {
    const m = this.map;
    let x = this.pos.x, y = this.pos.y, z = this.pos.z;
    let vx = this.vel.x, vy = this.vel.y, vz = this.vel.z;
    const dt = 1 / 30;
    for (let t = 0; t < 6; t += dt) {
      vy -= G * dt;
      x += vx * dt; y += vy * dt; z += vz * dt;
      if (y < m.H(x, z)) {
        m.normal(x, z, nTmp);
        this.landingNormal.set(nTmp.x, nTmp.y, nTmp.z);
        this.timeToLand = t;
        return;
      }
    }
    this.landingNormal.copy(Y);
    this.timeToLand = 3;
  }

  stepAir(dt, inp) {
    const P = this.p;
    this.airTime += dt;
    this.vel.y -= G * dt;
    const sp = this.vel.length();
    this.vel.multiplyScalar(1 - 0.0016 * sp * dt);

    // rotation control
    const steer = (inp.left ? 1 : 0) - (inp.right ? 1 : 0);
    const fl = (inp.up ? 1 : 0) - (inp.down ? 1 : 0);
    const rl = (inp.rollR ? 1 : 0) - (inp.rollL ? 1 : 0);
    const resp = (target) => (target !== 0 ? 9 : 7);
    this.spinRate += (steer * P.spinMax - this.spinRate) * Math.min(1, resp(steer) * dt);
    this.flipRate += (fl * P.flipMax - this.flipRate) * Math.min(1, resp(fl) * dt);
    this.rollRate += (rl * P.rollMax - this.rollRate) * Math.min(1, resp(rl) * dt);
    // auto-finish: when no input, drift rotations toward the nearest landable angle
    if (!fl && this.timeToLand < 0.6) {
      const r = wrap(this.flip);
      if (Math.abs(r) < 1.0) this.flipRate += (-r * 6 - this.flipRate) * Math.min(1, 6 * dt);
    }
    if (!steer && this.timeToLand < 0.7) {
      // nearest orientation that lines the board up with the direction of travel
      const tot = this.yawOffset + this.spin;
      const e = tot - Math.round(tot / Math.PI) * Math.PI;
      if (Math.abs(e) < 0.9) this.spinRate += (-e * 7 - this.spinRate) * Math.min(1, 7 * dt);
    }
    if (!rl && this.timeToLand < 0.6) {
      const r = wrap(this.roll);
      if (Math.abs(r) < 1.0) this.rollRate += (-r * 6 - this.rollRate) * Math.min(1, 6 * dt);
    }
    this.spin += this.spinRate * dt;
    this.flip += this.flipRate * dt;
    this.roll += this.rollRate * dt;

    // grabs
    let gi = -1;
    for (let i = 0; i < 4; i++) if (inp.grab[i]) { gi = i + (inp.grabAlt ? 4 : 0); break; }
    if (gi < 0 && inp.grabJapan) gi = GRABS[this.sport].indexOf('Japan');
    if (gi < 0 && inp.grabTail) gi = GRABS[this.sport].indexOf('Tail');
    if (gi !== this.grabIdx) {
      this.grabIdx = gi;
      if (gi >= 0) this.grabs.push({ name: GRABS[this.sport][gi], time: 0, idx: gi });
    }
    if (gi >= 0 && this.grabs.length) this.grabs[this.grabs.length - 1].time += dt;
    this.grabBlend += ((gi >= 0 ? 1 : 0) - this.grabBlend) * Math.min(1, dt * 12);
    this.crouch += ((gi >= 0 ? 1 : 0.25 + Math.min(0.4, Math.abs(this.flipRate) * 0.05)) - this.crouch) * Math.min(1, dt * 8);

    // orientation base follows the predicted landing surface
    this.predictT -= dt;
    if (this.predictT <= 0) { this.predictLanding(); this.predictT = 0.05; }
    else this.timeToLand -= dt;
    const a = Math.min(1, dt / Math.max(0.12, this.timeToLand) * 1.4 + dt * 0.6);
    this.upBase.lerp(this.landingNormal, a).normalize();
    this.computeYawNat(false);

    this.pos.addScaledVector(this.vel, dt);
    this.checkRails(inp);
    if (this.mode !== 'air') return;

    const h = this.map.H(this.pos.x, this.pos.z);
    if (this.pos.y <= h) {
      this.resolvePenetration();
      this.n.set(nTmp.x, nTmp.y, nTmp.z);
      this.land();
    }
  }

  airRecord(landing) {
    return {
      kind: 'air', sport: this.sport, goofy: this.goofy, takeoffSwitch: this.takeoffSwitch,
      spin: this.spin, flip: this.flip, roll: this.roll, airTime: this.airTime,
      grabs: this.grabs.slice(), fromSideways: this.fromSideways, landing,
    };
  }

  isTrickWorthy(rec) {
    return rec.airTime > 0.45 || Math.abs(rec.spin) > 2.5 || Math.abs(rec.flip) > 3 || Math.abs(rec.roll) > 3 || rec.grabs.some((g) => g.time > 0.18);
  }

  land() {
    const n = this.n;
    this.updateQuat(1);
    const bodyUp = tmpV.set(0, 1, 0).applyQuaternion(this.quat);
    const bodyFwd = tmpV2.set(0, 0, 1).applyQuaternion(this.quat).projectOnPlane(n);
    const upDot = bodyUp.dot(n);
    const vn = this.vel.dot(n);
    const impact = -vn;
    this.vel.addScaledVector(n, -vn);
    const vt = tmpV3.copy(this.vel);
    let yawErr = 0;
    if (bodyFwd.lengthSq() > 1e-4 && vt.lengthSq() > 0.25) {
      bodyFwd.normalize();
      const c = Math.abs(bodyFwd.dot(vt.normalize()));
      yawErr = Math.acos(clamp(c, -1, 1));
    }
    const grabbing = this.grabIdx >= 0;
    const ok = upDot > Math.cos(58 * Math.PI / 180) && yawErr < 52 * Math.PI / 180 && impact < 26;
    const rec = this.airRecord('clean');
    if (!ok) {
      rec.landing = 'crash';
      this.crash(rec);
      return;
    }
    const sketchy = upDot < Math.cos(30 * Math.PI / 180) || yawErr > 28 * Math.PI / 180 || grabbing;
    rec.landing = sketchy ? 'sketchy' : 'clean';
    // settle onto the snow
    this.mode = 'ground';
    if (bodyFwd.lengthSq() > 1e-4) this.heading.copy(bodyFwd).projectOnPlane(n).normalize();
    this.switch = this.heading.dot(this.vel) < 0;
    if (sketchy) this.vel.multiplyScalar(0.72);
    this.landSquash = clamp(impact / 10, 0.2, 1);
    this.grabIdx = -1; this.grabBlend = 0;
    this.spinRate = this.flipRate = this.rollRate = 0;
    this.spin = this.flip = this.roll = 0;
    this.groundTime = 0;
    this.events.push({ type: 'land', impact, sketchy });
    if (this.isTrickWorthy(rec)) this.addTrick(rec);
  }

  // ---------------------------------------------------------------- tricks / combo
  addTrick(rec) {
    let name, pts;
    if (rec.kind === 'air') { name = nameAirTrick(rec); pts = scoreAirTrick(rec); }
    else if (rec.kind === 'butter') { name = rec.name; pts = rec.basePts; }
    else { name = nameRailTrick(rec); pts = scoreRailTrick(rec); }
    const seen = this.trickCounts[name] || 0;
    pts = Math.round(pts * Math.pow(0.75, seen));
    if (rec.landing === 'sketchy') pts = Math.round(pts * 0.6);
    rec.name = name; rec.pts = pts;
    this.combo.push(rec);
    this.comboTimer = 0;
    this.events.push({ type: 'trick', name, pts, landing: rec.landing, kind: rec.kind });
  }

  bankCombo() {
    if (!this.combo.length) return;
    const sum = this.combo.reduce((a, r) => a + r.pts, 0);
    const mult = this.combo.length;
    const total = sum * mult;
    for (const r of this.combo) this.trickCounts[r.name] = (this.trickCounts[r.name] || 0) + 1;
    this.runScore += total;
    this.events.push({ type: 'bank', total, mult, names: this.combo.map((r) => r.name) });
    this.combo = [];
    this.comboTimer = 0;
  }

  crash(rec) {
    this.mode = 'crash';
    this.crashT = 0;
    this.crashSpin = new V3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    this.crashQ = this.quat.clone();
    const lost = this.combo.reduce((a, r) => a + r.pts, 0) + (rec ? scoreAirTrick(rec) : 0);
    this.combo = [];
    this.events.push({ type: 'crash', lost, name: rec && this.isTrickWorthy(rec) ? nameAirTrick(rec) : null });
  }

  stepCrash(dt, inp) {
    const m = this.map;
    this.crashT += dt;
    this.vel.y -= G * dt;
    this.pos.addScaledVector(this.vel, dt);
    const h = m.H(this.pos.x, this.pos.z);
    if (this.pos.y <= h) {
      this.resolvePenetration();
      this.n.set(nTmp.x, nTmp.y, nTmp.z);
      const d = this.vel.dot(this.n);
      if (d < 0) this.vel.addScaledVector(this.n, -d * 1.25);
      this.vel.multiplyScalar(Math.exp(-dt * 2.2));
    }
    const sp = this.vel.length();
    tmpQ.setFromAxisAngle(this.crashSpin, Math.min(12, sp * 0.9) * dt);
    this.crashQ.premultiply(tmpQ);
    if (this.crashT > 2.2 || (this.crashT > 0.6 && inp.jumpPressed)) this.respawn();
  }

  // ---------------------------------------------------------------- rails
  checkRails(inp) {
    if (this.time - this.lastRailExit < 0.35) return;
    const rails = this.map.rails;
    const p = this.pos;
    for (let ri = 0; ri < rails.length; ri++) {
      const r = rails[ri];
      const pts = r.pts;
      for (let i = 0; i < pts.length - 1; i++) {
        const A = pts[i], B = pts[i + 1];
        const dx = B.x - A.x, dz = B.z - A.z;
        const len2 = dx * dx + dz * dz;
        let t = ((p.x - A.x) * dx + (p.z - A.z) * dz) / len2;
        if (t < 0 || t > 1) continue;
        const cx = A.x + dx * t, cz = A.z + dz * t, cy = A.y + (B.y - A.y) * t;
        const hd = Math.hypot(p.x - cx, p.z - cz);
        if (hd > r.width * 0.5 + 0.32) continue;
        const dy = p.y - cy;
        const dir = tmpV.set(B.x - A.x, B.y - A.y, B.z - A.z).normalize();
        const relVy = this.vel.y - dir.y * this.vel.dot(dir);
        const horiz = tmpV2.set(this.vel.x, 0, this.vel.z);
        const hl = horiz.length();
        if (hl < 1.5) continue;
        const align = Math.abs((horiz.x * dir.x + horiz.z * dir.z) / (hl * Math.hypot(dir.x, dir.z)));
        if (align < 0.75) continue;
        let ok = false;
        if (this.mode === 'air') ok = dy > -0.45 && dy < 0.35 && relVy < 0.6;
        else ok = dy > -0.18 && dy < 0.3;
        if (!ok) continue;
        this.enterRail(ri, i, t, dir);
        return;
      }
    }
  }

  enterRail(ri, seg, t, dirIn) {
    const dir = dirIn.clone(); // dirIn is a shared scratch vector that updateQuat() overwrites
    const r = this.map.rails[ri];
    let onSpin = 0;
    // board orientation relative to rail
    this.updateQuat(1);
    const bf = tmpV2.set(0, 0, 1).applyQuaternion(this.quat);
    bf.y = 0; bf.normalize();
    const hd = tmpV3.set(dir.x, 0, dir.z).normalize();
    let rel = Math.atan2(hd.x * bf.z - hd.z * bf.x, hd.dot(bf)); // signed angle from rail to board
    // snap to nearest quarter turn
    let q = Math.round(rel / (Math.PI / 2));
    if (this.mode === 'air') {
      // trick record of the air before the rail
      const rec = this.airRecord('clean');
      if (Math.abs(this.flip) > 1.2 || Math.abs(this.roll) > 1.2) {
        // can't lock on while inverted
        const r2 = wrap(this.flip), r3 = wrap(this.roll);
        if (Math.abs(r2) > 1.0 || Math.abs(r3) > 1.0) return;
      }
      onSpin = Math.round(Math.abs(this.spin) * 180 / Math.PI / 90) * 90;
      if (this.isTrickWorthy(rec) && (Math.abs(this.flip) > 3 || this.grabs.some((g) => g.time > 0.18))) this.addTrick(rec);
    }
    const speedAlong = this.vel.dot(dir);
    this.rail = {
      ri, seg, t, speed: speedAlong, slide: q * Math.PI / 2, slideAnim: rel, time: 0,
      onSpin, swaps: 0, press: null, prevSteer: 0, name: r.name,
      switch: (q & 1) === 0 ? (Math.abs(q) === 2) !== (speedAlong < 0) : false,
    };
    if (this.rail.slide > Math.PI) this.rail.slide -= TAU;
    if (this.rail.slide < -Math.PI) this.rail.slide += TAU;
    this.mode = 'rail';
    this.grabIdx = -1; this.grabBlend = 0;
    this.spin = this.flip = this.roll = 0;
    this.spinRate = this.flipRate = this.rollRate = 0;
    this.events.push({ type: 'rail', name: r.name });
    this.placeOnRail();
  }

  placeOnRail() {
    const r = this.map.rails[this.rail.ri];
    const A = r.pts[this.rail.seg], B = r.pts[this.rail.seg + 1];
    const t = this.rail.t;
    this.pos.set(A.x + (B.x - A.x) * t, A.y + (B.y - A.y) * t + (r.type === 'box' ? 0.06 : 0.03), A.z + (B.z - A.z) * t);
  }

  stepRail(dt, inp) {
    const R = this.rail;
    const r = this.map.rails[R.ri];
    R.time += dt;
    const A = r.pts[R.seg], B = r.pts[R.seg + 1];
    const dir = tmpV.set(B.x - A.x, B.y - A.y, B.z - A.z);
    const len = dir.length();
    dir.divideScalar(len);
    R.speed += -G * dir.y * dt;
    R.speed -= Math.sign(R.speed) * (0.6 + 0.004 * R.speed * R.speed) * dt;
    R.t += (R.speed * dt) / len;
    // swaps / presses
    const steer = (inp.left ? 1 : 0) - (inp.right ? 1 : 0);
    if (steer !== 0 && R.prevSteer === 0) {
      R.slide += steer * Math.PI / 2;
      if (R.slide > Math.PI + 0.01) R.slide -= TAU;
      if (R.slide < -Math.PI - 0.01) R.slide += TAU;
      R.swaps++;
    }
    R.prevSteer = steer;
    R.slideAnim += wrap(R.slide - R.slideAnim) * Math.min(1, dt * 14);
    const prs = inp.up ? 'nose' : inp.down ? 'tail' : null;
    if (prs) R.press = prs;
    this.press += ((inp.up ? 1 : inp.down ? -1 : 0) - this.press) * Math.min(1, dt * 10);
    this.crouch += (0.35 - this.crouch) * Math.min(1, dt * 8);

    let leave = false;
    while (R.t > 1) {
      if (R.seg < r.pts.length - 2) { R.seg++; R.t = (R.t - 1) * len / segLen(r, R.seg); }
      else { R.t = 1; leave = true; break; }
    }
    while (R.t < 0) {
      if (R.seg > 0) { R.seg--; R.t = 1 + R.t * len / segLen(r, R.seg); }
      else { R.t = 0; leave = true; break; }
    }
    this.placeOnRail();
    const A2 = r.pts[R.seg], B2 = r.pts[R.seg + 1];
    const d2 = tmpV2.set(B2.x - A2.x, B2.y - A2.y, B2.z - A2.z).normalize();
    this.vel.copy(d2).multiplyScalar(R.speed);
    if (Math.abs(R.speed) < 0.4) leave = true;
    const jumpOff = !inp.jump && this.jumpHeld;
    if (leave || jumpOff) this.exitRail(inp, jumpOff);
  }

  exitRail(inp, jumped) {
    const R = this.rail;
    const sideways = Math.abs(Math.abs(wrap(R.slide)) - Math.PI / 2) < 0.3;
    const rec = {
      kind: 'rail', sport: this.sport, goofy: this.goofy, slide: wrap(R.slide), press: R.press,
      switch: R.switch, onSpin: R.onSpin, time: R.time, swaps: R.swaps, railName: R.name, landing: 'clean',
    };
    if (R.time > 0.25) this.addTrick(rec);
    // set board heading from rail orientation
    this.updateQuat(1);
    this.heading.set(0, 0, 1).applyQuaternion(this.quat).normalize();
    this.n.set(0, 1, 0);
    this.switch = this.heading.dot(this.vel) < 0;
    this.vel.y += jumped ? this.p.ollie * 0.95 : 0.6;
    this.pos.y += 0.05;
    this.lastRailExit = this.time;
    this.fromRail = { sideways };
    this.press = 0;
    this.rail = null;
    this.mode = 'air';
    this.takeoff(inp, jumped);
  }

  // ---------------------------------------------------------------- orientation
  updateQuat(dt) {
    const q = this.quat;
    if (this.mode === 'ground') {
      baseQuat(this.n, q);
      const yaw = yawOf(this.heading, this.n);
      tmpQ.setFromAxisAngle(Y, yaw);
      q.multiply(tmpQ);
    } else if (this.mode === 'air') {
      baseQuat(this.upBase, q);
      tmpQ.setFromAxisAngle(Y, this.yawNat + this.yawOffset + this.spin);
      q.multiply(tmpQ);
      tmpQ.setFromAxisAngle(tmpV.set(1, 0, 0), this.flip);
      q.multiply(tmpQ);
      tmpQ.setFromAxisAngle(tmpV.set(0, 0, 1), -this.roll);
      q.multiply(tmpQ);
    } else if (this.mode === 'rail') {
      const r = this.map.rails[this.rail.ri];
      const A = r.pts[this.rail.seg], B = r.pts[this.rail.seg + 1];
      const d = tmpV2.set(B.x - A.x, B.y - A.y, B.z - A.z).normalize();
      const yaw = Math.atan2(d.x, d.z) + this.rail.slideAnim;
      tmpQ.setFromAxisAngle(Y, yaw);
      // pitch to follow rail slope
      const pitch = -Math.asin(clamp(d.y, -1, 1)) * Math.cos(this.rail.slideAnim);
      tmpQ2.setFromAxisAngle(tmpV.set(1, 0, 0), pitch);
      q.copy(tmpQ).multiply(tmpQ2);
    } else if (this.mode === 'crash') {
      q.copy(this.crashQ);
    }
  }
}

function segLen(r, i) {
  const A = r.pts[i], B = r.pts[i + 1];
  return Math.hypot(B.x - A.x, B.y - A.y, B.z - A.z);
}
