# ADR 0005 — Contraseña maestra con PIN de desbloqueo rápido

- **Estado:** propuesta — requiere confirmación del cliente (P-3 y P-4)
- **Fecha:** 27 de julio de 2026
- **Fase:** 1

## Contexto

El contrato exige almacenamiento cifrado local de las credenciales API. El cliente pidió
además, el 27 de julio, «2 dígitos de contraseña configurable y una contraseña maestra
para recuperación/cambio, una por cada sistema».

Un PIN de 2 dígitos son **100 combinaciones**. Si fuera la clave que cifra el almacén,
cualquiera con el archivo lo abriría en un segundo.

## Decisión

Tres capas con responsabilidades distintas:

1. **Contraseña maestra** → `scrypt(N=2^17, r=8, p=1)` → clave de 32 bytes → AES-256-GCM
   sobre `vault.enc`. Es la única frontera criptográfica real.
2. **DPAPI de Windows** (`safeStorage` de Electron) envuelve esa clave para la opción
   «recordar en este equipo». Ata el descifrado a la cuenta de Windows.
3. **PIN** → puerta de la aplicación que libera la envoltura DPAPI. Contador de intentos
   **persistido en disco**, espera creciente (0·1·3·10·30 s) y borrado de la envoltura a
   los 5 fallos.

Longitud del PIN configurable de 2 a 8 dígitos; 2 por defecto, como pidió el cliente.

## Lo que protege cada capa

| Amenaza | Maestra | DPAPI | PIN |
|---|---|---|---|
| Roban el archivo (nube, USB, respaldo) | Sí | Sí | — |
| Otro usuario de Windows en el equipo | Sí | Sí | — |
| Malware bajo la sesión del operador | Sí | **No** | **No** |
| Alguien se sienta frente al equipo | Sí | — | Sí |

Con el desbloqueo rápido **activo**, un proceso malicioso corriendo como el operador puede
pedirle la clave a DPAPI sin conocer el PIN. Con el desbloqueo rápido **desactivado**, la
contraseña maestra nunca toca el disco y ese vector se cierra. Es una decisión del
cliente: comodidad diaria contra superficie de ataque.

## Tensión con el pliego, declarada

El pliego dice «sin login ni perfiles». Una contraseña maestra no es un sistema de login:
no hay usuarios, ni roles, ni recuperación por correo. Es la llave de una caja fuerte, se
pide una vez al abrir y la aplicación no corre en segundo plano.

## Sin recuperación

No hay pregunta de seguridad, ni copia de la clave, ni puerta trasera: cualquier mecanismo
de recuperación sería, por definición, una segunda forma de abrir el almacén sin la
contraseña.

Ante pérdida, el plan es operativo: borrar `vault.enc`, revocar las API keys en Bitget y
registrarlas de nuevo. `cuentas.json` conserva nombres, grupos y orden, así que no se
pierde la estructura del panel. **Debe explicarse al cliente antes de la Fase 2:** es la
única operación irreversible del sistema.

## Consecuencias

- El almacén y sus metadatos se separan: `vault.enc` (secretos) y `cuentas.json` (todo lo
  demás). Permite dibujar el panel completo con la aplicación bloqueada, sin exponer nada.
- Una credencial con permiso de retiro se rechaza al darla de alta.
