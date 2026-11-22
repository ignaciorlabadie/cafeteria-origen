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

