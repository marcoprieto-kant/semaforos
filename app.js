import { getAllLights, isEditorUnlocked, removeLight, saveLight, serverNow, signInAdmin, signOutAdmin } from "./db.js";
import { calculatePhase, MAX_CYCLES, validateCycles } from "./traffic-cycle.js";

const $ = (id) => document.getElementById(id);
const DEFAULT_VIEW = { lat: 41.6523, lng: -4.7245, zoom: 15 };
const LAST_VIEW_KEY = "semaforos-last-map-view";
const markers = new Map();
let map, locationMarker;
let lights = [], selectedId = null, editingLight = null, draftId = null;
let pendingCoordinates = null, placement = null, deletionLight = null, syncLight = null;
let refreshing = false, writing = false, mutationEpoch = 0, loadState = "loading", snapshotDate = null;
let unlockedUI = false, tapCount = 0, tapTimeout, toastTimeout;

initialize().catch(() => {
  $("empty-state").hidden = false;
  $("empty-title").textContent = "No se pudo cargar el mapa";
  $("empty-description").textContent = "Comprueba Internet y recarga. Si es tu primera visita necesitas conexión.";
});

async function initialize() {
  bindEvents();
  registerServiceWorker();
  if (!window.L) throw new Error("Leaflet no disponible");
  const view = readLastView();
  map = L.map("map", { zoomControl: false }).setView([view.lat, view.lng], view.zoom);
  L.control.zoom({ position: "bottomleft" }).addTo(map);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  map.on("click", handleMapClick);
  map.on("moveend", saveLastView);
  map.on("locationfound", handleLocationFound);
  map.on("locationerror", () => {
    $("locate-button").disabled = false;
    toast("No se pudo obtener tu ubicación. Puedes moverte por el mapa o habilitar el permiso.");
  });
  updateEditorMode();
  updateStatus();
  updateEmptyState();
  // Ask for location on first visit only; subsequent visits retain the map view.
  if (!view.restored) requestLocation();
  await refreshLights();
  setInterval(() => { if (!document.hidden) refreshCycles(); }, 250);
  setInterval(() => { if (!document.hidden && navigator.onLine) refreshLights(); }, 15000);
}

function bindEvents() {
  $("admin-trigger").addEventListener("click", () => {
    clearTimeout(tapTimeout);
    tapTimeout = setTimeout(() => { tapCount = 0; }, 1600);
    if (++tapCount >= 5) { tapCount = 0; openAdmin(); }
  });
  $("admin-badge").addEventListener("click", openAdmin);
  $("admin-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if ($("admin-submit").disabled || isEditorUnlocked()) return;
    const pin = $("admin-pin").value.trim();
    if (!/^[0-9]{4,12}$/.test(pin)) return errorText("admin-error", "Introduce un PIN de 4 a 12 cifras.");
    $("admin-submit").disabled = true;
    $("admin-error").hidden = true;
    try {
      await signInAdmin(pin);
      $("admin-dialog").close();
      updateEditorMode();
      toast("Modo editor activado. Los cambios se publican para todos.");
    } catch (error) { errorText("admin-error", error.message); }
    finally { $("admin-submit").disabled = false; $("admin-pin").value = ""; }
  });
  $("admin-signout").addEventListener("click", async () => {
    try { await signOutAdmin(); toast("Edición cerrada."); }
    catch { toast("Edición cerrada aquí. La sesión del servidor caducará automáticamente."); }
    updateEditorMode(); $("admin-dialog").close();
  });
  for (const id of ["close-admin", "cancel-admin"]) $(id).addEventListener("click", () => $("admin-dialog").close());
  $("admin-dialog").addEventListener("close", () => { $("admin-pin").value = ""; });
  $("add-button").addEventListener("click", () => beginPlacement("add"));
  $("empty-add-button").addEventListener("click", () => beginPlacement("add"));
  $("cancel-placement").addEventListener("click", () => { if (!writing) cancelPlacement(); });
  $("locate-button").addEventListener("click", requestLocation);
  $("refresh-button").addEventListener("click", () => refreshLights(true));
  $("close-detail").addEventListener("click", closeDetails);
  $("edit-button").addEventListener("click", () => { if (selectedLight()) openEditor(selectedLight()); });
  $("move-button").addEventListener("click", () => { if (selectedLight()) beginPlacement("move", selectedLight()); });
  $("delete-button").addEventListener("click", () => {
    if (!ensureEditor() || !selectedLight()) return;
    deletionLight = structuredClone(selectedLight());
    $("delete-name").textContent = deletionLight.name;
    $("delete-error").hidden = true;
    $("delete-dialog").showModal();
  });
  $("cancel-delete").addEventListener("click", () => { if (!writing) $("delete-dialog").close(); });
  $("confirm-delete").addEventListener("click", confirmDelete);
  for (const id of ["close-editor", "cancel-editor"]) $(id).addEventListener("click", () => { if (!writing) $("editor-dialog").close(); });
  $("editor-dialog").addEventListener("close", () => {
    editingLight = null; pendingCoordinates = null; draftId = null; updateEmptyState();
  });
  $("light-form").addEventListener("submit", handleSave);
  $("add-cycle").addEventListener("click", () => {
    const rows = $("cycle-rows").children;
    if (rows.length >= MAX_CYCLES) return;
    const last = rows[rows.length - 1];
    appendCycle({ green: last.querySelector('[data-phase="green"]').value, red: last.querySelector('[data-phase="red"]').value });
    $("cycle-rows").lastElementChild.querySelector("input").focus();
  });
  $("cycle-rows").addEventListener("input", updateSequenceTotal);
  $("sync-button").addEventListener("click", () => {
    if (!ensureEditor() || !selectedLight()) return;
    syncLight = structuredClone(selectedLight());
    $("sync-error").hidden = true;
    $("sync-dialog").showModal();
  });
  $("confirm-sync").addEventListener("click", synchronize);
  $("search-button").addEventListener("click", () => {
    $("search-input").value = ""; renderSearch(); $("search-dialog").showModal();
  });
  $("search-input").addEventListener("input", renderSearch);
  $("show-all").addEventListener("click", () => {
    $("search-dialog").close(); closeDetails(); cancelPlacement();
    if (lights.length) map.fitBounds(lights.map((l) => [l.lat, l.lng]), { padding: [80, 150], maxZoom: 17 });
  });
  $("info-button").addEventListener("click", () => $("info-dialog").showModal());
  $("export-button").addEventListener("click", exportLights);
  for (const dialog of document.querySelectorAll("dialog")) {
    dialog.addEventListener("cancel", (event) => { if (writing) event.preventDefault(); });
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog || writing) return;
      const r = dialog.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close();
    });
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { refreshCycles(); refreshLights(); }
  });
  window.addEventListener("pageshow", () => { if (map) refreshLights(); });
  window.addEventListener("online", () => refreshLights());
  window.addEventListener("offline", () => { updateStatus(); toast("Sin conexión: los datos pueden estar desactualizados."); });
  window.addEventListener("resize", () => { map?.invalidateSize(); if (selectedLight()) requestAnimationFrame(focusSelectedMarker); });
}

async function refreshLights(manual = false) {
  if (refreshing || writing || !map) return;
  refreshing = true;
  $("refresh-button").disabled = true;
  const epoch = mutationEpoch;
  try {
    const snapshot = await getAllLights();
    if (epoch !== mutationEpoch || writing) return;
    lights = snapshot.lights;
    snapshotDate = snapshot.savedAt;
    loadState = snapshot.stale ? "stale" : "ready";
    renderLights();
    if (manual) toast(snapshot.stale ? snapshot.error : "Mapa actualizado.", snapshot.stale);
  } catch (error) {
    loadState = "error";
    if (manual) toast(error.message, true);
  } finally {
    refreshing = false; $("refresh-button").disabled = false;
    updateStatus(); updateEmptyState();
  }
}

function openAdmin() {
  $("admin-error").hidden = true;
  $("admin-pin").value = "";
  $("pin-field").hidden = isEditorUnlocked();
  $("admin-submit").hidden = isEditorUnlocked();
  $("admin-signout").hidden = !isEditorUnlocked();
  $("admin-dialog").showModal();
  if (!isEditorUnlocked()) $("admin-pin").focus();
}

function updateEditorMode() {
  unlockedUI = isEditorUnlocked();
  for (const id of ["admin-badge", "add-button", "empty-add-button", "editor-actions", "sync-button"]) $(id).hidden = !unlockedUI;
  if (!unlockedUI) {
    cancelPlacement();
    for (const id of ["editor-dialog", "delete-dialog", "sync-dialog"]) if ($(id).open) $(id).close();
  }
  updateEmptyState();
}

function ensureEditor() {
  if (!isEditorUnlocked()) { updateEditorMode(); toast("Introduce el PIN para editar.", true); return false; }
  if (!navigator.onLine) { toast("Necesitas conexión para publicar cambios.", true); return false; }
  return !writing;
}

function renderLights() {
  const ids = new Set(lights.map((l) => l.id));
  for (const [id, entry] of markers) {
    if (!ids.has(id)) { entry.marker.remove(); markers.delete(id); }
  }
  for (const light of lights) {
    const previous = markers.get(light.id);
    if (previous?.revision === light.revision) continue;
    previous?.marker.remove();
    const marker = L.marker([light.lat, light.lng], {
      icon: L.divIcon({
        className: "traffic-light-wrapper", iconSize: [44, 68], iconAnchor: [22, 64],
        html: '<div class="traffic-marker"><div class="signal-case"><span class="signal-lamp red"></span><span class="signal-lamp green"></span></div><span class="marker-countdown"></span><span class="marker-pin"></span></div>',
      }),
      title: light.name, keyboard: true, riseOnHover: true,
    }).addTo(map);
    marker.on("click", () => openDetails(light.id));
    markers.set(light.id, { marker, revision: light.revision });
  }
  if (selectedId && !selectedLight()) closeDetails();
  updateEmptyState(); refreshCycles();
  if ($("search-dialog").open) renderSearch();
}

function refreshCycles() {
  if (unlockedUI !== isEditorUnlocked()) updateEditorMode();
  const now = serverNow();
  for (const light of lights) {
    const state = calculatePhase(light, now);
    const root = markers.get(light.id)?.marker.getElement();
    if (!root) continue;
    root.setAttribute("aria-label", `${light.name}: ${state.label}, ${state.remainingSeconds} segundos estimados`);
    const body = root.querySelector(".traffic-marker");
    body.className = `traffic-marker phase-${state.phase}`;
    body.querySelector(".marker-countdown").textContent = state.remainingSeconds;
  }
  if (selectedLight()) renderDetails(selectedLight(), now);
}

function selectedLight() { return lights.find((l) => l.id === selectedId); }
function openDetails(id) {
  if (!lights.some((l) => l.id === id)) return;
  cancelPlacement(); selectedId = id;
  $("detail-sheet").hidden = false;
  document.body.classList.add("details-open");
  renderDetails(selectedLight()); updateEmptyState();
  requestAnimationFrame(focusSelectedMarker);
}
function focusSelectedMarker() {
  const light = selectedLight();
  if (!light || $("detail-sheet").hidden) return;
  const sheet = $("detail-sheet").getBoundingClientRect();
  const size = map.getSize();
  const point = map.latLngToContainerPoint([light.lat, light.lng]);
  let x = size.x / 2, y = size.y / 2;
  if (size.x < 700 && size.y >= 540) {
    // Keep the entire marker in the visible strip between the notice and sheet.
    const top = document.querySelector(".safety-notice").getBoundingClientRect().bottom;
    y = Math.min(sheet.top - 8, (top + sheet.top + 60) / 2);
  } else if (sheet.left < size.x / 2) {
    x = (sheet.right + size.x) / 2;
  } else {
    x = sheet.left / 2; y = Math.max(210, size.y * 0.62);
  }
  map.panBy([point.x - x, point.y - y], { animate: false });
}
function closeDetails() {
  $("detail-sheet").hidden = true; selectedId = null;
  document.body.classList.remove("details-open"); updateEmptyState();
}
function renderDetails(light, now = serverNow()) {
  const state = calculatePhase(light, now), cycle = light.cycles[state.cycleIndex];
  $("detail-name").textContent = light.name;
  $("detail-countdown").textContent = state.remainingSeconds;
  $("detail-green").textContent = `${cycle.green} s`;
  $("detail-red").textContent = `${cycle.red} s`;
  $("detail-phase-chip").className = `phase-chip ${state.phase}`;
  $("detail-phase-chip").querySelector("span").textContent = state.label;
  $("detail-progress").style.transform = `scaleX(${state.progress})`;
  $("detail-sequence").textContent = `Vuelta ${state.cycleIndex + 1} de ${state.cycleCount} · Secuencia de ${formatDuration(state.sequenceDurationSeconds)}`;
  $("detail-updated").textContent = `Configurado: ${new Date(light.updatedAt).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" })}. Tiempos orientativos.`;
}

function beginPlacement(type, light = null) {
  if (!ensureEditor()) return;
  closeDetails(); placement = { type, light: light ? structuredClone(light) : null };
  $("placement-message").textContent = type === "move" ? "Toca la nueva posición. Se mantendrá la secuencia." : "Toca el punto exacto del mapa para añadirlo.";
  $("placement-banner").hidden = false; $("map").classList.add("placing"); updateEmptyState();
}
function cancelPlacement() {
  placement = null; $("placement-banner").hidden = true; $("map").classList.remove("placing"); updateEmptyState();
}
async function handleMapClick(event) {
  if (!placement || !ensureEditor()) return;
  const point = { lat: event.latlng.lat, lng: event.latlng.wrap().lng };
  if (placement.type === "add") {
    pendingCoordinates = point; cancelPlacement(); openEditor(); return;
  }
  const light = { ...placement.light, ...point };
  setWriting(true);
  try {
    const saved = await saveLight(light, { restart: false });
    acceptSaved(saved); cancelPlacement(); openDetails(saved.id); toast("Posición publicada. La secuencia se mantiene.");
  } catch (error) { toast(error.message, true); }
  finally { setWriting(false); }
}

function openEditor(light = null) {
  if (!ensureEditor()) return;
  editingLight = light ? structuredClone(light) : null;
  draftId = light?.id ?? crypto.randomUUID();
  $("form-error").hidden = true;
  $("editor-title").textContent = light ? "Editar semáforo" : "Nuevo semáforo";
  $("light-name").value = light?.name ?? "";
  $("light-name").placeholder = "Por ejemplo: Plaza Mayor · lado norte";
  $("cycle-rows").replaceChildren();
  for (const cycle of light?.cycles ?? [{ green: 45, red: 45 }]) appendCycle(cycle);
  $("editor-dialog").showModal();
}

function appendCycle(cycle) {
  const row = document.createElement("section"); row.className = "cycle-row";
  row.innerHTML = '<div class="cycle-heading"><strong></strong><button class="remove-cycle" type="button">Quitar</button></div><div class="timing-grid"></div>';
  for (const [phase, label] of [["green", "Verde"], ["red", "Rojo"]]) {
    const field = document.createElement("label"); field.className = `timing-field ${phase}`;
    field.innerHTML = `<span><i></i>${label}</span><span class="number-input"><input type="number" inputmode="numeric" min="1" max="3600" step="1" required data-phase="${phase}" /><b>s</b></span>`;
    field.querySelector("input").value = cycle[phase]; row.querySelector(".timing-grid").append(field);
  }
  row.querySelector("button").addEventListener("click", () => { row.remove(); updateSequenceTotal(); });
  $("cycle-rows").append(row); updateSequenceTotal();
}
function readCycles() {
  return [...$("cycle-rows").children].map((row) => ({
    green: Number(row.querySelector('[data-phase="green"]').value),
    red: Number(row.querySelector('[data-phase="red"]').value),
  }));
}
function updateSequenceTotal() {
  const rows = [...$("cycle-rows").children];
  rows.forEach((row, i) => {
    row.querySelector("strong").textContent = `Vuelta ${i + 1}`;
    row.querySelector("button").disabled = rows.length === 1;
    row.querySelector("button").setAttribute("aria-label", `Quitar vuelta ${i + 1}`);
    row.querySelectorAll("input").forEach((input) => input.setAttribute("aria-label", `${input.dataset.phase === "green" ? "Verde" : "Rojo"} de vuelta ${i + 1}, segundos`));
  });
  $("add-cycle").disabled = rows.length >= MAX_CYCLES;
  try {
    const cycles = validateCycles(readCycles());
    $("sequence-total").textContent = `${cycles.length} de ${MAX_CYCLES} vueltas · Total ${formatDuration(cycles.reduce((n, c) => n + c.green + c.red, 0))}`;
  } catch { $("sequence-total").textContent = "Cada luz debe durar entre 1 y 3600 segundos."; }
}

async function handleSave(event) {
  event.preventDefault(); if (!ensureEditor()) return;
  const name = $("light-name").value.trim();
  if (!name || [...name].length > 60) return errorText("form-error", "Escribe un nombre de 1 a 60 caracteres.");
  let cycles;
  try { cycles = validateCycles(readCycles()); }
  catch (error) { return errorText("form-error", error.message); }
  if (!editingLight && !pendingCoordinates) return errorText("form-error", "Selecciona la ubicación en el mapa.");
  const light = { ...(editingLight ?? pendingCoordinates), id: draftId, name, cycles };
  setWriting(true); $("form-error").hidden = true;
  try {
    const saved = await saveLight(light);
    acceptSaved(saved); $("editor-dialog").close(); openDetails(saved.id);
    toast("Semáforo publicado. Comienza el verde de la primera vuelta.");
  } catch (error) { errorText("form-error", error.message); }
  finally { setWriting(false); }
}

async function synchronize() {
  if (!ensureEditor() || !syncLight) return;
  setWriting(true);
  try {
    const saved = await saveLight(syncLight);
    acceptSaved(saved); $("sync-dialog").close(); toast("Sincronizado: verde de la primera vuelta.");
  } catch (error) { errorText("sync-error", error.message); }
  finally { setWriting(false); }
}
async function confirmDelete() {
  if (!ensureEditor() || !deletionLight) return;
  setWriting(true);
  try {
    await removeLight(deletionLight);
    lights = lights.filter((l) => l.id !== deletionLight.id);
    $("delete-dialog").close(); closeDetails(); renderLights(); toast("Semáforo eliminado del mapa público.");
  } catch (error) { errorText("delete-error", error.message); }
  finally { setWriting(false); }
}
function acceptSaved(saved) {
  lights = lights.filter((l) => l.id !== saved.id); lights.push(saved);
  loadState = "ready"; snapshotDate = Date.now(); renderLights(); updateStatus();
}
function setWriting(value) {
  writing = value; mutationEpoch += 1;
  for (const id of ["save-button", "confirm-delete", "confirm-sync", "cancel-placement", "admin-signout"]) $(id).disabled = value;
  $("save-button").textContent = value ? "Publicando…" : "Publicar semáforo";
  updateEditorMode();
}

function renderSearch() {
  const normalize = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const query = normalize($("search-input").value.trim());
  const matches = lights.filter((l) => normalize(l.name).includes(query)).sort((a, b) => a.name.localeCompare(b.name, "es"));
  $("search-results").replaceChildren();
  if (!matches.length) $("search-results").textContent = "No hay semáforos que coincidan.";
  for (const light of matches) {
    const button = document.createElement("button"); button.type = "button"; button.className = "search-result";
    button.textContent = light.name;
    button.addEventListener("click", () => {
      $("search-dialog").close();
      map.setView([light.lat, light.lng], 18, { animate: false });
      openDetails(light.id);
    });
    $("search-results").append(button);
  }
  $("show-all").disabled = !lights.length;
}
function exportLights() {
  const blob = new Blob([JSON.stringify({ version: 4, exportedAt: new Date().toISOString(), lights }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = `semaforos-${new Date().toISOString().slice(0, 10)}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function updateEmptyState() {
  const count = lights.length;
  $("light-count").textContent = `${count} ${count === 1 ? "semáforo" : "semáforos"}`;
  $("empty-state").hidden = count > 0 || Boolean(placement) || $("editor-dialog").open || !$("detail-sheet").hidden;
  const failed = loadState === "error";
  $("empty-title").textContent = failed ? "No se pudo conectar" : loadState === "loading" ? "Cargando semáforos…" : "Valladolid, paso a paso";
  $("empty-description").textContent = failed
    ? "Pulsa Actualizar para reintentar. Si estás configurando la web, revisa los pasos de Supabase."
    : loadState === "loading" ? "Conectando con el mapa público."
    : unlockedUI ? "Añade el primer semáforo y configura sus vueltas."
    : "Todavía no hay semáforos publicados. Los que se añadan aparecerán aquí para todos.";
}
function updateStatus() {
  const stale = !navigator.onLine || loadState === "stale" || loadState === "error";
  $("connection-status").classList.toggle("offline", stale);
  $("connection-status").querySelector("b").textContent = stale
    ? snapshotDate ? "Copia sin actualizar" : "Sin datos del servidor"
    : loadState === "loading" ? "Conectando…" : "Mapa compartido";
  $("connection-status").title = snapshotDate ? `Última descarga: ${new Date(snapshotDate).toLocaleString("es-ES")}` : "Pendiente de conexión";
}
function requestLocation() {
  if (!map || $("locate-button").disabled) return;
  $("locate-button").disabled = true;
  map.locate({ setView: false, enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
}
function handleLocationFound(event) {
  $("locate-button").disabled = false;
  // Do not interrupt a point selection or a timing edit if GPS arrives late.
  if (!placement && !$("editor-dialog").open) map.setView(event.latlng, 17);
  if (!locationMarker) locationMarker = L.circleMarker(event.latlng, {
    radius: 7, color: "#fff", weight: 3, fillColor: "#2d7ff9", fillOpacity: 1, interactive: false,
  }).addTo(map);
  else locationMarker.setLatLng(event.latlng);
}
function saveLastView() {
  try {
    const center = map.getCenter();
    localStorage.setItem(LAST_VIEW_KEY, JSON.stringify({ lat: center.lat, lng: center.lng, zoom: map.getZoom() }));
  } catch { /* Browsing without storage still works. */ }
}
function readLastView() {
  try {
    const view = JSON.parse(localStorage.getItem(LAST_VIEW_KEY));
    if (Number.isFinite(view?.lat) && Math.abs(view.lat) <= 90 && Number.isFinite(view?.lng) && Number.isFinite(view?.zoom)) return { ...view, restored: true };
  } catch { /* First visit / disabled storage. */ }
  return DEFAULT_VIEW;
}
function formatDuration(seconds) {
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min${seconds % 60 ? ` ${seconds % 60} s` : ""}`;
}
function errorText(id, message) { $(id).textContent = message; $(id).hidden = false; }
function toast(message, error = false) {
  clearTimeout(toastTimeout); $("toast").textContent = message;
  $("toast").classList.toggle("error", error); $("toast").hidden = false;
  toastTimeout = setTimeout(() => { $("toast").hidden = true; }, error ? 6500 : 4000);
}
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  let reloading = false;
  const wasControlled = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!wasControlled || reloading) return;
    // Never discard an editor's draft to install an update.
    if (writing || $("editor-dialog").open || isEditorUnlocked()) {
      toast("Hay una nueva versión. Termina la edición y recarga la web."); return;
    }
    reloading = true; location.reload();
  });
  navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).then((registration) => registration.update()).catch(() => {});
}
