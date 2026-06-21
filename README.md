# Semáforos

PWA privada para colocar semáforos independientes sobre OpenStreetMap y configurar manualmente sus tiempos. Los datos permanecen exclusivamente en IndexedDB, dentro del dispositivo.

## Probar en el ordenador

```powershell
npm start
```

Abre `http://127.0.0.1:4173`. Las pruebas del cálculo se ejecutan con `npm test`.

## Instalar en iPhone

Una vez publicada con HTTPS, abre el enlace en Safari, pulsa **Compartir** y después **Añadir a pantalla de inicio**.

## Publicar gratis en GitHub Pages

1. Sube estos archivos a un repositorio de GitHub cuya rama principal sea `main`.
2. En **Settings → Pages**, selecciona **GitHub Actions** como origen.
3. La automatización incluida publicará la web y mostrará su dirección HTTPS.

## Privacidad y conexión

No hay cuentas ni servidor de datos. Al borrar la PWA o los datos del sitio se borran también los semáforos. La interfaz funciona sin conexión después de la primera carga; el mapa base utiliza las zonas que conserve la caché normal del navegador y no descarga áreas de forma masiva.
