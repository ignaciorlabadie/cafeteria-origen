import express from 'express';
import * as pedidos from '../services/pedidos.service';
import { texto, entero, arrayNoVacio, idEntero } from '../validacion';

const router = express.Router();

/**
 * POST /api/pedidos
 * Crea un pedido y devuelve su total calculado.
 *
 * CSRF: cubierto por el middleware global `verificarCsrf` cuando hay sesión
 * (token + SameSite + Origin/Referer).
 *
 * Validación de entrada (Práctica 4): tipo, rango y longitud de `cantidad`,
 * `mesa`, `cliente`, `productoId` y de la lista de items. El servicio vuelve
 * a validar por defensa en profundidad.
 *
 * FALLA (Práctica 5): no requiere autenticación ni rol.
 */
router.post('/', async (req, res, next) => {
  try {
    const cuerpo = req.body || {};
    const mesa = texto(cuerpo.mesa, 1, 20, 'mesa');
    const cliente = texto(cuerpo.cliente, 1, 80, 'cliente');
    const items = arrayNoVacio(cuerpo.items, 50, 'items').map((item) => {
      const renglon = item as Record<string, unknown>;
      return {
        productoId: idEntero(renglon.productoId, 'productoId'),
        cantidad: entero(renglon.cantidad, 1, 100, 'cantidad'),
      };
    });

    const pedido = await pedidos.crear({ mesa, cliente, items });
    res.status(201).json(pedido);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/pedidos?mesa=
 * Lista los pedidos de todas las mesas.
 *
 * FALLA — Inyección SQL en el filtro de mesa.
 * FALLA — Autorización: cualquier visitante puede ver los pedidos de TODAS
 * las mesas (los datos de los clientes de los demás).
 */
router.get('/', async (req, res, next) => {
  try {
    res.json({ pedidos: await pedidos.listar(req.query.mesa as string | undefined) });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/pedidos/:id
 * FALLA — IDOR: no se verifica que el pedido pertenezca al usuario que pregunta.
 */
router.get('/:id', async (req, res, next) => {
  try {
    const pedido = await pedidos.obtenerConItems(idEntero(req.params.id));
    if (!pedido) {
      return res.status(404).json({ error: 'Pedido no encontrado.' });
    }
    res.json(pedido);
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/pedidos/:id/estado */
router.patch('/:id/estado', async (req, res, next) => {
  try {
    const { estado } = req.body || {};
    // FALLA: no se valida el valor de `estado` ni se comprueba el rol del
    // que modifica el pedido (Práctica 5).
    const pedido = await pedidos.cambiarEstado(idEntero(req.params.id), estado);
    if (!pedido) {
      return res.status(404).json({ error: 'Pedido no encontrado.' });
    }
    res.json(pedido);
  } catch (err) {
    next(err);
  }
});

export default router;
