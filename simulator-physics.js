// Educational six-degree-of-freedom rigid bodies; SI units, not flight software.
export const RAD = Math.PI / 180;
export const DT = 0.01;
export const P = Object.freeze({
  gravity: 9.81, padTolerance: 3, verticalLimit: 2, horizontalLimit: 1,
  tiltLimit: 5, maxTime: 120, trialTime: 30, altitudeLimit: 1,
  hoverRadius: 2, hoverSpeed: 1, settleDuration: 5,
  catchHeight: 50, catchRadius: 5, catchVerticalLimit: 3,
  catchLateralLimit: 2, catchTiltLimit: 6,
});
export const DEFAULTS = Object.freeze({
  mode: 'landing', kp: 4, ki: 0.2, kd: 3, wind: 0, windY: 0,
  ignition: 650, offset: -60, dryMass: 35, fuelMass: 15, monoMass: 2,
  targetAltitude: 15, controllerFeedback: 'sensors', gnssEnabled: true,
  maxThrust: 1200, monoMaxThrust: 45, gimbalLimitDeg: null,
  gimbalLag: 0.08, throttleLag: null, thrustDelay: 0, sensorSeed: 7319,
  initialRollDeg: -6, initialPitchDeg: null, initialYawDeg: 0,
});
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function vehicle(config = DEFAULTS) {
  const c = { ...DEFAULTS, ...config };
  const mono = c.mode === 'monocopter';
  const length = mono ? 0.75 : 3, radius = mono ? 0.28 : 0.15;
  const dryMass = Math.max(0.1, mono ? c.monoMass : c.dryMass);
  return {
    kind: mono ? 'monocopter' : 'rocket', dryMass,
    initialFuel: mono ? 0 : Math.max(0, c.fuelMass), length, radius,
    footDepth: mono ? 0.45 : 1.7, footWidth: mono ? 0.35 : 0.8,
    // Signed body-Z thrust application point, relative to the center of mass.
    lever: mono ? 0.45 : -1.25,
    maxThrust: Math.max(0, mono ? c.monoMaxThrust : c.maxThrust),
    gimbalLimit: clamp(c.gimbalLimitDeg ?? (mono ? 18 : 12), 0, 60) * RAD,
    gimbalLag: Math.max(0, c.gimbalLag),
    throttleLag: Math.max(0, c.throttleLag ?? (mono ? 0.1 : 0.18)),
    thrustDelay: clamp(c.thrustDelay, 0, 10), isp: 220,
    axialArea: mono ? 0.16 : 0.075, lateralArea: mono ? 0.25 : 0.9,
    axialCd: 0.45, lateralCd: 0.8,
    // Cylindrical dry body and a centered, shorter cylindrical fuel tank.
    dryInertia: [
      dryMass * (3 * radius ** 2 + length ** 2) / 12,
      dryMass * (3 * radius ** 2 + length ** 2) / 12,
      dryMass * radius ** 2 / 2,
    ],
    fuelInertia: [(3 * 0.12 ** 2 + 1.6 ** 2) / 12,
      (3 * 0.12 ** 2 + 1.6 ** 2) / 12, 0.12 ** 2 / 2],
    angularDrag: mono ? 0.035 : 0.6,
    yawDrag: mono ? 0.02 : 0.04,
    // Propeller reaction torque per unit thrust; no commanded yaw torque.
    reactionTorque: mono ? 0.0025 : 0,
  };
}

function normalize(q) {
  const n = Math.hypot(...q);
  for (let i = 0; i < 4; i++) q[i] /= n;
  return q;
}

// Quaternion [w,x,y,z] maps body coordinates to world coordinates.
export function rotate(q, v) {
  const [w, x, y, z] = q, [a, b, c] = v;
  const tx = 2 * (y * c - z * b);
  const ty = 2 * (z * a - x * c);
  const tz = 2 * (x * b - y * a);
  return [a + w * tx + y * tz - z * ty,
    b + w * ty + z * tx - x * tz, c + w * tz + x * ty - y * tx];
}

function inverseRotate(q, v) {
  return rotate([q[0], -q[1], -q[2], -q[3]], v);
}

function thrustDirection(gimbal) {
  const x = Math.tan(gimbal[0]), y = Math.tan(gimbal[1]);
  const n = Math.hypot(x, y, 1);
  return [x / n, y / n, 1 / n];
}

export function attitude(s) {
  const [w, x, y, z] = s.q;
  return {
    roll: Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)),
    pitch: Math.asin(clamp(2 * (w * y - z * x), -1, 1)),
    yaw: Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)),
    tilt: Math.acos(clamp(1 - 2 * (x * x + y * y), -1, 1)),
  };
}

// Exact support heights of four square-mounted feet and the cylindrical body.
export function clearance(s) {
  const [w, x, y, z] = s.q, v = s.vehicle;
  const zx = 2 * (x * z - w * y), zy = 2 * (y * z + w * x);
  const zz = 1 - 2 * (x * x + y * y);
  const feet = -v.footDepth * zz - v.footWidth * (Math.abs(zx) + Math.abs(zy));
  const body = -v.length / 2 * Math.abs(zz) - v.radius * Math.hypot(zx, zy);
  return s.z + Math.min(feet, body);
}

function updateMass(s) {
  const v = s.vehicle;
  s.mass = v.dryMass + s.fuel;
  for (let i = 0; i < 3; i++) s.inertia[i] = v.dryInertia[i] + s.fuel * v.fuelInertia[i];
}

export function newState(config = DEFAULTS) {
  const c = { ...DEFAULTS, ...config }, v = vehicle(c);
  if (c.controllerFeedback !== 'sensors' && c.controllerFeedback !== 'truth') {
    throw new RangeError('controllerFeedback must be sensors or truth');
  }
  const landing = c.mode === 'landing' || c.mode === 'catch';
  const roll = c.initialRollDeg * RAD, pitch = (c.initialPitchDeg ?? (landing ? 85 : 8)) * RAD;
  const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2);
  const cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  const cy = Math.cos(c.initialYawDeg * RAD / 2), sy = Math.sin(c.initialYawDeg * RAD / 2);
  const s = {
    t: 0, x: landing ? c.offset : 0, y: 0, z: 0,
    vx: 0, vy: 0, vz: landing ? -25 : 0,
    q: [cr * cp * cy + sr * sp * sy, sr * cp * cy - cr * sp * sy,
      cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy], rates: [0, 0, 0],
    fuel: v.initialFuel, mass: v.dryMass + v.initialFuel, inertia: [0, 0, 0],
    thrust: landing ? 0 : Math.min(v.maxThrust, (v.dryMass + v.initialFuel) * P.gravity),
    gimbal: [0, 0], integral: [0, 0], reference: { roll: 0, pitch: 0 },
    phase: landing ? 'coast' : 'climb', trackingError: 0, settledTime: 0,
    ignitionTime: landing ? null : 0, done: false, result: null, vehicle: v,
    mode: c.mode, targetAltitude: c.targetAltitude, controllerFeedback: c.controllerFeedback,
  };
  updateMass(s);
  // Altitudes, including the commanded hover altitude, mean lowest-point clearance.
  s.z = (landing ? 1000 : 2) - clearance(s);
  s.command = { thrust: s.thrust, gimbal: [0, 0] };
  s.saturation = { gimbal: false, throttle: false };
  if (v.thrustDelay > 0) {
    s.thrustQueue = { values: new Float64Array(Math.ceil(v.thrustDelay / DT) + 3),
      times: new Float64Array(Math.ceil(v.thrustDelay / DT) + 3), head: 0, count: 0,
      applied: s.thrust, lastTick: -1 };
  }
  initializeSensors(s, c);
  s.feedback = feedbackSnapshot(s);
  return s;
}

// Copy the selected navigation input once per controller invocation. Actuator state,
// fuel, mass and inertia remain known model parameters, not navigation feedback.
function feedbackSnapshot(s) {
  const sensors = s.controllerFeedback === 'sensors', input = sensors ? s.estimate : s;
  return { source: s.controllerFeedback, x: input.x, y: input.y, vx: input.vx, vy: input.vy,
    clearance: sensors ? input.clearance : clearance(s), vz: input.vz,
    q: input.q.slice(), rates: input.rates.slice() };
}

function controller(s, c, dt) {
  const f = s.feedback = feedbackSnapshot(s), height = f.clearance, v = s.vehicle;
  const h = Math.max(0, height - (s.mode === 'catch' ? P.catchHeight : 0));
  const landing = s.mode === 'landing' || s.mode === 'catch';
  if (s.phase === 'coast' && height <= c.ignition) {
    s.phase = 'burn'; s.integral.fill(0); s.ignitionTime = s.t;
  }
  const tiltLimit = landing ? (h > 25 ? 0.3 : 0.06 + 0.24 * h / 25) : 0.3;
  const ax = clamp(-0.10 * f.x - 0.55 * f.vx, -3, 3);
  const ay = clamp(-0.10 * f.y - 0.55 * f.vy, -3, 3);
  const lateral = Math.hypot(ax, ay);
  const scale = lateral > 0 ? Math.min(1, Math.tan(tiltLimit) * P.gravity / lateral) : 1;
  const desired = [ax * scale, ay * scale, P.gravity];
  const norm = Math.hypot(...desired);
  for (let i = 0; i < 3; i++) desired[i] /= norm;
  s.reference.roll = s.phase === 'coast' ? 0 : Math.atan2(-ay * scale, P.gravity);
  s.reference.pitch = s.phase === 'coast' ? 0 : Math.atan2(ax * scale, P.gravity);
  if (s.phase === 'coast' || (v.kind === 'rocket' && s.fuel <= 0)) {
    s.saturation.gimbal = false; s.saturation.throttle = false;
    return { thrust: 0, gimbal: [0, 0] };
  }
  let az;
  if (landing) {
    let vRef = -Math.min(35, Math.sqrt(0.8 ** 2 + 2 * 4 * h));
    // A tilted entry needs alignment time before committing to terminal descent.
    // Use only the selected navigation feedback, never actual position in sensor mode.
    if (h < 60 && (Math.hypot(f.x, f.y) > P.padTolerance / 2 || Math.hypot(f.vx, f.vy) > 0.5)) {
      vRef = Math.max(vRef, -3);
    }
    const braking = vRef > -35 ? clamp(-4 * f.vz / -vRef, 0, 8) : 0;
    az = braking + 2.5 * (vRef - f.vz);
  } else {
    const vRef = clamp(0.8 * (c.targetAltitude - h), -3, 4);
    az = 2 * (vRef - f.vz);
    s.phase = Math.abs(c.targetAltitude - h) < 1 ? 'hold' : 'climb';
  }
  const thrustAxis = rotate(f.q, thrustDirection(s.gimbal));
  const requestedThrust = s.mass * (P.gravity + az) / Math.max(0.25, thrustAxis[2]);
  const thrust = clamp(requestedThrust, 0, v.maxThrust);
  s.saturation.throttle = requestedThrust >= v.maxThrust - 1e-9;
  const target = inverseRotate(f.q, desired);
  const error = [-target[1], target[0]];
  const [p, q, r] = f.rates, [ix, iy, iz] = s.inertia;
  const alpha = error.map((e, i) => c.kp * e + c.ki * s.integral[i] - c.kd * f.rates[i]);
  // Euler coupling compensation is roll/pitch only. Yaw remains entirely passive.
  const torqueX = ix * alpha[0] + (iz - iy) * q * r;
  const torqueY = iy * alpha[1] + (ix - iz) * p * r;
  const authority = v.lever * Math.max(s.thrust, 10);
  const requested = [torqueY / authority, -torqueX / authority];
  const limit = Math.sin(v.gimbalLimit);
  // Radial force clipping respects the total cone angle, not two independent cones.
  const magnitude = Math.hypot(...requested);
  const fraction = magnitude > limit ? limit / magnitude : 1;
  s.saturation.gimbal = magnitude > limit + 1e-9;
  const fx = requested[0] * fraction, fy = requested[1] * fraction;
  const fz = Math.sqrt(Math.max(0, 1 - fx * fx - fy * fy));
  const gimbal = [Math.atan2(fx, fz), Math.atan2(fy, fz)];
  // Conditional integration prevents accumulating error behind actuator saturation.
  if (magnitude <= limit && thrust > 0 && s.thrust > 1) {
    for (let i = 0; i < 2; i++) s.integral[i] = clamp(s.integral[i] + error[i] * dt, -0.5, 0.5);
  }
  return { thrust, gimbal };
}

function derivative(s, c) {
  const v = s.vehicle, [p, q, r] = s.rates;
  const inertia = v.dryInertia.map((value, i) => value + s.fuel * v.fuelInertia[i]);
  const mass = v.dryMass + s.fuel;
  const air = inverseRotate(s.q, [s.vx - c.wind, s.vy - c.windY, s.vz]);
  const rho = 1.225 * Math.exp(-Math.max(0, s.z) / 8500);
  const lateralSpeed = Math.hypot(air[0], air[1]);
  const drag = -0.5 * rho * v.lateralCd * v.lateralArea * lateralSpeed;
  const direction = thrustDirection(s.gimbal);
  const fx = s.thrust * direction[0], fy = s.thrust * direction[1];
  const force = rotate(s.q, [fx + drag * air[0], fy + drag * air[1],
    s.thrust * direction[2]
      - 0.5 * rho * v.axialCd * v.axialArea * Math.abs(air[2]) * air[2]]);
  const torque = [-v.lever * fy - v.angularDrag * p,
    v.lever * fx - v.angularDrag * q,
    v.reactionTorque * s.thrust - v.yawDrag * r * Math.abs(r)];
  const [ix, iy, iz] = inertia, [w, x, y, z] = s.q;
  return {
    x: s.vx, y: s.vy, z: s.vz,
    vx: force[0] / mass, vy: force[1] / mass, vz: force[2] / mass - P.gravity,
    rates: [(torque[0] + (iy - iz) * q * r) / ix,
      (torque[1] + (iz - ix) * r * p) / iy, (torque[2] + (ix - iy) * p * q) / iz],
    q: [-(x * p + y * q + z * r) / 2, (w * p + y * r - z * q) / 2,
      (w * q + z * p - x * r) / 2, (w * r + x * q - y * p) / 2],
    fuel: v.kind === 'rocket' ? -s.thrust / (v.isp * 9.80665) : 0,
  };
}

const LINEAR = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'fuel'];
function advance(s, d, dt) {
  const out = { ...s, q: s.q.slice(), rates: s.rates.slice() };
  for (const key of LINEAR) out[key] += d[key] * dt;
  out.fuel = Math.max(0, out.fuel);
  for (let i = 0; i < 4; i++) out.q[i] += d.q[i] * dt;
  for (let i = 0; i < 3; i++) out.rates[i] += d.rates[i] * dt;
  normalize(out.q);
  return out;
}

function finish(s, timeout = false) {
  const a = attitude(s), catching = s.mode === 'catch';
  const hover = s.mode === 'stabilize' || s.mode === 'monocopter';
  const positionError = Math.hypot(s.x, s.y), lateralSpeed = Math.hypot(s.vx, s.vy);
  const altitudeError = Math.abs(clearance(s) - (hover ? s.targetAltitude : catching ? P.catchHeight : 0));
  const envelope = catching
    ? a.tilt / RAD <= P.catchTiltLimit && Math.abs(s.vz) <= P.catchVerticalLimit
      && lateralSpeed <= P.catchLateralLimit && positionError <= P.catchRadius
    : a.tilt / RAD <= P.tiltLimit && (hover
      ? positionError <= P.hoverRadius && Math.hypot(s.vx, s.vy, s.vz) <= P.hoverSpeed
      : Math.abs(s.vz) <= P.verticalLimit && lateralSpeed <= P.horizontalLimit && positionError <= P.padTolerance);
  const contact = clearance(s) <= 1e-8;
  const ok = !timeout && envelope && (catching ? altitudeError <= 1e-8 && s.vz <= 0 : hover
    ? !contact && altitudeError <= P.altitudeLimit && s.settledTime >= P.settleDuration - 1e-9 : contact);
  const d = diagnostics(s);
  const failures = [];
  if (!d.safe.verticalSpeed) failures.push(`vertical speed ${Math.abs(s.vz).toFixed(2)} m/s exceeds ${d.limits.verticalSpeed} m/s; brake earlier`);
  if (!d.safe.lateralSpeed) failures.push(`lateral speed ${lateralSpeed.toFixed(2)} m/s exceeds ${d.limits.lateralSpeed} m/s; reduce crosswind or allow more correction time`);
  if (hover && Math.hypot(s.vx, s.vy, s.vz) > P.hoverSpeed) failures.push(`total speed ${Math.hypot(s.vx, s.vy, s.vz).toFixed(2)} m/s exceeds ${P.hoverSpeed} m/s hover limit`);
  if (!d.safe.alignment) failures.push(`lateral target error ${positionError.toFixed(2)} m exceeds ${d.limits.alignment} m; correct alignment earlier`);
  if (!d.safe.tilt) failures.push(`tilt ${(a.tilt / RAD).toFixed(2)}° exceeds ${d.limits.tiltDeg}°; increase attitude authority or damping`);
  if (hover && altitudeError > P.altitudeLimit) failures.push(`altitude error ${altitudeError.toFixed(2)} m exceeds ${P.altitudeLimit} m`);
  if (hover && s.settledTime < P.settleDuration - 1e-9) failures.push(`held the envelope for ${s.settledTime.toFixed(2)} s; ${P.settleDuration} s required`);
  if (hover && contact) failures.push('ground contact during stabilization');
  if (catching && (altitudeError > 1e-8 || s.vz > 0)) failures.push('did not cross the catch plane descending');
  if (timeout) failures.push('flight time limit exceeded');
  if (!ok && s.vehicle.kind === 'rocket' && s.fuel <= 1e-8) failures.unshift('propellant exhausted; add fuel or reduce burn demand');
  if (!ok && !d.safe.thrustAuthority) failures.unshift('insufficient vertical thrust authority; increase maximum thrust, reduce mass or reduce tilt');
  let reason = catching ? 'Captured within the tower catch envelope' : hover
    ? 'Altitude and position held for the final five seconds' : 'Touchdown within all limits';
  if (!ok) reason = `${catching ? 'Missed catch: ' : ''}${failures.join('; ')}`;
  s.result = {
    ok, task: catching ? 'catch' : hover ? 'hover' : 'landing', x: s.x, y: s.y,
    vx: s.vx, vy: s.vy, vz: s.vz, tilt: a.tilt / RAD, fuel: s.fuel,
    t: s.t, timeout, positionError, altitudeError, lateralSpeed,
    yawRate: s.rates[2] / RAD, reason, failures,
  };
  s.done = true; s.thrust = 0;
  s.phase = catching ? (ok ? 'caught' : 'missed') : ok ? (hover ? 'stable' : 'landed') : timeout ? 'timeout' : contact ? 'impact' : 'unstable';
}

function stepOnce(s, config, dt) {
  if (s.done || dt <= 0) return;
  const c = { ...DEFAULTS, ...config };
  if (clearance(s) <= 0) { s.z -= clearance(s); finish(s); return; }
  const duration = s.mode === 'landing' || s.mode === 'catch' ? P.maxTime : P.trialTime;
  dt = Math.min(dt, duration - s.t);
  const before = { ...s, q: s.q.slice(), rates: s.rates.slice() };
  const h0 = clearance(s), command = controller(s, c, dt), v = s.vehicle;
  s.command = command;
  for (let i = 0; i < 2; i++) s.gimbal[i] += (command.gimbal[i] - s.gimbal[i])
    * (v.gimbalLag === 0 ? 1 : 1 - Math.exp(-dt / v.gimbalLag));
  const commandedThrust = delayedThrust(s, command.thrust);
  s.thrust += (commandedThrust - s.thrust)
    * (v.throttleLag === 0 ? 1 : 1 - Math.exp(-dt / v.throttleLag));
  if (v.kind === 'rocket') s.thrust = Math.min(s.thrust, s.fuel * v.isp * 9.80665 / dt);
  // Explicit midpoint, including quaternion kinematics and Euler's rigid-body equation.
  const midpoint = advance(s, derivative(s, c), dt / 2);
  const next = advance(s, derivative(midpoint, c), dt);
  for (const key of LINEAR) s[key] = next[key];
  s.q = next.q; s.rates = next.rates; s.t += dt;
  updateMass(s);
  const a = attitude(s);
  const target = rotate([Math.cos(s.reference.pitch / 2), 0, Math.sin(s.reference.pitch / 2), 0],
    [0, -Math.sin(s.reference.roll), Math.cos(s.reference.roll)]);
  const up = rotate(s.q, [0, 0, 1]);
  const error = Math.acos(clamp(up[0] * target[0] + up[1] * target[1] + up[2] * target[2], -1, 1));
  s.trackingError += error * error * dt;
  const h1 = clearance(s);
  const threshold = s.mode === 'catch' ? P.catchHeight : 0;
  if (h1 <= threshold) {
    const fraction = clamp((h0 - threshold) / (h0 - h1), 0, 1);
    for (const key of LINEAR) s[key] = before[key] + (s[key] - before[key]) * fraction;
    for (let i = 0; i < 4; i++) s.q[i] = before.q[i] + (s.q[i] - before.q[i]) * fraction;
    for (let i = 0; i < 3; i++) s.rates[i] = before.rates[i] + (s.rates[i] - before.rates[i]) * fraction;
    normalize(s.q); s.z += threshold - clearance(s); s.t = before.t + dt * fraction;
    s.trackingError = before.trackingError + (s.trackingError - before.trackingError) * fraction;
    updateMass(s); finish(s);
  } else if (s.mode === 'stabilize' || s.mode === 'monocopter') {
    const stable = Math.abs(h1 - c.targetAltitude) <= P.altitudeLimit
      && Math.hypot(s.x, s.y) <= P.hoverRadius
      && Math.hypot(s.vx, s.vy, s.vz) <= P.hoverSpeed && a.tilt <= P.tiltLimit * RAD;
    s.settledTime = stable ? s.settledTime + dt : 0;
    if (s.t >= duration - 1e-9) finish(s);
  } else if (s.t >= duration - 1e-9) finish(s, true);
  updateSensors(s, c);
}

// Substeps preserve discrete sensor rates and the bounded delay queue for all callers.
export function step(s, config = DEFAULTS, dt = DT) {
  let remaining = dt;
  while (!s.done && remaining > 1e-12) {
    const untilIMU = (s.sensorModel.imuTick + 1) / SENSOR_MODEL.imuHz - s.t;
    const untilBarometer = (s.sensorModel.baroTick + 1) / SENSOR_MODEL.barometerHz - s.t;
    const untilGNSS = (s.sensorModel.gnssTick + 1) / SENSOR_MODEL.gnssHz - s.t;
    const queue = s.thrustQueue;
    const untilCommand = queue?.count ? queue.times[queue.head] - s.t : DT;
    const interval = Math.min(remaining, DT, untilIMU > 1e-10 ? untilIMU : DT,
      untilBarometer > 1e-10 ? untilBarometer : DT,
      untilGNSS > 1e-10 ? untilGNSS : DT,
      untilCommand > 1e-10 ? untilCommand : DT, s.vehicle.thrustDelay || DT);
    stepOnce(s, config, interval);
    remaining -= interval;
  }
}

function delayedThrust(s, requested) {
  const queue = s.thrustQueue;
  if (!queue) return requested;
  // Commands are sampled at 100 Hz even when a caller uses smaller integration steps.
  // Thus at most ceil(delay / DT) + 1 commands can be pending, without eviction.
  const capacity = queue.values.length;
  while (queue.count && queue.times[queue.head] <= s.t + 1e-10) {
    queue.applied = queue.values[queue.head];
    queue.head = (queue.head + 1) % capacity;
    queue.count--;
  }
  const tick = Math.floor((s.t + 1e-10) / DT);
  if (tick !== queue.lastTick) {
    const index = (queue.head + queue.count) % capacity;
    queue.values[index] = requested;
    queue.times[index] = s.t + s.vehicle.thrustDelay;
    queue.count++;
    queue.lastTick = tick;
  }
  return queue.applied;
}

export function diagnostics(s, config = {}) {
  const v = s.vehicle, catching = s.mode === 'catch';
  const hover = s.mode === 'stabilize' || s.mode === 'monocopter';
  const tiltDeg = attitude(s).tilt / RAD;
  const direction = rotate(s.q, thrustDirection(s.gimbal));
  const availableThrust = v.kind === 'rocket' && s.fuel <= 1e-8 ? 0 : v.maxThrust;
  const verticalTWR = availableThrust * Math.max(0, direction[2]) / (s.mass * P.gravity);
  const netBraking = P.gravity * (verticalTWR - 1);
  const descendingSpeed = Math.max(0, -s.vz);
  // Conservative lag allowance: assume ballistic descent during delay + one
  // throttle time constant, then full projected thrust. Drag is intentionally omitted.
  const latency = v.thrustDelay + v.throttleLag;
  const delayDistance = descendingSpeed * latency + 0.5 * P.gravity * latency ** 2;
  const brakingDistance = descendingSpeed === 0 ? 0 : netBraking > 0
    ? (descendingSpeed + P.gravity * latency) ** 2 / (2 * netBraking) + delayDistance : Infinity;
  const target = hover ? (config.targetAltitude ?? s.targetAltitude) : catching ? P.catchHeight : 0;
  const availableBrakingDistance = Math.max(0, clearance(s) - target);
  const distanceToTarget = Math.hypot(s.x, s.y), lateralSpeed = Math.hypot(s.vx, s.vy);
  const limits = { verticalSpeed: catching ? P.catchVerticalLimit : hover ? P.hoverSpeed : P.verticalLimit,
    lateralSpeed: catching ? P.catchLateralLimit : hover ? P.hoverSpeed : P.horizontalLimit,
    alignment: catching ? P.catchRadius : hover ? P.hoverRadius : P.padTolerance,
    tiltDeg: catching ? P.catchTiltLimit : P.tiltLimit };
  const safe = { verticalSpeed: Math.abs(s.vz) <= limits.verticalSpeed,
    lateralSpeed: lateralSpeed <= limits.lateralSpeed,
    totalSpeed: !hover || Math.hypot(s.vx, s.vy, s.vz) <= P.hoverSpeed,
    alignment: distanceToTarget <= limits.alignment, tilt: tiltDeg <= limits.tiltDeg,
    altitude: Math.abs(clearance(s) - target) <= (hover ? P.altitudeLimit : 1e-8),
    thrustAuthority: verticalTWR > 1, braking: brakingDistance <= availableBrakingDistance };
  const warnings = [];
  if (!safe.thrustAuthority) warnings.push('No positive vertical braking authority at this attitude and fuel state');
  if (!safe.braking && descendingSpeed > limits.verticalSpeed) warnings.push('Estimated stopping distance exceeds height above target; ignite earlier or increase thrust');
  if (s.saturation.gimbal) warnings.push('Gimbal command is saturated; reduce attitude demand or increase gimbal limit');
  if (s.saturation.throttle) warnings.push('Maximum thrust command; no additional throttle authority');
  if (!safe.alignment) warnings.push(`Lateral target error exceeds ${limits.alignment} m`);
  return { currentTWR: s.thrust / (s.mass * P.gravity), maxTWR: v.maxThrust / (s.mass * P.gravity),
    verticalTWR, gimbalSaturated: s.saturation.gimbal, throttleSaturated: s.saturation.throttle,
    gimbalAngleDeg: Math.atan(Math.hypot(Math.tan(s.gimbal[0]), Math.tan(s.gimbal[1]))) / RAD,
    brakingDistance, availableBrakingDistance, distanceToTarget, lateralSpeed, tiltDeg, safe, limits, warnings };
}

// Illustrative simulated noise/bias, NOT measured hardware specifications.
export const SENSOR_MODEL = Object.freeze({
  imuHz: 100, barometerHz: 25, preflightSamples: 100, accelNoise: 0.06, accelBias: 0.035,
  gyroNoise: 0.12 * RAD, gyroBias: 0.08 * RAD,
  pressureNoise: 1.2, pressureBias: 2, temperatureNoise: 0.04, temperatureBias: 0.15,
  // Illustrative close-pad relative positioning, not a receiver accuracy claim.
  gnssHz: 5, gnssPositionNoise: 0.3, gnssVelocityNoise: 0.05,
  gnssPositionBias: 0.1, gnssVelocityBias: 0.01,
});

function noise(s, stream = 'seed') {
  let sum = 0;
  for (let i = 0; i < 6; i++) {
    s.sensorModel[stream] = (1664525 * s.sensorModel[stream] + 1013904223) >>> 0;
    sum += s.sensorModel[stream] / 4294967296;
  }
  return (sum - 3) * Math.SQRT2;
}

function initializeSensors(s, c) {
  s.sensorModel = { seed: c.sensorSeed >>> 0, gnssSeed: (c.sensorSeed ^ 0x9e3779b9) >>> 0,
    imuTick: -1, baroTick: -1, gnssTick: -1 };
  s.sensorModel.accelBias = [0, 0, 0].map(() => noise(s) * SENSOR_MODEL.accelBias);
  s.sensorModel.gyroBias = [0, 0, 0].map(() => noise(s) * SENSOR_MODEL.gyroBias);
  s.sensorModel.pressureBias = noise(s) * SENSOR_MODEL.pressureBias;
  s.sensorModel.temperatureBias = noise(s) * SENSOR_MODEL.temperatureBias;
  s.sensorModel.gnssPositionBias = [0, 0].map(() => noise(s, 'gnssSeed') * SENSOR_MODEL.gnssPositionBias);
  s.sensorModel.gnssVelocityBias = [0, 0].map(() => noise(s, 'gnssSeed') * SENSOR_MODEL.gnssVelocityBias);
  s.sensors = { imu: null, barometer: null, gnss: null };
  // Simulated stationary preflight observations, NOT the powered in-flight force:
  // infer roll/pitch from gravity while supported; there is no heading observation.
  const supported = inverseRotate(s.q, [0, 0, P.gravity]), average = [0, 0, 0], gyroMean = [0, 0, 0];
  for (let sample = 0; sample < SENSOR_MODEL.preflightSamples; sample++) {
    for (let i = 0; i < 3; i++) {
      average[i] += (supported[i] + s.sensorModel.accelBias[i]
        + noise(s) * SENSOR_MODEL.accelNoise) / SENSOR_MODEL.preflightSamples;
      gyroMean[i] += (s.sensorModel.gyroBias[i] + noise(s) * SENSOR_MODEL.gyroNoise)
        / SENSOR_MODEL.preflightSamples;
    }
  }
  const roll = Math.atan2(average[1], average[2]);
  const pitch = Math.atan2(-average[0], Math.hypot(average[1], average[2]));
  const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2);
  const cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  // Without aiding, only the configured launch position and rest velocity are known.
  // GNSS supplies a noisy pad-relative position/velocity prior at the first sample.
  s.estimate = { q: [cr * cp, sr * cp, cr * sp, -sr * sp], roll, pitch, yaw: 0,
    altitude: 0, vz: 0, clearance: 0, x: s.mode === 'landing' || s.mode === 'catch' ? c.offset : 0,
    y: 0, vx: 0, vy: 0, rates: [0, 0, 0], gyroBiasEstimate: gyroMean,
    navigationSource: 'imu-dead-reckoning',
    alignmentSource: 'simulated static preflight accelerometer alignment' };
  updateSensors(s, c);
}

function updateSensors(s, c) {
  const model = s.sensorModel, e = s.estimate;
  if (!c.gnssEnabled) {
    s.sensors.gnss = null;
    e.navigationSource = 'imu-dead-reckoning';
  }
  if (s.t + 1e-9 >= (model.imuTick + 1) / SENSOR_MODEL.imuHz) {
    const interval = s.sensors.imu ? s.t - s.sensors.imu.t : 0;
    const acceleration = derivative(s, c);
    const specific = inverseRotate(s.q, [acceleration.vx, acceleration.vy, acceleration.vz + P.gravity]);
    const accel = specific.map((v, i) => v + model.accelBias[i] + noise(s) * SENSOR_MODEL.accelNoise);
    const gyro = s.rates.map((v, i) => v + model.gyroBias[i] + noise(s) * SENSOR_MODEL.gyroNoise);
    s.sensors.imu = { t: s.t, accel, gyro };
    model.imuTick = Math.round(s.t * SENSOR_MODEL.imuHz);
    // Powered specific force is not a gravity/heading observation, even near 1g.
    // Propagate the static preflight alignment using measured, calibrated gyro only.
    const rates = gyro.map((v, i) => v - e.gyroBiasEstimate[i]);
    const [w, x, y, z] = e.q, [p, q, r] = rates;
    e.q = normalize([w - (x * p + y * q + z * r) * interval / 2,
      x + (w * p + y * r - z * q) * interval / 2,
      y + (w * q + z * p - x * r) * interval / 2,
      z + (w * r + x * q - y * p) * interval / 2]);
    const angles = attitude(e);
    e.roll = angles.roll; e.pitch = angles.pitch; e.yaw = angles.yaw;
    e.rates = rates;
    const worldAcceleration = rotate(e.q, accel);
    worldAcceleration[2] -= P.gravity;
    // IMU prediction in all axes; sampled barometer and optional GNSS innovations
    // below correct only observed quantities, never hidden simulation state.
    e.x += e.vx * interval + 0.5 * worldAcceleration[0] * interval * interval;
    e.y += e.vy * interval + 0.5 * worldAcceleration[1] * interval * interval;
    e.vx += worldAcceleration[0] * interval;
    e.vy += worldAcceleration[1] * interval;
    e.altitude += e.vz * interval + 0.5 * worldAcceleration[2] * interval * interval;
    e.vz += worldAcceleration[2] * interval;
  }
  if (s.t + 1e-9 >= (model.baroTick + 1) / SENSOR_MODEL.barometerHz) {
    const previous = s.sensors.barometer;
    const temperatureC = 15 - 0.0065 * s.z + model.temperatureBias + noise(s) * SENSOR_MODEL.temperatureNoise;
    const pressurePa = Math.max(1, 101325 * Math.max(0.01, 1 - 0.0065 * s.z / 288.15) ** 5.25588
      + model.pressureBias + noise(s) * SENSOR_MODEL.pressureNoise);
    const altitude = (temperatureC + 273.15) / 0.0065 * ((101325 / pressurePa) ** (1 / 5.25588) - 1);
    s.sensors.barometer = { t: s.t, pressurePa, temperatureC, altitude };
    model.baroTick = Math.round(s.t * SENSOR_MODEL.barometerHz);
    if (!previous) e.altitude = altitude;
    else {
      const interval = s.t - previous.t;
      const residual = altitude - e.altitude;
      e.altitude += 0.12 * residual;
      e.vz += 0.015 * residual / Math.max(interval, 1e-9);
    }
  }
  if (s.t + 1e-9 >= (model.gnssTick + 1) / SENSOR_MODEL.gnssHz) {
    model.gnssTick = Math.round(s.t * SENSOR_MODEL.gnssHz);
    if (c.gnssEnabled) {
      // Truth is read only here, in the simulated receiver. The estimator consumes
      // these noisy observations in a known pad-relative frame, not true XY.
      const observation = { t: s.t,
        x: s.x + model.gnssPositionBias[0] + noise(s, 'gnssSeed') * SENSOR_MODEL.gnssPositionNoise,
        y: s.y + model.gnssPositionBias[1] + noise(s, 'gnssSeed') * SENSOR_MODEL.gnssPositionNoise,
        vx: s.vx + model.gnssVelocityBias[0] + noise(s, 'gnssSeed') * SENSOR_MODEL.gnssVelocityNoise,
        vy: s.vy + model.gnssVelocityBias[1] + noise(s, 'gnssSeed') * SENSOR_MODEL.gnssVelocityNoise };
      s.sensors.gnss = observation;
      for (const key of ['x', 'y', 'vx', 'vy']) {
        const gain = model.gnssTick === 0 ? 1 : key === 'x' || key === 'y' ? 0.5 : 0.7;
        e[key] += gain * (observation[key] - e[key]);
      }
      e.navigationSource = 'gnss-aided-imu';
    }
  }
  // Sample-and-hold: prediction at 100Hz, pressure correction at 25Hz, GNSS at 5Hz.
  e.clearance = clearance({ z: e.altitude, q: e.q, vehicle: s.vehicle });
}

function cost(s) {
  const r = s.result;
  const rms = Math.sqrt(s.trackingError / Math.max(s.t, DT)) / RAD;
  const usedFuel = s.vehicle.initialFuel > 0 ? (s.vehicle.initialFuel - r.fuel) / s.vehicle.initialFuel : 0;
  return (r.ok ? 0 : 12) + (r.timeout ? 50 : 0)
    + Math.max(0, Math.abs(r.vz) - 0.8) / P.verticalLimit
    + r.lateralSpeed / P.horizontalLimit + r.tilt / P.tiltLimit
    + r.positionError / P.padTolerance + (r.task === 'hover' ? r.altitudeError / P.altitudeLimit : 0)
    + rms / 30 + 0.5 * usedFuel;
}

export function score(s) {
  const raw = Math.round(100 * Math.exp(-Math.max(0, cost(s) - 0.4) / 3));
  return s.result.ok ? raw : Math.min(59, raw);
}

export function evaluate(config = DEFAULTS) {
  const s = newState(config), path = []; let ticks = 0;
  while (!s.done) {
    if (ticks++ % 40 === 0) path.push({ x: s.x, y: s.y, z: s.z });
    step(s, config);
  }
  path.push({ x: s.x, y: s.y, z: s.z });
  return { state: s, cost: cost(s), score: score(s), path };
}

// Deterministic 12-generation, six-child local search; one candidate per UI frame.
export function createSearch(config = DEFAULTS) {
  const c = { ...DEFAULTS, ...config };
  let seed = 7319, count = 0, generation = 0, child = 0;
  let parent = [c.kp, c.ki, c.kd], sigma = [1.8, 0.6, 1.8], best = null, generationBest = null;
  const random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 4294967296);
  const normal = () => { let v = 0; for (let i = 0; i < 6; i++) v += random(); return (v - 3) * Math.SQRT2; };
  return {
    total: 73,
    next() {
      if (count >= 73) return null;
      const gains = count === 0 ? parent.slice() : parent.map((v, i) => Math.round(clamp(v + sigma[i] * normal(), 0, 10) * 10) / 10);
      const candidate = { ...evaluate({ ...c, kp: gains[0], ki: gains[1], kd: gains[2] }), gains };
      if (!best || candidate.cost < best.cost) best = candidate;
      if (!generationBest || candidate.cost < generationBest.cost) generationBest = candidate;
      if (count > 0 && ++child === 6) {
        parent = best.gains.slice(); sigma = sigma.map(v => v * (generationBest === best ? 1.05 : 0.7));
        generationBest = null; child = 0; generation++;
      }
      count++;
      return { candidate, best, count, done: count === 73, generation };
    },
  };
}
