const DATABASE_NAME = "semaforos-db";
const DATABASE_VERSION = 1;
const STORE_NAME = "traffic-lights";

let databasePromise;

function openDatabase() {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          const store = database.createObjectStore(STORE_NAME, { keyPath: "id" });
          store.createIndex("createdAt", "createdAt");
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("La base de datos está bloqueada por otra ventana."));
    });
  }

  return databasePromise;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getStore(mode) {
  const database = await openDatabase();
  return database.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
}

export async function getAllLights() {
  const store = await getStore("readonly");
  const records = await requestToPromise(store.getAll());
  return records.sort((a, b) => a.createdAt - b.createdAt);
}

export async function saveLight(light) {
  const store = await getStore("readwrite");
  await requestToPromise(store.put(light));
  return light;
}

export async function removeLight(id) {
  const store = await getStore("readwrite");
  await requestToPromise(store.delete(id));
}
