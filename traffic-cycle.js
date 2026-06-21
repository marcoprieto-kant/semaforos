export const PHASES = ["green", "amber", "red"];

export const PHASE_LABELS = {
  green: "Verde",
  amber: "Ámbar",
  red: "Rojo",
};

export function calculatePhase(light, now = Date.now()) {
  const durations = {
    green: toPositiveSeconds(light.durations?.green),
    amber: toPositiveSeconds(light.durations?.amber),
    red: toPositiveSeconds(light.durations?.red),
  };

  const cycleMs = PHASES.reduce((total, phase) => total + durations[phase] * 1000, 0);
  const startedAt = Number.isFinite(Number(light.startedAt)) ? Number(light.startedAt) : now;
  const elapsedSinceStart = Math.max(0, now - startedAt);
  const elapsedInCycleMs = elapsedSinceStart % cycleMs;

  let phaseStartMs = 0;
  for (const phase of PHASES) {
    const phaseDurationMs = durations[phase] * 1000;
    const phaseEndMs = phaseStartMs + phaseDurationMs;
    if (elapsedInCycleMs < phaseEndMs) {
      const elapsedInPhaseMs = elapsedInCycleMs - phaseStartMs;
      return {
        phase,
        label: PHASE_LABELS[phase],
        remainingSeconds: Math.max(1, Math.ceil((phaseEndMs - elapsedInCycleMs) / 1000)),
        phaseDurationSeconds: durations[phase],
        progress: Math.min(1, Math.max(0, elapsedInPhaseMs / phaseDurationMs)),
        elapsedInCycleMs,
        cycleDurationSeconds: cycleMs / 1000,
      };
    }
    phaseStartMs = phaseEndMs;
  }

  throw new Error("No se pudo calcular la fase del semáforo.");
}

function toPositiveSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new TypeError("Las duraciones deben ser números positivos.");
  }
  return seconds;
}
