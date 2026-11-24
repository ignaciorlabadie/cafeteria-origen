# Informe — Cafetería Origen

## VUL-01 · Inyección SQL en el login

- **Qué es y por qué importa:** el nombre de usuario y la contraseña se insertaban directamente dentro de la consulta SQL de autenticación. Un atacante podía reescribir la condición y entrar sin credenciales válidas, con acceso a los datos y al panel de administración.
- **Dónde está:** `src/services/usuarios.service.ts:42` (versión original): `const sql = \`SELECT * FROM usuarios WHERE username = '${username}' AND password = '${password}'\`;`
- **Cómo se observa:** en `http://localhost:8080/admin.html`, cargar usuario `' OR 1=1 --` y cualquier contraseña; también probar `admin'--`. Evidencia en la versión vulnerable: el login respondía `200` y dejaba una sesión de administrador aunque la contraseña fuera falsa.
- **Por qué ocurre:** la comilla simple del payload cerraba la cadena del código y el resto del texto pasaba a ser SQL. `db.query(sql)` recibía la consulta ya armada, sin separar datos de código.
- **Cómo se corrige:** consulta parametrizada; los valores viajan en un array aparte y PostgreSQL no los interpreta como instrucciones:

  ```ts
  const { rows } = await db.query<Usuario>(
    'SELECT * FROM usuarios WHERE username = $1 AND password = $2',
    [username, password]
  );
  return rows[0] || null;
  ```

- **Cómo se verifica:** `docker compose exec app npm run test:seguridad` → bloque *Inyección SQL*:
  `✔ el login NO acepta el bypass con payload SQL` y `✔ el login NO acepta el payload que comenta la contraseña`.

## VUL-02 · Inyección SQL en los filtros del catálogo

- **Qué es y por qué importa:** los filtros `tipo`, `variedad` y `q` del menú se concatenaban en el `WHERE`/`ILIKE`, permitiendo ampliar la búsqueda, filtrar productos de otros orígenes o inyectar otras consultas.
- **Dónde está:** `src/services/catalogo.service.ts:40-43` (versión original): `sql += \` AND tipo = '${tipo}'\``, `sql += \` AND variedad = '${variedad}'\`` y `sql += \` AND (nombre ILIKE '%${q}%' OR descripcion ILIKE '%${q}%')\``.
- **Cómo se observa:** en el buscador del menú escribir `' OR '1'='1`; en el filtro por origen, `Colombia' OR '1'='1`. Evidencia en la versión vulnerable: la respuesta devolvía los 20 productos en vez de los que coincidían con el texto buscado.
- **Por qué ocurre:** el valor del cliente se interpolaba entre comillas dentro del texto SQL, de modo que las comillas y operadores del payload cambiaban la lógica de la consulta.
- **Cómo se corrige:** se validan `tipo` y `variedad` contra listas blancas, se acumulan condiciones con marcadores `$1`, `$2`, ... y se escapan los comodines de `ILIKE`:

  ```ts
  if (tipo && !TIPOS_VALIDOS.includes(tipo)) return [];
  if (variedad && !VARIEDADES_VALIDAS.includes(variedad)) return [];
  const condiciones = ['activo = true'];
  const valores: unknown[] = [];
  if (q) {
    const patron = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
    valores.push(patron);
    const marcador = '$' + valores.length;
    const escape = " ESCAPE '\\'";
    condiciones.push(
      '(nombre ILIKE ' + marcador + escape + ' OR descripcion ILIKE ' + marcador + escape + ')'
    );
  }
  const sql = 'SELECT * FROM productos WHERE ' + condiciones.join(' AND ') +
    ' ORDER BY tipo, variedad NULLS FIRST, id';
  const { rows } = await db.query<Producto>(sql, valores);
  ```

- **Cómo se verifica:** `npm run test:seguridad` → `✔ la búsqueda del catálogo NO se puede ampliar con SQL` y `✔ el filtro por origen NO se puede ampliar con SQL`.

## VUL-03 · Inyección SQL en el filtro por mesa

- **Qué es y por qué importa:** el parámetro `mesa` de `GET /api/pedidos` se concatenaba en el `WHERE`, permitiendo ver pedidos de todas las mesas sin filtrar por la solicitada.
- **Dónde está:** `src/services/pedidos.service.ts:95` (versión original): `if (mesa) sql += \` WHERE mesa = '${mesa}'\`;`
- **Cómo se observa:** pedir `GET /api/pedidos?mesa=' OR '1'='1`. Evidencia en la versión vulnerable: la respuesta incluía pedidos de mesas distintas a la pedida.
- **Por qué ocurre:** el valor llegaba como texto desde `req.query.mesa` y se insertaba entre comillas en la consulta; el `OR '1'='1'` hacía verdadera la condición para todas las filas.
- **Cómo se corrige:** marcador posicional y valor por separado:

  ```ts
  let sql = 'SELECT * FROM pedidos';
  const valores: unknown[] = [];
  if (mesa) {
    valores.push(mesa);
    sql += ' WHERE mesa = $1';
  }
  sql += ' ORDER BY id DESC';
  const { rows } = await db.query<Pedido>(sql, valores);
  ```

- **Cómo se verifica:** `npm run test:seguridad` → `✔ el filtro por mesa NO se puede ampliar con SQL`.

## VUL-04 · Inyección SQL en el reporte por origen

- **Qué es y por qué importa:** el origen del reporte de ventas se concatenaba en un `HAVING`, permitiendo un `UNION` para leer tablas ajenas a la app, como `usuarios` con sus contraseñas.
- **Dónde está:** `src/services/reportes.service.ts:84` (versión original): `HAVING pr.variedad = '${variedad}'`.
- **Cómo se observa:** `GET /api/reportes/ventas-por-variedad?variedad=Brasil' UNION SELECT username, password, 1, 1 FROM usuarios--`. Evidencia en la versión vulnerable: el JSON del reporte incluía usuarios y contraseñas de la tabla `usuarios`.
- **Por qué ocurre:** la concatenación cerraba la consulta original y agregaba una segunda consulta, que PostgreSQL ejecutaba con los privilegios de la aplicación.
- **Cómo se corrige:** se valida el origen contra la lista blanca de variedades conocidas y se pasa como parámetro:

  ```ts
  const VARIEDADES_VALIDAS: string[] = Object.keys(PRECIO_POR_GRAMO);

  export async function ventasPorVariedad(variedad: string): Promise<VentaPorVariedad[]> {
    if (!VARIEDADES_VALIDAS.includes(variedad)) return [];
    const sql = `
      SELECT pr.variedad, pr.nombre, SUM(pi.cantidad) AS unidades,
             SUM(pi.cantidad * pi.precio_unitario) AS total
        FROM pedido_items pi
        JOIN productos pr ON pr.id = pi.producto_id
       GROUP BY pr.variedad, pr.nombre
      HAVING pr.variedad = $1`;
    const { rows } = await db.query<VentaPorVariedad>(sql, [variedad]);
    return rows;
  }
  ```

- **Cómo se verifica:** `npm run test:seguridad` → `✔ el reporte por origen NO filtra otras tablas con UNION`.

## VUL-26 · Base de datos sin contraseña y con superusuario

- **Qué es y por qué importa:** la base aceptaba conexiones sin autenticación (`trust`) y la aplicación se conectaba como el superusuario `postgres`. Cualquier inyección SQL podía leer, modificar o borrar cualquier tabla y crear otros roles.
- **Dónde está:** `docker-compose.yml:25,29,60,61` (versión original): `POSTGRES_PASSWORD: postgres`, `POSTGRES_HOST_AUTH_METHOD: trust`, `DB_USER: postgres` y `DB_PASSWORD: postgres`.
- **Cómo se observa:** `docker compose exec db psql -U postgres -d origen` entraba sin clave; desde cualquiera de los cuatro puntos de inyección se podía ejecutar `DROP TABLE productos` contra la base de pruebas. Evidencia: `SELECT current_user, rolsuper FROM pg_roles WHERE rolname = current_user` devolvía `postgres` y `true`.
- **Por qué ocurre:** `POSTGRES_HOST_AUTH_METHOD: trust` deshabilitaba la autenticación por contraseña, y las variables de entorno de la app apuntaban al rol con todos los privilegios. No existía separación entre el usuario administrador de PostgreSQL y el usuario de la aplicación.
- **Cómo se corrige:** se quitó `POSTGRES_HOST_AUTH_METHOD: trust` y la app usa el rol con mínimos privilegios creado en `docker/initdb/02-usuario-aplicacion.sql`:

  ```yaml
  services:
    db:
      environment:
        POSTGRES_DB: origen
        POSTGRES_USER: postgres
        POSTGRES_PASSWORD: postgres
    app:
      environment:
        DB_HOST: db
        DB_PORT: 5432
        DB_NAME: origen
        DB_USER: origen_app
        DB_PASSWORD: origen_app_2024
  ```

- **Cómo se verifica:** recrear la base con `docker compose down -v && docker compose up -d` para que se creen el rol `origen_app` y sus permisos, y correr `npm run test:seguridad` → `✔ la aplicación NO se conecta con un superusuario de la base` (el test consulta `current_user` y `rolsuper` en la BD).

## VUL-05 · Cross-Site Scripting reflejado

- **Qué es y por qué importa:** la entrada del usuario volvía al navegador dentro de una respuesta o de un mensaje de error y se pintaba como HTML. Un atacante podía ejecutar JavaScript en la sesión de otra persona: robar la cookie, suplantarla o cambiar lo que ve.
- **Dónde está (versión original):**
  - `src/public/js/app.js:130`: `el.innerHTML = 'Resultados para <strong>' + filtros.q + '</strong> ...'` (texto del buscador).
  - `src/public/js/app.js:137,233,288`: mensajes de error pintados con `innerHTML`.
  - `src/public/js/admin.js:63,79`: `feedback()` usaba `innerHTML` con el error del servidor.
  - `src/routes/auth.routes.ts:39`, `src/routes/productos.routes.ts:58`, `src/middleware/errores.ts:18`: mensajes de error que devolvían el usuario, el id o la URL recibidos.
- **Cómo se observa:** en el buscador del menú, `<img src=x onerror=alert('XSS')>`; en el login, `<img src=x onerror=alert(1)>` como usuario; en el panel, `No pudimos iniciar sesión: ...` con un usuario que contenía HTML.
- **Por qué ocurre:** `innerHTML` interpreta la cadena como marcado, y el servidor reflejaba la entrada en el JSON de error. No había separación entre datos y código, ni una CSP que frenara los scripts.
- **Cómo se corrige:** los errores del servidor son genéricos (`'Usuario o contraseña incorrectos.'`, `'No existe ese producto.'`, `'Ruta no encontrada.'`). En el cliente, todo se inserta como texto:

  ```js
  function elemento(etiqueta, clase, texto) {
    var el = document.createElement(etiqueta);
    if (clase) el.className = clase;
    if (texto !== undefined) el.textContent = String(texto == null ? '' : texto);
    return el;
  }

  el.appendChild(document.createTextNode('Resultados para '));
  el.appendChild(elemento('strong', '', filtros.q));
  ```

  Ya no queda ninguna asignación a `.innerHTML` en `src/public/js/`.
- **Cómo se verifica:** `npm run test:seguridad` → bloque *Cross-Site Scripting* 3/3 en verde; `npm run check:security` → `✔ XSS-01`, `✔ XSS-02`. Además, con el login `<img src=x onerror=alert(1)>` la respuesta JSON no contiene `<img>`.

## VUL-06 · Cross-Site Scripting almacenado en las reseñas

- **Qué es y por qué importa:** el texto de una reseña se guardaba en la base y se ejecutaba en el navegador de **todos** los visitantes que abrieran el sitio, mucho después de que el atacante se fuera.
- **Dónde está:** `src/public/js/app.js:257-271` (versión original): `cont.innerHTML = resp.data.comentarios.map(...)` con `raw(c.autor)` y `raw(c.texto)`, donde `raw()` devolvía el valor sin escapar.
- **Cómo se observa:** publicar una reseña con `<script>alert('XSS almacenado')</script>` y recargar la página: el alert salta solo, también en otro navegador.
- **Por qué ocurre:** los datos de la base se trataban como HTML de confianza; `raw()` no escapaba nada y `innerHTML` ejecutaba el `<script>` al insertarlo.
- **Cómo se corrige:** la reseña se arma con `createElement` / `textContent`:

  ```js
  var reseña = elemento('article', 'review');
  var head = elemento('div', 'review-head');
  head.appendChild(elemento('span', 'review-author', c.autor));
  head.appendChild(elemento('span', 'review-stars', estrellas));
  reseña.appendChild(head);
  reseña.appendChild(elemento('p', 'review-text', c.texto));
  cont.appendChild(reseña);
  ```

  En la Práctica 4 se agregó además el límite de longitud en servidor (autor 2‑40, texto 3‑280, calificación 1‑5), así que el payload ni siquiera se guarda (XSS‑04).
- **Cómo se verifica:** `npm run check:security` → `✔ XSS-01` y `✔ XSS-04`; recargar el sitio con una reseña que contenga HTML: se muestra como texto, sin alerts.

## VUL-07 · Cross-Site Scripting de DOM en el panel

- **Qué es y por qué importa:** un parámetro de la URL se inyectaba directamente en el DOM del panel de administración. Alguien podía enviarle al administrador un link con un payload y ejecutar código con su sesión.
- **Dónde está:** `src/public/js/admin.js:421-428` (versión original): `var objetivo = params.get('vista'); $('#panel-bienvenida').innerHTML = 'Panel ' + objetivo;`.
- **Cómo se observa:** abrir `http://localhost:8080/admin.html?vista=<img src=x onerror=alert('DOM')>`.
- **Por qué ocurre:** `URLSearchParams` devuelve texto sin sanear, pero se asignaba a `innerHTML`, que lo interpreta como HTML.
- **Cómo se corrige:** asignar el valor con `textContent`:

  ```js
  $('#panel-bienvenida').textContent = 'Panel ' + objetivo;
  ```

  También se reescribieron las tablas del panel (pedidos, productos, reportes, usuarios), los KPIs y los mensajes de `feedback()` con `createElement` / `textContent`, porque allí también se pintaban datos de la API con `innerHTML`.
- **Cómo se verifica:** `admin.html?vista=<img src=x onerror=alert('DOM')>` muestra el texto literal sin ejecutarlo; `npm run test:seguridad` → bloque *Cross-Site Scripting* en verde.

## VUL-23 (parcial) · Content Security Policy

- **Qué es y por qué importa:** es una segunda línea de defensa: aunque algún dato se pinte como HTML por error, el navegador no ejecuta scripts inline ni `eval`.
- **Dónde está (versión original):** `src/app.ts` no configuraba `helmet` ni `contentSecurityPolicy`.
- **Cómo se observa:** `curl -I http://localhost:8080/` no mostraba `Content-Security-Policy`.
- **Por qué ocurre:** Express no agrega cabeceras de seguridad por defecto; sin CSP, un XSS que escapara a la validación podía ejecutar scripts inline.
- **Cómo se corrige:** en `src/app.ts`:

  ```ts
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          // La demo corre por HTTP en localhost: no forzar HTTPS aquí.
          upgradeInsecureRequests: null,
        },
      },
    })
  );
  ```

  Los HTML sólo cargan scripts externos (`/js/app.js`, `/js/admin.js`), así que `script-src 'self'` no rompe el sitio. Los demás controles de configuración (secretos y diagnóstico) se cubren más abajo en VUL-27 y VUL-23.
- **Cómo se verifica:** `npm run check:security` → `✔ XSS-03` y `✔ CFG-01`; `npm run test:seguridad` → `✔ el sitio envía cabeceras de seguridad`; `curl -I http://localhost:8080/` muestra `Content-Security-Policy` y `X-Content-Type-Options`.

## Reflexión de la práctica 2

El cambio de fondo fue dejar de tratar el texto como HTML. La corrección no es "limpiar" el payload del usuario — siempre aparece una variante que se escapa — sino elegir el destino correcto: `textContent` cuando se muestra texto, `setAttribute` cuando se setea un atributo, y `createElement` cuando se arma estructura. La validación en servidor y la CSP son capas adicionales, no reemplazos de ese hábito. En un proyecto real, además, habría que usar un framework que escape por defecto y prohibir `innerHTML` con una regla de lint, para que la falla no vuelva a aparecer en el próximo cambio.

## VUL-08 · Cross-Site Request Forgery (CSRF)

- **Qué es y por qué importa:** un sitio de un tercero podía hacer que el navegador de un usuario con sesión iniciada enviara peticiones a la API de la cafetería sin que él lo supiera. El navegador adjunta la cookie de sesión automáticamente, así que el servidor tomaba esas acciones como legítimas: crear pedidos, publicar reseñas o modificar productos y roles desde el panel.
- **Dónde está (versión original):**
  - `src/middleware/sesion.ts:61-62`: `res.cookie('sid', id, { path: '/' })` — sin `sameSite`, así que la cookie viajaba también en peticiones desde otros sitios.
  - `src/routes/pedidos.routes.ts:18`, `src/routes/comentarios.routes.ts:24` y las rutas de `src/routes/admin.routes.ts`: operaciones POST/PUT/PATCH/DELETE sin ningún token ni verificación de origen.
  - `src/app.ts`: no había endpoint que entregara un token ni middleware que lo validara.
- **Cómo se observa:** con una sesión iniciada en `admin.html`, abrir en otra pestaña el `ataque.html` de la guía (un formulario oculto con `action` apuntando a `http://localhost:8080/api/pedidos` que se envía solo). En la versión vulnerable el pedido se creaba igual, aunque la petición viniera de otra página.
- **Por qué ocurre:** la autenticación por cookie no distingue quién inició la petición. Si el servidor acepta una escritura con sólo la cookie `sid`, cualquier sitio que el usuario tenga abierto puede dispararla.
- **Cómo se corrige:** tres capas, en `src/middleware/csrf.ts` y `src/middleware/sesion.ts`:

  1. **Token por sesión** con `randomBytes(32).toString('hex')`, guardado en `Sesion.csrfToken` y entregado por `GET /api/csrf-token`. El cliente lo reenvía en `X-CSRF-Token`, en el campo `_csrf` o en `?_csrf=`. El servidor compara las tres copias (token recibido, cookie `csrf` y token de la sesión) con `timingSafeEqual`:

     ```ts
     const token = tokenDePeticion(req);
     const cookie = leerCookies(req).csrf || '';
     if (!iguales(token, cookie)) {
       res.status(403).json({ error: 'Token anti-CSRF inválido o ausente.' });
       return;
     }
     const sesion = obtenerSesion(req);
     if (sesion && !iguales(token, sesion.csrfToken)) { /* 403 */ }
     ```

  2. **Cookie `SameSite: lax`** en `sid` y en `csrf`, para que el navegador no las envíe en POST cross-site. Queda para la Práctica 5 agregar `HttpOnly` y `Secure` a `sid`.
  3. **Chequeo de `Origin`/`Referer`** contra el host de la petición, sólo cuando esas cabeceras están presentes (si faltan, decide el token). Un origen distinto se rechaza con `{"error":"Origen de la petición no permitido."}`.

  El middleware `verificarCsrf` se monta en `src/app.ts` justo después de los parsers de body y cubre todas las escrituras. Se exceptúa `/api/auth/login`: todavía no hay sesión y el login forzado no entrega al atacante una sesión; además queda cubierto por `SameSite` y por `Origin`. Los clientes (`app.js` y `admin.js`) cargan el token con `cargarCsrf()` y lo agregan como cabecera en todo POST/PUT/PATCH/DELETE. Tras el login se vuelve a cargar, porque cambia el token de la sesión.
- **Cómo se verifica:**
  - `npm run test:seguridad` → bloque *Seguridad · CSRF* **1/1**: `✔ existe un token anti-CSRF y las peticiones sin token se rechazan`. El test hace login, pide el token y comprueba que un POST a `/api/pedidos` sin token se rechaza mientras que con token funciona.
  - `npm run check:security` → `✔ CSRF-01`, `✔ CSRF-02`, `✔ CSRF-03` y `✔ CSRF-04`. El total pasó de 12/37 a **15/37** controles críticos; los 22 restantes son de las prácticas 4-6.
  - `npm test` → **28/28** en verde: los helpers de los tests funcionales ya enviaban el token, así que no hicieron falta cambios en tests.
  - Demo manual: sin token, `POST /api/pedidos` responde `403 {"error":"Token anti-CSRF inválido o ausente."}`; con el formulario legítimo del sitio el pedido se crea normalmente y el panel sigue pudiendo cambiar estados y roles.

## Reflexión de la práctica 3

CSRF se resuelve con una idea simple: una cookie prueba *qué sesión* es, pero no *quién* pidió la acción. Por eso hace falta un valor que el sitio legítimo sepa enviar y un sitio externo no pueda leer. El doble envío (cookie + cabecera) es barato y funciona sin estado extra; comparar también contra el token guardado en la sesión evita que un atacante que puede escribir una cookie fije su propio valor. `SameSite` y `Origin` no reemplazan al token: son defensa en profundidad para navegadores o casos donde el token se pierde.

Un detalle que se corrigió al iniciar la Práctica 4: el middleware global devolvía `403` antes de que corriera la lógica de las rutas, así que pruebas como `no se aceptan cantidades negativas` pasaban por falta de token en vez de por la validación. Ahora el token se exige **sólo cuando hay sesión** (`verificarCsrf` en `src/middleware/csrf.ts`), porque CSRF es el abuso de la sesión de la víctima: publicar una reseña o pedir un café ya son acciones públicas. Las rutas del panel siguen protegidas por `requiereSesion`. Los logs de la batería confirman que esos tests ahora responden `400 ErrorValidacion`.

## VUL-10 · Validación de entrada ausente en pedidos

- **Qué es y por qué importa:** el servicio de pedidos no valida tipo, rango ni longitud de `cantidad`, `mesa`, `cliente` ni de la lista de `items`. Se aceptan cantidades negativas (el total del pedido queda negativo, la cafetería le "paga" al cliente), textos como `"muchos"` (el total queda `NaN`), y cantidades desmesuradas (abuso de recursos / DoS).
- **Dónde está:** `src/services/pedidos.service.ts:41-64` (versión original): el bucle `for (const item of items)` usa `item.cantidad` sin validar que sea un entero positivo.
- **Cómo se observa:** `POST /api/pedidos` con `{"items":[{"productoId":4,"cantidad":-5}]}` devuelve un total negativo. Con `cantidad: "abc"` el total queda `NaN`.
- **Por qué ocurre:** TypeScript solo anota tipos en tiempo de compilación; en ejecución `req.body` puede tener cualquier forma. No hay validación del lado del servidor.
- **Cómo se corrige:** se valida en `src/routes/pedidos.routes.ts` **y** en `src/services/pedidos.service.ts` (defensa en profundidad), antes de calcular el total:

  ```ts
  const mesa = texto(cuerpo.mesa, 1, 20, 'mesa');
  const cliente = texto(cuerpo.cliente, 1, 80, 'cliente');
  const items = arrayNoVacio(cuerpo.items, 50, 'items').map((item) => {
    const renglon = item as Record<string, unknown>;
    return {
      productoId: idEntero(renglon.productoId, 'productoId'),
      cantidad: entero(renglon.cantidad, 1, 100, 'cantidad'),
    };
  });
  ```

  Los helpers viven en `src/validacion.ts` y lanzan `ErrorValidacion` (HTTP 400).
- **Cómo se verifica:** `npm run test:seguridad` → `✔ no se aceptan cantidades negativas` y `✔ no se aceptan cantidades no numéricas`. Los logs muestran `400 ErrorValidacion: El campo "cantidad" debe ser un entero entre 1 y 100`, es decir, la validación se ejecuta de verdad (antes estos tests pasaban por un `403` de CSRF).

## VUL-11 · Reseñas sin límites

- **Qué es y por qué importa:** `POST /api/comentarios` acepta `autor`, `texto` y `calificación` sin validar longitud ni rango. Se acepta una reseña de 50.000 caracteres, lo que además es el vehículo del XSS almacenado (VUL-07).
- **Dónde está:** `src/routes/comentarios.routes.ts:24` y `src/services/comentarios.service.ts:40` (versión original).
- **Cómo se observa:** publicar una reseña con `texto` de 5000 caracteres y `calificacion: 999`; el servidor la guarda tal cual.
- **Por qué ocurre:** no hay validación del lado del servidor; solo anotaciones de TypeScript que no se verifican en ejecución.
- **Cómo se corrige:** en la ruta y en el servicio, aplicar:
  ```ts
  const a = texto(autor, 2, 40, 'autor');
  const t = texto(textoComentario, 3, 280, 'texto').trim();
  const c = entero(calificacion, 1, 5, 'calificación');
  ```
  Los helpers `texto()` y `entero()` viven en `src/validacion.ts` y lanzan `ErrorValidacion` (HTTP 400) si fallan. En el servicio se renombró el parámetro a `textoComentario`: antes el parámetro tapaba al helper `texto()` y cualquier alta de reseña reventaba con un 500.
- **Cómo se verifica:** `npm run test:seguridad` → `✔ no se aceptan reseñas sin límite de longitud`; enviar una reseña de 5000 caracteres responde `400`. `npm run check:security` → `✔ XSS-04`.

## VUL-12 · Subida de archivos sin restricciones

- **Qué es y por qué importa:** el panel permite subir archivos sin validar extensión, tipo MIME real ni tamaño, y guarda el archivo con el nombre que envía el cliente (sin sanitizar "../"). Como los archivos se sirven con `express.static` desde el mismo origen, un `.html` con `<script>` se ejecuta como XSS almacenado en el dominio de la cafetería, y un nombre con `../../` puede escribir fuera de la carpeta `uploads/`.
- **Dónde está:** `src/routes/admin.routes.ts:180-196` (versión original): `fs.writeFileSync(path.join(config.uploadsDir, nombre), buffer)` sin ninguna validación.
- **Cómo se observa:** en el panel se sube un `.html` con `<script>alert(1)</script>`, se abre la URL devuelta y el script corre en el sitio. Con nombre `../../pwned.html` se intenta escribir fuera de `uploads/`.
- **Por qué ocurre:** no hay lista blanca de extensiones, no se verifica el magic number del archivo, no se limita el tamaño, y el nombre lo decide el cliente.
- **Cómo se corrige:** `src/routes/admin.routes.ts` conecta los helpers que ya existían en `src/validacion.ts`:

  ```ts
  const EXTENSIONES_IMAGEN = ['.png', '.jpg', '.jpeg', '.webp'];
  const TAMANO_MAXIMO = 2 * 1024 * 1024;

  const extension = validarExtension(path.extname(path.basename(nombre)), EXTENSIONES_IMAGEN);
  const buffer = Buffer.from(contenidoBase64, 'base64');
  validarTamaño(buffer.length, TAMANO_MAXIMO);
  validarMagicNumber(buffer, MIME_IMAGENES);

  const archivo = nombreArchivoSeguro(extension);
  const destino = path.resolve(config.uploadsDir, archivo);
  if (!destino.startsWith(path.resolve(config.uploadsDir) + path.sep)) {
    throw new ErrorValidacion('Ruta de destino no permitida.');
  }
  ```

  El tipo MIME se comprueba por *magic number* del buffer, no por el `Content-Type` que manda el cliente. El nombre lo genera el servidor, así que `../../pwned.html` nunca decide la ruta de escritura.
- **Cómo se verifica:** `npm run test:seguridad` → `✔ no se aceptan archivos ejecutables ni se escribe fuera de uploads`; los logs muestran `400 ErrorValidacion: Extensión no permitida: ".html"`. `check:security` → `✔ VAL-04` y `✔ VAL-05`.

## VUL-13 · Identificadores de ruta sin validar

- **Qué es y por qué importa:** los parámetros `:id` llegaban como texto a los servicios y se usaban directamente en consultas parametrizadas. Aunque no había inyección SQL, valores como `abc` o `1;DROP` llegaban hasta la base y provocaban errores 500 o respuestas engañosas.
- **Dónde está:** `src/routes/productos.routes.ts:53`, `src/routes/pedidos.routes.ts:50,66`, `src/routes/comentarios.routes.ts:46` y `src/routes/admin.routes.ts:58,85,102` (versión original).
- **Cómo se observa:** `GET /api/productos/abc` respondía 500 en vez de 400.
- **Por qué ocurre:** `Number(req.params.id)` devolvía `NaN` y ese valor llegaba a los servicios sin comprobación.
- **Por qué no se había detectado:** `check:security` daba `✔ VAL-01` porque `Number.isInteger` aparecía dentro de `src/validacion.ts`, pero **ninguna ruta lo usaba**. Era un falso verde del análisis estático.
- **Cómo se corrige:** `idEntero()` (entero positivo, `1..Number.MAX_SAFE_INTEGER`) se aplica en los siete puntos antes de llamar al servicio.
- **Cómo se verifica:** `npm run check:security` → `✔ VAL-01`, ahora por código ejecutado en las rutas; un `GET /api/productos/abc` responde 400 en vez de 500.

## VUL-14 · Stack trace filtrado al cliente

- **Qué es y por qué importa:** `src/middleware/errores.ts` respondía `{ error: err.message, stack: err.stack }`. La traza revela rutas internas, nombres de archivos, consultas SQL y versiones de librerías.
- **Dónde está:** `src/middleware/errores.ts:30` (versión original): `res.status(500).json({ error: err.message, stack: err.stack })`.
- **Cómo se observa:** una ruta inexistente o un id inválido devolvía un JSON con `stack` y rutas internas como `/app/src/...`.
- **Por qué ocurre:** el middleware enviaba el objeto `Error` completo al cliente en lugar de registrar los detalles y responder con un mensaje fijo.
- **Cómo se corrige:** los 4xx devuelven el mensaje de validación; los 5xx responden `{"error":"Error interno del servidor."}`. El objeto completo (con su traza) se registra con `console.error` en el servidor, nunca en la respuesta HTTP.
- **Cómo se verifica:** `npm run test:seguridad` → `✔ la API NO devuelve stack traces al cliente`; `check:security` → `✔ VAL-06`.
- **Equivalencia con la planilla del grupo:** este control corresponde a **VUL-24** (*Stack traces enviados al cliente*) en `VULNERABILIDADES.md`; en este informe se numeró VUL-14 por el orden de la práctica 4.

## Reflexión de la práctica 4

No confiar en el cliente: `type="number"`, `min` y `max` se cambian con el devtools, así que el servidor vuelve a comprobar tipo, longitud, rango y formato. Centralizar los helpers en `src/validacion.ts` evita validaciones distintas por ruta y `ErrorValidacion` separa entrada inválida (400) de fallo interno (500).

Dos detalles del estado inicial: `VAL-01` estaba en verde por una palabra clave en `src/validacion.ts` que ninguna ruta usaba, y varios tests pasaban por un `403` de CSRF en vez de por la validación. Mirar los logs evita esos falsos verdes. Los helpers de archivo sólo sirvieron una vez conectados a `admin.routes.ts`.

Resultado al cerrar la práctica 4: `check:security` **20/37**, *Validación de entrada* **4/4**, `npm test` **28/28** y `npm run test:seguridad` **20 pasos / 9 fallos** (prácticas 5 y 6). Tras la integración final: **37/37**, **29/29** y **28/28**.

---

## VUL-15 · Contraseñas almacenadas en texto plano

- **Qué es y por qué importa:** quien consiga la base (un backup, un volumen, un SQL injection) obtiene directamente todas las contraseñas, que además suelen reutilizarse en otros servicios.
- **Dónde está:** `src/inicializar.ts:21-52` (carga inicial con `password: 'admin'`, `'cliente'`, ...), `src/services/usuarios.service.ts:17-23` (`WHERE username = $1 AND password = $2`) y `:56-62` (`cambiarPassword` guardaba el texto recibido).
- **Cómo se observa:** `docker compose exec db psql -U postgres -d origen -c "SELECT username, password FROM usuarios;"` mostraba `admin | admin`, `cliente | cliente`, etc.
- **Por qué ocurre:** se comparaba y guardaba el valor exacto que mandaba el cliente; TypeScript no agrega ninguna protección en ejecución.
- **Cómo se corrige:** `bcrypt.hash(password, 12)` en la carga inicial, en `actualizar()` y en `cambiarPassword()`; `bcrypt.compare()` en el login. La base vieja se migra sola en el primer arranque: las 9 filas que no empezaban con `$2` se hashearon (`[semilla] 9 contraseña(s) migrada(s) a bcrypt.`).
- **Cómo se verifica:** `npm run test:seguridad` → `✔ las contraseñas NO se guardan en texto plano`; `check:security` → `✔ AUTH-01`, `✔ AUTH-02`, `✔ AUTH-03`.

## VUL-16 · Identificador de sesión predecible y sin regenerar

- **Qué es y por qué importa:** el id era `sesion_1`, `sesion_2`... Un atacante puede probar valores y usurpar la sesión de otro usuario. Además, al hacer login no se descartaba una sesión previa, lo que permite *fijación de sesión*: inducir al victim a entrar con un `sid` conocido por el atacante.
- **Dónde está:** `src/middleware/sesion.ts:31,50-53` (versión original): `contadorSesiones += 1; const id = \`sesion_${contadorSesiones}\`;`.
- **Cómo se observa:** dos logins seguidos daban `sid=sesion_1` y `sid=sesion_2`.
- **Por qué ocurre:** el generador usaba un contador en memoria y el login no descartaba una sesión previa, lo que además permitía fijación de sesión.
- **Cómo se corrige:** `randomBytes(32).toString('hex')` (64 caracteres) y `destruirSesion(req)` justo antes de `crearSesion()` en el login, para que la cookie impuesta por un tercero deje de existir.
- **Cómo se verifica:** `✔ el identificador de sesión es aleatorio y no predecible` (tres logins seguidos dan tres ids distintos); `✔ AUTH-07`, `✔ AUTH-08`.

## VUL-17 · Cookie de sesión sin banderas y sesiones eternas

- **Qué es y por qué importa:** sin `HttpOnly`, cualquier XSS lee el `sid`; sin `Secure`, la cookie viaja en texto plano; sin vencimiento, una cookie robada sirve para siempre. El logout original sólo borraba la cookie del navegador: la sesión seguía viva en el servidor.
- **Dónde está:** `src/middleware/sesion.ts:69-70` y `src/routes/auth.routes.ts:62-65` (versión original).
- **Cómo se observa:** el `Set-Cookie` no llevaba `HttpOnly`/`Secure`/`SameSite`, y después del logout el `sid` antiguo seguía vivo en el servidor.
- **Por qué ocurre:** la cookie se escribía con opciones por defecto y el `Map` de sesiones no se limpiaba al cerrar sesión.
- **Cómo se corrige:** la cookie `sid` lleva `HttpOnly`, `SameSite=Lax`, `Secure` cuando `NODE_ENV=production` y `Max-Age=900`. La sesión vence por inactividad (15 min) y por vida máxima (8 h); cada acceso renueva el TTL sin superar el límite absoluto. El logout llama a `destruirSesion(req)`, borra la entrada del `Map` y limpia las cookies. La cookie `csrf` sigue legible por JS porque el cliente debe reenviarla.
- **Cómo se verifica:** `✔ la cookie de sesión lleva HttpOnly, Secure y SameSite` y `✔ el logout invalida la sesión en el servidor`; `✔ AUTH-05`, `✔ AUTH-06`, `✔ AUTH-09`, `✔ AUTH-10`, `✔ AUTH-11`. En vivo, el `Set-Cookie` muestra `sid=<64 hex>; Max-Age=900; HttpOnly; SameSite=Lax`.

## VUL-18 · Fuerza bruta ilimitada en el login

- **Qué es y por qué importa:** se podían probar contraseñas sin límite. Los mensajes ya eran genéricos, pero el tiempo de respuesta distinto entre "usuario inexistente" y "contraseña incorrecta" permitía enumerar cuentas por *timing*.
- **Dónde está:** `src/routes/auth.routes.ts:18-54` (versión original): no había middleware de límite.
- **Cómo se observa:** probando varias veces a mano no había bloqueo; un usuario inexistente respondía distinto que uno existente con clave incorrecta, y el tiempo también variaba.
- **Por qué ocurre:** no existía límite de intentos y el código buscaba el usuario antes de comparar un hash, lo que cambiaba el tiempo de respuesta.
- **Cómo se corrige:** dos capas con `express-rate-limit`: 5 intentos fallidos por IP y 5 por cuenta en 15 minutos (429). `skipSuccessfulRequests: true` evita que los logins correctos consuman el cupo. Para igualar tiempos, cuando el usuario no existe se comparte la contraseña con un hash bcrypt señuelo.
- **Cómo se verifica:** `✔ el login bloquea o limita los intentos repetidos` y `✔ el login correcto sigue funcionando después de un bloqueo` (2/2 del bloque *Fuerza bruta*); `✔ AUTH-04`, `✔ AUTH-12`.

## VUL-19 · Falta de control de roles y escalada de privilegios

- **Qué es y por qué importa:** cualquier usuario autenticado, incluso con rol `cliente`, entraba al panel y podía crear/borrar productos, cambiar contraseñas, cambiar roles y ejecutar comandos en el servidor.
- **Dónde está:** `src/routes/admin.routes.ts:49`: estaba importado `requiereRol` pero no se usaba; `PUT /usuarios/:id` aceptaba `rol` del cuerpo sin verificar quién lo mandaba.
- **Cómo se observa:** con `cliente/cliente` se abría `/admin.html` y `PUT /api/admin/usuarios/:id` aceptaba `{"rol":"admin"}`.
- **Por qué ocurre:** el router exigía sesión pero no rol, y el cuerpo se copiaba a `cambios` sin lista blanca ni verificación del usuario autenticado.
- **Cómo se corrige:** `router.use(requiereRol('admin'))` para todo el panel y, además, `if (!req.usuario || req.usuario.rol !== 'admin')` antes de aceptar un cambio de `rol`, con lista blanca `admin|barista|mozo|cliente`. Contraseñas y nombres se validan con los helpers de la Práctica 4.
- **Cómo se verifica:** `✔ un usuario sin rol admin NO puede entrar al panel` y `✔ un usuario NO puede cambiar su propio rol a admin`; `✔ AUTH-14`, `✔ AUTH-15`. En vivo, un `cliente` recibe `403` en `GET /api/admin/usuarios`.

## VUL-20 · Credenciales triviales de fábrica

- **Qué es y por qué importa:** `admin/admin` y `cliente/cliente` son las primeras combinaciones que prueba cualquier escáner. Estaban además en `src/config.ts` y en el propio `admin.html`.
- **Dónde está:** `src/config.ts:36-39` y `src/inicializar.ts:23-48` (versión original); también el cartel de `src/public/admin.html`.
- **Cómo se observa:** entrar al panel con `admin/admin` y `cliente/cliente`.
- **Por qué ocurre:** la carga inicial fijaba contraseñas conocidas y la configuración las versionaba como valores por defecto.
- **Cómo se corrige:** se eliminó `credencialesPorDefecto` de la configuración. La carga inicial lee `SEED_ADMIN_PASSWORD`, `SEED_CLIENTE_PASSWORD`, etc.; si no están definidas, genera una contraseña aleatoria por cuenta y la muestra **una sola vez** en el log del servidor. En la base ya existente se conservaron las contraseñas anteriores, pero hasheadas, para no romper la demo. Para la demostración local se definen `SEED_*_PASSWORD` en `docker-compose.yml` con las credenciales de la guía; en producción deben generarse aleatoriamente o forzarse a cambiar. El cartel del panel ya no publica contraseñas.
- **Cómo se verifica:** `check:security` → `✔ AUTH-13` (control recomendado).

## Reflexión de la práctica 5

Autenticar es más que comparar usuario y contraseña: hay que cuidar el hash, el id de sesión, su duración, su destrucción y los roles. El rate limiting fue lo más delicado: el contador vive en memoria, así que un límite mal puesto bloqueaba el resto de la suite; `skipSuccessfulRequests` y un cupo por cuenta además del de IP resolvieron eso.

Un detalle sutil: con mensajes genéricos, un usuario inexistente respondía antes que uno con contraseña incorrecta. El hash señuelo iguala el tiempo. Rotar la cookie `csrf` en cada login obligó a confirmar que el doble envío seguía funcionando.

Resultado al cerrar la práctica 5: `check:security` **31/37**, *Autenticación* **6/6**, *Login* **3/3**, *Fuerza bruta* **2/2**, `npm test` **28/28** y `npm run test:seguridad` **26 pasos / 3 fallos** (comandos y diagnóstico). `CFG-05` se cubrió en la integración final.

## CMD-01/02/03 · Inyección de comandos

- **Qué es y por qué importa:** `exec(\`ping -c 3 ${host}\`)` pasaba la entrada por `/bin/sh -c`; `;`, `&&` o `$()` ejecutaban comandos arbitrarios dentro del contenedor.
- **Dónde está:** `src/routes/admin.routes.ts:171` (versión original): `exec(\`ping -c 3 ${host}\`)`.
- **Cómo se observa:** en "Probar conexión", `127.0.0.1; cat /etc/hostname` devolvía el contenido del archivo junto con el ping.
- **Por qué ocurre:** `exec` invoca `/bin/sh -c`, así que los operadores del shell se interpretan como parte del comando.
- **Cómo se corrige:** `HOSTS_PERMITIDOS = ['127.0.0.1', 'proveedor.origen.com']` y `spawn('ping', ['-c', '3', host], { shell: false })`. Fuera de la lista: `400`.
- **Cómo se verifica:** `check:security` → `✔ CMD-01`, `✔ CMD-02`, `✔ CMD-03` y `✔ AUTH-14`; `test:seguridad` → 2/2 en inyección de comandos. El payload `127.0.0.1; echo INYECCION_DETECTADA` ya no devuelve el marcador.

## VUL-23 · Diagnóstico sin autenticar y con `process.env` expuesto

- **Qué es y por qué importa:** `GET /api/_diagnostico` devolvía `process.env` completo, incluida `DB_PASSWORD`, sin exigir sesión.
- **Dónde está:** `src/routes/debug.routes.ts:17-28` (versión original).
- **Cómo se observa:** `curl http://localhost:8080/api/_diagnostico` devolvía `DB_PASSWORD` y otras variables sin autenticación.
- **Por qué ocurre:** el handler serializaba `process.env` y el router no aplicaba `requiereSesion` ni `requiereRol('admin')`.
- **Cómo se corrige:** `router.use(requiereSesion, requiereRol('admin'))` y una respuesta sólo con `process.version`, `platform`, `arch`, `memoryUsage()`, `uptime()` y `pid`. El archivo se conserva porque el checklist lo busca.
- **Cómo se verifica:** sin sesión responde `401`; con sesión admin, `200` y sin secretos. `✔ CFG-03`, `✔ CFG-04` y `✔ el endpoint de diagnóstico NO expone secretos`.

## VUL-25 · Cabeceras de seguridad y CSP

- **Qué es y por qué importa:** son cabeceras HTTP que reducen el impacto de XSS y de intentos de incrustar la app en un iframe ajeno. La CSP es la segunda capa, después de no usar `innerHTML` y de validar entradas.
- **Dónde está:** `src/app.ts:26-27` (versión original), sin `helmet`.
- **Cómo se observa:** `curl -I http://localhost:8080/` no mostraba `Content-Security-Policy` ni `X-Frame-Options`.
- **Por qué ocurre:** Express no habilita estas cabeceras por defecto.
- **Cómo se corrige:** `helmet({ contentSecurityPolicy: {...} })` en `src/app.ts`: `default-src 'self'`, `script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'` e `img-src 'self' data:`. `upgradeInsecureRequests: null` porque la demo corre por HTTP en `localhost`.
- **Cómo se verifica:** `✔ CFG-01`, `✔ XSS-03` y `✔ el sitio envía cabeceras de seguridad`.

## VUL-27 · Secretos y credenciales escritos en el código

- **Qué es y por qué importa:** `src/config.ts` tenía `sessionSecret: 'origen-cafe-2024'`, `DB_USER`/`DB_PASSWORD || 'postgres'` y un bloque `credencialesPorDefecto`.
- **Dónde está:** `src/config.ts` (versión original): `sessionSecret: 'origen-cafe-2024'`, `DB_USER`/`DB_PASSWORD || 'postgres'` y `credencialesPorDefecto`.
- **Cómo se observa:** `git grep -n "sessionSecret: '\|postgres" src/config.ts` mostraba esos valores fijos.
- **Por qué ocurre:** la configuración mezclaba valores de despliegue con el código fuente, así que cualquiera con acceso al repositorio conocía el secreto y las credenciales.
- **Cómo se corrige:** todo se lee de `process.env`. En development, si falta `SESSION_SECRET`, se genera un valor efímero con `randomBytes(32)`; en production, su ausencia (o la de `DB_USER`/`DB_PASSWORD`) produce error de arranque. `DB_USER` no tiene valor fijo en el código: `origen_app` queda en `.env.example` y en el despliegue. `docker-compose.yml` sí se ajustó en VUL-26 (sin `trust` y con el usuario `origen_app`), y además define las credenciales de demostración vía `SEED_*_PASSWORD`. Se eliminó `credencialesPorDefecto`.
- **Cómo se verifica:** `✔ CFG-02` y `✔ SQLI-05`. `git grep -n "sessionSecret: '\|origen-cafe" src/config.ts` no devuelve resultados.

## CFG-05 · Contenedor ejecutado como usuario no root

- **Qué es y por qué importa:** el proceso de la aplicación corría con `uid=0`; si la app se compromete, el atacante hereda root dentro del contenedor.
- **Dónde está:** `Dockerfile` (versión original), sin `USER node` ni `chown` de `/app/uploads`.
- **Cómo se observa:** `docker compose exec app id` devolvía `uid=0(root)`.
- **Por qué ocurre:** la imagen de Node corre como root por defecto y el directorio de subidas pertenecía a root.
- **Cómo se corrige:** `RUN mkdir -p /app/uploads && chown -R node:node /app/uploads` y `USER node` en el `Dockerfile`.
- **Cómo se verifica:** `docker compose exec app id` → `uid=1000(node) gid=1000(node) groups=1000(node)`. La subida de archivos sigue pasando. Era un control recomendado y quedó cubierto.

## Mapa de numeración entre `INFORME.md` y `VULNERABILIDADES.md`

El informe usa la numeración en que se trabajaron las prácticas; el catálogo usa otra. Equivalencias que no son 1:1:

| `VULNERABILIDADES.md` | `INFORME.md` |
|---|---|
| VUL-05, VUL-06 | VUL-05 |
| VUL-07 | VUL-06 |
| VUL-08 | VUL-07 |
| VUL-09 | VUL-08 |
| VUL-13 | VUL-15 |
| VUL-14 | VUL-18 |
| VUL-15, VUL-17, VUL-18 | VUL-17 |
| VUL-16 | VUL-16 |
| VUL-19 | VUL-18 |
| VUL-20, VUL-21 | VUL-19 |
| VUL-22 | CMD-01/02/03 |
| VUL-24 | VUL-14 |
| VUL-25 | VUL-25 y VUL-23 (parcial) |
| VUL-27 | VUL-20 y VUL-27 |

El resto (`VUL-01..04`, `VUL-10..12`, `VUL-23`, `VUL-26`) coincide.

## Integración y verificación final

Integración cerrada sobre `dev` (PR #8 de autenticación y PR #9 de validación de ids). No se integró `fix/auth-sesiones`: reintroducía secretos fijos y publicaba el puerto de PostgreSQL en `docker-compose.yml`. Los conflictos de `src/config.ts` y `src/routes/admin.routes.ts` se resolvieron conservando la configuración env-based, el `spawn(...)` sin shell y la validación de roles y contraseñas de la práctica 5.

Batería final dentro del contenedor:

```text
$ docker compose exec app npm run typecheck      → sin errores
$ docker compose exec app npm run check:security → ✔ 37/37, sin recomendados pendientes
$ docker compose exec app npm run test:seguridad → tests 29 / pass 29 / fail 0
$ docker compose exec app npm test               → tests 28 / pass 28 / fail 0
```

Los `[error] 400 ErrorValidacion` y el `500 TypeError` de `calcularPrecio` son payloads adversarios esperados: la API responde sin stack trace (`✔ la API NO devuelve stack traces al cliente`, VUL-24). El bloque de fuerza bruta tarda unos segundos por el rate limiting deliberado.

### Reflexión de la práctica 6

La configuración es código: un secreto versionado o un `USER root` son tan explotables como una consulta interpolada. Estos controles no se ven en el flujo feliz, por eso hicieron falta el checklist, la revisión del `Dockerfile`/`docker-compose.yml` y una pasada final con los cuatro comandos. Un ✔ aislado no alcanza: `CFG-02` mira sólo `config.ts`, `CFG-03/04` sólo `debug.routes.ts` y `CFG-01` ya venía de XSS. Resultado: **37/37**, **29/29** y **28/28**, con `docker-compose.yml` intacto.