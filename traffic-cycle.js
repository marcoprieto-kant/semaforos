export const PHASES = ["green", "red"];
export const PHASE_LABELS = { green: "Verde", red: "Rojo" };
export const MAX_CYCLES = 24;

export function validateCycles(cycles) {
  if (!Array.isArray(cycles) || cycles.length < 1 || cycles.length > MAX_CYCLES) {
    throw new TypeError(`Añade entre 1 y ${MAX_CYCLES} vueltas.`);
  }
  return cycles.map((cycle) => {
    const green = Number(cycle?.green);
    const red = Number(cycle?.red);
    if (![green, red].every((n) => Number.isInteger(n) && n >= 1 && n <= 3600)) {
      throw new TypeError("Cada tiempo debe ser un entero entre 1 y 3600 segundos.");
    }
    return { green, red };
  });
}

// Absolute instants preserve the sequence across sleep, reloads and days.
export function calculatePhase(light, now = Date.now()) {
  const cycles = validateCycles(light.cycles);
  const startedAt = Number(light.startedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(now)) {
    throw new TypeError("Fecha de inicio no válida.");
  }
  const sequenceMs = cycles.reduce((sum, c) => sum + (c.green + c.red) * 1000, 0);
  let position = Math.max(0, now - startedAt) % sequenceMs;
  for (let cycleIndex = 0; cycleIndex < cycles.length; cycleIndex += 1) {
    const cycle = cycles[cycleIndex];
    for (const phase of PHASES) {
      const duration = cycle[phase] * 1000;
      if (position < duration) {
        return {
          phase, label: PHASE_LABELS[phase], cycleIndex, cycleCount: cycles.length,
          remainingSeconds: Math.ceil((duration - position) / 1000),
          phaseDurationSeconds: cycle[phase], progress: position / duration,
          cycleDurationSeconds: cycle.green + cycle.red,
          sequenceDurationSeconds: sequenceMs / 1000,
        };
      }
      position -= duration;
    }
  }
  throw new Error("No se pudo calcular la fase.");
}
