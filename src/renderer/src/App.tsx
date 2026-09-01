import { useEffect } from 'react';
import { ESTADO_ACCION_VARIABLE, type ClaveColorEstado } from '@/lib/tokens';
import { usarPanel } from '@/store/panel';
import { PantallaDesbloqueo } from '@/features/login/PantallaDesbloqueo';
import { Avisos } from '@/features/panel/Avisos';
import { BarraLateral } from '@/features/panel/BarraLateral';
import { BuscadorActivos } from '@/features/panel/BuscadorActivos';
import { DialogoBajaApi } from '@/features/panel/DialogoBajaApi';
import { DialogoColores } from '@/features/panel/DialogoColores';
import { DialogoPlan } from '@/features/panel/DialogoPlan';
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
 * El color es lo único que se aplica fuera de React, y por el mismo motivo en
 * los dos casos: cambiar `data-theme` o una custom property en `<body>` deja
 * que la cascada de CSS resuelva todo sin que ningún componente vuelva a
 * renderizarse. Con la matriz dibujando 300 subcuentas × 20 casillas, eso es la
 * diferencia entre mover un deslizador de color y congelar la pantalla.
 */
export default function App() {
  const pantalla = usarPanel((s) => s.pantalla);
  const tema = usarPanel((s) => s.tema);
  const coloresEstado = usarPanel((s) => s.coloresEstado);
  const iniciar = usarPanel((s) => s.iniciar);

  useEffect(() => {
    void iniciar();
  }, [iniciar]);

  useEffect(() => {
    document.body.setAttribute('data-theme', tema);
  }, [tema]);

  /*
   * Se escribe en `<body>`, que gana a `:root` por especificidad. Los valores
   * de fábrica siguen declarados en `styles/index.css` y son los que mandan
   * mientras el operador no haya elegido nada.
   */
  useEffect(() => {
    for (const [clave, variable] of Object.entries(ESTADO_ACCION_VARIABLE)) {
      document.body.style.setProperty(variable, coloresEstado[clave as ClaveColorEstado]);
    }
  }, [coloresEstado]);

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <Encabezado />

      <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        <div style={{ order: 1, flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <PanelResultadoLote />
          <MatrizCuentas />
        </div>
        <div style={{ order: 2, height: '100%', display: 'flex' }}>
          <BarraLateral />
        </div>
      </div>

      <PantallaApis />
      {/* Va sobre la pantalla de API keys, que es desde donde se pide la baja. */}
      <DialogoBajaApi />
      <BuscadorActivos />
      <DialogoSeguridad />
      <DialogoColores />
      <DialogoPlan />
      <ModalDetalleSubcuenta />
      {pantalla === 'login' && <PantallaDesbloqueo />}
      <Avisos />
    </div>
  );
}
