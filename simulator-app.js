import { RAD, DT, DEFAULTS, SENSOR_MODEL, clamp, clearance, attitude, newState, step, score, createSearch, diagnostics, evaluate } from './simulator-physics.js?v=scene-20261126';
import { scenarioDefinitions, summarizeBatch, telemetrySample, telemetryCSV } from './simulator-engineering.js?v=scene-20261126';
import { drawCloseup, drawSeries, drawSearch } from './simulator-renderer.js?v=webgl-20261126';
import { FlightRenderer } from './simulator-webgl.js?v=materials-path-20261126';

const $ = id => document.getElementById(id);
const format = (v, digits = 0) => v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const config = { ...DEFAULTS };
const gainKeys = ['kp', 'ki', 'kd'];
const scenarioKeys = ['ignition', 'wind', 'windY', 'offset', 'dryMass', 'fuelMass', 'monoMass', 'targetAltitude'];
const actuatorKeys = ['maxThrust', 'monoMaxThrust', 'gimbalLimitDeg', 'gimbalLag', 'throttleLag', 'thrustDelay'];
const timeKeys = ['gimbalLag', 'throttleLag', 'thrustDelay'];
const actuatorValue = key => config[key] ?? (key === 'gimbalLimitDeg' ? config.mode === 'monocopter' ? 18 : 12 : config.mode === 'monocopter' ? 0.1 : 0.18);
const gains = () => gainKeys.map(key => config[key]);
const gainsText = g => `Kp ${format(g[0], 1)} / Ki ${format(g[1], 1)} / Kd ${format(g[2], 1)}`;
const renderer = new FlightRenderer($('scene'));
let state, history = [], ghosts = [], trails = [], tuningLog = [];
let running = !matchMedia('(prefers-reduced-motion: reduce)').matches;
let accumulator = 0, previousTime = null, lastSample = -1, lastGhost = -1;
let search = null, searchBest = null, autoFlight = false, interactiveTrial = false;
let yourBest = null, autoBest = null, previousYaw = 0, unwrappedYaw = 0;
let batch = null, batchResults = [], telemetry = [], runNumber = 0, runStartedAt = '', flightEvents = [];
const palette = {};

function updateOutputs() {
  $('controllerFeedback').value = config.controllerFeedback;
  $('gnssEnabled').value = String(config.gnssEnabled);
  gainKeys.forEach(key => { $(key + '-output').textContent = format(config[key], 1); });
  ['ignition', 'offset', 'targetAltitude'].forEach(key => { $(key + '-output').textContent = `${format(config[key])} m`; });
  ['wind', 'windY'].forEach(key => { $(key + '-output').textContent = `${format(config[key])} m/s`; });
  ['dryMass', 'fuelMass', 'monoMass'].forEach(key => { $(key + '-output').textContent = `${format(config[key], key === 'dryMass' ? 0 : 1)} kg`; });
  actuatorKeys.forEach(key => {
    const value = actuatorValue(key), displayed = timeKeys.includes(key) ? value * 1000 : value;
    $(key).value = displayed;
    $(key + '-output').textContent = `${format(displayed)}${timeKeys.includes(key) ? ' ms' : key === 'gimbalLimitDeg' ? '°' : ' N'}`;
  });
}
function updateMode() {
  const catching = config.mode === 'catch';
  const landing = config.mode === 'landing' || catching, mono = config.mode === 'monocopter';
  $('rocket-fields').hidden = mono; $('monocopter-fields').hidden = !mono;
  $('rocket-thrust-row').hidden = mono; $('mono-thrust-row').hidden = !mono;
  $('ignition-row').hidden = !landing; $('target-row').hidden = landing;
  $('fuel-readout').hidden = mono;
  $('offset').closest('.slider-row').hidden = !landing;
  $('mode-description').textContent = landing
    ? catching ? 'Start tilted at 1 km. Brake and align with the tower arms at 50 m clearance.'
      : 'Start at 1 km with 25° pitch. Tune pitch and roll PID gains to land on the pad.'
    : mono ? 'Climb from 2 m to the hover target. Control pitch and roll as propeller torque spins the body.'
      : 'Climb from 2 m to the target altitude. Hold position through pitch and roll disturbances.';
  $('mode-warning').textContent = mono
    ? 'Yaw is uncontrolled. Hover scoring checks tilt and position, not heading. Battery and blade gyrodynamics are not simulated.'
    : catching ? 'Arm loads, tower collisions and motion after capture are not simulated.'
    : 'Two-axis thrust vector control does not independently control yaw.';
  $('scene-mode').textContent = `A3 / ${catching ? 'Tower catch' : landing ? 'Rocket landing' : mono ? 'Monocopter' : 'Vertical flight'}`;
  $('scene-range').textContent = landing ? '6 DOF · 1 km initial clearance' : '6 DOF · 30 s hover trial';
}
function applyGains(values) {
  gainKeys.forEach((key, i) => { config[key] = values[i]; $(key).value = values[i]; }); updateOutputs();
}
function updateFeedbackStatus() {
  $('feedback-status').textContent = state.controllerFeedback === 'sensors'
    ? `Sensor feedback uses estimated attitude, barometric height and speed, ${state.estimate.navigationSource === 'gnss-aided-imu' ? 'simulated GNSS-aided horizontal navigation' : 'IMU-only horizontal navigation with drift'}, and preflight-calibrated gyro rates.`
    : 'Truth feedback uses ideal position, velocity, attitude and angular rates. Sensors do not control this flight.';
}
function reset({ keepTrails = false, auto = false, play = true } = {}) {
  state = newState(config); history = []; ghosts = []; telemetry = []; flightEvents = [];
  runNumber++; runStartedAt = new Date().toISOString();
  accumulator = 0; lastSample = -1; lastGhost = -1; previousTime = null;
  previousYaw = attitude(state).yaw; unwrappedYaw = previousYaw;
  interactiveTrial = false; autoFlight = auto; running = play;
  if (!keepTrails) trails = [];
  $('verdict').hidden = true; $('current-score').textContent = '—';
  $('run').disabled = false; $('run').textContent = running ? 'Pause' : 'Start'; $('disturb').disabled = false;
  $('gain-note').textContent = 'Gains apply live. Restart for a comparable trial.';
  updateFeedbackStatus(); sample(); setBusyControls(); updateExportStatus();
}
function clearBests() {
  yourBest = null; autoBest = null;
  $('your-score').textContent = '—'; $('auto-score').textContent = '—';
  $('your-gains').textContent = 'successful trials'; $('auto-gains').textContent = 'successful trials';
}
function clearBatch() {
  batchResults = []; $('batch-results').replaceChildren(); $('batch-progress').value = 0;
  $('batch-status').textContent = `Ready with current gains and actuators, ${config.controllerFeedback} feedback and ${config.gnssEnabled ? 'simulated GNSS aiding' : 'IMU-only navigation'}.`;
}
function scenarioChanged() {
  const play = running || state.done;
  clearBests(); clearBatch(); searchBest = null; trails = []; tuningLog = []; $('tune-chart').hidden = true;
  $('tune-status').textContent = 'Settings changed. Best scores cleared.';
  updateOutputs(); updateMode(); reset({ play });
}
for (const key of gainKeys) {
  $(key).addEventListener('input', () => {
    config[key] = Number($(key).value); updateOutputs(); interactiveTrial = true; autoFlight = false;
    clearBatch(); flightEvents.push({ t: state.t, type: 'gains', gains: gains() });
    $('gain-note').textContent = 'Gains changed during flight. Restart for a comparable trial.';
  });
}
for (const key of scenarioKeys) $(key).addEventListener('input', () => { config[key] = Number($(key).value); scenarioChanged(); });
for (const key of actuatorKeys) $(key).addEventListener('input', () => {
  config[key] = Number($(key).value) / (timeKeys.includes(key) ? 1000 : 1); scenarioChanged();
});
$('mode').addEventListener('change', () => {
  config.mode = $('mode').value;
  config.offset = config.mode === 'landing' || config.mode === 'catch' ? DEFAULTS.offset : 0; $('offset').value = config.offset;
  scenarioChanged();
});
$('controllerFeedback').addEventListener('change', () => {
  config.controllerFeedback = $('controllerFeedback').value; scenarioChanged();
});
$('gnssEnabled').addEventListener('change', () => {
  config.gnssEnabled = $('gnssEnabled').value === 'true'; scenarioChanged();
});
$('camera').addEventListener('change', () => renderer.setCamera($('camera').value));
$('view-zoom').addEventListener('input', () => { renderer.zoom = Number($('view-zoom').value); });
$('path-camera').addEventListener('change', () => renderer.setPathCamera($('path-camera').value));
const flightControls = $('run').parentElement;
const controlsHome = flightControls.parentElement, controlsNext = flightControls.nextSibling;
let pathShown = false, homeScroll = 0;
function updateView() {
  const showPath = location.hash === '#flight-path';
  if (showPath === pathShown) return;
  if (showPath) homeScroll = scrollY;
  pathShown = showPath;
  $('workspace').hidden = showPath;
  $('flight-path-screen').hidden = !showPath;
  renderer.pathActive = showPath;
  if (showPath) {
    $('path-controls').append(flightControls);
    scrollTo(0, 0);
    $('path-title').focus({ preventScroll: true });
  } else {
    controlsHome.insertBefore(flightControls, controlsNext);
    scrollTo(0, homeScroll);
    $('open-flight-path').focus({ preventScroll: true });
  }
}
addEventListener('hashchange', updateView);
$('run').addEventListener('click', () => {
  if (search || batch || state.done) return;
  running = !running; accumulator = 0; $('run').textContent = running ? 'Pause' : 'Resume';
});
$('restart').addEventListener('click', () => {
  if (search) stopSearch(false);
  if (batch) stopBatch(true);
  tuningLog = []; $('tune-chart').hidden = true;
  reset();
});
$('speed').addEventListener('change', () => { accumulator = 0; });
$('disturb').addEventListener('click', () => {
  if (state.done || search || batch) return;
  // An actual external angular impulse, integrated by the rigid-body equations.
  state.rates[0] += 0.7; state.rates[1] -= 0.6; state.rates[2] += 0.15;
  interactiveTrial = true; autoFlight = false;
  flightEvents.push({ t: state.t, type: 'angularImpulse', deltaRatesRadS: [0.7, -0.6, 0.15] });
  $('gain-note').textContent = 'Angular impulse applied to all three axes. Resume if paused to observe recovery.';
});
function noteBest(candidateScore, values, automatic, mixed = false) {
  const best = automatic ? autoBest : yourBest;
  if (best && best.score >= candidateScore) return;
  const record = { score: candidateScore, gains: values.slice() };
  if (automatic) autoBest = record; else yourBest = record;
  $(automatic ? 'auto-score' : 'your-score').textContent = candidateScore;
  $(automatic ? 'auto-gains' : 'your-gains').textContent = mixed ? 'interactive trial' : gainsText(values);
}
function setBusyControls() {
  const busy = Boolean(search || batch);
  [...gainKeys, ...scenarioKeys, ...actuatorKeys, 'mode', 'controllerFeedback', 'gnssEnabled', 'speed'].forEach(id => { $(id).disabled = busy; });
  $('run').disabled = busy || state.done; $('disturb').disabled = busy || state.done;
  $('tune').disabled = Boolean(batch); $('batch').disabled = Boolean(search);
  $('tune').textContent = search ? 'Stop tuning' : 'Auto-tune';
  $('batch').textContent = batch ? 'Cancel batch' : 'Run scenario batch';
}
function startSearch() {
  clearBatch(); search = createSearch({ ...config }); searchBest = null; tuningLog = []; trails = [];
  reset({ play: false }); $('tune-chart').hidden = false; setBusyControls();
  $('tune-status').textContent = `Testing current gains with ${config.controllerFeedback} feedback, then 72 mutations.`;
}
function stopSearch(fly = true) {
  search = null; setBusyControls();
  if (searchBest) {
    applyGains(searchBest.gains);
    $('tune-status').textContent = `Kept ${gainsText(searchBest.gains)}. ${searchBest.state.result.ok ? `Score ${searchBest.score}.` : 'No successful trial. Kept the lowest-cost attempt.'}`;
  } else $('tune-status').textContent = 'Search stopped before the first evaluation.';
  if (fly) reset({ keepTrails: true, auto: true });
}
$('tune').addEventListener('click', () => { if (search) stopSearch(); else startSearch(); });
function tuneFrame() {
  const progress = search.next();
  if (!progress) { stopSearch(); return; }
  const { candidate, best, count, done } = progress; searchBest = best;
  tuningLog.push({ score: candidate.score, ok: candidate.state.result.ok });
  trails.push({ path: candidate.path, ok: candidate.state.result.ok });
  if (candidate.state.result.ok) noteBest(candidate.score, candidate.gains, true);
  $('tune-status').textContent = `Attempt ${count} / 73 · best ${best.score}${best.state.result.ok ? ' / successful' : ' / no success yet'}`;
  if (done) stopSearch();
}
function batchStatus(prefix) {
  const summary = summarizeBatch(batchResults), total = $('batch-progress').max;
  $('batch-status').textContent = `${prefix}. ${summary.total} of ${total} scenarios completed: ${summary.successes} passed, ${summary.failures} failed. Success rate ${format(summary.successRate * 100, 1)}%. ${config.controllerFeedback === 'sensors' ? 'Sensor' : 'Truth'} feedback; ${config.gnssEnabled ? 'simulated GNSS aided' : 'IMU only'}.`;
}
function startBatch() {
  const scenarios = scenarioDefinitions({ ...config });
  clearBatch(); batch = { scenarios, index: 0, resume: running };
  running = false; accumulator = 0; previousTime = null;
  $('batch-progress').max = scenarios.length;
  $('batch-status').textContent = `Running 0 of ${scenarios.length} scenarios. Main flight paused.`;
  setBusyControls();
}
function stopBatch(cancelled = false) {
  if (!batch) return;
  const resume = batch.resume;
  batch = null; running = resume && !state.done; accumulator = 0; previousTime = null;
  $('run').textContent = state.done ? 'Finished' : running ? 'Pause' : 'Resume';
  batchStatus(cancelled ? 'Batch cancelled' : 'Batch complete'); setBusyControls();
}
function batchFrame() {
  const item = batch.scenarios[batch.index], trial = evaluate(item.config);
  batchResults.push({ ...item, ...trial }); batch.index++;
  const row = document.createElement('li');
  row.className = trial.state.result.ok ? 'success' : 'failure';
  row.textContent = `${item.label}: ${trial.state.result.ok ? 'Passed' : 'Failed'} · score ${trial.score}. ${trial.state.result.ok ? 'All completion criteria met.' : trial.state.result.reason}`;
  $('batch-results').append(row); $('batch-progress').value = batch.index;
  batchStatus('Running batch');
  if (batch.index === batch.scenarios.length) stopBatch();
}
$('batch').addEventListener('click', () => { if (batch) stopBatch(true); else if (!search) startBatch(); });
function updateExportStatus(message = '') {
  $('export-status').textContent = message || `Recorded ${telemetry.length} samples over ${format(state.t, 1)} s.`;
}
$('export-csv').addEventListener('click', () => {
  if (state.t !== lastSample) sample();
  const status = state.done ? 'completed' : 'partial', exportedAt = new Date().toISOString(), events = JSON.stringify(flightEvents);
  const rows = telemetry.map(row => ({ ...row, export_status: status, exported_at_utc: exportedAt,
    run_started_at_utc: runStartedAt, run_modified: interactiveTrial, run_events_json: events }));
  const url = URL.createObjectURL(new Blob([telemetryCSV(rows)], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = `a3-${config.mode}-${state.controllerFeedback}-flight-${runNumber}-${status}.csv`;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  updateExportStatus(`Downloaded ${status} flight: ${rows.length} samples over ${format(state.t, 1)} s.`);
});
function showResult() {
  const r = state.result, trialScore = score(state), catching = r.task === 'catch', landing = r.task === 'landing' || catching;
  $('current-score').textContent = trialScore;
  if (r.ok) noteBest(trialScore, gains(), autoFlight, interactiveTrial);
  const verdict = $('verdict'); verdict.replaceChildren(); verdict.hidden = false;
  verdict.className = `verdict${r.ok ? ' ok' : ''}${catching ? ' tower-verdict' : ''}`;
  const heading = document.createElement('strong');
  heading.textContent = `${catching ? r.ok ? 'Caught by tower' : 'Catch missed' : r.ok ? landing ? 'Landed' : 'Hover stabilized' : landing ? 'Landing failed' : 'Stabilization failed'} · ${trialScore}`;
  verdict.append(heading);
  if (r.ok) {
    const metrics = document.createElement('p');
    metrics.textContent = landing
      ? `Vertical speed ${format(Math.abs(r.vz), 1)} m/s ${catching ? 'at the arms' : 'at touchdown'}. ${catching ? 'Capture' : 'Pad'} error ${format(Math.hypot(r.x, r.y), 1)} m. Fuel remaining ${format(r.fuel, 1)} kg.`
      : `Horizontal error ${format(r.positionError, 2)} m. Height error ${format(Math.abs(r.altitudeError), 2)} m. Tilt ${format(r.tilt, 1)}°. ${state.vehicle.kind === 'monocopter' ? `Uncontrolled yaw rate ${format(r.yawRate, 1)}°/s.` : ''}`;
    verdict.append(metrics);
  } else {
    if (r.failures?.length) {
      const failures = document.createElement('ul');
      failures.className = 'verdict-list';
      for (const failure of r.failures) {
        const item = document.createElement('li');
        item.textContent = failure;
        failures.append(item);
      }
      verdict.append(failures);
    } else {
      const reason = document.createElement('p');
      reason.textContent = r.reason;
      verdict.append(reason);
    }
    const action = document.createElement('p');
    action.textContent = 'Adjust the settings and restart to try again.';
    verdict.append(action);
  }
  $('run').disabled = true; $('run').textContent = 'Finished'; $('disturb').disabled = true;
}
function readPalette() {
  const style = getComputedStyle(document.documentElement);
  for (const key of ['paper', 'panel', 'ink', 'muted', 'rule', 'accent', 'ok', 'bad', 'sky-top', 'sky-bottom', 'cloud', 'terrain', 'ship', 'pad']) palette[key] = style.getPropertyValue('--' + key).trim();
}
readPalette(); matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readPalette);
function sample() {
  const a = attitude(state);
  const delta = Math.atan2(Math.sin(a.yaw - previousYaw), Math.cos(a.yaw - previousYaw));
  unwrappedYaw += delta; previousYaw = a.yaw;
  history.push({ t: state.t, pitch: a.pitch / RAD, roll: a.roll / RAD, yaw: unwrappedYaw / RAD,
    pitchReference: state.reference.pitch / RAD, rollReference: state.reference.roll / RAD,
    pitchEstimate: state.estimate.pitch / RAD, rollEstimate: state.estimate.roll / RAD,
    altitude: clearance(state), altitudeEstimate: state.estimate.clearance,
    vertical: state.vz, verticalEstimate: state.estimate.vz });
  telemetry.push(telemetrySample(state, config, { runId: runNumber, scenarioId: 'main', scenarioLabel: 'Recorded main flight' }));
  lastSample = state.t; updateExportStatus();
}
function render() {
  renderer.draw(state, config, ghosts, trails, palette, Boolean(search));
  drawCloseup($('closeup'), state, palette);
  drawSeries($('pitch-chart'), history, state.t, ['pitch', 'pitchReference', 'pitchEstimate'], palette);
  drawSeries($('roll-chart'), history, state.t, ['roll', 'rollReference', 'rollEstimate'], palette);
  drawSeries($('yaw-chart'), history, state.t, ['yaw'], palette, {minimum: 90, yaw: true});
  drawSeries($('altitude-chart'), history, state.t, ['altitude', 'altitudeEstimate'], palette, { minimum: 5, unit: 'm' });
  drawSeries($('vertical-chart'), history, state.t, ['vertical', 'verticalEstimate'], palette, { minimum: 5, unit: 'm/s' });
  drawSearch($('tune-chart'), tuningLog, palette);
  const a = attitude(state), mass = state.vehicle.dryMass + state.fuel;
  $('altitude').textContent = format(Math.max(0, clearance(state)), config.mode === 'landing' ? 0 : 1);
  $('vertical').textContent = format(state.vz, 1); $('horizontal').textContent = format(Math.hypot(state.vx, state.vy), 1);
  $('pitch').textContent = format(a.pitch / RAD, 1); $('roll').textContent = format(a.roll / RAD, 1);
  $('yaw').textContent = format(a.yaw / RAD, 1); $('yaw-rate').textContent = format(state.rates[2] / RAD, 1);
  $('mass').textContent = format(mass, 1); $('thrust').textContent = format(state.thrust);
  $('fuel').textContent = format(state.fuel, 1); $('clock').textContent = `T+${format(state.t, 1).padStart(4, '0')} s`;
  $('phase').textContent = search ? 'Auto-tuning' : batch ? 'Batch running; flight paused' : state.phase.charAt(0).toUpperCase() + state.phase.slice(1).toLowerCase();
  $('path-status').textContent = `${$('scene-mode').textContent} · ${$('clock').textContent} · ${$('phase').textContent}`;
  $('gimbal').textContent = `gimbal ${format(state.gimbal[0] / RAD, 1)}° / ${format(state.gimbal[1] / RAD, 1)}°`;
  $('throttle').textContent = `throttle ${format(state.thrust / state.vehicle.maxThrust * 100)}%`;
  const d = diagnostics(state, config), distance = value => Number.isFinite(value) ? `${format(value, 1)} m` : value === Infinity ? '∞ · no braking authority' : value === -Infinity ? '−∞ · cannot stop' : '—';
  $('twr').textContent = `max T/W ${format(d.maxTWR, 2)}`;
  $('current-twr').textContent = format(d.currentTWR, 2);
  $('lateral-error').textContent = `${format(d.distanceToTarget, 1)} m`;
  $('braking-distance').textContent = distance(d.brakingDistance);
  $('braking-remaining').textContent = distance(d.availableBrakingDistance);
  $('braking-margin').textContent = distance(d.availableBrakingDistance - d.brakingDistance);
  $('gimbal-saturation').textContent = d.gimbalSaturated ? 'At angle limit' : 'Within angle limit';
  $('gimbal-saturation').classList.toggle('warning', d.gimbalSaturated);
  $('diagnostic-warning').textContent = d.warnings.join(' ');
  $('diagnostic-warning').classList.toggle('warning', d.warnings.length > 0);
  for (const [key, truth, estimated] of [
    ['pitch', a.pitch / RAD, state.estimate.pitch / RAD], ['roll', a.roll / RAD, state.estimate.roll / RAD],
    ['altitude', clearance(state), state.estimate.clearance], ['vertical', state.vz, state.estimate.vz],
    ['yaw', a.yaw / RAD, state.estimate.yaw / RAD],
    ['x', state.x, state.estimate.x], ['y', state.y, state.estimate.y],
    ['vx', state.vx, state.estimate.vx], ['vy', state.vy, state.estimate.vy],
    ['rate-x', state.rates[0] / RAD, state.estimate.rates[0] / RAD],
    ['rate-y', state.rates[1] / RAD, state.estimate.rates[1] / RAD],
    ['rate-z', state.rates[2] / RAD, state.estimate.rates[2] / RAD],
  ]) {
    $(`sensor-${key}-truth`).textContent = format(truth, 2);
    $(`sensor-${key}-estimate`).textContent = format(estimated, 2);
  }
  const gnss = state.sensors.gnss;
  const gnssAge = gnss ? Math.max(0, state.t - gnss.t) : null;
  $('sensor-gnss').textContent = !config.gnssEnabled
    ? 'Simulated GNSS is off. No observations. IMU-only horizontal navigation drifts.'
    : gnss
      ? `Simulated GNSS ${gnssAge > 1.5 / SENSOR_MODEL.gnssHz ? 'is stale' : 'sample held'}. Last sample at T+${format(gnss.t, 2)} s, age ${format(gnssAge, 2)} s. X ${format(gnss.x, 2)} m; Y ${format(gnss.y, 2)} m; Vx ${format(gnss.vx, 2)} m/s; Vy ${format(gnss.vy, 2)} m/s. These are observations, not estimates.`
      : 'Waiting for simulated GNSS. X, Y, Vx and Vy observations are unavailable.';
  $('sensor-gyro').textContent = `Raw gyro X/Y/Z: ${state.sensors.imu.gyro.map(value => format(value / RAD, 3)).join(' / ')}°/s. Estimated preflight bias X/Y/Z: ${state.estimate.gyroBiasEstimate.map(value => format(value / RAD, 3)).join(' / ')}°/s. This bias is subtracted for propagation and sensor-feedback rates.`;
  $('sensor-model').textContent = `Sample rates: IMU ${SENSOR_MODEL.imuHz} Hz; barometer ${SENSOR_MODEL.barometerHz} Hz; simulated GNSS ${SENSOR_MODEL.gnssHz} Hz. Seed ${config.sensorSeed}. Preflight uses ${SENSOR_MODEL.preflightSamples} static accelerometer and gyro samples. Latest IMU sample T+${format(state.sensors.imu.t, 2)} s; barometer T+${format(state.sensors.barometer.t, 2)} s. Noise σ: acceleration ${format(SENSOR_MODEL.accelNoise, 3)} m/s²; gyro ${format(SENSOR_MODEL.gyroNoise / RAD, 2)}°/s; pressure ${format(SENSOR_MODEL.pressureNoise, 1)} Pa. Fixed bias σ: acceleration ${format(SENSOR_MODEL.accelBias, 3)} m/s²; gyro ${format(SENSOR_MODEL.gyroBias / RAD, 2)}°/s; pressure ${format(SENSOR_MODEL.pressureBias, 1)} Pa. GNSS noise σ: position ${format(SENSOR_MODEL.gnssPositionNoise, 2)} m; velocity ${format(SENSOR_MODEL.gnssVelocityNoise, 2)} m/s. GNSS fixed bias σ: position ${format(SENSOR_MODEL.gnssPositionBias, 2)} m; velocity ${format(SENSOR_MODEL.gnssVelocityBias, 2)} m/s. These illustrative values represent close-pad accuracy, not measured GNSS performance.`;
}
function frame(timestamp) {
  const elapsed = previousTime === null ? 0 : clamp((timestamp - previousTime) / 1000, 0, 0.05);
  previousTime = timestamp;
  if (search) tuneFrame();
  else if (batch) batchFrame();
  else if (running && !state.done) {
    accumulator += elapsed * Number($('speed').value);
    while (accumulator >= DT && !state.done) {
      step(state, config); accumulator -= DT;
      if (state.t - lastSample >= 0.1 || state.done) sample();
      if (state.t - lastGhost >= (config.mode === 'landing' ? 1.25 : 1) && !state.done) {
        ghosts.push({ ...state, q: state.q.slice(), gimbal: state.gimbal.slice() }); lastGhost = state.t;
      }
    }
    if (state.done) { accumulator = 0; showResult(); }
  }
  render(); requestAnimationFrame(frame);
}
document.addEventListener('visibilitychange', () => { previousTime = null; accumulator = 0; });
updateOutputs(); updateMode(); reset({ play: running }); updateView(); requestAnimationFrame(frame);
