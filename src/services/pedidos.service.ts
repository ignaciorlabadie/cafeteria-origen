import * as db from '../db';
import { calcularPrecio } from '../catalogo';
import { texto, entero, arrayNoVacio, idEntero } from '../validacion';
import type { Pedido, PedidoConItems, PedidoItem, Producto } from '../tipos';

/** Un renglón del pedido, tal como llega en el cuerpo de la petición. */
export interface ItemPedido {
  productoId: number;
  cantidad: number;
}

/** Pedido nuevo, tal como llega en el cuerpo de la petición. */
export interface NuevoPedido {
  mesa: string;
  cliente: string;
  items: ItemPedido[];
}

/** Id tal como llega en la URL (texto) o ya convertido. */
type Id = number | string;

/**
 * Servicio de pedidos.
 *
 * Práctica 4: se valida de nuevo acá, aunque la ruta ya lo haga, porque el
 * servicio puede ser llamado desde otros lugares. Tipo (entero), rango
 * (1..100), longitud (mesa/cliente) y formato (array de 1..50 items).
 */

/**
 * Crea un pedido a partir de una lista de items { productoId, cantidad }.
 * Total = suma de calcularPrecio(producto) x cantidad
 */
export async function crear({ mesa, cliente, items }: NuevoPedido): Promise<PedidoConItems | null> {
  // Los tipos de `NuevoPedido` NO alcanzan: en ejecución puede llegar
  // cualquier cosa, así que se valida antes de calcular el total.
  const m = texto(mesa, 1, 20, 'mesa');
  const c = texto(cliente, 1, 80, 'cliente');
  const renglones = arrayNoVacio(items, 50, 'items').map((item) => {
    const renglon = item as Record<string, unknown>;
    return {
      productoId: idEntero(renglon.productoId, 'productoId'),
      cantidad: entero(renglon.cantidad, 1, 100, 'cantidad'),
    };
  });

  const filas: { productoId: number; cantidad: number; precioUnitario: number }[] = [];

  for (const item of renglones) {
    // Si el producto no existe, el error 500 ya no filtra su traza: el
    // manejador global responde con un mensaje genérico.
    const producto = await buscarProducto(item.productoId);
    const precioUnitario = calcularPrecio(producto);
    filas.push({
      productoId: producto.id,
      cantidad: item.cantidad,
      precioUnitario,
    });
  }

  const total = filas.reduce(
    (acc, f) => acc + f.precioUnitario * f.cantidad,
    0
  );

  const { rows } = await db.query<Pedido>(
    `INSERT INTO pedidos (mesa, cliente, estado, total)
     VALUES ($1, $2, 'abierto', $3)
     RETURNING *`,
    [m, c, total]
  );
  const pedido = rows[0];

  for (const fila of filas) {
    await db.query(
      `INSERT INTO pedido_items (pedido_id, producto_id, cantidad, precio_unitario)
       VALUES ($1, $2, $3, $4)`,
      [pedido.id, fila.productoId, fila.cantidad, fila.precioUnitario]
    );
  }

  return obtenerConItems(pedido.id);
}

/** Busca un producto por id (helper interno). */
async function buscarProducto(productoId: number): Promise<Producto> {
  const { rows } = await db.query<Producto>('SELECT * FROM productos WHERE id = $1', [productoId]);
  return rows[0];
}

/** Lista pedidos (con filtro opcional por mesa). */
export async function listar(mesa?: string): Promise<Pedido[]> {
  let sql = 'SELECT * FROM pedidos';
  const valores: unknown[] = [];
  if (mesa) {
    valores.push(mesa);
    sql += ' WHERE mesa = $1';
  }
  sql += ' ORDER BY id DESC';

  const { rows } = await db.query<Pedido>(sql, valores);
  return rows;
}

/** Devuelve un pedido con sus items. */
export async function obtenerConItems(id: Id): Promise<PedidoConItems | null> {
  const { rows: pedidos } = await db.query<Pedido>(
    'SELECT * FROM pedidos WHERE id = $1',
    [id]
  );
  const pedido = pedidos[0];
  if (!pedido) return null;

  const { rows: items } = await db.query<PedidoItem>(
    `SELECT pi.*, pr.nombre AS producto_nombre
       FROM pedido_items pi
       JOIN productos pr ON pr.id = pi.producto_id
      WHERE pi.pedido_id = $1`,
    [id]
  );

  return { ...pedido, items };
}

/** Cambia el estado de un pedido. */
export async function cambiarEstado(id: Id, estado: string): Promise<Pedido | null> {
  const { rows } = await db.query<Pedido>(
    'UPDATE pedidos SET estado = $1 WHERE id = $2 RETURNING *',
    [estado, id]
  );
  return rows[0] || null;
}
