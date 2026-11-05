# Mi Terminal

Cliente SSH para Windows, liviano y enfocado en administrar servidores Linux (pensado para
instancias EC2 con Ubuntu). Reúne en una sola ventana lo que normalmente se hace con
MobaXterm, PuTTY y WinSCP.

## Funciones

- **Terminal SSH con pestañas.** Colores, `top`, `nano`, `vim`, etc. Copiar al seleccionar,
  pegar con clic derecho o `Ctrl+Shift+V`. Enter en una pestaña desconectada la reconecta.
- **Gestor de sesiones.** Agrupadas por carpeta y con búsqueda. Autenticación por contraseña,
  clave privada (OpenSSH o **PuTTY `.ppk` v2 y v3**) o agente SSH.
- **Explorador SFTP.** Navegar, subir (botón o arrastrando archivos), descargar, renombrar,
  crear carpetas y borrar.
  - **Modo sudo:** opera como administrador para escribir en carpetas de `root` o `www-data`.
    Los archivos nuevos quedan con el dueño de su carpeta.
  - **Edición remota (estilo WinSCP):** doble clic abre el archivo en tu editor y cada vez
    que guardas se sube solo al servidor.
- **Túneles SSH** locales y remotos, configurados por sesión.
- **Barra de estadísticas del servidor:** CPU con gráfico, RAM, red, tiempo encendido,
  usuarios conectados y uso de discos, actualizada cada 2 segundos.
- **Paneles ajustables:** el ancho de la lista de sesiones y del panel SFTP se cambia
  arrastrando el divisor (doble clic vuelve al original) y se recuerda.

## Tecnologías

| Pieza | Versión | Uso |
|---|---|---|
| [Electron](https://www.electronjs.org/) | 45 | App de escritorio: Chromium para la ventana y Node.js 24 para red, archivos y cifrado. |
| [ssh2](https://github.com/mscdex/ssh2) | 1.17.0 (fija) | Conexión SSH, autenticación, terminal, SFTP, túneles y canal de estadísticas. JavaScript puro, sin depender de OpenSSH ni PuTTY. |
| [xterm.js](https://xtermjs.org/) | 6 | El terminal en pantalla (el mismo de VS Code), con los complementos `fit` (ajuste de tamaño) y `webgl` (dibujo por tarjeta gráfica). |
| [hash-wasm](https://github.com/Daninet/hash-wasm) | 4.12 | Argon2 en WebAssembly, necesario para abrir claves PuTTY v3. |
| HTML, CSS y JavaScript | — | Interfaz sin frameworks. |
| [electron-builder](https://www.electron.build/) + NSIS | 26 | Genera el instalador `.exe` para Windows. |

`ssh2` está fijado a una versión exacta porque el modo sudo de SFTP usa un detalle interno
de esa librería. Antes de actualizarla, prueba el modo sudo.

## Estructura

```
src/
  main.js              Proceso principal: sesiones, SSH, SFTP, túneles, edición remota y seguridad
  preload.js           Puente entre la interfaz y el proceso principal (lo único que la interfaz puede usar)
  ppk.js               Lector de claves PuTTY v2/v3 → formato OpenSSH, solo en memoria
  stats.js             Estadísticas del servidor (lee /proc, df y who por un canal SSH aparte)
  renderer/
    index.html         Estructura de la ventana
    renderer.js        Interfaz: pestañas, árbol de sesiones, panel SFTP, barra de estadísticas
    styles.css         Estilos (tema oscuro)
build/icon.png         Icono de la app
```

## Desarrollo

Requiere [Node.js](https://nodejs.org/) 20 o superior.

```bash
npm install
npm start
```

Si `npm start` dice que falta el ejecutable de Electron, ejecuta una vez
`node node_modules/electron/install.js`.

## Generar el instalador

```bash
npm run dist
```

Crea `dist\Mi Terminal Setup <versión>.exe`. Instala solo para el usuario actual (sin
permisos de administrador) y crea accesos directos en el escritorio y el menú Inicio.
Para una versión nueva, sube `version` en `package.json`, vuelve a generar e instala
encima: las sesiones se conservan.

El instalador no tiene firma digital, así que Windows mostrará "Windows protegió su PC".
Hay que pulsar **Más información → Ejecutar de todas formas**.

## Dónde se guardan los datos

Fuera del proyecto, en `%APPDATA%\mi-terminal\`:

| Archivo | Contenido |
|---|---|
| `sessions.json` | Sesiones. Las contraseñas y frases de paso van cifradas con DPAPI de Windows: solo tu usuario, en tu equipo, puede descifrarlas. |
| `known_hosts.json` | Huellas de los servidores en los que confiaste. Si una cambia, la conexión se bloquea. |
| `settings.json` | Preferencias, como el editor elegido. |

Las copias temporales de la edición remota se guardan en `%TEMP%\mi-terminal-edit\` y se
borran al cerrar la pestaña o la app.

## Seguridad

- **Ventana aislada:** `contextIsolation`, `sandbox` y política de contenido estricta. La
  interfaz no accede al sistema; solo usa las funciones que expone `preload.js`, y el
  proceso principal verifica que cada llamada venga de la ventana de la app.
- **Los secretos nunca llegan a la interfaz:** contraseñas y frases de paso se descifran
  solo en el proceso principal, al conectar.
- **Verificación de servidores:** la primera conexión muestra la huella SHA-256. Las
  siguientes se comparan y, si cambia, la conexión se bloquea.
- **Algoritmos modernos:** se excluyen los basados en SHA-1.
- **Archivos del servidor:** los nombres y datos que llegan del servidor se muestran como
  texto, nunca como HTML. Con el programa predeterminado de Windows no se abren tipos
  ejecutables (`.bat`, `.exe`, `.js`, `.lnk`…), para que un servidor comprometido no
  pueda ejecutar nada en tu PC.
- **Ejecutable reforzado:** Electron Fuses desactivan `RunAsNode` y la depuración por línea
  de comandos, y se valida la integridad del paquete. La versión instalada no se abre con
  `--remote-debugging-port`.
- **Túneles solo locales:** escuchan en `127.0.0.1`, no en la red.

Precauciones de uso:

- El **modo sudo** da control total del servidor. Actívalo solo donde lo necesites.
- Si un programa malicioso corre con tu usuario de Windows, puede descifrar las
  contraseñas guardadas, igual que con cualquier otro cliente SSH. Si prefieres no
  guardarlas, deja el campo vacío y la app las pedirá al conectar.
- No hay actualizaciones automáticas: mantén la app al día generando versiones nuevas.
  Electron recibe parches de seguridad con frecuencia.
  **Dependabot** (`.github/dependabot.yml`) revisa las dependencias cada lunes y abre
  propuestas de actualización. Antes de aceptar una, prueba la app con `npm start`.
- **Nunca** pongas claves ni archivos de sesiones dentro de esta carpeta. El `.gitignore`
  los excluye, pero lo más seguro es tenerlos fuera.
