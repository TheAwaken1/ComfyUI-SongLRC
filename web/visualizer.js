// The Visualizer tab. One analyser feeds several styles:
//   Ring   - a spectrum ring round a core that swells on the kick, a waveform
//            traced inside it, and sparks thrown off on hard beats
//   Bars   - the classic spectrum, with a faint reflection under the baseline
//   Tunnel - spectrum-warped hexagons rushing out of a drifting vanishing point
//   Warp   - a starfield whose speed follows the song, kicking into hyperspace
// Kept free of ComfyUI imports; it only needs a canvas and an AnalyserNode.
// A canvas outside the page (the video export) keeps its own size and draws at
// options.scale instead of the screen's pixel ratio.

const BARS = 72; // spectrum bands; the ring mirrors them left and right

// One analyser setup for the node and the export. Light smoothing keeps hits
// sharp; the wide decibel window stops loud masters pinning every band at the top.
export function makeAnalyser(context) {
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.5;
  analyser.minDecibels = -90;
  analyser.maxDecibels = -12;
  return analyser;
}

export const STYLES = [
  ["ring", "Ring"],
  ["bars", "Bars"],
  ["tunnel", "Tunnel"],
  ["warp", "Warp"],
];

// ------------------------------------------------------------------- Ring

function makeRing() {
  const MAX_SPARKS = 140;
  const sparks = [];
  let spin = 0;

  function burst(cx, cy, radius, amount) {
    const count = Math.round(6 + amount * 18);
    for (let i = 0; i < count && sparks.length < MAX_SPARKS; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 60 + Math.random() * 180 * (0.5 + amount);
      sparks.push({
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1,
        size: 0.8 + Math.random() * 1.8,
        hue: 12 + Math.random() * 26,
      });
    }
  }

  return {
    fade: 0.32,
    blend: "lighter",
    layout: "inset",
    draw(ctx, f) {
      const { cx, cy, size, ratio, dt, bass, kick, pulse, levels, wave } = f;
      spin += dt * (0.12 + bass * 0.4 + pulse * 1.2);
      const core = size * (0.16 + bass * 0.04 + pulse * 0.035);
      const reach = size * 0.27;

      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, core * 1.9);
      glow.addColorStop(0, "rgba(255,178,122," + (0.22 + bass * 0.5).toFixed(3) + ")");
      glow.addColorStop(0.45, "rgba(150,47,58," + (0.18 + bass * 0.3).toFixed(3) + ")");
      glow.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cx, cy, core * 1.9, 0, Math.PI * 2);
      ctx.fill();

      // Spectrum ring, mirrored so the shape stays balanced.
      const step = Math.PI / BARS;
      ctx.lineCap = "round";
      ctx.lineWidth = Math.max(1.5 * ratio, ((Math.PI * 2 * core) / (BARS * 2)) * 0.55);
      for (let side = -1; side <= 1; side += 2) {
        for (let i = 0; i < BARS; i += 1) {
          const v = levels[i];
          const angle = -Math.PI / 2 + spin + side * (i + 0.5) * step;
          const length = 2 * ratio + Math.pow(v, 1.35) * reach;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          const hue = 18 - v * 30; // orange, leaning into crimson as it peaks
          ctx.strokeStyle =
            "hsla(" + hue.toFixed(1) + ",92%," + (48 + v * 30).toFixed(1) + "%," +
            (0.45 + v * 0.55).toFixed(3) + ")";
          ctx.beginPath();
          ctx.moveTo(cx + cos * core, cy + sin * core);
          ctx.lineTo(cx + cos * (core + length), cy + sin * (core + length));
          ctx.stroke();
        }
      }

      // Waveform traced round the inside of the core.
      if (wave) {
        ctx.lineWidth = 1.4 * ratio;
        ctx.strokeStyle = "rgba(255,226,205,0.75)";
        ctx.beginPath();
        const points = 160;
        for (let p = 0; p <= points; p += 1) {
          const s = wave[Math.floor(((p % points) / points) * wave.length)] / 128 - 1;
          const r = core * 0.72 + s * core * 0.45;
          const angle = (p / points) * Math.PI * 2 - spin * 0.5;
          const x = cx + Math.cos(angle) * r;
          const y = cy + Math.sin(angle) * r;
          if (p === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      // Outer halo that breathes with the beat.
      ctx.lineWidth = 1 * ratio;
      ctx.strokeStyle = "rgba(255,178,122," + (0.1 + bass * 0.35).toFixed(3) + ")";
      ctx.beginPath();
      ctx.arc(cx, cy, core + reach * (0.9 + bass * 0.3), 0, Math.PI * 2);
      ctx.stroke();

      if (kick) burst(cx, cy, core, Math.max(bass, 0.5));
      for (let i = sparks.length - 1; i >= 0; i -= 1) {
        const spark = sparks[i];
        spark.x += spark.vx * dt * ratio;
        spark.y += spark.vy * dt * ratio;
        spark.vx *= 0.985;
        spark.vy *= 0.985;
        spark.life -= dt * 0.9;
        if (spark.life <= 0) {
          sparks.splice(i, 1);
          continue;
        }
        ctx.fillStyle =
          "hsla(" + spark.hue.toFixed(0) + ",100%,70%," + spark.life.toFixed(3) + ")";
        ctx.beginPath();
        ctx.arc(spark.x, spark.y, spark.size * ratio, 0, Math.PI * 2);
        ctx.fill();
      }
    },
  };
}

// ------------------------------------------------------------------- Bars

function makeBars() {
  let flash = 0;

  return {
    fade: 0.8,
    blend: "source-over",
    layout: "inset",
    draw(ctx, f) {
      const { w, h, ratio, dt, kick, levels, bass } = f;
      flash = kick ? 1 : Math.max(0, flash - dt * 3);
      const base = h * 0.66;
      const tall = h * 0.52;
      const left = w * 0.05;
      const slot = (w * 0.9) / BARS;
      const width = Math.max(1, slot * 0.66);
      const lift = (v) => Math.pow(v, 1.25) * tall;

      // Floor glow that flares on the kick, flattened to an ellipse so it fades
      // out before the edges of the frame.
      const reach = Math.min(w * 0.5, (h - base) / 0.3);
      const floor = ctx.createRadialGradient(0, 0, 0, 0, 0, reach);
      floor.addColorStop(0, "rgba(255,120,60," + (0.14 + bass * 0.14 + flash * 0.25).toFixed(3) + ")");
      floor.addColorStop(1, "rgba(0,0,0,0)");
      ctx.save();
      ctx.translate(w / 2, base);
      ctx.scale(1, 0.3);
      ctx.fillStyle = floor;
      ctx.fillRect(-reach, -reach, reach * 2, reach * 2);
      ctx.restore();

      const up = ctx.createLinearGradient(0, base, 0, base - tall);
      up.addColorStop(0, "#6b2410");
      up.addColorStop(0.45, "#e0582a");
      up.addColorStop(0.8, "#ffb27a");
      up.addColorStop(1, "#fff0e0");
      const down = ctx.createLinearGradient(0, base, 0, base + tall * 0.4);
      down.addColorStop(0, "rgba(224,88,42,.32)");
      down.addColorStop(1, "rgba(224,88,42,0)");

      for (let i = 0; i < BARS; i += 1) {
        const v = levels[i];
        const x = left + i * slot + (slot - width) / 2;
        const height = Math.max(2 * ratio, lift(v));

        ctx.fillStyle = up;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, base - height, width, height, [width / 2, width / 2, 0, 0]);
        else ctx.rect(x, base - height, width, height);
        ctx.fill();

        ctx.fillStyle = down;
        ctx.fillRect(x, base + 3 * ratio, width, height * 0.4);
      }

      ctx.fillStyle = "rgba(255,178,122," + (0.35 + flash * 0.5).toFixed(3) + ")";
      ctx.fillRect(left, base, w * 0.9, 1.5 * ratio);
    },
  };
}

// ----------------------------------------------------------------- Tunnel

function makeTunnel() {
  const rings = [];
  let clock = 0;
  let spin = 0;
  let shakeX = 0;
  let shakeY = 0;

  return {
    fade: 0.4,
    blend: "source-over",
    layout: "full",
    draw(ctx, f) {
      const { w, h, size, ratio, dt, t, bass, energy, kick, pulse, punch, levels } = f;
      // Cruise slowly between beats and surge on every kick.
      const speed = 0.1 + energy * 0.3 + pulse * 1.4;
      spin += dt * (0.1 + pulse * 1.5);
      clock += dt;
      while (clock > 0.35) {
        clock -= 0.35;
        rings.push({ z: 1, bright: 0, twist: spin });
      }
      if (kick) {
        rings.push({ z: 1, bright: 1, twist: spin });
        shakeX = (Math.random() - 0.5) * size * 0.05;
        shakeY = (Math.random() - 0.5) * size * 0.05;
      }
      shakeX *= Math.exp(-dt / 0.12);
      shakeY *= Math.exp(-dt / 0.12);

      // A vanishing point that drifts, so the camera seems to fly a curve,
      // and jolts on the kick.
      const vx = w / 2 + Math.sin(t * 0.6) * w * 0.05 + shakeX;
      const vy = h / 2 + Math.cos(t * 0.45) * h * 0.05 + shakeY;
      const core = ctx.createRadialGradient(vx, vy, 0, vx, vy, size * 0.3);
      core.addColorStop(0, "rgba(255,190,140," + (0.25 + bass * 0.45).toFixed(3) + ")");
      core.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = core;
      ctx.fillRect(vx - size * 0.3, vy - size * 0.3, size * 0.6, size * 0.6);

      const reach = Math.hypot(w, h);
      const points = 96;
      const sector = Math.PI / 3;
      for (let i = rings.length - 1; i >= 0; i -= 1) {
        const ring = rings[i];
        ring.z -= dt * speed * (0.35 + (1 - ring.z));
        const radius = (size * 0.08) / Math.max(ring.z, 0.02);
        if (ring.z <= 0.02 || radius > reach) {
          rings.splice(i, 1);
          continue;
        }
        const near = 1 - ring.z;
        ctx.lineWidth = (0.7 + near * near * 3 + ring.bright * 2.5) * ratio;
        ctx.strokeStyle =
          "hsla(" + ((340 + near * 45) % 360).toFixed(1) + ",95%," +
          (38 + near * 20 + ring.bright * 22 + pulse * 10).toFixed(1) + "%," +
          (Math.min(1, near * 1.6) * (0.3 + 0.6 * near)).toFixed(3) + ")";
        ctx.beginPath();
        for (let p = 0; p <= points; p += 1) {
          const angle = ring.twist + (p / points) * Math.PI * 2;
          const hex = Math.cos(sector / 2) /
            Math.cos((((angle % sector) + sector) % sector) - sector / 2);
          const band = p <= points / 2 ? p : points - p; // mirrored spectrum
          const level = levels[Math.min(BARS - 1, Math.floor((band / (points / 2)) * BARS))];
          const r = radius * hex * (1 + level * near * (0.3 + punch * 0.4));
          const x = vx + Math.cos(angle) * r;
          const y = vy + Math.sin(angle) * r;
          if (p === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    },
  };
}

// ------------------------------------------------------------------- Warp

function makeWarp() {
  const COUNT = 520;
  const stars = [];
  let boost = 0;
  let spin = 0;

  function reset(star, far) {
    star.x = Math.random() * 2 - 1;
    star.y = Math.random() * 2 - 1;
    star.z = far ? 1 : 0.05 + Math.random() * 0.95;
    star.pz = star.z;
    star.hue = 18 + Math.random() * 30;
    star.band = Math.floor(Math.random() * BARS);
    return star;
  }
  for (let i = 0; i < COUNT; i += 1) stars.push(reset({}, false));

  return {
    fade: 0.3,
    blend: "lighter",
    layout: "full",
    draw(ctx, f) {
      const { w, h, cx, cy, size, ratio, dt, energy, pulse, levels } = f;
      boost = pulse;
      const speed = 0.04 + energy * 0.35 + pulse * 1.5;
      spin += dt * (0.03 + pulse * 0.4);
      const cos = Math.cos(spin);
      const sin = Math.sin(spin);
      const spread = size * 0.55;

      if (boost > 0) {
        const flash = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.7);
        flash.addColorStop(0, "rgba(255,200,160," + (boost * 0.2).toFixed(3) + ")");
        flash.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = flash;
        ctx.fillRect(0, 0, w, h);
      }

      ctx.lineCap = "round";
      for (const star of stars) {
        star.pz = star.z;
        star.z -= dt * speed;
        if (star.z <= 0.02) {
          reset(star, true);
          continue;
        }
        const rx = star.x * cos - star.y * sin;
        const ry = star.x * sin + star.y * cos;
        const x = cx + (rx / star.z) * spread;
        const y = cy + (ry / star.z) * spread;
        if (x < -20 || x > w + 20 || y < -20 || y > h + 20) {
          reset(star, true);
          continue;
        }
        const px = cx + (rx / star.pz) * spread;
        const py = cy + (ry / star.pz) * spread;
        const near = 1 - star.z;
        // Each star follows one band of the spectrum, so the field sparkles with the mix.
        const lit = 0.35 + levels[star.band] * 0.9;
        ctx.strokeStyle =
          "hsla(" + star.hue.toFixed(0) + ",100%," + (60 + near * 30).toFixed(0) + "%," +
          Math.min(1, (0.1 + near * 1.3) * lit).toFixed(3) + ")";
        ctx.lineWidth = (0.6 + near * near * 3) * (0.7 + lit * 0.5) * ratio;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
    },
  };
}

const MAKERS = { ring: makeRing, bars: makeBars, tunnel: makeTunnel, warp: makeWarp };

// ------------------------------------------------------------------ engine

export function createVisualizer(canvas, options = {}) {
  const ctx = canvas.getContext("2d");
  let analyser = null;
  let freq = null;
  let wave = null;
  let frame = 0;
  let running = false;
  let last = 0;
  const levels = new Float32Array(BARS);
  // Each band's recent average; a band lights up by how far it jumps above it.
  const average = new Float32Array(BARS);
  let bassSlow = 0;
  let bassBefore = 0;
  let sinceKick = 1;
  let pulse = 0;
  let style = null;
  let styleName = "";

  function setStyle(name) {
    const chosen = MAKERS[name] ? name : "ring";
    if (chosen === styleName) return;
    styleName = chosen;
    style = MAKERS[chosen]();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  setStyle(options.style);

  function fit() {
    if (!canvas.isConnected) return options.scale || 1;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    return ratio;
  }

  // Map the useful part of the spectrum onto the bands on a log scale, so the
  // bass does not swallow half the display. Returns the beat measures the
  // styles move with: bass (0-1), kick (a beat just landed), pulse (1 on a
  // kick, decaying fast) and punch (how far the bass is above its recent level).
  function sample(dt) {
    if (!analyser) {
      const t = performance.now() / 1000;
      for (let i = 0; i < BARS; i += 1) levels[i] = 0.06 + 0.04 * Math.sin(t * 1.6 + i * 0.35);
      return { bass: 0.08 + 0.05 * Math.sin(t * 2), kick: false, pulse: 0, punch: 0 };
    }
    analyser.getByteFrequencyData(freq);
    analyser.getByteTimeDomainData(wave);
    const top = Math.floor(freq.length * 0.7);
    const follow = 1 - Math.exp(-dt / 0.5);
    for (let i = 0; i < BARS; i += 1) {
      const from = Math.floor(Math.pow(top, i / BARS));
      const to = Math.max(from + 1, Math.floor(Math.pow(top, (i + 1) / BARS)));
      let peak = 0;
      for (let b = from; b < to && b < freq.length; b += 1) peak = Math.max(peak, freq[b]);
      // Lift the treble, which sits much lower than the bass in raw energy.
      const raw = Math.min(1, (peak / 255) * (0.85 + (i / BARS) * 0.45));
      average[i] += (raw - average[i]) * follow;
      // A steady band sits at part height; hits jump well above it.
      levels[i] = Math.min(1, raw * 0.6 + Math.max(0, raw - average[i]) * 2.4);
    }

    // Kick drum: the lowest bands (~20-130 Hz) rising sharply past their recent level.
    let bass = 0;
    for (let b = 1; b < 7; b += 1) bass += freq[b];
    bass /= 6 * 255;
    bassSlow += (bass - bassSlow) * (1 - Math.exp(-dt / 0.45));
    const rise = bass - bassBefore;
    bassBefore = bass;
    sinceKick += dt;
    const kick = sinceKick > 0.18 && bass > 0.3 && bass > bassSlow * 1.08 + 0.02 && rise > 0.01;
    if (kick) sinceKick = 0;
    pulse = kick ? 1 : pulse * Math.exp(-dt / 0.16);
    const punch = Math.min(1, Math.max(0, (bass - bassSlow) * 5));
    return { bass, kick, pulse, punch };
  }

  function loop(now) {
    if (!running) return;
    frame = requestAnimationFrame(loop);
    paint(now);
  }

  function paint(now) {
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016);
    last = now;
    const ratio = fit();
    const w = canvas.width;
    const h = canvas.height;
    const { bass, kick, pulse: beat, punch } = sample(dt);
    let energy = 0;
    for (let i = 0; i < BARS; i += 1) energy += levels[i];
    energy /= BARS;

    // Fade the last frame instead of wiping it, which leaves short motion trails.
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "rgba(0,0,0," + style.fade + ")";
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = style.blend;
    style.draw(ctx, {
      w, h, cx: w / 2, cy: h / 2, size: Math.min(w, h), ratio, dt, t: now / 1000,
      bass, energy, kick, pulse: beat, punch, levels, wave,
    });
    ctx.globalCompositeOperation = "source-over";
  }

  return {
    attach(node) {
      analyser = node;
      freq = new Uint8Array(node.frequencyBinCount);
      wave = new Uint8Array(node.fftSize);
    },
    setStyle,
    // "inset" styles are framed with room around them; "full" ones fill the frame.
    get layout() {
      return style.layout;
    },
    // One frame, for a caller that runs its own loop.
    paint,
    start() {
      if (running) return;
      running = true;
      last = 0;
      frame = requestAnimationFrame(loop);
    },
    stop() {
      running = false;
      cancelAnimationFrame(frame);
    },
  };
}
