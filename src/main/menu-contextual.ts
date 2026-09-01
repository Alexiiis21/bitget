import { Menu, MenuItem } from 'electron';
import type { BrowserWindow, ContextMenuParams } from 'electron';

/**
 * Menu del boton derecho: cortar, copiar, pegar y seleccionar todo.
 *
 * --------------------------------------------------------------------------
 * Por que hay que escribirlo
 * --------------------------------------------------------------------------
 * Una pagina web trae este menu de serie; una ventana de Electron, no. Sin el,
 * la unica forma de pegar en el panel es Ctrl+V, y el caso donde eso duele es el
 * alta de credenciales: tres claves de 64 caracteres que nadie teclea a mano y
 * que se traen desde Bitget en el portapapeles. Lo pidio el cliente el
 * 31/08/2026.
 *
 * --------------------------------------------------------------------------
 * Los secretos guardados siguen sin poder copiarse
 * --------------------------------------------------------------------------
 * Copiar y cortar se ofrecen **desactivados** en los campos de contrasena:
 * Chromium no deja copiar de un `input[type=password]` y lo dice en
 * `editFlags.canCopy`, que es lo que se respeta aqui en vez de forzar el item.
 * Asi «Pegar» -que es lo que se pidio- funciona en la Secret Key y en la
 * Passphrase sin abrir una via para sacar de ellas lo que ya esta dentro.
 *
 * La lista de API keys tampoco expone nada: solo guarda la clave enmascarada,
 * asi que lo mas que se puede copiar de ahi es `bg••••8b3f`. RNF-001.
 *
 * Los rotulos van en castellano y no por `role` a secas: los roles de Electron
 * se rotulan en el idioma del sistema operativo, y en un Windows en ingles este
 * menu saldria en ingles dentro de un panel que esta entero en castellano.
 */
export function habilitarMenuContextual(ventana: BrowserWindow): void {
  ventana.webContents.on('context-menu', (_evento, params) => {
    const menu = menuDe(params);
    /*
     * Sin nada que ofrecer no se abre menu.
     *
     * Es el caso del clic derecho sobre la matriz de casillas: un menu con tres
     * opciones apagadas no informa de nada y tapa justo lo que se acaba de
     * pulsar.
     */
    if (menu === null) return;
    menu.popup({ window: ventana });
  });
}

function menuDe(params: ContextMenuParams): Menu | null {
  const { editFlags } = params;

  if (params.isEditable) {
    const menu = new Menu();
    menu.append(new MenuItem({ label: 'Deshacer', role: 'undo', enabled: editFlags.canUndo }));
    menu.append(new MenuItem({ label: 'Rehacer', role: 'redo', enabled: editFlags.canRedo }));
    menu.append(new MenuItem({ type: 'separator' }));
    menu.append(new MenuItem({ label: 'Cortar', role: 'cut', enabled: editFlags.canCut }));
    menu.append(new MenuItem({ label: 'Copiar', role: 'copy', enabled: editFlags.canCopy }));
    menu.append(new MenuItem({ label: 'Pegar', role: 'paste', enabled: editFlags.canPaste }));
    menu.append(new MenuItem({ type: 'separator' }));
    menu.append(
      new MenuItem({ label: 'Seleccionar todo', role: 'selectAll', enabled: editFlags.canSelectAll })
    );
    return menu;
  }

  /* Fuera de un campo, el menu solo tiene sentido sobre texto ya seleccionado. */
  if (params.selectionText.trim() === '') return null;

  const menu = new Menu();
  menu.append(new MenuItem({ label: 'Copiar', role: 'copy', enabled: editFlags.canCopy }));
  return menu;
}
