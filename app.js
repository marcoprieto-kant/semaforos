import { getAllLights, removeLight, saveLight } from "./db.js";
import { calculatePhase } from "./traffic-cycle.js";

const DEFAULT_VIEW = { lat: 40.4168, lng: -3.7038, zoom: 6 };
const LAST_VIEW_KEY = "semaforos-last-map-view";

const elements = {
  map: document.querySelector("#map"),
  count: document.querySelector("#light-count"),
  connection: document.querySelector("#connection-status"),
  locate: document.querySelector("#locate-button"),
  placementBanner: document.querySelector("#placement-banner"),
  placementMessage: document.querySelector("#placement-message"),
  cancelPlacement: document.querySelector("#cancel-placement"),
  emptyState: document.querySelector("#empty-state"),
  emptyAdd: document.querySelector("#empty-add-button"),
  add: document.querySelector("#add-button"),
  detail: document.querySelector("#detail-sheet"),
  detailName: document.querySelector("#detail-name"),
  detailChip: document.querySelector("#detail-phase-chip"),
  detailCountdown: document.querySelector("#detail-countdown"),
  detailProgress: document.querySelector("#detail-progress"),
  detailGreen: document.querySelector("#detail-green"),
  detailAmber: document.querySelector("#detail-amber"),
  detailRed: document.querySelector("#detail-red"),
  closeDetail: document.querySelector("#close-detail"),
  edit: document.querySelector("#edit-button"),
  move: document.querySelector("#move-button"),
  delete: document.querySelector("#delete-button"),
  editor: document.querySelector("#editor-dialog"),
  editorTitle: document.querySelector("#editor-title"),
  form: document.querySelector("#light-form"),
  name: document.querySelector("#light-name"),
  green: document.querySelector("#green-time"),
  amber: document.querySelector("#amber-time"),
  red: document.querySelector("#red-time"),
  formError: document.querySelector("#form-error"),
  closeEditor: document.querySelector("#close-editor"),
  cancelEditor: document.querySelector("#cancel-editor"),
  deleteDialog: document.querySelector("#delete-dialog"),
  deleteName: document.querySelector("#delete-name"),
  cancelDelete: document.querySelector("#cancel-delete"),
  confirmDelete: document.querySelector("#confirm-delete"),
  toast: document.querySelector("#toast"),
};

let map;
let lights = [];
let selectedId = null;
let editingId = null;
let pendingCoordinates = null;
let placementMode = null;
let deletionId = null;
let locationMarker = null;
let toastTimeout = null;
const markers = new Map();

initialize().catch((error) => {
  console.error(error);
  showToast("No se pudo iniciar la aplicación. Recarga la página.", true);
});

async function initialize() {
  if (!window.L) {
    throw new Error("Leaflet no está disponible.");
  }

  initializeMap();
  bindEvents();
  updateConnectionStatus();

  try {
    lights = await getAllLights();
  } catch (error) {
    console.error(error);
    showToast("No se pudieron leer los semáforos guardados.", true);
  }

  renderAllLights();
  requestLocation(true);
  setInterval(refreshCycles, 250);

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch((error) => console.warn("Service worker:", error));
    });
  }
}

function initializeMap() {
  const initialView = readLastView();
  map = L.map(elements.map, {
    zoomControl: false,
    attributionControl: true,
  }).setView([initialView.lat, initialView.lng], initialView.zoom);

  L.control.zoom({ position: "bottomleft" }).addTo(map);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  map.on("click", handleMapClick);
  map.on("moveend", saveLastView);
  map.on("locationfound", handleLocationFound);
  map.on("locationerror", handleLocationError);
}

function bindEvents() {
  elements.add.addEventListener("click", () => beginPlacement("add"));
  elements.emptyAdd.addEventListener("click", () => beginPlacement("add"));
  elements.cancelPlacement.addEventListener("click", cancelPlacement);
  elements.locate.addEventListener("click", () => requestLocation(false));
  elements.closeDetail.addEventListener("click", closeDetails);
  elements.edit.addEventListener("click", () => {
    const light = getSelectedLight();
    if (light) openEditor(light);
  });
  elements.move.addEventListener("click", () => {
    const light = getSelectedLight();
    if (light) beginPlacement("move", light.id);
  });
  elements.delete.addEventListener("click", openDeleteConfirmation);
  elements.closeEditor.addEventListener("click", closeEditor);
  elements.cancelEditor.addEventListener("click", closeEditor);
  elements.form.addEventListener("submit", handleFormSubmit);
  elements.cancelDelete.addEventListener("click", closeDeleteConfirmation);
  elements.confirmDelete.addEventListener("click", confirmDelete);
  window.addEventListener("online", updateConnectionStatus);
  window.addEventListener("offline", updateConnectionStatus);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshCycles();
  });

  elements.editor.addEventListener("click", (event) => {
    if (event.target === elements.editor) closeEditor();
  });
  elements.deleteDialog.addEventListener("click", (event) => {
    if (event.target === elements.deleteDialog) closeDeleteConfirmation();
  });
}

function renderAllLights() {
  markers.forEach((marker) => marker.remove());
  markers.clear();
  lights.forEach(createMarker);
  updateEmptyState();
  refreshCycles();
}

function createMarker(light) {
  const state = calculatePhase(light);
  const icon = L.divIcon({
    className: "traffic-light-wrapper",
    html: markerMarkup(light, state),
    iconSize: [42, 83],
    iconAnchor: [21, 74],
  });

  const marker = L.marker([light.lat, light.lng], {
    icon,
    keyboard: true,
    title: light.name,
    alt: `${light.name}, luz ${state.label}`,
    riseOnHover: true,
  }).addTo(map);

  marker.on("click", () => openDetails(light.id));
  markers.set(light.id, marker);
}

function markerMarkup(light, state) {
  const name = escapeHtml(light.name);
  return `
    <div class="traffic-marker phase-${state.phase}" data-light-id="${escapeHtml(light.id)}" aria-label="${name}: ${state.label}">
      <div class="signal-case">
        <span class="signal-lamp red"></span>
        <span class="signal-lamp amber"></span>
        <span class="signal-lamp green"></span>
      </div>
      <span class="marker-countdown">${state.remainingSeconds}</span>
      <span class="marker-pin"></span>
    </div>`;
}

function refreshCycles() {
  const now = Date.now();
  for (const light of lights) {
    const state = calculatePhase(light, now);
    const markerElement = markers.get(light.id)?.getElement()?.querySelector(".traffic-marker");
    if (markerElement) {
      markerElement.classList.remove("phase-green", "phase-amber", "phase-red");
      markerElement.classList.add(`phase-${state.phase}`);
      markerElement.setAttribute("aria-label", `${light.name}: ${state.label}`);
      const countdown = markerElement.querySelector(".marker-countdown");
      if (countdown) countdown.textContent = state.remainingSeconds;
    }
  }

  const selected = getSelectedLight();
  if (selected && !elements.detail.hidden) renderDetails(selected, now);
}

function openDetails(id) {
  const light = lights.find((item) => item.id === id);
  if (!light) return;
  cancelPlacement();
  selectedId = id;
  renderDetails(light);
  elements.detail.hidden = false;
  elements.emptyState.hidden = true;
}

function renderDetails(light, now = Date.now()) {
  const state = calculatePhase(light, now);
  elements.detailName.textContent = light.name;
  elements.detailCountdown.textContent = state.remainingSeconds;
  elements.detailGreen.textContent = `${light.durations.green} s`;
  elements.detailAmber.textContent = `${light.durations.amber} s`;
  elements.detailRed.textContent = `${light.durations.red} s`;
  elements.detailChip.className = `phase-chip ${state.phase}`;
  elements.detailChip.querySelector("span").textContent = state.label;
  elements.detailProgress.style.transform = `scaleX(${state.progress})`;
}

function closeDetails() {
  elements.detail.hidden = true;
  selectedId = null;
  updateEmptyState();
}

function beginPlacement(type, id = null) {
  closeDetails();
  placementMode = { type, id };
  elements.placementMessage.textContent = type === "move"
    ? "Toca el mapa para elegir la nueva posición"
    : "Toca el mapa para colocar el semáforo";
  elements.placementBanner.hidden = false;
  elements.emptyState.hidden = true;
  elements.map.classList.add("placing");
  showToast(type === "move" ? "Elige la nueva posición." : "Elige un punto del mapa.");
}

function cancelPlacement() {
  placementMode = null;
  pendingCoordinates = null;
  elements.placementBanner.hidden = true;
  elements.map.classList.remove("placing");
  updateEmptyState();
}

async function handleMapClick(event) {
  if (!placementMode) return;

  if (placementMode.type === "add") {
    pendingCoordinates = { lat: event.latlng.lat, lng: event.latlng.lng };
    placementMode = null;
    elements.placementBanner.hidden = true;
    elements.map.classList.remove("placing");
    openEditor();
    return;
  }

  const light = lights.find((item) => item.id === placementMode.id);
  if (!light) return;

  const updated = {
    ...light,
    lat: event.latlng.lat,
    lng: event.latlng.lng,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };

  try {
    await saveLight(updated);
    replaceLight(updated);
    cancelPlacement();
    updateMarker(updated);
    openDetails(updated.id);
    showToast("Semáforo movido. El ciclo vuelve a empezar en verde.");
  } catch (error) {
    console.error(error);
    showToast("No se pudo mover el semáforo.", true);
  }
}

function openEditor(light = null) {
  editingId = light?.id ?? null;
  elements.form.reset();
  elements.formError.hidden = true;
  elements.editorTitle.textContent = light ? "Editar semáforo" : "Nuevo semáforo";
  elements.name.value = light?.name ?? `Semáforo ${nextLightNumber()}`;
  elements.green.value = light?.durations.green ?? 30;
  elements.amber.value = light?.durations.amber ?? 3;
  elements.red.value = light?.durations.red ?? 30;
  elements.editor.showModal();
  requestAnimationFrame(() => elements.name.select());
}

function closeEditor() {
  elements.editor.close();
  editingId = null;
  pendingCoordinates = null;
  updateEmptyState();
}

async function handleFormSubmit(event) {
  event.preventDefault();
  const name = elements.name.value.trim();
  const durations = {
    green: Number(elements.green.value),
    amber: Number(elements.amber.value),
    red: Number(elements.red.value),
  };

  if (!name) return showFormError("Ponle un nombre al semáforo.");
  if (Object.values(durations).some((value) => !Number.isInteger(value) || value < 1 || value > 3600)) {
    return showFormError("Cada tiempo debe ser un número entero entre 1 y 3600 segundos.");
  }

  const existing = editingId ? lights.find((item) => item.id === editingId) : null;
  if (!existing && !pendingCoordinates) return showFormError("Falta elegir la posición en el mapa.");

  const now = Date.now();
  const light = {
    id: existing?.id ?? createId(),
    name,
    lat: existing?.lat ?? pendingCoordinates.lat,
    lng: existing?.lng ?? pendingCoordinates.lng,
    durations,
    startedAt: now,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  try {
    await saveLight(light);
    if (existing) {
      replaceLight(light);
      updateMarker(light);
    } else {
      lights.push(light);
      createMarker(light);
    }
    elements.editor.close();
    editingId = null;
    pendingCoordinates = null;
    updateEmptyState();
    openDetails(light.id);
    showToast(existing
      ? "Cambios guardados. El ciclo vuelve a empezar en verde."
      : "Semáforo añadido. El ciclo ha comenzado en verde.");
  } catch (error) {
    console.error(error);
    showFormError("No se pudo guardar. Comprueba el espacio disponible en el iPhone.");
  }
}

function updateMarker(light) {
  const oldMarker = markers.get(light.id);
  if (oldMarker) oldMarker.remove();
  markers.delete(light.id);
  createMarker(light);
}

function replaceLight(updated) {
  lights = lights.map((light) => light.id === updated.id ? updated : light);
}

function openDeleteConfirmation() {
  const light = getSelectedLight();
  if (!light) return;
  deletionId = light.id;
  elements.deleteName.textContent = light.name;
  elements.deleteDialog.showModal();
}

function closeDeleteConfirmation() {
  elements.deleteDialog.close();
  deletionId = null;
}

async function confirmDelete() {
  const id = deletionId;
  if (!id) return;
  try {
    await removeLight(id);
    markers.get(id)?.remove();
    markers.delete(id);
    lights = lights.filter((light) => light.id !== id);
    closeDeleteConfirmation();
    closeDetails();
    updateEmptyState();
    showToast("Semáforo eliminado.");
  } catch (error) {
    console.error(error);
    showToast("No se pudo eliminar el semáforo.", true);
  }
}

function requestLocation(initial) {
  elements.locate.classList.add("is-loading");
  elements.locate.setAttribute("aria-busy", "true");
  elements.locate.dataset.initial = String(initial);
  map.locate({
    setView: false,
    enableHighAccuracy: false,
    timeout: 10000,
    maximumAge: 60000,
  });
}

function handleLocationFound(event) {
  const isInitial = elements.locate.dataset.initial === "true";
  elements.locate.classList.remove("is-loading");
  elements.locate.removeAttribute("aria-busy");
  map.setView(event.latlng, isInitial ? 16 : Math.max(map.getZoom(), 16), { animate: true });

  if (!locationMarker) {
    locationMarker = L.circleMarker(event.latlng, {
      radius: 7,
      color: "#ffffff",
      weight: 3,
      fillColor: "#2d7ff9",
      fillOpacity: 1,
      interactive: false,
    }).addTo(map);
  } else {
    locationMarker.setLatLng(event.latlng);
  }

  if (!isInitial) showToast("Mapa centrado en tu ubicación.");
}

function handleLocationError() {
  const isInitial = elements.locate.dataset.initial === "true";
  elements.locate.classList.remove("is-loading");
  elements.locate.removeAttribute("aria-busy");
  if (isInitial) {
    showToast("No se pudo usar tu ubicación. Puedes moverte por el mapa manualmente.");
  } else {
    showToast("Activa el permiso de ubicación para centrar el mapa.", true);
  }
}

function updateEmptyState() {
  const count = lights.length;
  elements.count.textContent = count === 1 ? "1 instalado" : `${count} instalados`;
  elements.emptyState.hidden = count > 0 || Boolean(placementMode) || !elements.detail.hidden;
}

function updateConnectionStatus() {
  const online = navigator.onLine;
  elements.connection.classList.toggle("offline", !online);
  elements.connection.lastChild.textContent = online ? " En línea" : " Sin conexión";
}

function saveLastView() {
  const center = map.getCenter();
  localStorage.setItem(LAST_VIEW_KEY, JSON.stringify({
    lat: center.lat,
    lng: center.lng,
    zoom: map.getZoom(),
  }));
}

function readLastView() {
  try {
    const value = JSON.parse(localStorage.getItem(LAST_VIEW_KEY));
    if (Number.isFinite(value?.lat) && Number.isFinite(value?.lng) && Number.isFinite(value?.zoom)) return value;
  } catch {
    // Se usa la vista predeterminada.
  }
  return DEFAULT_VIEW;
}

function getSelectedLight() {
  return lights.find((light) => light.id === selectedId) ?? null;
}

function nextLightNumber() {
  const used = new Set(lights.map((light) => light.name));
  let number = lights.length + 1;
  while (used.has(`Semáforo ${number}`)) number += 1;
  return number;
}

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `light-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function showFormError(message) {
  elements.formError.textContent = message;
  elements.formError.hidden = false;
}

function showToast(message, isError = false) {
  clearTimeout(toastTimeout);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", isError);
  elements.toast.hidden = false;
  toastTimeout = setTimeout(() => {
    elements.toast.hidden = true;
  }, 3600);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#039;",
    '"': "&quot;",
  })[character]);
}
