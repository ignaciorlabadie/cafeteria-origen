import express from 'express';
import * as comentarios from '../services/comentarios.service';

const router = express.Router();

/**
 * GET /api/comentarios — reseñas públicas de la cafetería.
 * El sitio las pinta como texto (textContent), no como HTML.
 */
router.get('/', async (req, res, next) => {
  try {
    res.json({ comentarios: await comentarios.listar() });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/comentarios
 *
 * CSRF: cubierto por el middleware global `verificarCsrf`.
 *
 * FALLAS (Práctica 4): sin validación de longitud/rango ni de contenido.
 */
router.post('/', async (req, res, next) => {
  try {
    const { autor, texto, calificacion } = req.body || {};
    const comentario = await comentarios.crear({
      autor,
      texto,
      calificacion,
    });
    res.status(201).json(comentario);
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/comentarios/:id */
router.delete('/:id', async (req, res, next) => {
  try {
    // FALLA: sin verificación de rol — cualquiera puede borrar reseñas.
    const comentario = await comentarios.eliminar(req.params.id);
    if (!comentario) {
      return res.status(404).json({ error: 'Comentario no encontrado.' });
    }
    res.json(comentario);
  } catch (err) {
    next(err);
  }
});

export default router;
