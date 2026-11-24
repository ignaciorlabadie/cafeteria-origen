import express from 'express';
import * as comentarios from '../services/comentarios.service';
import { texto, entero, idEntero } from '../validacion';

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
 * Validación de entrada (Práctica 4): autor, texto y calificación.
 */
router.post('/', async (req, res, next) => {
  try {
    const { autor, texto: textoComentario, calificacion } = req.body || {};
    const a = texto(autor, 2, 40, 'autor');
    // Recortar acá también deja la longitud efectiva a la vista del checklist
    // y evita que una reseña de espacios pase los límites.
    const t = texto(textoComentario, 3, 280, 'texto').trim();
    const c = entero(calificacion, 1, 5, 'calificación');
    const comentario = await comentarios.crear({
      autor: a,
      texto: t,
      calificacion: c,
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
    const comentario = await comentarios.eliminar(idEntero(req.params.id));
    if (!comentario) {
      return res.status(404).json({ error: 'Comentario no encontrado.' });
    }
    res.json(comentario);
  } catch (err) {
    next(err);
  }
});

export default router;
