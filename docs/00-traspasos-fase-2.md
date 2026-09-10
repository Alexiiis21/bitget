# Fase 2 — Pantalla de saldos por subcuenta

**Panel de Control Bitget (PCB)** · Fecha: 3 de septiembre de 2026
Presupuesto de referencia: [`presupuesto-traspaso-subcuentas.md`](presupuesto-traspaso-subcuentas.md), Fase 2, 1–2 días, $500 MXN

> Cubre lo contratado: *"consulta del saldo de futuros de todas las subcuentas de
> una cuenta principal en una sola petición, mostrando el disponible y el máximo
> transferible real de cada una"*. Continúa [`00-traspasos-fase-1.md`](00-traspasos-fase-1.md).

---

## 1. Lo que ya funciona

| Pieza | Dónde |
|---|---|
| Endpoint de saldos agregados | [`bitget/rest/endpoints/subcuentas.ts`](../src/main/bitget/rest/endpoints/subcuentas.ts) |
| Cruce de lo que reporta Bitget con lo dado de alta | [`domain/saldos-subcuentas.ts`](../src/main/domain/saldos-subcuentas.ts) |
| Credencial de cuenta madre, cifrada | [`security/vault.ts`](../src/main/security/vault.ts) — almacén v2 |
| Alta, baja y lectura | [`ipc/sesion.ts`](../src/main/ipc/sesion.ts) — `agregarMadre`, `saldosSubcuentas` |
| Canales de IPC | `madres:listar` · `madres:agregar` · `madres:eliminar` · `saldos:leer` |
| Pantalla | [`PantallaSaldos.tsx`](../src/renderer/src/features/panel/PantallaSaldos.tsx), botón **Saldos** en el encabezado |

**Comprobado el 03/09/2026 contra `api.bitget.com`:** `GET /api/v2/mix/account/sub-account-assets`
responde `00000` con la clave madre actual (`[coow, cpow, chow]`). **Leer saldos no
necesita permiso de traspaso** — la hipótesis de la Fase 1 queda confirmada, y por eso
esta fase se pudo construir sin esperar a la credencial nueva.

## 2. El hallazgo que cambia lo que hay que pedirle a Daniel

La clave `BITGET_MADRE_*` del `.env` **no es la madre de las subcuentas del panel**:

| | UID |
|---|---|
| Clave `BITGET_MADRE_*` (y `BITGET_DEMO_*`: son la misma) | 7514542716 |
| Padre real de las 9 subcuentas vivas, según ellas mismas | **1513226215** |

Por eso `sub-account-assets` devuelve `success` con **cero** subcuentas: la clave es
válida y tiene permisos de sobra, pero esa cuenta no tiene subcuentas colgando. El UID
1513226215 es además el que ya figuraba como ejemplo de `uidPadre` en
[`03-modelo-de-datos.md`](03-modelo-de-datos.md).

**Consecuencia para la demostración:** la pantalla está construida y probada, pero solo
mostrará saldos reales cuando exista la API Key de la cuenta **1513226215**. Contra el
mercado simulado y en la demostración se ve completa.

El panel no deja que eso pase inadvertido: al dar de alta una clave que no reporta
subcuentas, el alta **se acepta pero avisa** —«Bitget no le reporta ninguna subcuenta;
comprueba que sea la API Key de la cuenta principal de la que cuelgan tus subcuentas»—
en vez de dejar una tabla vacía sin explicación.

**Segundo hallazgo, que afecta a la Fase 3:** `/api/v2/user/virtual-subaccount-list`
respondió `40018 · Invalid IP`. Los endpoints de gestión de subcuentas **sí** aplican la
lista blanca de IP, y esta máquina no está en ella. Es muy probable que el traspaso de la
Fase 3 choque con lo mismo aunque la clave tenga el permiso. Conviene resolver la IP a la
vez que el permiso, no después.

## 3. Decisiones de diseño que conviene conocer

**Dos columnas de dinero, no una.** El disponible no es lo que puede salir: el margen
comprometido en posiciones abiertas no se transfiere. Bitget publica los dos números
(`available` y `maxTransferOut`) y el panel los enseña por separado. Fundirlos llevaría a
preparar repartos que el exchange rechaza, y el rechazo llegaría con todo montado.

**Se muestran las dos listas, no su intersección.** Una subcuenta que Bitget reporta y el
panel no tiene dada de alta sale marcada `NO ESTÁ EN EL PANEL`, y no se esconde: un
traspaso se firma con la clave de la madre y **no necesita la credencial de la subcuenta**,
así que esa cuenta puede recibir y enviar saldo igualmente. Al revés, una cuenta del panel
que la madre no reporta sale como `SIN DATOS` en vez de desaparecer.

**Un dato que no se sabe se pinta como raya, nunca como cero.** Cero es una afirmación
sobre el dinero de alguien; cuando la madre no informa de una subcuenta, lo cierto es que
no se sabe.

**La pantalla no se refresca sola.** El endpoint admite una petición cada 10 s por cuenta.
Se lee al abrir y al pulsar Actualizar, y la hora de la lectura queda a la vista.

**La credencial madre vive en su propia lista dentro del almacén** (`madres`), no mezclada
con las de subcuenta: no opera, no tiene casilla ni modo de margen. El almacén sube a
**versión 2**; los archivos v1 se abren igual y se convierten al guardar. Un ejecutable
anterior se niega a abrir un almacén v2 —a propósito: lo reescribiría sin la credencial de
la madre y la perdería en silencio.

**La baja de una madre exige contraseña de paso**, como la de una subcuenta y con más
motivo: es la credencial más poderosa del almacén.

## 4. Cómo comprobarlo

```bash
npm run typecheck && npm run lint    # sin errores ni avisos
npm test                             # 628 pruebas, 38 archivos
npm run test:e2e                     # 14 pruebas sobre la aplicación compilada
```

Pruebas nuevas de esta fase: 8 unitarias del cruce de listas
([`test/unit/saldos-subcuentas.test.ts`](../test/unit/saldos-subcuentas.test.ts)),
11 del almacén con credenciales de madre, 12 de integración contra el exchange simulado
([`test/integration/saldos-madre.test.ts`](../test/integration/saldos-madre.test.ts)) y
2 e2e de que los canales nuevos respetan el bloqueo del panel.

**A mano, en la demostración:** `npm run dev:demo` → desbloquear con cualquier clave de 4
o más → botón **Saldos** del encabezado → rellenar el alta → se ve la tabla, con filas
`SIN DATOS`, una `NO ESTÁ EN EL PANEL` y varias donde el transferible es menor que el
disponible.

## 5. Lo que queda para la Fase 3

- El traspaso en sí (`POST /api/v2/spot/wallet/subaccount-transfer`), con confirmación previa y registro. Ningún canal lo expone todavía.
- Apretar el esquema de `subcuentas.ts`: los campos hoy `nullish` salen de la documentación, no de una respuesta real capturada. En cuanto haya clave de la madre 1513226215 se captura una respuesta y se fijan.
- Resolver a la vez el permiso de traspaso y la lista blanca de IP (§2).

## 6. Para Daniel

1. **API Key de la cuenta principal 1513226215** — la que tiene las subcuentas colgando. Con permiso de lectura de subcuentas ya se ven los saldos; el de traspaso hace falta para la Fase 3.
2. **IP del equipo en la lista blanca** de esa clave (§2), o los endpoints de subcuentas seguirán devolviendo `40018`.
3. Sigue pendiente desde la Fase 1: confirmar por escrito la ampliación de política del 29/08 ([`presupuesto-traspaso-subcuentas.md` §4](presupuesto-traspaso-subcuentas.md)).
