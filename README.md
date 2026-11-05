# Mi Terminal

Cliente SSH personal para Windows hecho con Electron:

- Terminal SSH con pestañas (xterm.js, el mismo terminal de VS Code)
- Gestor de sesiones con carpetas y búsqueda
- Explorador SFTP: navegar, subir (botón o arrastrando archivos), descargar, renombrar, borrar
- Túneles SSH locales y remotos por sesión

## Instalador

```bash
npm run dist
```

Genera `dist\Mi Terminal Setup <versión>.exe`. Al instalarlo crea accesos directos en el
menú Inicio y el escritorio. Para publicar cambios, sube `version` en `package.json`,
vuelve a generar e instala encima: las sesiones se conservan.

## Uso en desarrollo

```bash
npm install
npm start
```

- **Nueva sesión:** botón `+` en la barra lateral.
- **Conectar:** doble clic en la sesión. Clic derecho para editar, duplicar o eliminar.
- **Copiar:** selecciona el texto (se copia solo) o usa Ctrl+Shift+C.
- **Pegar:** clic derecho en la terminal o Ctrl+Shift+V.
- **Reconectar:** Enter en una pestaña desconectada.
- **SFTP:** botón `SFTP` arriba a la derecha; muestra los archivos de la pestaña activa.

## Dónde se guardan los datos

En `%APPDATA%\mi-terminal\`:

- `sessions.json`: las sesiones. Las contraseñas y frases de paso se guardan cifradas con
  el almacén de Windows (DPAPI): solo tu usuario de Windows en este equipo puede descifrarlas.
- `known_hosts.json`: huellas de los servidores en los que confiaste. Si la huella de un
  servidor cambia, la app rechaza la conexión.
