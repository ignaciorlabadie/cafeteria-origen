import * as db from '../db';
import { calcularPrecio, PRECIO_POR_GRAMO } from '../catalogo';
import type { DatosProducto, Producto, ProductoConPrecio } from '../tipos';

/** Filtros del menú, tal como llegan en la query string. */
export interface FiltrosCatalogo {
  tipo?: string;
  variedad?: string;
  q?: string;
}

/** Datos que manda el panel de administración al crear o editar. */
export type DatosProductoEntrada = Partial<DatosProducto> & { activo?: boolean };

/** Id tal como llega en la URL (texto) o ya convertido. */
type Id = number | string;

const TIPOS_VALIDOS: string[] = ['espresso', 'filtrado', 'pasteleria'];
const VARIEDADES_VALIDAS: string[] = Object.keys(PRECIO_POR_GRAMO);

/** Lista productos aplicando los filtros del menú. */
export async function listar(filtros: FiltrosCatalogo = {}): Promise<ProductoConPrecio[]> {
  const { tipo, variedad, q } = filtros;

  if (tipo && !TIPOS_VALIDOS.includes(tipo)) return [];
  if (variedad && !VARIEDADES_VALIDAS.includes(variedad)) return [];

  const condiciones = ['activo = true'];
  const valores: unknown[] = [];

  if (tipo) {
    valores.push(tipo);
    condiciones.push('tipo = $' + valores.length);
  }
  if (variedad) {
    valores.push(variedad);
    condiciones.push('variedad = $' + valores.length);
  }
  if (q) {
    const patron = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
    valores.push(patron);
    const marcador = '$' + valores.length;
    const escape = " ESCAPE '\\'";
    condiciones.push(
      '(nombre ILIKE ' + marcador + escape + ' OR descripcion ILIKE ' + marcador + escape + ')'
    );
  }

  const sql =
    'SELECT * FROM productos WHERE ' + condiciones.join(' AND ') +
    ' ORDER BY tipo, variedad NULLS FIRST, id';

  const { rows } = await db.query<Producto>(sql, valores);

  return rows.map((p) => ({ ...p, precio: calcularPrecio(p) }));
}

/** Obtiene un producto por id. */
export async function obtener(id: Id): Promise<ProductoConPrecio | null> {
  const idNumerico = Number(id);
  if (!Number.isInteger(idNumerico) || idNumerico <= 0) return null;

  const { rows } = await db.query<Producto>('SELECT * FROM productos WHERE id = $1', [idNumerico]);
  if (!rows[0]) return null;
  return { ...rows[0], precio: calcularPrecio(rows[0]) };
}

/** Crea un producto nuevo. */
export async function crear(datos: DatosProductoEntrada): Promise<Producto> {
  const { rows } = await db.query<Producto>(
    `INSERT INTO productos (nombre, tipo, variedad, tamano, gramos, precio_base, precio_por_gramo, descripcion)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      datos.nombre,
      datos.tipo,
      datos.variedad || null,
      datos.tamano || null,
      datos.gramos ?? null,
      datos.precio_base ?? 0,
      datos.precio_por_gramo ?? 0,
      datos.descripcion || '',
    ]
  );
  return rows[0];
}

/** Actualiza un producto. */
export async function actualizar(id: Id, datos: DatosProductoEntrada): Promise<Producto | null> {
  const { rows } = await db.query<Producto>(
    `UPDATE productos
        SET nombre = $1, tipo = $2, variedad = $3, tamano = $4, gramos = $5,
            precio_base = $6, precio_por_gramo = $7, descripcion = $8, activo = $9
      WHERE id = $10
      RETURNING *`,
    [
      datos.nombre,
      datos.tipo,
      datos.variedad || null,
      datos.tamano || null,
      datos.gramos ?? null,
      datos.precio_base ?? 0,
      datos.precio_por_gramo ?? 0,
      datos.descripcion || '',
      datos.activo !== false,
      id,
    ]
  );
  return rows[0] || null;
}

/** Elimina (desactiva) un producto. */
export async function eliminar(id: Id): Promise<Producto | null> {
  const { rows } = await db.query<Producto>(
    'UPDATE productos SET activo = false WHERE id = $1 RETURNING *',
    [id]
  );
  return rows[0] || null;
}

/** Lista las variedades disponibles en el catálogo. */
export async function variedades(): Promise<string[]> {
  const { rows } = await db.query<{ variedad: string }>(
    "SELECT DISTINCT variedad FROM productos WHERE variedad IS NOT NULL ORDER BY variedad"
  );
  return rows.map((r) => r.variedad);
}
