/**
 * Linea de tiempo de aperturas y Take Profit de una subcuenta, sacada de la
 * bitacora (`docs/session-*.jsonl` o la carpeta de logs del panel).
 *
 * Nacio de la incidencia de ELITE LAURA del 19/10/2026 -un Take Profit de short
 * que en Bitget aparecia por encima de la entrada- y sirve para repetir ese
 * analisis con logs nuevos sin rehacerlo a mano. No sale a la red ni toca el
 * vault: solo lee los archivos que se le pasan.
 *
 * Uso:
 *   node scripts/analizar-tp-cuenta.mjs --cuenta 1395 docs/session-20261019.jsonl [mas.jsonl ...]
 *   node scripts/analizar-tp-cuenta.mjs --cuenta 1395 --simbolo PEPEUSDT docs/session-2026102*.jsonl
 *
 * `--cuenta` son los ultimos caracteres de la API key, como salen enmascarados
 * en la bitacora (bg••••••••1395). Imprime una tabla Markdown con la hora UTC y
 * la de Mexico, y debajo los avisos: aperturas planificadas que no se enviaron,
 * cantidades de `modify-strategy-order` que no cuadran con la posicion, y el
 * modo detectado frente al que la cuenta declara.
 *
 * De donde sale cada columna
 * --------------------------
 * - Lado: `posSide` del cuerpo; en `modify-strategy-order`, que no lo lleva, el
 *   evento `take-profit-envio` (logs desde la v0.16.x), o el orderId de una
 *   colocacion anterior, o la ultima letra del clientOid que devuelve Bitget
 *   (`pcb...l` / `pcb...s`, ver `clientOidDe`), o `tpsl-v3-pendientes`. Si
 *   nada de eso lo dice -el TP embebido en `place-order` tiene como clientOid
 *   su propio orderId- se infiere de la apertura con la misma qty y el orderId
 *   mas cercano: Bitget numera por tiempo y el TP embebido nace milisegundos
 *   despues de su orden. La columna Notas lo marca como inferido.
 * - Entrada: la del evento `take-profit-planificado` si existe (es la de
 *   Bitget). Si no, la media de las aperturas del panel en ese lado, con el
 *   precio de `apertura-planificada`: es aproximada y lo dice con «~».
 * - Valido: long con el TP por encima de la entrada, short por debajo.
 */
import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const opcion = (n) => {
  const i = args.indexOf(n);
  if (i === -1) return null;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const cuenta = opcion('--cuenta');
const simbolo = opcion('--simbolo');
const archivos = args;
if (cuenta === null || archivos.length === 0) {
  console.error('Uso: node scripts/analizar-tp-cuenta.mjs --cuenta <ultimos digitos> [--simbolo X] archivo.jsonl ...');
  process.exit(1);
}

/** La vigencia de un plan de apertura: `PLAN_VIGENCIA_MS` en src/shared/constants.ts. */
const VIGENCIA_MS = 120_000;

const mexico = new Intl.DateTimeFormat('es-MX', {
  timeZone: 'America/Mexico_City',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});
const utc = (ts) => ts.slice(5, 19).replace('T', ' ');

const lineas = [];
for (const f of archivos) {
  for (const l of (await readFile(f, 'utf8')).split('\n')) {
    if (l.trim() === '') continue;
    try {
      const r = JSON.parse(l);
      if (String(r.cuenta ?? '').endsWith(cuenta)) lineas.push(r);
    } catch {
      /* linea cortada al final del archivo */
    }
  }
}
lineas.sort((a, b) => a.ts.localeCompare(b.ts));

const filas = [];
const avisos = [];
const ladoDeOrden = new Map(); // orderId -> lado
const qtyPorLado = { long: 0, short: 0 };
const costePorLado = { long: 0, short: 0 }; // sum(qty * precio) para la media
const planificadas = []; // { ts, lado, precio, enviada }
let ultimoPlanTp = null; // evento take-profit-planificado / -envio mas reciente
const modos = new Set();
const aperturas = []; // { orderId, lado, qty, precio } de place-order con TP embebido

/** La apertura de la que nace un TP embebido. Ver la cabecera. */
const aperturaDe = (orderId, qty) => {
  let mejor = null;
  for (const a of aperturas) {
    if (qty && a.qty !== qty) continue;
    const d = BigInt(orderId) - BigInt(a.orderId);
    const abs = d < 0n ? -d : d;
    if (mejor === null || abs < mejor.abs) mejor = { ...a, abs };
  }
  return mejor;
};

const ladoDeSide = (side) => (side === 'buy' ? 'long' : side === 'sell' ? 'short' : '?');
const ladoDeClientOid = (c) => (/^pcb.*l$/.test(c ?? '') ? 'long' : /^pcb.*s$/.test(c ?? '') ? 'short' : null);
const entradaAprox = (lado) =>
  qtyPorLado[lado] > 0 ? `~${(costePorLado[lado] / qtyPorLado[lado]).toPrecision(5)}` : '?';
const valido = (lado, tp, entrada) => {
  const e = Number(String(entrada).replace('~', ''));
  const t = Number(tp);
  if (!Number.isFinite(e) || !Number.isFinite(t) || e === 0 || (lado !== 'long' && lado !== 'short')) return '?';
  return (lado === 'long' ? t > e : t < e) ? 'sí' : 'NO';
};
const fila = (r, accion, lado, entrada, tp, orderId, extra = '') =>
  filas.push({ ts: r.ts, accion, lado, entrada, tp: tp ?? '-', orderId: orderId ?? '-', valido: tp ? valido(lado, tp, entrada) : '-', extra });

for (const r of lineas) {
  const c = r.cuerpo ?? {};
  if (simbolo && (c.symbol ?? r.simbolo) && (c.symbol ?? r.simbolo) !== simbolo) continue;
  const resp = typeof r.respuesta === 'object' && r.respuesta !== null ? r.respuesta : {};

  if (r.tipo === 'evento') {
    if (r.evento === 'deteccion-modo') modos.add(`modo=${r.modo} accountMode=${r.accountMode} holdMode=${r.holdMode}`);
    if (r.evento === 'apertura-planificada') planificadas.push({ ts: r.ts, lado: r.lado, precio: r.precio, size: r.size, enviada: false });
    if (r.evento === 'take-profit-planificado' || r.evento === 'take-profit-envio') ultimoPlanTp = r;
    if (r.evento === 'take-profit-planificado' && r.qtyOrden && r.qtyPosicion && r.qtyOrden !== r.qtyPosicion) {
      avisos.push(`${utc(r.ts)} ${r.lado}: la orden ${r.orderIdAnterior} declara qty ${r.qtyOrden} y la posición es ${r.qtyPosicion}.`);
    }
    if (r.evento === 'tpsl-v3-pendientes' && r.orderId) ladoDeOrden.set(r.orderId, ladoDeOrden.get(r.orderId) ?? r.posSide);
    continue;
  }
  if (r.tipo !== 'peticion' || r.metodo !== 'POST') continue;
  const ok = r.codigo === '00000';
  const fallo = ok ? '' : `rechazada ${r.codigo ?? ''} ${r.mensaje ?? ''}`.trim();

  if (/\/trade\/place-order$|\/mix\/order\/place-order$/.test(r.ruta)) {
    const lado = c.posSide ?? c.holdSide ?? ladoDeSide(c.side);
    const cierre = c.reduceOnly === 'yes' || c.tradeSide === 'close';
    const plan = [...planificadas].reverse().find((p) => p.lado === lado && !p.enviada && Date.parse(r.ts) - Date.parse(p.ts) <= VIGENCIA_MS);
    if (plan) plan.enviada = true;
    if (ok && !cierre && plan) {
      qtyPorLado[lado] += Number(c.qty ?? c.size);
      costePorLado[lado] += Number(c.qty ?? c.size) * Number(plan.precio);
    }
    const tp = c.takeProfit ?? c.presetStopSurplusPrice;
    if (ok && tp && resp.orderId) aperturas.push({ orderId: resp.orderId, lado, qty: String(c.qty ?? c.size), precio: plan?.precio });
    fila(r, cierre ? 'cierre' : `apertura qty ${c.qty ?? c.size}`, lado, plan ? plan.precio : entradaAprox(lado), tp, resp.orderId, fallo);
  } else if (/place-strategy-order$|place-tpsl-order$/.test(r.ruta)) {
    const lado = c.posSide ?? c.holdSide ?? '?';
    if (resp.orderId) ladoDeOrden.set(resp.orderId, lado);
    const exacta = ultimoPlanTp && ultimoPlanTp.lado === lado ? ultimoPlanTp.precioEntrada : null;
    fila(r, `TP nuevo (${c.tpslMode ?? c.planType})`, lado, exacta ?? entradaAprox(lado), c.takeProfit ?? c.triggerPrice, resp.orderId, fallo);
  } else if (/modify-strategy-order$|modify-tpsl-order$/.test(r.ruta)) {
    const envio = ultimoPlanTp && ultimoPlanTp.evento === 'take-profit-envio' && ultimoPlanTp.orderId === c.orderId ? ultimoPlanTp : null;
    const madre = /^\d+$/.test(c.orderId ?? '') ? aperturaDe(c.orderId, c.qty) : null;
    const lado = envio?.lado ?? ladoDeOrden.get(c.orderId) ?? ladoDeClientOid(resp.clientOid) ?? madre?.lado ?? '?';
    const origen = envio
      ? 'evento'
      : ladoDeOrden.has(c.orderId)
        ? 'orderId'
        : ladoDeClientOid(resp.clientOid)
          ? `clientOid ${resp.clientOid}`
          : madre
            ? `inferido: TP embebido de la apertura ${madre.orderId}`
            : 'desconocido';
    const entrada = envio?.precioEntrada ?? (origen.startsWith('inferido') && madre.precio ? madre.precio : entradaAprox(lado));
    const qtyLado = qtyPorLado[lado];
    /* Un TP embebido cubre solo su apertura: su qty es la de esa orden, no la del lado. */
    const deSuApertura = madre !== null && madre.qty === c.qty;
    if (c.qty && qtyLado && !deSuApertura && Number(c.qty) !== qtyLado) {
      avisos.push(`${utc(r.ts)} modify ${c.orderId} (${lado}) con qty ${c.qty}; el panel abrió ${qtyLado} en ese lado.`);
    }
    fila(r, `TP modificado qty ${c.qty ?? '-'}`, lado, entrada, c.takeProfit ?? c.triggerPrice, c.orderId, `lado por ${origen} ${fallo}`.trim());
  } else if (/cancel-strategy-order$|cancel-plan-order$/.test(r.ruta)) {
    fila(r, 'TP cancelado', ladoDeOrden.get(c.orderId) ?? '?', '-', null, c.orderId ?? JSON.stringify(c.orderIdList), fallo);
  } else if (/close-positions$/.test(r.ruta)) {
    const lado = c.posSide ?? c.holdSide;
    for (const l of lado ? [lado] : ['long', 'short']) {
      qtyPorLado[l] = 0;
      costePorLado[l] = 0;
    }
    fila(r, 'cierre total', lado ?? 'ambos', '-', null, null, fallo);
  }
}

for (const p of planificadas.filter((p) => !p.enviada)) {
  avisos.push(`${utc(p.ts)} apertura ${p.lado} planificada (${p.size} a ${p.precio}) sin place-order en ${VIGENCIA_MS / 1000} s: no se confirmó o caducó.`);
}

console.log(`# Cuenta …${cuenta}${simbolo ? ` · ${simbolo}` : ''}\n`);
console.log('| UTC | México | Acción | Lado | Entrada | TP enviado | orderId | Válido | Notas |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const f of filas) {
  console.log(`| ${utc(f.ts)} | ${mexico.format(new Date(f.ts))} | ${f.accion} | ${f.lado} | ${f.entrada} | ${f.tp} | ${f.orderId} | ${f.valido} | ${f.extra} |`);
}
if (modos.size > 0) console.log(`\nDetección de modo: ${[...modos].join('; ')}`);
if (avisos.length > 0) console.log(`\n## Avisos\n\n${avisos.map((a) => `- ${a}`).join('\n')}`);
