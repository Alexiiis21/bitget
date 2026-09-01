# Sonidos del panel

## `caja-registradora.*` — apertura de posiciones

Suena una vez cuando un lote de apertura entra en Bitget con al menos una casilla
correcta. Lo dispara `lib/sonido.ts` desde `store/panel.ts`.

### Cómo se cambia

Deje caer el archivo en esta carpeta con el nombre `caja-registradora` y la
extensión que tenga: `.mp3`, `.wav`, `.ogg`, `.m4a`. **Borre el anterior** — si
quedan dos, `import.meta.glob` toma uno cualquiera de los dos.

No hay que tocar ninguna línea de código. Tampoco hace falta que la extensión
coincida con la del archivo que hay ahora.

### Lo que hay ahora es un marcador de posición

`caja-registradora.wav` está **sintetizado**, no grabado: una ráfaga de ruido
filtrado —el cajón— y dos campanas inarmónicas a 2093 Hz y 2637 Hz separadas
110 ms. Suena a caja registradora y sirve para comprobar que el circuito
funciona, pero no es el sonido de Bitget ni pretende serlo. Está para que el
panel no arranque mudo mientras se decide cuál va.

### De dónde sacar el definitivo

**El de Bitget, exacto.** No lo publican como archivo suelto; hay que sacarlo de
donde ya se reproduce. En el navegador: abra la pantalla de futuros de Bitget con
las DevTools de Chrome en la pestaña **Network**, filtro **Media**, y ejecute una
orden. El archivo de audio aparece en la lista — clic derecho, *Open in new tab*
y guardar. En Android el mismo archivo está dentro del APK, en `res/raw/` o en
`assets/`, y se saca descomprimiéndolo. Tenga en cuenta que ese archivo es de
Bitget: para una herramienta interna es un asunto práctico, pero no es material
libre y no debería salir de aquí.

**Libre de derechos, que es la opción por defecto.** Buscar «cash register»,
«cha-ching» o «kaching»:

- [Pixabay](https://pixabay.com/sound-effects/search/cash-register/) — sin
  atribución, descarga directa en MP3. Es el camino más corto.
- [ZapSplat](https://www.zapsplat.com/music/cash-register-old-fashioned-open-ka-ching-version-1/) —
  gratis con cuenta; catálogo grande y bien grabado.
- [Free-Stock-Music](https://www.free-stock-music.com/sound-effects-library-cash-register-sound.html) —
  CC0 1.0, sin atribución, uso comercial incluido.
- [directory.audio](https://directory.audio/collection/341-cash-register-cha-ching) —
  colección entera de cajas registradoras bajo Creative Commons.

### Qué pedirle al archivo

- **Menos de un segundo y medio.** Se dispara junto al informe del lote; algo
  más largo sigue sonando cuando el operador ya está leyendo el resultado.
- **Sin silencio al principio.** Un archivo con 300 ms de nada por delante se
  oye tarde y parece que el panel va lento.
- **Normalizado, sin picos al tope.** `sonido.ts` lo reproduce al 70 %.
- **Más de 4 KiB, o cualquier tamaño si se respeta la regla de empaquetado.**
  La CSP del `index.html` no admite `data:` en medios, así que un archivo que
  Vite decidiera empotrar en base64 no sonaría en el binario. La regla que lo
  impide está en `electron.vite.config.ts` (`assetsInlineLimit`); mientras siga
  ahí, el tamaño da igual.
