# ADR 0008 — Respaldo de credenciales en un archivo, fuera de la carpeta del panel

- **Estado:** aceptada
- **Fecha:** 13 de septiembre de 2026
- **Fase:** 5

## Contexto

El binario es portable y guarda sus datos **junto al `.exe`**. Es lo que hace que copiar
la carpeta copie el sistema entero y que dos entornos en la misma máquina no se pisen,
pero tiene una consecuencia que se cobró el 05/09/2026: al recibir una versión nueva y
abrirla desde otra carpeta —Descargas, el escritorio—, el panel no encuentra la carpeta de
datos y arranca en blanco. La conclusión del operador fue la peor posible: *«no se pasaron
las API keys»*. No se habían perdido; seguían donde estaban.

La respuesta de entonces fue `credenciales:importar`: el operador señala su carpeta
anterior y se copia el almacén cifrado. Resuelve el caso, pero depende de dos cosas que
fallan justo cuando hacen falta:

1. **Que la carpeta vieja siga existiendo.** Si borra el panel anterior, no hay nada que
   señalar.
2. **Que sepa encontrarla.** El propio mensaje de error lo delata: «elija la carpeta que
   se llama *datos-staging* —o *datos*—, no el acceso directo ni el .exe».

Y el panel se actualiza a menudo. Una salida que exige recordar dónde estaba la instalación
anterior es una salida que falla el día que se usa.

## Decisión

Un archivo `.pcbak` con `vault.enc`, `cuentas.json` y `activos.json` en base64, guardado en
`Documentos\Panel de Control Bitget[-staging]\respaldos\`. Se crea con un botón —**un
clic, sin diálogos**— y también solo, tras cada alta y cada baja. La versión nueva lo busca
al arrancar y ofrece restaurarlo con otro clic.

Implementación en [`respaldo-credenciales.ts`](../../src/main/storage/respaldo-credenciales.ts)
y [`respaldo-automatico.ts`](../../src/main/storage/respaldo-automatico.ts).

## Razones

**En Documentos y no junto al `.exe`.** El respaldo existe justamente para sobrevivir a que
se borre la carpeta del panel viejo; guardarlo dentro de ella sería guardarlo en el único
sitio que se sabe que va a desaparecer. Y es lo que permite que la versión nueva lo
encuentre sola: una ruta conocida y estable, sin que el operador navegue nada.

**Un archivo y no una carpeta.** Se puede adjuntar a un correo, copiar a un USB o arrastrar
al escritorio sin perder piezas por el camino. La importación por carpeta sigue existiendo
como salida secundaria, intacta.

**Sin dependencias nuevas.** JSON + base64 + `zod`, que es exactamente lo que ya es
`vault.enc`. Un ZIP habría exigido una librería para ahorrar unos kilobytes en archivos de
decenas de KB.

**`sha256` por archivo.** AES-GCM ya autentica el vault, pero solo *después* de medio
segundo de scrypt, y su fallo se traduce a «archivo dañado», que el operador lee como «he
perdido mis claves». Con el checksum se rechaza antes de tocar el disco y se dice «este
respaldo llegó incompleto», que es otra cosa. Además `cuentas.json` y `activos.json` no
tienen ninguna otra protección.

**Versiones de schema en la cabecera.** Es [`vault.ts:323`](../../src/main/security/vault.ts)
aplicado un paso antes. El vault rechaza un archivo de versión futura al abrirlo; aquí hay
que rechazarlo antes de **escribirlo**, porque para cuando el operador lo descubriera ya se
habría reemplazado el suyo.

**Fechados más un alias estable.** El alias hace la detección determinista sin ordenar por
`mtime` —que se reescribe al copiar carpetas—. Los fechados existen porque el respaldo
automático dispara también en cada baja: con un solo archivo rotatorio, una baja equivocada
se propagaría al respaldo en tres segundos y la credencial se habría ido de los dos sitios.

## Lo que esto relaja, y cómo se compensa

`importar-credenciales.ts` documenta como absoluta la regla **«nunca se pisa un almacén
existente»**. Restaurar sí puede, porque su caso es otro: no es «señalo la carpeta vieja,
aquí no hay nada», sino «este archivo manda, posiblemente sobre lo que hay». Y ese caso es
el **frecuente**, no el raro: quien abre el `.exe` nuevo y teclea una contraseña ya ha
creado un almacén antes de darse cuenta de que debería haber restaurado.

Tres compensaciones, y ninguna es opcional:

1. **El almacén anterior no se borra.** Se aparta con `rename` a
   `vault.enc.reemplazado-<sello>` en la misma carpeta, junto con su `.bak`. Sigue sin
   existir ninguna escritura irreversible sobre las API keys.
2. **Hace falta la contraseña maestra de *este* panel**, que es lo que demuestra que lo que
   se aparta es de quien lo aparta.
3. **Exige el panel bloqueado.** Con el almacén abierto en memoria, `Sesion` sigue apuntando
   a la misma ruta y la siguiente escritura del vault —un alta, fijar la contraseña de
   paso— volcaría el contenido **viejo** sobre el archivo recién restaurado. La
   restauración se perdería en silencio y nadie se enteraría hasta necesitar una clave. Se
   comprueba en el manejador de IPC, no solo en la pantalla.

Por eso es un módulo nuevo y no un parámetro en `importar-credenciales.ts`: convertir esa
regla en un booleano obligaría al siguiente lector a mirar el call site para saber qué está
vigente, sobre el archivo que guarda las únicas copias de las API keys.

## Consecuencias, incluida la que no gusta

**El vault cifrado ahora vive también en Documentos.** En Windows 11 esa carpeta suele estar
sincronizada a OneDrive, entra en casi cualquier herramienta de copia de seguridad y no
está protegida más allá de la cuenta de usuario. Es decir: **el almacén cifrado puede acabar
en servidores de Microsoft y en el disco externo del operador.**

Es un intercambio deliberado —el requisito es justamente sobrevivir al borrado de la carpeta
del panel— y queda escrito como consecuencia aceptada, no disimulada. Lo que lo sostiene es
que el archivo va cifrado tal cual, con AES-256-GCM y scrypt N=2¹⁷, y que **la contraseña
maestra no está dentro**. Esa frase no es tranquilizadora: es la frontera de seguridad, y
por eso se repite en cuatro sitios —la pantalla de API keys, el propio `.pcbak` para quien
lo abra con el Bloc de notas, la pantalla de desbloqueo y el diálogo de confirmación—.

Consecuencia directa: la fortaleza de la contraseña maestra pasa a ser estructural de un
modo que antes no lo era tanto.

**Propiedad conocida, no mitigada aquí:** los respaldos fechados que se conservan son
almacenes anteriores, cada uno abrible con la maestra que estuviera vigente cuando se hizo.
Cambiar la maestra no los invalida. Lo mismo ya ocurre con `vault.enc.bak`. Podar los
respaldos al cambiar la maestra queda anotado para más adelante.

**Limitación aceptada:** dos paneles del mismo entorno en la misma máquina comparten carpeta
de respaldos y se pisan el alias. `panelOrigen` va en la cabecera para que la pantalla diga
«respaldo del panel #3», los fechados de ambos conviven y «Buscar un archivo de respaldo…»
llega a cualquiera. Se documenta con la salida nombrada en lugar de complicar los nombres de
archivo, porque un clic sin diálogos es prioritario.

## Alternativas descartadas

| Alternativa | Por qué no |
|---|---|
| Guardar el respaldo junto al `.exe` | Es el sitio que el operador borra al cambiar de versión: no resolvería nada |
| Pedir la carpeta con un diálogo en cada respaldo | Tres o cuatro clics, y la versión nueva no podría encontrarlo sola |
| Exportar las credenciales en claro | Convertiría un archivo inerte en el peor archivo del disco |
| Incluir la contraseña maestra o un token de desbloqueo | Lo mismo, con más pasos |
| Incluir `instancia.json` | Dos paneles con el mismo número es la confusión que ese número existe para evitar |
| Un ZIP en vez de JSON+base64 | Una dependencia nativa o pura para ahorrar kilobytes en archivos de decenas de KB |
| Cerrar la sesión automáticamente al restaurar | Cerraría la sesión del operador desde un canal que él invocó esperando otra cosa |
