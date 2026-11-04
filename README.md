# Frostline

A 3D snow park game in the browser, built with WebGL (three.js). Ride **snowboard or ski** through a slopestyle course, a big air jump and a superpipe. Spin, flip, cork, grab and grind.

This is an original game. The maps, rider, art and code were all made for this project.

## Play

It's a static site with no build step. Serve the folder and open `index.html`:

```bash
python3 -m http.server 8000
```

Then go to http://localhost:8000. (Opening the file straight from disk won't work, because browsers block ES modules on `file://`.)

It also works as-is on GitHub Pages.

## Courses

- **Slopestyle**: three rails and boxes (ride-on box, straight rail, kinked rail), three table-top jumps that get bigger, a second rail garden (rainbow rail, long box, down rail, gap rail, wall box) and a quarter pipe at the end.
- **Big Air**: a tall start tower, a 36° kicker and a long landing.
- **Superpipe**: a 220 m halfpipe. Ride up a wall to launch straight up and come back down into the pipe.

## Default controls (rebind them in the menu)

| Key | Ground | Air | Rail |
|---|---|---|---|
| A / D or ← / → | carve | spin | swap 90° (boardslide / lipslide) |
| W / ↑ | tuck / push | frontflip | nose press |
| S / ↓ | brake | backflip | tail press |
| Space | hold to charge, release to ollie | | pop off |
| Q / E | | roll (side flips, rodeos) | |
| J K L I | | grabs 1–4 | |
| Shift + J K L I | | grabs 5–8 | |
| R | respawn at checkpoint | | |
| C | change camera | | |
| Esc / P | pause | | |

Grabs:
- **Snowboard:** Indy, Melon, Nose, Tail, plus Mute, Stalefish, Method, Japan.
- **Ski:** Safety, Mute, Japan, Tail, plus Critical, Blunt, Truck Driver, Octo.

Trick tips:
- Hold a direction while you pop (or at the lip) to pre-wind a spin.
- Spin plus backflip makes a **cork**, spin plus frontflip a **misty**, and spin plus roll a **rodeo**.
- Hold the keys longer for double or triple corks.
- Land with the board or skis pointing down the hill (forwards or switch).

Tricks chain into combos: rails into jumps into rails. The combo multiplier is the number of tricks in the chain. A combo is banked about 1.4 s after you land on the snow, and you lose it if you bail.

Gamepads work too:
- Left stick / d-pad: steer and flip
- A: jump
- X / B / Y / RT: grabs
- LT: alt grabs
- LB / RB: roll
- Start: pause

## Code layout

- `js/terrain.js`: map shapes. Height functions, the jump profile builder, rails.
- `js/physics.js`: rider physics. Carving, air rotation, landing checks, rails, combos.
- `js/tricks.js`: trick names and scoring.
- `js/rider.js`: the rider model and its posing.
- `js/world.js`: terrain mesh, park features, scenery, sky, snow particles.
- `js/input.js`: rebindable keys and gamepad.
- `js/main.js`: game loop, camera, HUD, menus.
- `js/sound.js`: sound effects.
- `lib/three.module.min.js`: three.js r160 (MIT).
