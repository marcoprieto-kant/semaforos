import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./config.js";
import { validateCycles } from "./traffic-cycle.js";

const url = String(SUPABASE_URL).trim().replace(/\/$/, "");
const key = String(SUPABASE_ANON_KEY).trim();
// Only public records are persisted. The PIN and editor token never go into storage.
let editorSession = null;
let clockOffset = 0;
let databasePromise;
let lastSnapshot = null;
let mutationGeneration = 0;

export function serverNow() { return Date.now() + clockOffset; }
export function isEditorUnlocked() {
  return Boolean(editorSession && editorSession.expiresAt > serverNow());
}

async function rpc(name, args = {}) {
  const localPreview = /^http:\/\/127\.0\.0\.1:\d+$/.test(url) && globalThis.location?.origin === url;
  if ((!/^https:\/\//.test(url) && !localPreview) || !key || /sb_secret_/.test(key)) {
    throw new Error("Falta la URL o la clave pública correcta en config.js.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  const started = Date.now();
  try {
    const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
      method: "POST", cache: "no-store", signal: controller.signal,
      headers: { apikey: key, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    const data = await response.json();
    if (!response.ok) {
      if (data.message === "EDITOR_SESSION_EXPIRED") {
        editorSession = null;
        throw new Error("La sesión ha caducado. Vuelve a introducir el PIN.");
      }
      if (data.message === "EDIT_CONFLICT") {
        throw new Error("Este semáforo ha cambiado. Cierra el formulario, actualiza el mapa y vuelve a intentarlo.");
      }
      if (data.code === "PGRST202" || data.code === "42883") {
        throw new Error("Falta actualizar Supabase. Ejecuta supabase-schema.sql en su SQL Editor.");
      }
      throw new Error("No se pudo completar la operación en Supabase. Comprueba la configuración y la conexión.");
    }
    const serverTime = Date.parse(data?.server_time);
    if (Number.isFinite(serverTime)) clockOffset = serverTime - (started + Date.now()) / 2;
    return data;
  } catch (error) {
    if (error.name === "AbortError" || error instanceof TypeError) {
      throw new Error("No hay conexión con el servidor. Comprueba Internet o si el proyecto Supabase está pausado.");
    }
    throw error;
  } finally { clearTimeout(timeout); }
}

export function fromCloudRecord(record) {
  const light = {
    id: record.id, name: record.name, lat: Number(record.lat), lng: Number(record.lng),
    cycles: validateCycles(record.cycles), startedAt: Date.parse(record.started_at),
    createdAt: Date.parse(record.created_at), updatedAt: Date.parse(record.updated_at),
    // Preserve PostgreSQL microseconds for optimistic concurrency checks.
    revision: record.updated_at,
  };
  if (!light.id || !light.name || !Number.isFinite(light.startedAt) ||
      !Number.isFinite(light.lat) || !Number.isFinite(light.lng)) {
    throw new Error("El servidor devolvió un semáforo no válido.");
  }
  return light;
}

export async function getAllLights() {
  const generation = mutationGeneration;
  try {
    const data = await rpc("semaforos_read");
    const lights = data.lights.map(fromCloudRecord);
    const snapshot = { lights, savedAt: Date.now(), clockOffset };
    if (generation === mutationGeneration) {
      lastSnapshot = snapshot;
      await cacheSnapshot(lastSnapshot).catch(() => {});
    }
    return { ...snapshot, stale: false };
  } catch (error) {
    const cached = lastSnapshot ?? await readSnapshot().catch(() => null);
    if (!cached) throw error;
    clockOffset = cached.clockOffset || 0;
    return { ...cached, stale: true, error: error.message };
  }
}

export async function signInAdmin(pin) {
  const data = await rpc("semaforos_unlock", { p_pin: pin });
  if (!data.ok) {
    if (data.reason === "not_configured") throw new Error("El PIN aún no está configurado en Supabase. Consulta PUBLICAR.md.");
    if (data.retry_after) throw new Error(`Demasiados intentos. Espera ${Math.ceil(data.retry_after / 60)} minutos antes de volver a probar.`);
    throw new Error("PIN incorrecto.");
  }
  editorSession = { token: data.token, expiresAt: Date.parse(data.expires_at) };
}

export async function signOutAdmin() {
  const token = editorSession?.token;
  editorSession = null;
  if (token) await rpc("semaforos_lock", { p_token: token });
}

function token() {
  if (!isEditorUnlocked()) throw new Error("Abre el modo editor e introduce el PIN.");
  if (globalThis.navigator?.onLine === false) throw new Error("Necesitas Internet para publicar cambios.");
  return editorSession.token;
}

export async function saveLight(light, { restart = true } = {}) {
  mutationGeneration += 1;
  const data = await rpc("semaforos_save", {
    p_token: token(),
    p_light: { id: light.id, name: light.name, lat: light.lat, lng: light.lng, cycles: validateCycles(light.cycles) },
    p_expected: light.revision ?? null,
    p_restart: restart,
  });
  const saved = fromCloudRecord(data.light);
  await updateSnapshot(saved, false);
  return saved;
}

export async function removeLight(light) {
  mutationGeneration += 1;
  await rpc("semaforos_delete", { p_token: token(), p_id: light.id, p_expected: light.revision });
  await updateSnapshot(light, true);
}

async function updateSnapshot(light, remove) {
  if (!lastSnapshot) return;
  const lights = lastSnapshot.lights.filter((item) => item.id !== light.id);
  if (!remove) lights.push(light);
  lastSnapshot = { lights, savedAt: Date.now(), clockOffset };
  await cacheSnapshot(lastSnapshot).catch(() => {});
}

function openCache() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      // Separate from the old local database: never overwrite unpublished lights.
      const request = indexedDB.open("semaforos-public-cache", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("snapshot");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Caché bloqueada"));
    });
  }
  return databasePromise;
}

async function cacheSnapshot(snapshot) {
  const db = await openCache();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("snapshot", "readwrite");
    tx.objectStore("snapshot").put(snapshot, url);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function readSnapshot() {
  const db = await openCache();
  return new Promise((resolve, reject) => {
    const request = db.transaction("snapshot").objectStore("snapshot").get(url);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}
