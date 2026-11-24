import express from 'express';
import rateLimit from 'express-rate-limit';
import * as usuarios from '../services/usuarios.service';
import { crearSesion, destruirSesion, obtenerSesion } from '../middleware/sesion';

const router = express.Router();

/**
 * Rate limiting sobre el login para mitigar fuerza bruta (VUL-14).
 * Máximo 5 intentos fallidos por IP cada 15 minutos.
 * Los intentos exitosos no cuentan hacia el límite.
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5,
  skipSuccessfulRequests: true,
  message: { error: 'Demasiados intentos de inicio de sesión. Intentá de nuevo más tarde.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Inicio de sesión.
 *
 * FALLAS:
 *  - Inyección SQL en la verificación de credenciales (ver usuarios.service).
 *  - Contraseñas almacenadas en texto plano.
 *  - Sin rate limiting ni bloqueo: fuerza bruta ilimitada.
 *  - El identificador de sesión no se regenera (fijación de sesión).
 *
 * XSS: el mensaje de error es genérico y no refleja lo que envió el cliente.
 */
router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: 'Falta usuario o contraseña.' });
    }

    const usuario = await usuarios.autenticar(username, password);

    if (!usuario) {
      // Mensaje genérico: no distingue entre usuario inexistente y contraseña
      // incorrecta, para evitar enumeración de usuarios (VUL-19).
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    }

    // Regenerar identificador de sesión al iniciar sesión: destruir cualquier
    // sesión previa asociada a la cookie antes de crear la nueva, evitando
    // fijación de sesión (session fixation) (VUL-16).
    destruirSesion(req);

    crearSesion(req, res, {
      id: usuario.id,
      username: usuario.username,
      rol: usuario.rol,
      nombre: usuario.nombre,
    });

    res.json({
      mensaje: 'Inicio de sesión correcto.',
      usuario: {
        id: usuario.id,
        username: usuario.username,
        rol: usuario.rol,
        nombre: usuario.nombre,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Cierre de sesión.
 *
 * FALLA: sólo borra la cookie del navegador. La sesión sigue existiendo en el
 * servidor, así que con la cookie robada se puede seguir usando.
 */
router.post('/logout', (req, res) => {
  // Invalidar la sesión en el servidor (borrar del almacén de sesiones), no
  // solo borrar la cookie del navegador (VUL-18).
  destruirSesion(req);
  res.clearCookie('sid', { path: '/' });
  res.clearCookie('csrf', { path: '/' });
  res.json({ mensaje: 'Sesión cerrada.' });
});

/** Devuelve el usuario de la sesión actual. */
router.get('/yo', (req, res) => {
  const sesion = obtenerSesion(req);
  if (!sesion) {
    return res.status(401).json({ error: 'Necesitás iniciar sesión.' });
  }
  res.json({ usuario: sesion.usuario });
});

export default router;
