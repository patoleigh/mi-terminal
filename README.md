# Mi Terminal

Cliente SSH para Windows, liviano y enfocado en administrar servidores Linux (pensado para
instancias EC2 con Ubuntu). Reúne en una sola ventana lo que normalmente se hace con
MobaXterm, PuTTY y WinSCP.

## Funciones

- **Terminal SSH con pestañas.** Colores, `top`, `nano`, `vim`, etc. Copiar al seleccionar,
  pegar con clic derecho o `Ctrl+Shift+V`. Enter en una pestaña desconectada la reconecta.
- **Consolas locales.** El botón **+ Consola** abre PowerShell, CMD, Git Bash o una
  distribución de WSL (por ejemplo Ubuntu) de este equipo en una pestaña más. Solo se
  ofrecen las que están instaladas.
- **Agentes de IA (MCP).** Claude Code, Cursor, Codex u otro cliente MCP pueden usar la app:
  abrir sesiones, ejecutar comandos, leer la salida y manejar archivos. Solo en las sesiones
  que marques y con tu aprobación en cada acción. Ver [Agentes de IA](#agentes-de-ia-mcp).
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
  usuarios conectados y uso de discos, actualizada cada 2 segundos. Ocupa siempre una
  línea: si no cabe todo, se recorre con las flechas o la rueda del mouse.
- **Paneles ajustables:** el ancho de la lista de sesiones y del panel SFTP se cambia
  arrastrando el divisor (doble clic vuelve al original) y se recuerda.

## Tecnologías

| Pieza | Versión | Uso |
|---|---|---|
| [Electron](https://www.electronjs.org/) | 45 | App de escritorio: Chromium para la ventana y Node.js 24 para red, archivos y cifrado. |
| [ssh2](https://github.com/mscdex/ssh2) | 1.17.0 (fija) | Conexión SSH, autenticación, terminal, SFTP, túneles y canal de estadísticas. JavaScript puro, sin depender de OpenSSH ni PuTTY. |
| [xterm.js](https://xtermjs.org/) | 6 | El terminal en pantalla (el mismo de VS Code), con los complementos `fit` (ajuste de tamaño) y `webgl` (dibujo por tarjeta gráfica). |
| [node-pty](https://github.com/microsoft/node-pty) | 1.1 | Consolas locales (PowerShell, CMD, WSL) mediante ConPTY de Windows. Es la misma pieza que usa VS Code. |
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
  mcp.js               Servidor MCP local (HTTP en 127.0.0.1, con token)
  agent.js             Herramientas que usan los agentes y aprobación de cada acción
  local.js             Consolas locales: detecta las instaladas y las abre con node-pty
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

## Agentes de IA (MCP)

Mi Terminal puede actuar como servidor [MCP](https://modelcontextprotocol.io/) para que un
agente de IA trabaje en tus servidores a través de la app. Viene **apagado**.

**Activarlo**

1. Botón **MCP** (arriba de la lista de sesiones) → *Activar acceso de agentes*.
2. Edita cada sesión que quieras compartir y marca **Permitir agentes (MCP)**. Las demás
   son invisibles para el agente.
3. En el mismo panel, pulsa el botón de tu agente: copia la configuración lista para pegar.
   - **Claude Code:** pégala en una terminal.
   - **Cursor:** pégala en `.cursor\mcp.json` de tu carpeta de usuario.
   - **Codex:** pégala al final de `.codex\config.toml` de tu carpeta de usuario.

La app debe estar abierta para que el agente pueda conectarse.

**Agentes validados**

| Agente | Estado |
|---|---|
| Codex | Probado: conexión, herramientas y aprobaciones funcionan. |
| Claude Code | Probado: conexión, herramientas y aprobaciones funcionan. |
| Cursor | **Falta validarlo.** La configuración sigue su formato documentado, pero no se ha probado con el programa real. |

**Qué puede hacer un agente**

| Herramienta | Qué hace | Aprobación |
|---|---|---|
| `list_sessions`, `list_consoles`, `list_tabs` | Ver sesiones habilitadas, consolas locales y pestañas abiertas. | No |
| `open_session`, `open_console` | Abrir una pestaña SSH o una consola local. | Siempre |
| `create_session` | Crear una sesión guardada (sin contraseñas). | Siempre |
| `read_tab` | Leer lo que se ve en una pestaña. | Una vez por pestaña |
| `run_command`, `send_keys` | Ejecutar un comando o enviar teclas. | Cada vez |
| `sftp_list`, `sftp_read`, `sftp_write`, `sftp_upload`, `sftp_download` | Listar, leer, escribir, subir y descargar archivos. | Cada vez |

Cada aprobación muestra el texto exacto (el comando, la ruta, el contenido). En el panel
MCP eliges dónde aparece:

- **En el agente** (por defecto): la pregunta sale dentro de Codex, Claude Code o Cursor,
  donde estás trabajando. Usa el mecanismo *elicitation* de MCP. Si el agente no sabe
  mostrarla, se usa el aviso de Mi Terminal; nunca se aprueba sola.
- **En Mi Terminal** (más seguro): un aviso de la app, con **Rechazar** como botón por
  defecto. Nada se ejecuta sin tu clic en la app, aunque alguien obtenga el token.

Sin respuesta en 2 minutos, la solicitud se rechaza. **Permitir todo en esta pestaña**
deja de preguntar para esa pestaña hasta que se cierre o se desconecte; la pestaña muestra
una etiqueta **MCP** y un clic en ella quita el permiso.

Si el agente contesta al instante (en menos de 1,5 segundos), nadie alcanzó a leer la
pregunta: el agente respondió solo. Eso **nunca cuenta como aprobación**, ni siquiera si
la respuesta fue "aceptar", y Mi Terminal muestra su propio aviso. Pasa con agentes
configurados para no pedir confirmaciones (por ejemplo Codex en modo de acceso total).
Para dar permiso completo a una pestaña desde la app: clic derecho sobre la pestaña →
**Agentes (MCP): permitir todo en esta pestaña**. Cada aprobación queda anotada en
`agent-log.jsonl` con quién respondió y en cuánto tiempo.

**Límites de seguridad**

- El servidor escucha solo en `127.0.0.1` (no es accesible desde la red) y exige un token
  de 256 bits. Rechaza peticiones de páginas web (cabecera `Origin`) y de nombres de host
  ajenos, para que un sitio abierto en el navegador no pueda usarlo.
- El agente nunca recibe contraseñas, frases de paso ni claves, y no puede indicarlas: si
  hacen falta, la app te las pide a ti.
- Las consolas locales quedan fuera salvo que actives *Permitir también consolas locales*.
- Un comando debe caber completo en el aviso (máximo 2000 caracteres) y no puede llevar
  caracteres de control ocultos.
- No descarga a tu PC archivos de tipo ejecutable ni reemplaza archivos existentes.
- Todo queda en `agent-log.jsonl`.

Lo que ve el agente (la salida de los comandos, el contenido de los archivos) se envía al
proveedor de ese agente. Habilita solo las sesiones donde eso sea aceptable, y trata el
token como una contraseña: si se filtra, usa **Generar token nuevo**.

## Dónde se guardan los datos

Fuera del proyecto, en `%APPDATA%\mi-terminal\`:

| Archivo | Contenido |
|---|---|
| `sessions.json` | Sesiones. Las contraseñas y frases de paso van cifradas con DPAPI de Windows: solo tu usuario, en tu equipo, puede descifrarlas. |
| `known_hosts.json` | Huellas de los servidores en los que confiaste. Si una cambia, la conexión se bloquea. |
| `settings.json` | Preferencias: editor elegido y acceso de agentes (el token va cifrado con DPAPI). |
| `agent-log.jsonl` | Registro de cada acción pedida por un agente: fecha, herramienta, datos y resultado. |

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
- **Consolas locales acotadas:** la interfaz solo puede elegir una consola de la lista que
  arma el proceso principal (PowerShell, CMD, Git Bash, WSL); no puede pedir que se
  ejecute un programa o comando cualquiera.
- **Agentes con permiso explícito:** el acceso por MCP viene apagado, solo alcanza a las
  sesiones marcadas y cada acción se aprueba en la app (ver [Agentes de IA](#agentes-de-ia-mcp)).
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
