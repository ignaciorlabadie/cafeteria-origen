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
