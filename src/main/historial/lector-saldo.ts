/**
 * El saldo vigente de una cuenta, leído de Bitget cuando se pide.
 *
 * Cumple la Fase 4 del presupuesto de historial: *"el saldo real vigente de la
 * cuenta o subcuenta seleccionada, tal como lo reporta Bitget en el momento de
 * la consulta"*. Por eso **no se guarda en disco**: un saldo guardado es un
 * saldo viejo la próxima vez que se abre el panel. `leidoEn` dice de cuándo es.
 *
 * ==========================================================================
 * Una lectura por cuenta, y una caché muy corta
 * ==========================================================================
 * Dos peticiones para la misma cuenta mientras la primera sigue en curso
 * comparten la misma lectura. Y lo leído vale `SALDO_VIGENCIA_MS`: elegir una
 * cuenta, cambiar de periodo y volver a la misma no tiene por qué costar tres
 * peticiones con el mismo resultado. Cinco segundos son poco para que el saldo
 * cambie sin que el operador lo sepa —con el panel solo se consulta—, y mucho
 * para un doble clic.
 *
 * La caché se vacía al bloquear el panel (`limpiar`) y al dar de baja la cuenta
 * (`olvidar`).
 */
import type { SuperficieHistorial } from '../domain/posicion-cerrada';

export const SALDO_VIGENCIA_MS = 5_000;

export interface SaldoCuenta {
  cuentaId: string;
  moneda: string;
  /** Equity: saldo más el PnL no realizado. `null` si Bitget no trae la moneda. */
  equity: string | null;
  disponible: string | null;
  bloqueado: string | null;
  leidoEn: number;
  superficie: SuperficieHistorial;
}

export interface DependenciasLectorSaldo {
  leer: (cuentaId: string) => Promise<SaldoCuenta>;
  ahoraMs: () => number;
  vigenciaMs?: number;
}

export class LectorSaldo {
  private readonly deps: DependenciasLectorSaldo;
  private readonly enCurso = new Map<string, Promise<SaldoCuenta>>();
  private readonly cache = new Map<string, SaldoCuenta>();
  /**
   * Sube con cada `limpiar` u `olvidar`. Una lectura que empezó antes y termina
   * después no escribe en la caché: traería el saldo de una sesión ya cerrada o
   * de una cuenta ya dada de baja.
   */
  private generacion = 0;

  constructor(deps: DependenciasLectorSaldo) {
    this.deps = deps;
  }

  leer(cuentaId: string): Promise<SaldoCuenta> {
    const guardado = this.cache.get(cuentaId);
    const vigencia = this.deps.vigenciaMs ?? SALDO_VIGENCIA_MS;
    if (guardado !== undefined && this.deps.ahoraMs() - guardado.leidoEn < vigencia) {
      return Promise.resolve(guardado);
    }

    const vigente = this.enCurso.get(cuentaId);
    if (vigente !== undefined) return vigente;

    const generacion = this.generacion;
    const promesa = this.deps
      .leer(cuentaId)
      .then((saldo) => {
        if (generacion === this.generacion) this.cache.set(cuentaId, saldo);
        return saldo;
      })
      .finally(() => {
        if (this.enCurso.get(cuentaId) === promesa) this.enCurso.delete(cuentaId);
      });
    this.enCurso.set(cuentaId, promesa);
    return promesa;
  }

  olvidar(cuentaId: string): void {
    this.generacion++;
    this.cache.delete(cuentaId);
    this.enCurso.delete(cuentaId);
  }

  limpiar(): void {
    this.generacion++;
    this.cache.clear();
    this.enCurso.clear();
  }
}
