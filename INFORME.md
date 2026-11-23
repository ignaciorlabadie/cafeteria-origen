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
- **Cómo se verifica:** `npm run test:seguridad` → bloque *Cross-Site Scripting* 3/3 en verde; `npm run check:security` → `✔ XSS-01`, `✔ XSS-02`. Además, con el login `<img src=x onerror=alert(1)>` la respuesta JSON no contiene `<img`.

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

  El límite de longitud del texto en el servidor (XSS-04) queda para la práctica de validación de entrada.
- **Cómo se verifica:** `npm run check:security` → `✔ XSS-01` (ningún `innerHTML` en `src/public/js`); recargar el sitio con una reseña que contenga HTML: se muestra como texto, sin alerts.

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

  Los HTML sólo cargan scripts externos (`/js/app.js`, `/js/admin.js`), así que `script-src 'self'` no rompe el sitio. Otros controles de configuración (secretos, diagnóstico, stack traces) siguen pendientes para la práctica 6.
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

Un detalle a corregir en la Práctica 5: el middleware global devuelve `403` antes de que corra la lógica de las rutas, así que algunas pruebas de las prácticas pendientes pasan "por el motivo equivocado" (por ejemplo, `no se aceptan cantidades negativas` recibe 403 por falta de token en vez de un 400 de validación). No se modificaron los tests; conviene revisar esos casos cuando se implementen validación y autorización para que el resultado verde signifique realmente lo que dice. La batería completa quedó en 19 pasos y 10 fallos, todos correspondientes a las Prácticas 4-6 (fuerza bruta, validación, sesiones, comandos y diagnóstico).

## VUL-10 · Validación de entrada ausente en pedidos

- **Qué es y por qué importa:** el servicio de pedidos no valida tipo, rango ni longitud de `cantidad`, `mesa`, `cliente` ni de la lista de `items`. Se aceptan cantidades negativas (el total del pedido queda negativo, la cafetería le "paga" al cliente), textos como `"muchos"` (el total queda `NaN`), y cantidades desmesuradas (abuso de recursos / DoS).
- **Dónde está:** `src/services/pedidos.service.ts:41-64` (versión original): el bucle `for (const item of items)` usa `item.cantidad` sin validar que sea un entero positivo.
- **Cómo se observa:** `POST /api/pedidos` con `{"items":[{"productoId":4,"cantidad":-5}]}` devuelve un total negativo. Con `cantidad: "abc"` el total queda `NaN`.
- **Por qué ocurre:** TypeScript solo anota tipos en tiempo de compilación; en ejecución `req.body` puede tener cualquier forma. No hay validación del lado del servidor.
- **Cómo se corrige:** aplicar `entero(cantidad, 1, MAX, 'cantidad')` y `texto(mesa, 1, 20, 'mesa')` etc. en el servidor antes de calcular el total. Los helpers reutilizables están en `src/validacion.ts`.
- **Cómo se verifica:** `npm run test:seguridad` → `✔ no se aceptan cantidades negativas` y `✔ no se aceptan cantidades no numéricas`.
- **Estado:** identificado; la corrección de `pedidos.service.ts` queda para una rama separada (no está en el alcance de esta rama).

## VUL-11 · Reseñas sin límites

- **Qué es y por qué importa:** `POST /api/comentarios` acepta `autor`, `texto` y `calificación` sin validar longitud ni rango. Se acepta una reseña de 50.000 caracteres, lo que además es el vehículo del XSS almacenado (VUL-07).
- **Dónde está:** `src/routes/comentarios.routes.ts:24` y `src/services/comentarios.service.ts:40` (versión original).
- **Cómo se observa:** publicar una reseña con `texto` de 5000 caracteres y `calificacion: 999`; el servidor la guarda tal cual.
- **Por qué ocurre:** no hay validación del lado del servidor; solo anotaciones de TypeScript que no se verifican en ejecución.
- **Cómo se corrige:** en la ruta y en el servicio, aplicar:
  ```ts
  const a = texto(autor, 2, 40, 'autor');
  const t = texto(texto, 3, 280, 'texto');
  const c = entero(calificacion, 1, 5, 'calificación');
  ```
  Los helpers `texto()` y `entero()` viven en `src/validacion.ts` y lanzan `ErrorValidacion` (HTTP 400) si fallan.
- **Cómo se verifica:** `npm run test:seguridad` → `✔ no se aceptan reseñas sin límite de longitud`; enviar una reseña de 5000 caracteres responde 4xx.

## VUL-12 · Subida de archivos sin restricciones

- **Qué es y por qué importa:** el panel permite subir archivos sin validar extensión, tipo MIME real ni tamaño, y guarda el archivo con el nombre que envía el cliente (sin sanitizar "../"). Como los archivos se sirven con `express.static` desde el mismo origen, un `.html` con `<script>` se ejecuta como XSS almacenado en el dominio de la cafetería, y un nombre con `../../` puede escribir fuera de la carpeta `uploads/`.
- **Dónde está:** `src/routes/admin.routes.ts:180-196` (versión original): `fs.writeFileSync(path.join(config.uploadsDir, nombre), buffer)` sin ninguna validación.
- **Cómo se observa:** en el panel se sube un `.html` con `<script>alert(1)</script>`, se abre la URL devuelta y el script corre en el sitio. Con nombre `../../pwned.html` se intenta escribir fuera de `uploads/`.
- **Por qué ocurre:** no hay lista blanca de extensiones, no se verifica el magic number del archivo, no se limita el tamaño, y el nombre lo decide el cliente.
- **Cómo se corrige:** validar extensión contra lista blanca (`.png`, `.jpg`, `.webp`), verificar el magic number del buffer, limitar el tamaño, y generar un nombre aleatorio con `crypto.randomUUID()` en el servidor. Los helpers reutilizables para esta tarea están en `src/validacion.ts` (`validarExtension`, `validarMagicNumber`, `validarTamaño`, `nombreArchivoSeguro`) y se entregan a Juan para que los use en `admin.routes.ts`.
- **Cómo se verifica:** `npm run test:seguridad` → `✔ no se aceptan archivos ejecutables ni se escribe fuera de uploads`; subir un `.html` o hacer path traversal responde 4xx y no escribe fuera de `uploads/`.
- **Estado:** identificado; la corrección de `admin.routes.ts` la implementa Juan en su rama (no está en el alcance de esta rama).

