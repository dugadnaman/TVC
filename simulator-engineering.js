import { DEFAULTS, SENSOR_MODEL, RAD, attitude, clearance, diagnostics } from './simulator-physics.js';

// Each call captures values, not references to the live simulation. Observations,
// estimates, selected controller inputs and rigid-body truth are distinct.
export function telemetrySample(state, config = DEFAULTS, metadata = {}) {
  const c = { ...DEFAULTS, ...config }, v = state.vehicle;
  const a = attitude(state), e = state.estimate, d = diagnostics(state, c);
  const imu = state.sensors.imu, baro = state.sensors.barometer, gnss = state.sensors.gnss, f = state.feedback;
  return {
    ...metadata,
    time_s: state.t, mode: state.mode, phase: state.phase,
    controller_feedback: state.controllerFeedback,
    controller_navigation_source: state.controllerFeedback === 'sensors' ? e.navigationSource : 'actual rigid-body truth',
    controller_attitude_source: state.controllerFeedback === 'sensors' ? 'preflight-aligned quaternion propagated with calibrated gyro' : 'actual rigid-body quaternion',
    controller_lateral_source: state.controllerFeedback === 'sensors' ? e.navigationSource : 'actual rigid-body lateral state',
    controller_vertical_source: state.controllerFeedback === 'sensors' ? 'filtered barometric clearance and vertical speed' : 'actual rigid-body vertical state',
    controller_rates_source: state.controllerFeedback === 'sensors' ? 'measured gyro minus preflight estimated bias' : 'actual rigid-body angular rates',
    controller_snapshot_source: f?.source,
    controller_snapshot_timing: 'latest controller input snapshot before rigid-body integration',
    controller_x_m: f?.x, controller_y_m: f?.y,
    controller_vx_m_s: f?.vx, controller_vy_m_s: f?.vy,
    controller_clearance_m: f?.clearance, controller_vz_m_s: f?.vz,
    controller_qw: f?.q[0], controller_qx: f?.q[1], controller_qy: f?.q[2], controller_qz: f?.q[3],
    controller_roll_rate_rad_s: f?.rates[0], controller_pitch_rate_rad_s: f?.rates[1], controller_yaw_rate_rad_s: f?.rates[2],
    flight_status: state.done ? (state.result.ok ? 'success' : 'failure') : 'running',
    result_reason: state.result?.reason ?? '',
    true_x_m: state.x, true_y_m: state.y, true_com_altitude_m: state.z,
    true_clearance_m: clearance(state), true_vx_m_s: state.vx, true_vy_m_s: state.vy, true_vz_m_s: state.vz,
    true_qw: state.q[0], true_qx: state.q[1], true_qy: state.q[2], true_qz: state.q[3],
    true_roll_deg: a.roll / RAD, true_pitch_deg: a.pitch / RAD, true_yaw_deg: a.yaw / RAD,
    true_roll_rate_rad_s: state.rates[0], true_pitch_rate_rad_s: state.rates[1], true_yaw_rate_rad_s: state.rates[2],
    estimate_qw: e.q[0], estimate_qx: e.q[1], estimate_qy: e.q[2], estimate_qz: e.q[3],
    estimate_roll_deg: e.roll / RAD, estimate_pitch_deg: e.pitch / RAD, estimate_yaw_deg: e.yaw / RAD,
    estimate_com_altitude_m: e.altitude, estimate_clearance_m: e.clearance, estimate_vz_m_s: e.vz,
    estimate_x_m: e.x, estimate_y_m: e.y, estimate_vx_m_s: e.vx, estimate_vy_m_s: e.vy,
    estimate_roll_rate_rad_s: e.rates[0], estimate_pitch_rate_rad_s: e.rates[1], estimate_yaw_rate_rad_s: e.rates[2],
    estimate_navigation_source: e.navigationSource,
    estimate_rates_source: 'measured gyro minus preflight estimated bias; residual bias and sampled noise remain',
    estimate_gyro_bias_x_rad_s: e.gyroBiasEstimate[0], estimate_gyro_bias_y_rad_s: e.gyroBiasEstimate[1], estimate_gyro_bias_z_rad_s: e.gyroBiasEstimate[2],
    gyro_calibration_source: 'measured static preflight gyro mean, not true simulated bias',
    gyro_calibration_sample_count: SENSOR_MODEL.preflightSamples,
    estimate_alignment_source: e.alignmentSource,
    imu_sample_time_s: imu.t,
    imu_specific_force_x_m_s2: imu.accel[0], imu_specific_force_y_m_s2: imu.accel[1], imu_specific_force_z_m_s2: imu.accel[2],
    imu_gyro_x_rad_s: imu.gyro[0], imu_gyro_y_rad_s: imu.gyro[1], imu_gyro_z_rad_s: imu.gyro[2],
    imu_gyro_source: 'raw measured gyro including fixed bias and sampled noise',
    gnss_enabled: c.gnssEnabled,
    gnss_sample_time_s: gnss?.t,
    gnss_sample_age_s: gnss ? Math.max(0, state.t - gnss.t) : null,
    gnss_sample_status: !c.gnssEnabled ? 'off' : !gnss ? 'waiting' : state.t - gnss.t > 1.5 / SENSOR_MODEL.gnssHz ? 'stale' : 'sample held',
    gnss_observed_x_m: gnss?.x, gnss_observed_y_m: gnss?.y,
    gnss_observed_vx_m_s: gnss?.vx, gnss_observed_vy_m_s: gnss?.vy,
    barometer_sample_time_s: baro.t, barometer_pressure_pa: baro.pressurePa,
    barometer_temperature_c: baro.temperatureC, barometer_observed_altitude_m: baro.altitude,
    mass_kg: state.mass, fuel_kg: state.fuel, thrust_n: state.thrust,
    commanded_thrust_n: state.command.thrust,
    gimbal_x_deg: state.gimbal[0] / RAD, gimbal_y_deg: state.gimbal[1] / RAD,
    commanded_gimbal_x_deg: state.command.gimbal[0] / RAD, commanded_gimbal_y_deg: state.command.gimbal[1] / RAD,
    current_twr: d.currentTWR, maximum_twr: d.maxTWR, vertical_twr: d.verticalTWR,
    gimbal_saturated: d.gimbalSaturated, throttle_saturated: d.throttleSaturated,
    braking_distance_m: d.brakingDistance, available_braking_distance_m: d.availableBrakingDistance,
    lateral_target_error_m: d.distanceToTarget,
    diagnostics_source: 'actual rigid-body truth, independent of controller feedback',
    gain_kp: c.kp, gain_ki: c.ki, gain_kd: c.kd,
    wind_x_m_s: c.wind, wind_y_m_s: c.windY, ignition_clearance_m: c.ignition,
    initial_offset_x_m: c.offset, initial_roll_deg: c.initialRollDeg,
    initial_pitch_deg: c.initialPitchDeg, initial_yaw_deg: c.initialYawDeg,
    target_clearance_m: c.targetAltitude, dry_mass_kg: v.dryMass, initial_fuel_kg: v.initialFuel,
    maximum_thrust_n: v.maxThrust, configured_rocket_maximum_thrust_n: c.maxThrust,
    configured_monocopter_maximum_thrust_n: c.monoMaxThrust,
    gimbal_limit_deg: v.gimbalLimit / RAD, gimbal_response_s: v.gimbalLag,
    throttle_response_s: v.throttleLag, thrust_delay_s: v.thrustDelay,
    sensor_seed: c.sensorSeed, sensor_model: 'illustrative biased noisy MPU6050/BMP280 and simulated pad-relative XY GNSS; not measured hardware specifications',
    imu_sample_rate_hz: SENSOR_MODEL.imuHz, barometer_sample_rate_hz: SENSOR_MODEL.barometerHz,
    gnss_sample_rate_hz: SENSOR_MODEL.gnssHz,
    gnss_position_noise_sigma_m: SENSOR_MODEL.gnssPositionNoise, gnss_velocity_noise_sigma_m_s: SENSOR_MODEL.gnssVelocityNoise,
    gnss_position_bias_sigma_m: SENSOR_MODEL.gnssPositionBias, gnss_velocity_bias_sigma_m_s: SENSOR_MODEL.gnssVelocityBias,
    estimator_limitations: 'static preflight accelerometer tilt alignment and measured gyro mean calibration require motionless calibration; residual bias remains; heading starts at zero without absolute reference and XY GNSS does not directly measure yaw; powered acceleration is not gravity alignment; observed barometric initialization; simulated GNSS corrects IMU XY in a known pad-relative frame with illustrative close-pad accuracy, not a hardware claim; disabling GNSS leaves drifting IMU dead reckoning from known scenario lateral start and zero lateral velocity',
  };
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

// First-seen column order is deterministic; later metadata columns are retained.
// Infinity is intentional: it means no finite braking solution, not a missing sample.
export function telemetryCSV(samples) {
  if (!samples.length) return '';
  const columns = [...new Set(samples.flatMap(sample => Object.keys(sample)))];
  return [columns.map(csvCell).join(','),
    ...samples.map(sample => columns.map(key => csvCell(sample[key])).join(','))].join('\r\n') + '\r\n';
}

export const SCENARIOS = Object.freeze([
  Object.freeze({ id: 'baseline', label: 'Baseline', seed: 7319 }),
  Object.freeze({ id: 'crosswind-x', label: 'X crosswind +4 m/s', seed: 7320 }),
  Object.freeze({ id: 'crosswind-y', label: 'Y crosswind −4 m/s', seed: 7321 }),
  Object.freeze({ id: 'heavy', label: 'Dry mass +20%', seed: 7322 }),
  Object.freeze({ id: 'attitude', label: 'Initial roll −14°, pitch 18°, yaw 25°', seed: 7323 }),
  Object.freeze({ id: 'combined', label: 'Combined wind, mass and attitude', seed: 7324 }),
]);

export function scenarioDefinitions(config = DEFAULTS) {
  const baseline = { ...DEFAULTS, ...config };
  return SCENARIOS.map(scenario => {
    const c = { ...baseline, sensorSeed: scenario.seed };
    if (scenario.id === 'crosswind-x' || scenario.id === 'combined') c.wind += 4;
    if (scenario.id === 'crosswind-y' || scenario.id === 'combined') c.windY -= 4;
    if (scenario.id === 'heavy' || scenario.id === 'combined') {
      c.dryMass *= 1.2; c.monoMass *= 1.2;
    }
    if (scenario.id === 'attitude' || scenario.id === 'combined') {
      c.initialRollDeg = -14; c.initialPitchDeg = 18; c.initialYawDeg = 25;
    }
    return { id: scenario.id, label: scenario.label, config: c };
  });
}

export function summarizeBatch(results) {
  const total = results.length;
  const successes = results.filter(result => result.state.result.ok).length;
  return { total, successes, failures: total - successes,
    successRate: total ? successes / total : 0,
    meanScore: total ? results.reduce((sum, result) => sum + result.score, 0) / total : 0,
    results: results.map(result => ({ id: result.id, label: result.label,
      ok: result.state.result.ok, score: result.score, reason: result.state.result.reason,
      config: { ...result.config } })) };
}
