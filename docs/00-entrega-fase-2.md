# Entrega de la Fase 2 — Integración con la API oficial de Bitget

**Panel de Control Bitget (PCB) v1.0**
Fecha de entrega: 10 de agosto de 2026 · Presupuesto de referencia: Fase 2, $5,000 MXN, 2–3 semanas

---

## 1. Qué cubre esta fase, según el presupuesto

> *«Integración con la API oficial de Bitget — autenticación firmada, registro y validación
> de credenciales, estado de conexión por cuenta, control de límites de peticiones.»*

| Concepto contratado | Entregable | Estado |
|---|---|---|
| Autenticación firmada | [`rest/signer.ts`](../src/main/bitget/rest/signer.ts) · [`rest/client.ts`](../src/main/bitget/rest/client.ts) · [`bitget/errors.ts`](../src/main/bitget/errors.ts) | Entregado |
| Registro y validación de credenciales | [`security/vault.ts`](../src/main/security/vault.ts) · [`bitget/verificacion.ts`](../src/main/bitget/verificacion.ts) · [`domain/registro-cuentas.ts`](../src/main/domain/registro-cuentas.ts) · [`ipc/sesion.ts`](../src/main/ipc/sesion.ts) | Entregado |
| Estado de conexión por cuenta | [`domain/estado-conexion.ts`](../src/main/domain/estado-conexion.ts) · [`execution/supervisor-reconexion.ts`](../src/main/execution/supervisor-reconexion.ts) | Entregado |
| Control de límites de peticiones | [`execution/rate-limiter.ts`](../src/main/execution/rate-limiter.ts) | Entregado |
| Decisión de arquitectura de la fase | [`adr/0007`](adr/0007-entorno-staging-sin-docker.md) | Entregado |

### 1.1 Qué hace cada pieza, en una línea

**Autenticación firmada.** Cada petición se firma con HMAC-SHA256 sobre la cadena
`timestamp + método + ruta + consulta + cuerpo`. La regla que evita el fallo clásico de las
firmas: la cadena de consulta y el cuerpo se resuelven **una sola vez**, y el cliente está
obligado a enviar exactamente los mismos bytes que firmó. Además corrige la desviación del
reloj del equipo contra el de Bitget —una diferencia de segundos basta para que el exchange
rechace todo— y valida la forma de cada respuesta antes de usarla.

**Detección real de fallo.** Bitget responde HTTP 200 aunque haya rechazado la operación; el
veredicto viene dentro, en el campo `code`. El panel lo comprueba siempre y traduce el
código a un error clasificado en cuatro clases: reintentable, fatal de cuenta, fatal de lote
e **indeterminada** (se envió pero no se supo el desenlace). Un código desconocido nunca se
trata como reintentable.

**Registro y validación de credenciales.** El alta hace tres cosas en una sola operación y
en este orden: pregunta a Bitget si la credencial sirve, la cifra, y la registra. Si Bitget
la rechaza, **no se guarda nada** — el panel no puede mostrar como operativa una cuenta que
fallaría la primera vez que se le mande una orden.

**Almacenamiento cifrado.** `vault.enc` con AES-256-GCM y clave derivada por scrypt
(N=2^17, ~0,5 s por derivación: lento a propósito, para que probar contraseñas por fuerza
bruta no sea práctico). Lleva un verificador cifrado aparte que distingue *contraseña
incorrecta* de *archivo dañado*; sin él, ambos casos fallan igual y el operador no sabría si
escribió mal la contraseña o si acaba de perder cien credenciales. Toda escritura es
atómica —temporal, volcado a disco y renombrado— así que un corte de luz deja intacto el
archivo anterior, nunca uno a medias, y se conserva un respaldo `.bak`.

**Estado de conexión por cuenta.** El estado depende de **la clase del error, no de que
haya habido error**: un microcorte deja la cuenta en «conectando» y se reintenta con espera
creciente y aleatorizada; tres fallos seguidos la declaran desconectada; una credencial
rechazada la desconecta de inmediato y **sin programar reintentos**, porque reintentar una
clave muerta solo gasta cupo que necesitan las otras noventa y nueve.

**Control de límites de peticiones.** Dos cubos de tokens encadenados —40 peticiones por
segundo para toda la máquina y 8 por cuenta— más un techo de 12 peticiones simultáneas. El
limitador está **dentro** del cliente REST: no existe un camino a la red que lo evite. Ante
un 429 penaliza la cuenta y la máquina, y —esto importa— también detiene la recarga del cubo
durante la penalización.

---

## 2. La regla de seguridad, y cómo se hace cumplir

El presupuesto (§5, *Credenciales y permisos*) establece que el sistema no solicita,
almacena ni utiliza permisos de retiro. Al implementarlo apareció que **Bitget no publica el
significado de sus códigos de permiso**: una clave creada solo con permiso de futuros
devuelve `["coow","cpow"]`, cuatro letras sin documentación.

Con códigos que no se pueden interpretar, rechazar «los de retiro» falla **abierto**: un
código de retiro que no estuviera en la lista pasaría sin que nadie se enterase. Por eso la
regla se invirtió: **solo se aceptan los códigos confirmados como inocuos, y cualquier
código desconocido rechaza la credencial.** Falla cerrado.

Esto corrige lo escrito en [`03-modelo-de-datos.md`](03-modelo-de-datos.md) §5, que preveía
una lista de exclusión. El coste es que una clave con permisos legítimos aún no catalogados
se rechaza y hay que añadir su código; el beneficio es que ninguna clave con permiso de
retiro entra por descuido.

Las otras dos garantías, y su mecanismo:

| Garantía | Cómo se hace cumplir |
|---|---|
| La clave completa nunca sale del proceso principal | El renderer solo recibe `bg••••4f2a`. Verificado leyendo los bytes del disco y del payload, no preguntándole al objeto en memoria |
| El renderer no puede alcanzar Node, disco ni red | `contextIsolation`, una regla de ESLint y la prueba de humo que falla si alguien lo rompe |

---

## 3. Cómo verificar la entrega

Ocho comandos, en una máquina con Node 22.19 o superior:

```bash
npm install
npm run typecheck     # sin errores de tipos
npm run lint          # cero avisos tolerados
npm test              # 169 pruebas, sin salir a la red
npm run test:red      # 14 pruebas contra api.bitget.com  (requiere .env)
npm run test:staging  # las mismas, con el código compilado como staging
npm run test:e2e      # compila y arranca la aplicación real
npm run dev           # abre la aplicación
```

Resultado de esta entrega: **todo en verde**, 169 + 14 + 5 pruebas.

Las tres suites responden preguntas distintas, y esa es la razón de que existan las tres:

- `npm test` prueba que la **lógica** es correcta suponiendo que Bitget responde como
  creemos. Usa un exchange simulado que sabe producir lo que la cuenta demo no sabe producir
  a petición: rechazar con HTTP 200, colgarse sin responder, devolver 429.
- `npm run test:red` quita esa suposición: habla con `api.bitget.com` de verdad.
- `npm run test:staging` corre esas mismas pruebas con **el mismo código compilado que
  llevaría el binario entregado**, con las defensas de staging encendidas. Si esta suite
  pasa, lo hizo hablando con Bitget: no hay configuración en la que pase sin hacerlo.

### 3.1 Qué mirar en vivo, en veinte minutos

1. `npm run dev:staging` — el panel arranca **bloqueado**. Sin contraseña no hay credenciales.
2. Escribir una contraseña maestra: la primera vez crea el almacén cifrado.
3. **API keys** → registrar una subcuenta. El panel consulta a Bitget antes de guardar: una
   clave inválida se rechaza con el motivo en español y no llega a entrar en el almacén.
4. La fila aparece con la clave enmascarada y el estado *conectada*.
5. **Probar** vuelve a preguntar a Bitget y confirma en el momento si la credencial sigue
   siendo válida.
6. **Cerrar sesión** y volver a entrar: la cuenta sigue ahí, y el panel vuelve a
   verificarla contra Bitget por su cuenta —arranca en *desconectada* a propósito, para no
   pintar de verde una cuenta que lleva horas sin comprobarse—. El resultado se refleja en
   la lista al pulsar **Probar**; que la pantalla se refresque sola es trabajo de la Fase
   3. Con la contraseña equivocada, el panel distingue *contraseña incorrecta* de *archivo
   dañado*.

---

## 4. Entregado además de lo contratado, sin costo

**Carga masiva de subcuentas.** La propuesta de la Fase 1 la ofreció «de cortesía» al
descubrirse que cada subcuenta necesita su propio juego de claves. Está hecha:
[`scripts/crear-subcuentas.mjs`](../scripts/crear-subcuentas.mjs) da de alta subcuentas
virtuales y sus API Keys —con permiso de futuros y nada más— sin pasar por el formulario de
Bitget una por una, e [`importar-subcuentas.ts`](../scripts/importar-subcuentas.ts) las carga
al panel pasando por el mismo camino que el alta manual, de modo que también **valida el
lote**: si una de las claves salió mal, se sabe ahí y no en la reunión. Esto responde además
la pregunta abierta desde la primera semana: las subcuentas se pueden generar por API, y se
generaron.

**Entorno de staging.** Un modo de ejecución con carpeta de datos propia que habla solo con
la API real y en el que ninguna pieza de simulación sobrevive. Sin Docker, y el porqué está
razonado en [`adr/0007`](adr/0007-entorno-staging-sin-docker.md).

**La interfaz del diseño v2**, traducida a código. No es alcance de esta fase —las pantallas
que llena pertenecen a las Fases 4 y 6— pero ya está construida y se puede ver.

---

## 5. Lo que esta fase deliberadamente **no** incluye

Para que no haya sorpresas en la demostración: al abrir el panel en staging, **la matriz de
cuentas aparece vacía y cualquier orden falla**. No es un defecto. El listado de cuentas con
saldo, las posiciones en vivo y las cinco acciones de operación son las Fases 3, 4 y 6 del
presupuesto, y el código lo dice en voz alta en lugar de inventar datos: cada función sin
respaldo real falla con un mensaje explícito antes que mostrar una cifra fabricada como si
viniera de Bitget.

---

## 6. Dos defectos que encontraron las pruebas, no la producción

Se listan porque justifican el tiempo invertido en la suite:

**El cubo de peticiones se recargaba durante la penalización.** Tras un 429, la espera de
cinco segundos dejaba el cubo lleno, y al terminar salía una ráfaga de cuarenta peticiones
—exactamente lo que había provocado el 429—. En producción habría aparecido como bloqueos
temporales intermitentes de la IP, con cien cuentas dentro.

**El estado de conexión sobrevivía al bloqueo del panel.** Al cerrar sesión y volver a
entrar, las cuentas se pintaban en verde sin que nadie hubiera preguntado a Bitget. El
estado se descarta ahora al bloquear.

---

## 7. Lo que necesito de tu lado

| # | Asunto | Por qué importa |
|---|---|---|
| P-7 | **Take Profit por porcentaje**: ¿es sobre la ganancia de lo invertido (ROE) o sobre el movimiento del precio? | Con apalancamiento 10x la diferencia es de **diez veces**. Bloquea la Fase 4 |
| — | **Saldo y margen aislado** en la cuenta demo | Sin saldo no se puede probar «agregar margen», que exige margen aislado |
| — | Veinte minutos para la demostración de esta fase | Cláusula 4(b) del presupuesto |

---

## 8. Aprobación

Conforme a la cláusula 4(c) del presupuesto, esta fase se entiende aprobada si no se
manifiestan observaciones dentro de los **7 días naturales** posteriores a la demostración.

La **Fase 3 —administración de cuentas: alta y baja, estado de conexión y selección múltiple
para ejecución individual o en grupo—** puede comenzar de inmediato. Buena parte de su
cimiento quedó construido aquí: el alta y la baja funcionan de extremo a extremo y el estado
de conexión está entregado y probado. Lo que falta es lo que conecta esas cuentas con la
pantalla de operación: proyectar las subcuentas registradas —con su saldo— a la matriz, y
que la selección múltiple opere sobre cuentas reales en lugar de sobre datos de ejemplo.
