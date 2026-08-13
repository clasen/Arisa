# Arisa Master/Slave — Especificación de trabajo

Estado: contrato de implementación v1 aprobado el 13 de agosto de 2026.

Las decisiones y límites de este documento son normativos para la versión 1.
Los cambios de contrato posteriores requieren una revisión explícita de esta
especificación.

## Objetivo

Permitir que una instalación de Arisa opere otros servidores mediante pequeños
procesos remotos de Arisa. El usuario habla únicamente con la instalación
inteligente de Arisa. Un servidor remoto no necesita Telegram, Pi Agent,
credenciales de Codex ni su propia sesión de razonamiento.

La configuración buscada consiste en pedirle a Master una URL de bootstrap y
pegar un solo comando en el servidor Slave. La URL contiene la IP y el puerto de
Master más un secreto de uso único. Después del enrolamiento, Arisa puede
inspeccionar el servidor, usar las herramientas que tenga instaladas, leer
archivos y ejecutar comandos autorizados.

## Nombres

Los nombres canónicos del producto son:

- **Arisa Master**: la instalación inteligente conectada con Telegram y Pi
  Agent. Decide qué debe ocurrir y dónde.
- **Arisa Slave**: un ejecutor remoto determinista. Informa sus capacidades y
  realiza las solicitudes de su Arisa Master emparejada.

Los roles se llaman `master` y `slave` de forma consistente en la configuración,
el protocolo, la CLI y la documentación.

## Decisiones de diseño confirmadas

- El transporte es TCP directo mediante `node:net` y la criptografía se
  implementa con `node:crypto`.
- Arisa Master escucha en un `ip:port` explícito y Arisa Slave se conecta hacia
  afuera directamente mediante TCP.
- Slave fija como endpoint la IP literal incluida en la URL de bootstrap. Sólo
  acepta órdenes dentro de esa conexión autenticada con Master.
- La conexión se autentica con un secreto aleatorio de alta entropía y cifra
  todos los mensajes en la capa de protocolo propia de Arisa.
- La máquina de Master debe ser alcanzable desde Slave mediante una IP pública,
  una red privada o una VPN. La apertura y el forwarding del puerto de Master
  quedan fuera de Arisa. Slave no abre puertos de entrada.
- Arisa Slave puede ejecutarse con un usuario dedicado, con el usuario actual o
  como `root`; el usuario debe elegirlo explícitamente.
- Arisa Master es dueña de todo el razonamiento. Arisa Slave nunca elige
  herramientas a partir de una intención ni ejecuta un modelo.
- Una Slave puede instalar y exponer herramientas normales de Arisa.
- La gestión de Master/Slave vive en una tool daemon global, con el nombre de
  trabajo `master-slave`, y no en Arisa Core.
- El runtime general de daemons usa IPC local inmediato con streaming y conserva
  un journal durable para recuperación; no depende de polling durante la
  operación normal.
- Master puede organizar Slaves en grupos muchos-a-muchos y ejecutar una misma
  operación sobre una o varias Slaves o grupos.

## Perfil operativo v1

- Los transcripts criptográficos usan campos binarios en orden fijo, cada uno
  prefijado por su longitud, y el separador de dominio
  `arisa-master-slave-handshake-v1`.
- Los secretos de conexión vencen a los 10 minutos.
- Un frame puede ocupar como máximo 1 MiB y la salida acumulada de un job puede
  ocupar como máximo 16 MiB.
- La reconexión usa backoff exponencial con jitter entre 1 y 60 segundos.
- Una Slave desconectada durante 5 minutos genera el aviso offline deduplicado.
- Tanto la dirección de binding como el endpoint que Master publica son
  configuración obligatoria. No tienen un valor predeterminado implícito.
- Un batch ejecuta como máximo cuatro jobs simultáneos. Cada stream admite como
  máximo 1 MiB pendiente antes de aplicar backpressure.
- La tool oficial se obtiene desde un commit inmutable y cada archivo se valida
  contra un manifiesto SHA-256 incluido en la misma versión de Arisa Core.
- Linux con systemd es la primera plataforma operativa soportada. Master y Slave
  pueden coexistir en un host mediante homes, sockets, PID y logs separados.
- El usuario dedicado es la opción recomendada. El usuario actual está
  permitido y root requiere siempre una elección y confirmación explícitas.
- Los jobs dirigidos a Slaves offline se rechazan en v1.
- La instalación remota acepta sólo tools del catálogo verificado y requiere
  confirmación. Nunca se instala código silenciosamente como root.
- `arisa slave status` incluye el diagnóstico equivalente a Doctor para el host
  headless. `arisa slave log` muestra el log del host Slave.

## Arquitectura

```text
Telegram
   │
   ▼
Arisa Core
  - Pi Agent / Codex
  - conversaciones
  - autorización por chat
  - selección de operaciones remotas
   │ llamada local de tool
   ▼
Tool daemon master-slave — rol Master
  - listener, identidades y conexiones
  - registro y grupos de Slaves
  - jobs remotos y auditoría
   ▲ escucha TCP en ip:port
   │ conexión saliente cifrada
Tool daemon master-slave — rol Slave
  - identidad y política
  - inventario del host
  - ejecutor determinista de jobs
  - almacenamiento local de jobs y auditoría
   │ IPC local
   ▼
Arisa headless
  - supervisor de daemons
  - ToolRegistry local
  - herramientas instaladas
```

La conexión entre Master y Slave es directa. Slave conoce la dirección de Master
y es siempre quien inicia o restablece la conexión. Master acepta solamente el
protocolo binario autenticado de Arisa en el puerto configurado. Slave no expone
ningún puerto ni publica su IPC Unix local.

## Tool daemon y límite de Arisa Core

La tool daemon `master-slave` contiene los dos roles del protocolo. En una
instalación Master mantiene el listener y todas las sesiones entrantes. En una
instalación Slave mantiene una sola conexión saliente con su Master. El proceso
es global porque representa infraestructura de la instalación, no el estado de
un chat individual.

La tool es dueña de:

- transporte TCP, framing, cifrado e identidades emparejadas;
- secretos de conexión, perfiles, grupos y estado de las Slaves;
- dispatch, streaming, cancelación y auditoría de jobs remotos;
- autorización remota resultante de las concesiones emitidas por Master.

Arisa Core conserva únicamente responsabilidades genéricas:

- descubrimiento y ejecución de tools;
- supervisor, salud y ciclo de vida de daemons;
- IPC local, artifacts y eventos para el agente;
- el adaptador CLI `arisa slave <url>`.

En el servidor Slave se inicia un host headless de Arisa con supervisor, IPC y
ToolRegistry, pero sin Telegram ni Pi Agent. La tool daemon usa exclusivamente el
IPC público de Arisa para listar y ejecutar otras tools; no importa ni alcanza
internals de Core.

Como las tools no forman parte del paquete de Core, el primer
`arisa slave <url>` instala automáticamente la versión oficial verificada de
`master-slave`, inicia su daemon y le entrega la solicitud mediante un archivo
temporal con permisos restrictivos. Las ejecuciones posteriores reutilizan la
tool instalada. El secreto no se copia a variables de entorno, logs ni metadata
de arranque del daemon.

## Experiencia de usuario

El usuario le dice a Arisa Master que quiere agregar una Slave. Master crea un
secreto aleatorio de 256 bits, de vida corta y uso único, lo asocia con el chat
solicitante y devuelve una sola línea:

```bash
npm i -g arisa && arisa slave tcp://198.51.100.12:4719/arisa_secret_v1_<BASE64URL>
```

La URL completa es el único parámetro de `arisa slave`. Su parser exige:

- esquema exacto `tcp`;
- IP literal IPv4 o IPv6, con IPv6 entre corchetes;
- puerto explícito;
- exactamente un segmento de path con el secreto;
- ausencia de usuario, query, fragmento y segmentos adicionales.

En esta especificación se lo llama **secreto de conexión**, no hash secreto. Un
hash corto puede mostrarse como fingerprint, pero el protocolo necesita el
secreto aleatorio completo para autenticar el primer contacto y derivar claves.
La URL es sensible, no debe registrarse, y deja de servir cuando se consume o
vence. La simplicidad de pasarla como argumento implica que puede quedar en el
historial del shell; la implementación debe advertirlo al mostrar el comando.

Al ejecutar el comando, Slave:

1. parsea y valida la URL;
2. crea su identidad local y detecta el usuario de ejecución;
3. si corre con UID 0, pide confirmar si debe continuar como root o instalar el
   servicio con un usuario dedicado;
4. abre una conexión saliente con la IP y el puerto de Master;
5. completa el handshake usando el secreto;
6. intercambia automáticamente identidades, versión, perfil, política,
   capacidades y catálogo de herramientas;
7. se registra como servicio y mantiene la reconexión automática.

Master propone desde Telegram el nombre, propósito, raíces y permisos después
del primer contacto. El usuario los confirma conversacionalmente; no hacen falta
más parámetros de red en la consola de Slave. También puede asignarla a uno o
varios grupos en ese momento o reorganizarla después desde la conversación.

## Perfil y descubrimiento de Slave

Una Slave publica únicamente los metadatos operativos necesarios para tomar
decisiones correctas:

```json
{
  "slaveId": "uuid",
  "name": "production-api",
  "description": "Ejecuta la API pública y sus workers",
  "hostname": "api-01",
  "platform": "linux",
  "arch": "arm64",
  "arisaVersion": "x.y.z",
  "masterEndpoint": "tcp://198.51.100.12:4719",
  "privilege": {
    "user": "arisa-slave",
    "root": false,
    "scope": "restricted"
  },
  "roots": ["/srv/api"],
  "capabilities": ["inspect", "read", "tool.run", "exec"],
  "tools": []
}
```

El inventario puede incluir CPU, memoria, discos, runtimes relevantes y salud
de servicios. No debe incluir variables de entorno, credenciales, configuración
de herramientas, contenido de archivos, historial del shell ni otros secretos.

Master obtiene los perfiles de las Slaves dinámicamente mediante operaciones de
la tool como `list_slaves` e `inspect_slave`. Los perfiles completos no se
inyectan en cada prompt de Pi.

El registro de Master conserva además `connectionState`, `connectedAt`,
`disconnectedAt` y la causa del último cierre observado. Los umbrales de tiempo
offline para avisar al usuario pertenecen a la configuración centralizada y no
se codifican como constantes locales.

## Grupos de Slaves

Master puede organizar Slaves mediante grupos con nombre. Los grupos son
metadata local de Master: no cambian la identidad, conexión ni política propia
de una Slave y no se envían como autoridad al servidor remoto.

La pertenencia es muchos-a-muchos. Una Slave puede integrar varios grupos y un
grupo puede contener cualquier cantidad de Slaves. Cada grupo tiene un
`groupId` inmutable, un nombre modificable, una descripción opcional y la lista
de `slaveId` asociados. Los nombres son únicos dentro del chat propietario; las
operaciones y referencias persistidas usan siempre `groupId`.

Ejemplo:

```text
grupo X: api-x-1, api-x-2, worker-x-1
grupo Y: api-y-1, worker-y-1
producción: api-x-1, api-x-2, api-y-1
```

Las operaciones remotas reciben un selector común:

```json
{
  "target": {
    "slaveIds": ["slave-uuid-1"],
    "groupIds": ["group-uuid-x", "group-uuid-y"]
  }
}
```

Master resuelve la unión de ambos conjuntos y elimina Slaves repetidas antes de
crear jobs. La membresía se convierte en un snapshot al comenzar: agregar o
quitar una Slave después no modifica un batch ya aceptado.

Una ejecución grupal crea un `batchId` y un job hijo independiente por Slave.
La concurrencia máxima pertenece a la configuración centralizada. Los chunks de
salida pueden intercalarse entre Slaves, pero cada chunk incluye `slaveId`, nombre
y secuencia; dentro de una Slave mantienen su orden original. El resultado final
muestra cada servidor y un resumen de completados, fallidos, cancelados y no
iniciados.

Antes de producir efectos, Master verifica que todas las Slaves seleccionadas
estén autorizadas para el chat y publiquen la capacidad solicitada. La operación
segura predeterminada es no iniciar el batch si falla este preflight. El usuario
puede pedir explícitamente ejecución parcial; una vez iniciado no existe una
transacción distribuida y una falla en una Slave no revierte efectos ya
completados en otras.

Cancelar un batch impide iniciar sus jobs pendientes y solicita cancelación a
los que estén activos. Los jobs que ya terminaron conservan su resultado. Las
operaciones sensibles muestran antes de la confirmación los grupos resueltos,
la cantidad de Slaves y cuáles operan como root.

Eliminar un grupo borra solamente esa agrupación. No revoca, desconecta ni
elimina sus Slaves y no altera batches que ya tomaron su snapshot.

## Herramientas en Arisa Slave

Arisa Slave usa los contratos existentes de paquetes y CLI de herramientas de
Arisa. Las herramientas instaladas viven en el directorio de Arisa de la Slave
y se ejecutan localmente en ese servidor. Slave no necesita Pi Agent para
cargarlas ni ejecutarlas.

Slave publica un catálogo seguro que contiene, para cada herramienta instalada:

- nombre, versión y digest del paquete;
- descripción, categoría y keywords;
- declaraciones de entrada y salida;
- nombres de campos del esquema de configuración, nunca sus valores;
- requisitos declarados de sistema de archivos, procesos, red y privilegios;
- estado de disponibilidad y salud.

Arisa Master decide qué capacidad remota usar. Slave no reinterpreta
silenciosamente una operación ni sustituye una herramienta por otra.

Por ejemplo, si una Slave publica una herramienta `trash` y el usuario le pide a
Master que quite un archivo de forma segura, Pi puede elegir:

```json
{
  "operation": "tool.run",
  "target": {
    "slaveIds": ["slave-uuid"],
    "groupIds": []
  },
  "tool": "trash",
  "args": { "path": "/srv/api/old.log" }
}
```

`trash` es solamente un ejemplo de selección genérica de una herramienta
remota. El protocolo de Slave no contiene ninguna regla específica para
`trash`. Si Master solicita una herramienta que no está instalada, Slave
devuelve `capability_missing`; no recurre como fallback a un comando de shell ni
a un comportamiento diferente.

La tool daemon `master-slave` expone a Arisa estas operaciones:

- `create_slave_bootstrap`
- `list_slaves`
- `inspect_slave`
- `create_slave_group`
- `list_slave_groups`
- `add_slaves_to_group`
- `remove_slaves_from_group`
- `delete_slave_group`
- `list_slave_tools`
- `run_slave_tool`
- `read_slave_file`
- `run_slave_command`
- `install_slave_tool`
- `cancel_slave_batch`
- `revoke_slave`

Las operaciones que ejecutan trabajo usan el selector común `target`; no se
duplican variantes de cada operación para una Slave y para un grupo.

La instalación remota de herramientas es un permiso independiente. Una política
de Slave puede exigir confirmación para cada instalación, permitir un subconjunto
firmado del catálogo o aceptar instalaciones únicamente desde la consola local
de Slave. La instalación de código en una Slave ejecutada como root nunca debe
autorizarse silenciosamente.

Las solicitudes de herramientas conservan `requestedByChatId` para mantener
aislados el estado y la configuración de herramientas por chat. Los resultados
de las herramientas y los archivos generados vuelven por la conexión cifrada y
se convierten en artifacts del chat solicitante en Arisa Master.

## IPC general de daemons: rápido y durable

El runtime compartido de daemons debe ofrecer un canal local persistente mediante
socket Unix o named pipe en Windows. Es una mejora general para todas las tools
daemon, no una implementación privada de `master-slave`.

La rapidez no reemplaza la durabilidad. El flujo de cada job es:

1. el cliente persiste atómicamente la solicitud con estado `queued`;
2. notifica inmediatamente al daemon por el canal IPC, sin esperar un poll;
3. el daemon reclama el `jobId` de forma atómica y persiste `accepted` antes de
   producir un efecto externo;
4. el daemon transmite eventos y chunks por IPC mientras ejecuta;
5. el resultado final se persiste antes de confirmar `completed` o `failed`.

El daemon escanea el journal al iniciar para recuperar solicitudes `queued` o
`accepted`. Una notificación repetida sólo vuelve a señalar el mismo `jobId`; no
duplica su ejecución. Durante la operación normal no se sondea el directorio de
comandos. Así se conserva la recuperación del diseño basado en archivos y se
elimina su espera periódica.

Los mensajes locales usan frames versionados con esta forma lógica:

```json
{
  "jobId": "uuid",
  "type": "accepted | progress | chunk | completed | failed",
  "sequence": 1,
  "payload": {}
}
```

El canal admite varios jobs multiplexados. Cada daemon conserva su propia
política de concurrencia: streaming no implica ejecutar todo en paralelo. Si el
consumidor no puede recibir al ritmo del productor se aplica backpressure; no se
descartan chunks ni se permite crecimiento ilimitado de memoria.

El socket local vive en el directorio administrado del daemon, usa permisos
restrictivos y exige la identidad o capability token emitida por el supervisor.
No se publica fuera del host.

La invocación pública de una tool sigue siendo `run --request-file`. Para
conservar compatibilidad, ToolRegistry acepta dos formatos de salida:

- un único JSON final, como usan las tools actuales;
- NDJSON versionado con eventos `accepted`, `progress`, `chunk`, `completed` y
  `failed` para tools con streaming.

Cuando el manifest declara un daemon, ToolRegistry envía el job directamente al
IPC compartido y evita crear un proceso intermediario por cada llamada. El
entrypoint `run --request-file` permanece como adaptador para invocaciones desde
la terminal y usa el mismo cliente IPC. Las tools sin daemon continúan
ejecutándose como procesos independientes.

Para las tools sin daemon que emitan NDJSON, ToolRegistry parsea `stdout`
incrementalmente y publica los eventos mediante el mismo observador genérico de
ejecución; deja de acumular toda la salida en memoria hasta que termina el
proceso. El evento terminal contiene el mismo resultado que recibe hoy el
llamador. Los transports pueden mostrar progreso sin despertar a Pi por cada
chunk y deben agrupar actualizaciones según sus propios límites. `stderr`
continúa reservado para diagnóstico y nunca se mezcla con frames de protocolo.

## Protocolo TCP

El protocolo es propio, pero usa primitivas estándar incluidas en Node:

- `net.Socket` para el transporte;
- Ed25519 para las identidades persistentes de los pares y las firmas del
  transcript;
- X25519 efímero para acordar la clave de cada sesión;
- HKDF-SHA256 para derivar claves direccionales;
- AES-256-GCM para cifrado autenticado;
- `crypto.randomBytes()` para secretos de conexión, salts y challenges.

La conexión TCP es persistente y bidireccional. `net.Socket` funciona como un
stream `Duplex`: después del handshake, Master y Slave pueden enviar frames en
cualquier momento por el mismo socket, incluso mientras reciben datos en la
dirección opuesta.

Ambos extremos configuran `socket.setNoDelay(true)` al establecer la conexión
para priorizar la latencia de órdenes y respuestas pequeñas. Como TCP transporta
un flujo de bytes y no mensajes, el parser debe admitir que un frame llegue
fragmentado o que una lectura contenga varios frames. Si `socket.write()`
devuelve `false`, el emisor pausa nuevos envíos hasta el evento `drain`, sin
descartar ni reordenar frames.

Después del handshake, los frames usan un encabezado fijo y un payload acotado:

```text
uint32be  frameLength
uint8     protocolVersion
uint8     messageType
uint64be  sequence
bytes     ciphertext
bytes[16] authenticationTag
```

Cada dirección tiene una clave y un salt de nonce separados. El nonce de
AES-GCM se deriva del salt direccional y de la secuencia monotónica. La versión,
el tipo de mensaje y la secuencia se autentican como datos adicionales. Una
secuencia repetida, un tag inválido, un frame demasiado grande, una transición
inesperada o una versión incompatible cierran la conexión.

Los payloads de aplicación de la versión 1 son JSON en UTF-8. Los transcripts
criptográficos deben usar una codificación de bytes definida explícitamente en
lugar de depender del orden de las claves de un objeto JSON.

Como se trata de un protocolo de seguridad, la implementación necesita vectores
de prueba, pruebas con frames fragmentados, fuzzing de los campos de longitud,
pruebas de replay y una revisión independiente antes de habilitar la ejecución
remota.

## Emparejamiento y reconexión

1. Master genera un secreto de conexión aleatorio, de vida corta y uso único, y
   lo asocia con el chat que pidió agregar la Slave.
2. Master construye la URL `tcp://ip_master:port/secret` y se la entrega al
   usuario dentro del comando completo de instalación.
3. Slave parsea la URL, genera una identidad Ed25519 persistente y abre una
   conexión TCP saliente con la IP literal y el puerto indicados.
4. Slave verifica que la dirección remota real del socket coincide con la IP de
   la URL y mantiene ese endpoint durante el handshake.
5. Master y Slave intercambian sus claves públicas de identidad, claves X25519
   efímeras y challenges aleatorios.
6. Ambas prueban que poseen el secreto de conexión y firman el transcript exacto
   del handshake.
7. La salida de X25519 y el secreto de conexión se combinan mediante HKDF para
   producir las claves del primer handshake.
8. Cada parte confirma el transcript y persiste la identidad y el endpoint de su
   par.
9. Master consume y elimina el secreto inicial; ya no puede enrolar otra Slave
   con ese valor. Slave elimina la URL secreta de su estado y conserva solamente
   `tcp://ip_master:port` más la identidad fijada de Master.
10. Las reconexiones futuras autentican las identidades persistentes, usan nuevas
   claves X25519 efímeras y derivan claves de sesión nuevas sin reutilizar el
   secreto inicial.

Slave conserva el endpoint de Master y restablece la sesión con backoff cuando
se corta. Conectar a una IP literal funciona además como allowlist de destino:
Slave sólo procesa órdenes recibidas por el socket que ella misma abrió hacia
esa IP y después de autenticar la identidad Ed25519 fijada. La IP no sustituye
el secreto inicial, la identidad, el cifrado autenticado ni la autorización del
chat.

Para IPv4 se normalizan también las direcciones IPv4-mapped IPv6 antes de
comparar. No se confía en redirects, headers, hostnames ni endpoints declarados
por el servidor. El operador puede restringir además el tráfico saliente con el
firewall del host, pero Arisa no modifica reglas de firewall automáticamente.

La revocación coordinada elimina en ambas partes la identidad aceptada y termina
la conexión activa. Si Slave está inaccesible, Master puede olvidar el registro,
pero para revocar realmente su identidad en Slave hay que ejecutar
`arisa slave unpair` localmente o reconectarla para completar la revocación. Un
nuevo emparejamiento genera un secreto y una relación de identidad nuevos; no es
un fallback implícito de recuperación.

## Desconexión y cambio excepcional del endpoint

Slave mantiene la reconexión automática en segundo plano sin intervención de
Pi. Master conoce el estado de cada socket entrante. Cuando una Slave permanece
desconectada más allá del umbral configurado, Master emite un único evento
accionable para el chat que la administra y no repite el mismo aviso mientras
no cambie el estado.

Master no puede saber desde el lado servidor si Slave está apagada, perdió red o
tiene un endpoint incorrecto. El aviso no intenta resolver automáticamente la
causa. Primero indica revisar el servicio y la red.

La dirección de Master debe ser estable. No existe un mecanismo especial para
actualizarla. Si excepcionalmente cambia la IP o el puerto, el usuario le pide a
Master un secreto de conexión nuevo y vuelve a ejecutar en el servidor Slave el
mismo comando normal:

```php-template
arisa slave tcp://<ip_master>:4719/<secret>
```

Si ya existe una identidad local, Slave conserva el emparejamiento y exige que el
nuevo endpoint demuestre la misma identidad Ed25519 de Master. Sólo guarda la
nueva dirección después de completar el handshake. El secreto conserva las
mismas reglas de cualquier conexión inicial: alta entropía, vida corta y un solo
uso. Si el servicio Slave o la red están caídos, repetir el comando no resuelve
el problema y el aviso debe decirlo claramente.

## Ejecución como root

La instalación global por npm y la ejecución de Slave son decisiones
independientes. El paquete puede instalarse globalmente con privilegios elevados
mientras que el servicio se ejecuta con un usuario dedicado.

Si `arisa slave <url>` se ejecuta con UID 0, debe presentar opciones
explícitas:

```text
Ejecutar Arisa Slave como:
1. usuario dedicado arisa-slave (recomendado)
2. otro usuario existente
3. root
```

Se admite elegir `root`. El perfil resultante y todos los informes de Master
deben mostrar que Slave tiene autoridad root. El modo root restringido puede
seguir aplicando las raíces y operaciones configuradas en la capa de aplicación.
El modo root con host completo requiere otra confirmación explícita.

Las restricciones de aplicación reducen el uso accidental, pero dejan de ser
una frontera de seguridad si el propio proceso de Slave resulta comprometido:
una Slave root implica que Master emparejada puede controlar potencialmente el
servidor completo.

Quien quiera instalar el servicio como root ejecuta el mismo comando desde una
sesión con UID 0 y confirma esa opción. No se agregan parámetros de bootstrap
para seleccionar privilegios y el modo root nunca se infiere silenciosamente.

## Jobs remotos

La versión 1 admite estas operaciones estructuradas:

- `slave.inspect`
- `fs.list`
- `fs.read`
- `tool.list`
- `tool.run`
- `process.exec`
- `job.cancel`

`process.exec` recibe un ejecutable, un array de argumentos, un directorio de
trabajo y un timeout. Usa `spawn(executable, argv)` sin shell. La ejecución
mediante shell es una capacidad independiente que debe habilitarse
explícitamente en la política de Slave.

Cada job incluye:

```json
{
  "jobId": "uuid",
  "batchId": "uuid",
  "slaveId": "uuid",
  "operation": "tool.run",
  "args": {},
  "requestedByChatId": "123",
  "issuedAt": "ISO-8601",
  "expiresAt": "ISO-8601",
  "scope": "declared-capability"
}
```

`batchId` identifica la ejecución grupal que originó el job. En una ejecución
individual también se crea un batch de un solo miembro para mantener un único
modelo de streaming, cancelación y resultados.

Slave persiste el estado `accepted` antes de producir un efecto externo. La
repetición de un `jobId` devuelve el estado o resultado almacenado y nunca vuelve
a ejecutar la operación. La salida usa chunks ordenados y límites de bytes. La
cancelación detiene el árbol de procesos del que Slave es dueña. Los estados
finales son `completed`, `failed`, `cancelled` y `expired`.

La recomendación inicial es fallar de forma clara cuando una Slave está offline.
La programación durable de trabajos offline puede
agregarse más adelante como una función explícita de Master con vencimiento y
cancelación visibles.

## Autorización

El acceso a una Slave se concede al chat que pidió a Master crear la URL de
conexión. Los demás chats autorizados requieren una concesión explícita.
Incluir un `chatId` arbitrario en una solicitud remota no constituye
autorización.

Pertenecer a un grupo no concede acceso. Al resolver un selector, Master detecta
cualquier Slave que el chat no pueda administrar y falla el preflight completo;
nunca la elimina silenciosamente ni usa el grupo para eludir una concesión
individual.

Slave aplica la intersección de:

1. conexión TCP iniciada por Slave hacia el endpoint configurado de Master;
2. identidad criptográfica de Master emparejada;
3. identidad del chat autorizado;
4. capacidad publicada por Slave;
5. política de privilegios de Slave;
6. raíces permitidas y requisitos de herramientas;
7. validez y vencimiento del job.

El modelo de Master no puede ampliar estos permisos mediante prompting.

## Estado y ciclo de vida del servicio

Todas las rutas se obtienen mediante los helpers públicos de runtime. La tool no
construye raíces propias. Agrupaciones de estado propuestas:

```text
~/.arisa/state/tools/master-slave/                    # daemon, identidad, pares y journal global
~/.arisa/chats/<chatId>/state/tools/master-slave/     # grupos, concesiones y batches del chat
~/.arisa/tools/master-slave/                          # paquete instalado, sin estado mutable
~/.arisa/tools/                                       # demás herramientas locales
```

Las claves privadas y el material persistido de sesión usan permisos de archivo
restrictivos y escrituras atómicas. Master conserva cada secreto de conexión
sólo hasta su consumo o vencimiento. Slave no persiste la URL completa:
después de validarla conserva únicamente el endpoint de Master y las identidades
emparejadas. Estos valores no se guardan en el JSON normal de configuración del
runtime.

Superficie propuesta de la CLI:

```text
arisa slave <tcp://ip_master:port/secret>
arisa slave start
arisa slave stop
arisa slave restart
arisa slave status
arisa slave log
arisa slave unpair
arisa slave tools
```

Ejecutar `arisa` normalmente sigue significando Arisa Master. Los comandos de
servicio local de Slave no deben activar el bootstrap de Telegram ni la
validación de Pi. `arisa slave <url>` es el único comando de enlace: en una
instalación nueva realiza el bootstrap y, si encuentra una identidad local ya
emparejada, conserva esa identidad y actualiza el endpoint únicamente después de
autenticar a la misma Master. No se agregan flags ni preguntas para transportar
datos que ambos lados pueden intercambiar durante el handshake.

La URL se recibe como un único argumento posicional. Slave valida su formato,
extrae el endpoint y usa el secreto sólo para esa conexión. No imprime ni escribe
el argumento completo en sus logs. El usuario debe tratar el comando como una
credencial temporal porque su shell podría conservarlo en el historial.

## Fases de implementación

### 1. IPC general de daemons

- Extender el runtime compartido con socket Unix o named pipe, frames
  multiplexados, streaming y backpressure.
- Extender ToolRegistry para parsear NDJSON incremental, emitir eventos de
  ejecución y conservar compatibilidad con la respuesta JSON única actual.
- Conservar el journal durable, reclamo atómico, idempotencia y recuperación al
  reiniciar sin polling durante la operación normal.
- Migrar las tools daemon existentes y verificar que no cambie su contrato CLI,
  salud, supervisión ni recuperación.

### 2. Tool daemon y modo Slave headless

- Crear la tool oficial global `master-slave` con roles Master y Slave.
- Hacer que `arisa slave <url>` instale y verifique la tool, inicie el host
  headless y le entregue el secreto sin persistirlo en metadata de arranque.
- Reutilizar el IPC y ToolRegistry públicos para descubrir y ejecutar
  capacidades locales, sin importar internals de Core.
- Verificar una instalación global limpia y el contenido publicado de Core y de
  la tool.

### 3. Servidor TCP y emparejamiento seguro

- Implementar dentro de la tool el listener TCP de Master y el cliente saliente
  de Slave por separado de la ejecución de jobs.
- Implementar parsing estricto del único argumento
  `tcp://ip_master:port/secret`, framing, consumo del secreto, handshake de
  identidad, cifrado, reconexión, revocación y versionado del protocolo.
- Verificar que la dirección remota normalizada del socket saliente sea la IP
  literal incluida en la URL antes de continuar el handshake.
- Consumir en Master secretos de conexión de uso único y vida corta.
- Si Slave ya tiene un emparejamiento, exigir la misma identidad de Master antes
  de guardar un endpoint diferente o aceptar jobs.
- Permitir únicamente heartbeat e intercambio de perfil.

### 4. Integración con Master y grupos

- Exponer desde la tool el registro de Slaves y las operaciones de
  descubrimiento.
- Asociar las Slaves con el chat solicitante.
- Implementar grupos muchos-a-muchos, selector común, snapshot de membresía,
  deduplicación y preflight de autorización y capacidades.
- Implementar batches con concurrencia configurada, streaming etiquetado,
  cancelación y resultados por Slave.
- Agregar eventos de conexión, desconexión, reconexión y revocación.
- Detectar una desconexión que supere el umbral configurado, deduplicar el aviso
  y recomendar revisar el servicio y la red.
- Explicar que Master no puede distinguir por sí sola entre una Slave apagada,
  un problema de red y un endpoint incorrecto.
- Permitir que Pi vea dinámicamente los catálogos de herramientas remotas.

### 5. Operaciones de sólo lectura

- Implementar inspección, listado, lectura y listado de herramientas.
- Verificar contención en las raíces, path traversal, escape mediante symlinks,
  límites de frames, límites de salida y aislamiento por chat.

### 6. Ejecución de herramientas y comandos

- Implementar `run_slave_tool` y transferencia cifrada de artifacts.
- Preservar configuración y estado de herramientas por chat.
- Agregar política de instalación, verificación de fuentes firmadas y controles
  de permisos.
- Implementar creación directa de procesos, streaming de salida, timeouts,
  cancelación, identidad durable de jobs y recuperación después de reinicios.
- Probar los modos usuario dedicado, root restringido y root completo en hosts
  descartables.

### 7. Operación

- Extender Arisa Doctor con la salud de la tool daemon y su IPC, listener de
  Master, endpoint configurado, conexión saliente de Slave, identidad, versión,
  jobs, herramientas, estado offline y secretos de conexión pendientes.
- Ejercitar desconexiones reales, reconexiones, revocación, actualizaciones y
  dos máquinas alcanzables mediante IP pública, red privada o VPN.

## Regresiones requeridas

- Un job de daemon se persiste antes de notificarse y empieza sin esperar el
  intervalo histórico de polling.
- Reiniciar el daemon recupera jobs `queued` o `accepted`; repetir una
  notificación IPC no repite sus efectos.
- Los chunks multiplexados conservan secuencia por job y respetan backpressure
  sin crecimiento ilimitado de memoria.
- Perder el consumidor del stream no elimina el resultado durable del job.
- Una tool existente que devuelve un único JSON sigue funcionando sin cambios.
- El parser NDJSON acepta líneas fragmentadas, rechaza secuencias inválidas y
  entrega exactamente un resultado terminal por job.
- ToolRegistry no acumula en memoria la salida completa de un job con streaming
  y mantiene `stderr` fuera del canal de eventos.
- Instalar o actualizar `master-slave` exige verificar su origen e integridad;
  el secreto de conexión no aparece en logs ni metadata del daemon.
- Un secreto inicial no puede consumirse dos veces ni después de vencer o ser
  rotado.
- Una conexión que no conoce el secreto inicial no puede completar el primer
  handshake.
- El parser rechaza esquemas distintos de `tcp`, hostnames, puertos implícitos,
  secretos vacíos, segmentos adicionales, usuario, query y fragmento.
- Slave sólo intenta el endpoint literal incluido en la URL y comprueba que la
  dirección remota normalizada del socket coincide antes del handshake.
- El listener de Master procesa exclusivamente frames válidos del protocolo
  autenticado de Arisa.
- Un secreto de conexión sólo sirve para el chat que lo solicitó.
- Una Slave emparejada no reemplaza el endpoint ni acepta jobs desde él sin
  autenticar la misma identidad de Master.
- Los avisos de desconexión se emiten al superar el umbral configurado, se
  deduplican y no afirman conocer la causa.
- IPv4 y su representación IPv4-mapped IPv6 comparan como la misma dirección;
  direcciones diferentes no se aceptan por coincidencias textuales parciales.
- Slave no abre un puerto de entrada para este protocolo.
- La URL secreta no se registra ni se persiste después de ser procesada.
- Los fingerprints de pares incorrectos y los transcripts modificados impiden
  el emparejamiento.
- Los frames repetidos, reordenados, demasiado grandes o corruptos cierran la
  sesión.
- Un chat sin concesión no puede inspeccionar ni operar una Slave.
- Resolver varias Slaves y grupos produce una unión deduplicada y un snapshot
  inmutable para el batch.
- La pertenencia a un grupo no amplía permisos; una Slave no autorizada hace
  fallar el preflight antes de ejecutar efectos.
- Si falta una capacidad o una Slave requerida está desconectada, el modo seguro
  no inicia ningún job del batch; la ejecución parcial sólo se habilita por
  pedido explícito.
- Cada chunk y resultado grupal identifica la Slave correcta aunque varios jobs
  se ejecuten de forma concurrente.
- Eliminar un grupo no elimina Slaves ni modifica batches ya aceptados.
- Los archivos no pueden salir de las raíces configuradas mediante traversal o
  symlinks.
- Una herramienta faltante en Slave produce `capability_missing` sin
  comportamientos de fallback.
- Los valores de configuración de herramientas y las variables de entorno nunca
  se publican.
- Un job ID repetido no puede repetir un efecto externo.
- Un reinicio durante la ejecución deja un estado durable y accionable del job.
- La revocación desconecta a Slave e impide su reconexión.
- El modo root sólo puede seleccionarse explícitamente y permanece visible en
  los diagnósticos.

## Decisiones fuera de v1

- Otras plataformas de servicio además de Linux con systemd.
- Hostnames como endpoint de Master; v1 exige una IP literal.
- Programación durable de jobs mientras una Slave está offline.
- Instalación remota silenciosa de tools, incluso cuando sean oficiales y de
  bajo impacto.
