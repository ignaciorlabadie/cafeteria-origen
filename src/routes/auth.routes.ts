import express from 'express';
import rateLimit from 'express-rate-limit';
import type { NextFunction, Request, Response } from 'express';

import * as usuarios from '../services/usuarios.service';
import { crearSesion, destruirSesion, obtenerSesion } from '../middleware/sesion';
import { texto } from '../validacion';

const router = express.Router();

const VENTANA = 15 * 60 * 1000;
const MAXIMO_INTENTOS = 5;
const MENSAJE_BLOQUEO = {
  error: 'Demasiados intentos de inicio de sesión. Probá de nuevo más tarde.',
};

/**
 * Capa 1: límite por IP. Sólo cuentan las respuestas fallidas (401/400), para
 * que los logins correctos de los tests y del panel no consuman el cupo.
 */
const limitePorIp = rateLimit({
  windowMs: VENTANA,
  limit: MAXIMO_INTENTOS,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: MENSAJE_BLOQUEO,
});

/**
 * Capa 2: límite por cuenta. Si el atacante reparte intentos entre varias IPs,
 * la cuenta objetivo sigue bloqueándose; si ataca varias cuentas desde una IP,
 * lo cubre el límite por IP.
 */
type RegistroCuenta = { fallos: number; bloqueadoHasta: number };
const intentosPorCuenta = new Map<string, RegistroCuenta>();

function cuentaDe(req: Request): string {
  const username = req.body?.username;
  return typeof username === 'string' ? username.trim().toLowerCase() : '';
}

function cuentaBloqueada(cuenta: string): boolean {
  if (!cuenta) return false;
  const registro = intentosPorCuenta.get(cuenta);
  if (!registro) return false;
  if (registro.bloqueadoHasta > Date.now()) return true;
  intentosPorCuenta.delete(cuenta);
  return false;
}

function registrarFallo(cuenta: string): void {
  if (!cuenta) return;
  const registro = intentosPorCuenta.get(cuenta) || { fallos: 0, bloqueadoHasta: 0 };
  registro.fallos += 1;
  if (registro.fallos >= MAXIMO_INTENTOS) {
    registro.bloqueadoHasta = Date.now() + VENTANA;
  }
  intentosPorCuenta.set(cuenta, registro);
}

function reiniciarFallos(cuenta: string): void {
  if (cuenta) intentosPorCuenta.delete(cuenta);
}

function limitePorCuenta(req: Request, res: Response, next: NextFunction): void {
  if (cuentaBloqueada(cuentaDe(req))) {
    res.status(429).json(MENSAJE_BLOQUEO);
    return;
  }
  next();
}

/**
 * Inicio de sesión.
 *
 * - Contraseñas hasheadas con bcrypt (ver services/usuarios.service.ts).
 * - Rate limiting por IP y por cuenta.
 * - Mensaje genérico: no distingue usuario inexistente de contraseña errónea.
 * - Se descarta cualquier sesión previa antes de crear la nueva (fijación).
 * - XSS: el mensaje de error no refleja lo que mandó el cliente.
 */
router.post('/login', limitePorIp, limitePorCuenta, async (req, res, next) => {
  try {
    const username = texto(req.body?.username, 1, 80, 'usuario');
    const password = texto(req.body?.password, 1, 200, 'contraseña');
    const cuenta = cuentaDe(req);

    const usuario = await usuarios.autenticar(username, password);

    if (!usuario) {
      registrarFallo(cuenta);
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    }

    reiniciarFallos(cuenta);

    // Regeneración del identificador: si veníamos con una cookie impuesta por
    // un atacante, esa sesión se destruye y se emite un sid nuevo.
    destruirSesion(req);
    crearSesion(req, res, {
      id: usuario.id,
      username: usuario.username,
      rol: usuario.rol,
      nombre: usuario.nombre,
    });

    res.json({
      mensaje: `¡Bienvenido, ${usuario.nombre}!`,
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
 * Cierre de sesión: se borra la sesión del almacén del servidor y las cookies
 * del navegador. Con la cookie vieja ya no se puede reanudar la sesión.
 */
router.post('/logout', (req, res) => {
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
