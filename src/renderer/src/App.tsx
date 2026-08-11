import { useEffect } from 'react';
import { usarPanel } from '@/store/panel';
import { PantallaDesbloqueo } from '@/features/login/PantallaDesbloqueo';
import { Avisos } from '@/features/panel/Avisos';
import { BarraLateral } from '@/features/panel/BarraLateral';
import { DialogoPaso } from '@/features/panel/DialogoPaso';
import { DialogoSeguridad } from '@/features/panel/DialogoSeguridad';
import { Encabezado } from '@/features/panel/Encabezado';
import { MatrizCuentas } from '@/features/panel/MatrizCuentas';
import { ModalDetalleSubcuenta } from '@/features/panel/ModalDetalleSubcuenta';
import { PanelResultadoLote } from '@/features/panel/PanelResultadoLote';
import { PantallaApis } from '@/features/panel/PantallaApis';

/**
 * Composición del panel — diseño aprobado v2.
 *
 * El encabezado no se desplaza; el área de contenido (resultado del lote +
 * matriz de cuentas) y la barra lateral comparten la altura restante, uno
 * con scroll propio y la otra fija. Las pantallas superpuestas van al final,
 * cada una decidiendo por sí misma si debe dibujarse.
 *
 * El tema es el único estado que se aplica fuera de React: cambiar
 * `data-theme` en `<body>` deja que la cascada de CSS resuelva todos los
 * colores sin que ningún componente vuelva a renderizarse por eso.
 */
export default function App() {
  const pantalla = usarPanel((s) => s.pantalla);
  const tema = usarPanel((s) => s.tema);
  const iniciar = usarPanel((s) => s.iniciar);

  useEffect(() => {
    void iniciar();
  }, [iniciar]);

  useEffect(() => {
    document.body.setAttribute('data-theme', tema);
  }, [tema]);

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <Encabezado />

      <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        <div style={{ order: 1, flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <PanelResultadoLote />
          <MatrizCuentas />
        </div>
        <div style={{ order: 2 }}>
          <BarraLateral />
        </div>
      </div>

      <PantallaApis />
      <DialogoSeguridad />
      <DialogoPaso />
      <ModalDetalleSubcuenta />
      {pantalla === 'login' && <PantallaDesbloqueo />}
      <Avisos />
    </div>
  );
}
