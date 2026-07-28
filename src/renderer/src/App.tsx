import { useEffect, useState } from 'react';
import type { EstadoApp, InfoSistema } from '@shared/ipc-contract';

/**
 * Pantalla de verificacion de la Fase 1.
 *
 * No es la interfaz del producto: es la prueba de que la cadena
 * principal -> preload -> renderer funciona con tipos compartidos y con el
 * aislamiento de contexto activo. El Centro de Monitoreo se construye en la
 * Fase 6, sobre los wireframes de docs/04.
 */
export default function App() {
  const [info, setInfo] = useState<InfoSistema | null>(null);
  const [estado, setEstado] = useState<EstadoApp | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([window.pcb.sistemaInfo(), window.pcb.sistemaEstado()])
      .then(([i, e]) => {
        setInfo(i);
        setEstado(e);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-10 flex-none items-center gap-6 border-b border-rule bg-chrome px-4">
        <span className="font-bold tracking-wide">PCB</span>
        <span className="text-tenue">Fase 1 · esqueleto verificado</span>
        <span className="ml-auto text-tenue">{info?.instanciaNombre ?? '—'}</span>
      </header>

      <main className="flex-1 overflow-auto bg-panel p-8">
        <h1 className="mb-1 text-lg font-semibold">Panel de Control Bitget</h1>
        <p className="mb-6 text-tenue">
          Estructura del proyecto y cadena de procesos operativas. Sin conexion a Bitget todavia.
        </p>

        {error && <p className="text-fallo">Fallo el IPC: {error}</p>}

        <table className="border-collapse text-left">
          <tbody>
            <Fila k="Version" v={info?.appVersion} />
            <Fila k="Electron" v={info?.electron} />
            <Fila k="Node" v={info?.node} />
            <Fila k="Modo" v={info ? (info.portable ? 'portable' : 'instalado') : undefined} />
            <Fila k="Carpeta de datos" v={info?.carpetaDatos} />
            <Fila k="Vault" v={estado?.vault} />
            <Fila k="Cuentas registradas" v={estado?.cuentasRegistradas} />
            <Fila k="Aislamiento de contexto" v={window.pcb ? 'activo' : 'AUSENTE'} />
          </tbody>
        </table>
      </main>
    </div>
  );
}

function Fila({ k, v }: { k: string; v: string | number | undefined }) {
  return (
    <tr className="border-b border-rule-soft">
      <td className="py-1.5 pr-10 text-tenue">{k}</td>
      <td className="cifra py-1.5 text-left">{v ?? '…'}</td>
    </tr>
  );
}
