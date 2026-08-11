/**
 * Selección de implementación de `PanelService`.
 *
 * En **staging** siempre es `IpcPanelService`, sin excepción y sin variable que
 * lo pueda cambiar: el entorno existe precisamente para que no haya forma de
 * mirar datos inventados creyendo que son de Bitget. Como `__ENTORNO__` es un
 * literal en tiempo de compilación, la rama del mock queda muerta y Rollup la
 * elimina: `MockPanelService` no llega a entrar en el bundle de staging.
 *
 * En **dev** manda `VITE_PANEL_SERVICE`: `ipc` usa el proceso principal real y
 * cualquier otro valor (o su ausencia) usa `MockPanelService`. Ningún
 * componente decide esto: importan `panelService` de aquí y no saben cuál de las
 * dos hay detrás. Cambiar de una a otra es tocar esa variable, nunca un
 * componente.
 */
import type { PanelService } from '@shared/ports/panel-service';
import { MockPanelService } from './mock-panel-service';
import { IpcPanelService } from './ipc-panel-service';

const modo = import.meta.env['VITE_PANEL_SERVICE'] as string | undefined;

export const panelService: PanelService =
  __ENTORNO__ === 'staging' || modo === 'ipc' ? new IpcPanelService() : new MockPanelService();
