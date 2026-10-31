/**
 * Filtros del historial y archivo CSV, sin disco ni red.
 *
 * El archivo lo abre Excel en un equipo en México: lo que se prueba es que los
 * números sigan siendo números, que los acentos se lean, que una coma o unas
 * comillas no rompan columnas y que un texto no pueda ejecutarse como fórmula.
 */
import { describe, expect, it } from 'vitest';
import {
  construirCsv,
  cumpleFiltro,
  fechaCsv,
  hayFiltro,
  identificadorCuenta,
  nombreArchivoCsv,
  SIN_FILTRO,
  type FilaCsv
} from '@shared/historial-csv';

const op = (symbol: string, lado: 'long' | 'short', resultado: string) => ({
  symbol,
  lado,
  resultado
});

describe('cumpleFiltro', () => {
  it('sin filtro pasa todo, también lo que quedó en cero', () => {
    expect(cumpleFiltro(SIN_FILTRO, op('BTCUSDT', 'long', '0'))).toBe(true);
    expect(hayFiltro(SIN_FILTRO)).toBe(false);
  });

  it('filtra por par, lado y resultado a la vez', () => {
    const f = { simbolo: 'BTCUSDT', lado: 'short' as const, resultado: 'ganadoras' as const };
    expect(cumpleFiltro(f, op('BTCUSDT', 'short', '1.5'))).toBe(true);
    expect(cumpleFiltro(f, op('ETHUSDT', 'short', '1.5'))).toBe(false);
    expect(cumpleFiltro(f, op('BTCUSDT', 'long', '1.5'))).toBe(false);
    expect(cumpleFiltro(f, op('BTCUSDT', 'short', '-1.5'))).toBe(false);
    expect(hayFiltro(f)).toBe(true);
  });

  it('una operación en cero no es ganadora ni perdedora', () => {
    expect(cumpleFiltro({ ...SIN_FILTRO, resultado: 'ganadoras' }, op('X', 'long', '0'))).toBe(
      false
    );
    expect(cumpleFiltro({ ...SIN_FILTRO, resultado: 'perdedoras' }, op('X', 'long', '0'))).toBe(
      false
    );
  });
});

const fila = (extra: Partial<FilaCsv> = {}): FilaCsv => ({
  positionId: '1478478270075379715',
  symbol: 'BTCUSDT',
  lado: 'long',
  modoMargen: 'isolated',
  apalancamiento: null,
  abiertaEnMs: Date.parse('2026-08-25T16:00:00Z'),
  cerradaEnMs: Date.parse('2026-08-25T18:30:15Z'),
  precioEntrada: '114820.5',
  precioSalida: '115412.1',
  cantidadCierre: '0.043',
  resultado: '-0.36095346',
  porcentaje: null,
  pnlPrecio: '0.0123',
  comisiones: '-0.37325346',
  financiamiento: '0',
  takeProfit: {
    precio: '115412.1',
    colocadoEnMs: Date.parse('2026-08-25T16:00:04Z'),
    disparadoEnMs: Date.parse('2026-08-25T18:30:15Z')
  },
  ...extra
});

const contexto = {
  identificador: 'PCB-1-A-1',
  cuenta: 'A',
  subcuenta: 'Sub-01',
  zona: 'America/Mexico_City'
};

describe('construirCsv', () => {
  const csv = construirCsv([fila()], contexto);
  const lineas = csv.replace(/^\uFEFF/, '').split('\r\n');

  it('empieza con BOM y usa fin de línea de Windows', () => {
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.includes('\n') && !csv.replace(/\r\n/g, '').includes('\n')).toBe(true);
  });

  it('una cabecera y una línea por operación, con las columnas de Bitget', () => {
    expect(lineas[0]).toBe(
      'Identificador,Cuenta,Subcuenta,Par,Lado,Apalancamiento,Modo de margen,Apertura,Precio de entrada promedio,' +
        'Precio de salida promedio,Take Profit,TP colocado (UTC),TP colocado (CDMX),' +
        'TP disparado (UTC),TP disparado (CDMX),Cantidad de cierre,Resultado USDT,Porcentaje,Cierre,' +
        'Resultado por precio,Comisiones,Financiamiento,ID de posición'
    );
    expect(lineas[1]).toBe(
      'PCB-1-A-1,A,Sub-01,BTCUSDT,Long,,Aislado,2026-08-25 10:00:00,114820.5,115412.1,115412.1,' +
        '2026-08-25 16:00:04,2026-08-25 10:00:04,2026-08-25 18:30:15,2026-08-25 12:30:15,0.043,-0.36095346,,' +
        '2026-08-25 12:30:15,0.0123,-0.37325346,0,1478478270075379715'
    );
  });

  it('los importes salen exactos y con punto decimal, para que Excel los sume', () => {
    expect(lineas[1]).toContain(',-0.36095346,');
    expect(lineas[1]).not.toContain("'-");
  });

  it('una coma o unas comillas en un nombre no rompen las columnas', () => {
    const c = construirCsv([fila()], { ...contexto, subcuenta: 'Juan, "el bueno"' });
    expect(c).toContain('"Juan, ""el bueno"""');
  });

  it('un nombre que empieza por = + - @ no se ejecuta como fórmula', () => {
    const c = construirCsv([fila()], { ...contexto, cuenta: '=HYPERLINK("x")', subcuenta: '-1+1' });
    expect(c).toContain('"\'=HYPERLINK(""x"")"');
    expect(c).toContain(",'-1+1,");
  });

  it('sin operaciones, solo la cabecera', () => {
    expect(
      construirCsv([], contexto)
        .replace(/^\uFEFF/, '')
        .split('\r\n')
    ).toHaveLength(2);
  });
});

describe('identificador interno', () => {
  it('panel, cuenta madre y casilla: PCB-1-A-1', () => {
    expect(identificadorCuenta(1, 'A', 1)).toBe('PCB-1-A-1');
    expect(identificadorCuenta(3, 'O', 20)).toBe('PCB-3-O-20');
  });

  it('es la primera columna de cada fila', () => {
    const c = construirCsv([fila()], { ...contexto, identificador: 'PCB-2-B-7' });
    const lineas = c.replace(/^\uFEFF/, '').split('\r\n');
    expect(lineas[1]?.startsWith('PCB-2-B-7,A,Sub-01,')).toBe(true);
  });
});

describe('fechas y nombre del archivo', () => {
  it('las fechas van en la hora de la zona dada', () => {
    expect(fechaCsv(Date.parse('2026-08-01T06:00:00Z'), 'America/Mexico_City')).toBe(
      '2026-08-01 00:00:00'
    );
    expect(fechaCsv(Date.parse('2026-08-01T06:00:00Z'), 'UTC')).toBe('2026-08-01 06:00:00');
  });

  it('el nombre lleva subcuenta y periodo, sin caracteres que Windows rechace', () => {
    expect(nombreArchivoCsv('PCB-1-A-1', '2026-08-01', '2026-08-07')).toBe(
      'historial_PCB-1-A-1_2026-08-01_a_2026-08-07.csv'
    );
    expect(nombreArchivoCsv('a/b:c*?', null, null)).toBe('historial_a_b_c___completo.csv');
    expect(nombreArchivoCsv('   ', null, null)).toBe('historial_subcuenta_completo.csv');
  });
});
