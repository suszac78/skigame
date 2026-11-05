// Trick names, grab definitions and scoring.

export const GRABS = {
  snowboard: ['Indy', 'Melon', 'Nose', 'Tail', 'Mute', 'Stalefish', 'Method', 'Japan'],
  ski: ['Safety', 'Mute', 'Japan', 'Tail', 'Critical', 'Blunt', 'Truck Driver', 'Octo'],
};

const MULT = ['', '', 'Double ', 'Triple ', 'Quad ', 'Quint '];

function roundTo(v, step) { return Math.round(v / step) * step; }

// rec: { sport, goofy, takeoffSwitch, spin (rad, + = left/ccw), flip (+ = front), roll, airTime,
//        grabs: [{name,time}], fromSideways (bool), landing: 'clean'|'sketchy'|'crash' }
export function nameAirTrick(rec) {
  const spinDeg = Math.abs(rec.spin) * 180 / Math.PI;
  const step = rec.fromSideways ? 90 : 180;
  let deg = roundTo(spinDeg, step);
  if (rec.fromSideways && deg === 0) deg = 90;
  const flips = Math.round(Math.abs(rec.flip) / (2 * Math.PI));
  const rolls = Math.round(Math.abs(rec.roll) / (2 * Math.PI));
  const totalInv = flips + rolls;
  const left = rec.spin > 0;
  let dirWord = '';
  let prefix = '';
  if (rec.sport === 'snowboard') {
    // regular rider: left (counter-clockwise) spins are frontside
    let fs = left;
    if (rec.goofy) fs = !fs;
    if (rec.takeoffSwitch) fs = !fs;
    if (rec.takeoffSwitch) prefix = fs ? 'Cab ' : 'Switch BS ';
    else dirWord = fs ? 'FS ' : 'BS ';
  } else {
    if (rec.takeoffSwitch) prefix = 'Switch ';
    dirWord = left ? 'Left ' : 'Right ';
  }
  let core;
  if (totalInv === 0) {
    if (deg === 0) core = 'Straight Air';
    else core = (prefix || dirWord) + deg;
  } else if (deg < 180) {
    // flips with little spin
    const mult = MULT[Math.min(totalInv, 5)];
    if (rolls > flips) core = prefix + mult + 'Side Flip';
    else if (rec.flip > 0) core = prefix + mult + 'Tamedog';
    else core = prefix + mult + 'Wildcat';
  } else {
    const mult = MULT[Math.min(totalInv, 5)];
    let kind;
    if (rolls > flips) kind = 'Rodeo';
    else if (rec.flip > 0) kind = 'Misty';
    else kind = 'Cork';
    if (rec.sport === 'snowboard') core = (prefix || dirWord) + mult + kind + ' ' + deg;
    else core = prefix + dirWord + mult + kind + ' ' + deg;
  }
  const g = rec.grabs.filter((x) => x.time > 0.18);
  if (g.length) core += ' ' + g.map((x) => x.name).join(' to ');
  return core.replace(/\s+/g, ' ').trim();
}

export function scoreAirTrick(rec) {
  const spinDeg = roundTo(Math.abs(rec.spin) * 180 / Math.PI, 90);
  const flips = Math.round(Math.abs(rec.flip) / (2 * Math.PI));
  const rolls = Math.round(Math.abs(rec.roll) / (2 * Math.PI));
  let pts = 50 + spinDeg * 1.2 + flips * 450 + rolls * 400 + rec.airTime * 60;
  if (flips + rolls > 0 && spinDeg >= 360) pts *= 1.25; // off-axis bonus
  for (const g of rec.grabs) if (g.time > 0.18) pts += Math.min(700, 150 + g.time * 420);
  if (rec.takeoffSwitch) pts *= 1.15;
  return Math.round(pts);
}

export function nameRailTrick(rec) {
  // rec: { sport, goofy, slide (rad, 0 = 50-50, +-PI/2 = sideways), press: 'nose'|'tail'|null, switch, railName, onSpin, time }
  const sideways = Math.abs(Math.abs(rec.slide) - Math.PI / 2) < 0.3;
  let core;
  if (rec.sport === 'snowboard') {
    if (sideways) core = rec.slide > 0 !== !!rec.goofy ? 'Boardslide' : 'Lipslide';
    else if (rec.press === 'nose') core = 'Nose Press';
    else if (rec.press === 'tail') core = 'Tail Press';
    else core = '50-50';
  } else {
    if (sideways) core = rec.slide > 0 ? 'Left Slide' : 'Right Slide';
    else if (rec.press === 'nose') core = 'Nose Butter Slide';
    else if (rec.press === 'tail') core = 'Tail Butter Slide';
    else core = 'Straight Slide';
  }
  let name = '';
  if (rec.switch) name += 'Switch ';
  if (rec.onSpin >= 90) name += rec.onSpin + ' On ';
  name += core;
  if (rec.swaps > 0) name += ' (' + rec.swaps + 'x swap)';
  return name;
}

export function scoreRailTrick(rec) {
  let pts = 120 + rec.time * 380 + rec.onSpin * 1.0 + (rec.swaps || 0) * 120;
  if (Math.abs(Math.abs(rec.slide) - Math.PI / 2) < 0.3) pts *= 1.2;
  if (rec.press) pts *= 1.15;
  if (rec.switch) pts *= 1.1;
  return Math.round(pts);
}
