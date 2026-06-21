import test from "node:test";
import assert from "node:assert/strict";
import { calculatePhase } from "../traffic-cycle.js";

const light = {
  startedAt: 1_000_000,
  durations: { green: 30, amber: 3, red: 30 },
};

test("comienza en verde con la cuenta atrás completa", () => {
  const state = calculatePhase(light, light.startedAt);
  assert.equal(state.phase, "green");
  assert.equal(state.remainingSeconds, 30);
});

test("cambia a ámbar exactamente al terminar el verde", () => {
  const state = calculatePhase(light, light.startedAt + 30_000);
  assert.equal(state.phase, "amber");
  assert.equal(state.remainingSeconds, 3);
});

test("cambia a rojo exactamente al terminar el ámbar", () => {
  const state = calculatePhase(light, light.startedAt + 33_000);
  assert.equal(state.phase, "red");
  assert.equal(state.remainingSeconds, 30);
});

test("vuelve a verde después de un ciclo completo", () => {
  const state = calculatePhase(light, light.startedAt + 63_000);
  assert.equal(state.phase, "green");
  assert.equal(state.remainingSeconds, 30);
});

test("recupera la fase correcta tras muchas horas cerrada", () => {
  const cycles = 10_000;
  const state = calculatePhase(light, light.startedAt + cycles * 63_000 + 31_500);
  assert.equal(state.phase, "amber");
  assert.equal(state.remainingSeconds, 2);
});

test("rechaza duraciones no positivas", () => {
  assert.throws(() => calculatePhase({ ...light, durations: { green: 0, amber: 3, red: 30 } }), /positivos/);
});
