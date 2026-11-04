// Keyboard (rebindable) + gamepad input.

export const ACTIONS = [
  { id: 'left', label: 'Turn / Spin Left' },
  { id: 'right', label: 'Turn / Spin Right' },
  { id: 'up', label: 'Tuck / Frontflip / Nose press' },
  { id: 'down', label: 'Brake / Backflip / Tail press' },
  { id: 'jump', label: 'Jump (hold to charge, release to pop)' },
  { id: 'grab1', label: 'Grab 1' },
  { id: 'grab2', label: 'Grab 2' },
  { id: 'grab3', label: 'Grab 3' },
  { id: 'grab4', label: 'Grab 4' },
  { id: 'grabAlt', label: 'Alt grab set (hold)' },
  { id: 'rollL', label: 'Roll Left (side flips / rodeos)' },
  { id: 'rollR', label: 'Roll Right (side flips / rodeos)' },
  { id: 'reset', label: 'Respawn at checkpoint' },
  { id: 'camera', label: 'Change camera' },
  { id: 'pause', label: 'Pause' },
];

export const DEFAULT_BINDS = {
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  jump: ['Space', ''],
  grab1: ['KeyJ', 'Numpad4'],
  grab2: ['KeyK', 'Numpad5'],
  grab3: ['KeyL', 'Numpad6'],
  grab4: ['KeyI', 'Numpad8'],
  grabAlt: ['ShiftLeft', 'ShiftRight'],
  rollL: ['KeyQ', ''],
  rollR: ['KeyE', ''],
  reset: ['KeyR', ''],
  camera: ['KeyC', ''],
  pause: ['Escape', 'KeyP'],
};

const STORE = 'frostline.binds.v1';

export function keyLabel(code) {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Arrow')) return { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' }[code];
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  return code.replace('Left', ' L').replace('Right', ' R');
}

export class Input {
  constructor() {
    this.binds = this.load();
    this.down = new Set();
    this.pressedOnce = new Set();
    this.capture = null; // callback when rebinding
    window.addEventListener('keydown', (e) => {
      if (this.capture) {
        e.preventDefault();
        const cb = this.capture;
        this.capture = null;
        cb(e.code);
        return;
      }
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
      if (!this.down.has(e.code)) this.pressedOnce.add(e.code);
      this.down.add(e.code);
      if (this.isBound(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => { this.down.delete(e.code); });
    window.addEventListener('blur', () => this.down.clear());
    this.padPrev = {};
    this.padPressed = {};
    this.pollPad();
  }

  load() {
    const b = JSON.parse(JSON.stringify(DEFAULT_BINDS));
    try {
      const s = JSON.parse(localStorage.getItem(STORE) || 'null');
      if (s) for (const k in b) if (Array.isArray(s[k])) b[k] = [s[k][0] || '', s[k][1] || ''];
    } catch (e) { /* storage unavailable */ }
    return b;
  }
  save() { try { localStorage.setItem(STORE, JSON.stringify(this.binds)); } catch (e) { /* ignore */ } }
  resetDefaults() { this.binds = JSON.parse(JSON.stringify(DEFAULT_BINDS)); this.save(); }
  setBind(action, slot, code) {
    // remove the key from any other action so a key does one thing
    for (const a in this.binds) for (let i = 0; i < 2; i++) if (this.binds[a][i] === code) this.binds[a][i] = '';
    this.binds[action][slot] = code;
    this.save();
  }
  isBound(code) { for (const a in this.binds) if (this.binds[a].includes(code)) return true; return false; }
  held(a) { const b = this.binds[a]; return this.down.has(b[0]) || this.down.has(b[1]); }
  pressed(a) {
    const b = this.binds[a];
    return this.pressedOnce.has(b[0]) || this.pressedOnce.has(b[1]) || !!this.padPressed[a];
  }

  // snapshot for physics
  poll() {
    this.pollPad();
    const p = this.pad;
    const s = {
      left: this.held('left') || p.left,
      right: this.held('right') || p.right,
      up: this.held('up') || p.up,
      down: this.held('down') || p.down,
      jump: this.held('jump') || p.jump,
      grab: [this.held('grab1') || p.g1, this.held('grab2') || p.g2, this.held('grab3') || p.g3, this.held('grab4') || p.g4],
      grabAlt: this.held('grabAlt') || p.alt,
      rollL: this.held('rollL') || p.rollL,
      rollR: this.held('rollR') || p.rollR,
      jumpPressed: this.pressed('jump'),
    };
    return s;
  }
  endFrame() { this.pressedOnce.clear(); this.padPressed = {}; }

  pollPad() {
    this.pad = { left: false, right: false, up: false, down: false, jump: false, g1: false, g2: false, g3: false, g4: false, alt: false, rollL: false, rollR: false };
    this.padPressed = this.padPressed || {};
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = pads && Array.from(pads).find((x) => x && x.connected);
    if (!gp) return;
    const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
    const b = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
    const P = this.pad;
    P.left = ax < -0.4 || b(14); P.right = ax > 0.4 || b(15);
    P.up = ay < -0.4 || b(12); P.down = ay > 0.4 || b(13);
    P.jump = b(0);
    P.g1 = b(2); P.g2 = b(1); P.g3 = b(3); P.g4 = b(7);
    P.alt = b(6);
    P.rollL = b(4); P.rollR = b(5);
    const edge = (name, val) => { if (val && !this.padPrev[name]) this.padPressed[name] = true; this.padPrev[name] = val; };
    edge('jump', P.jump); edge('pause', b(9)); edge('reset', b(8)); edge('camera', b(11) || b(10));
  }
}
