/**
 * Gestión de sesiones.
 *
 * Práctica 5:
 *  1. El id se genera con `randomBytes(32)` (64 hex): no es un contador ni se
 *     puede adivinar. Se regenera en cada login desde `auth.routes.ts`.
 *  2. La cookie `sid` es HttpOnly, SameSite=lax y Secure en producción; la
 *     cookie `csrf` sigue siendo legible por JS (doble envío).
 *  3. Las sesiones vencen por inactividad y por vida máxima absoluta.
 *  4. El logout borra la sesión del almacén del servidor, no sólo la cookie.
 */

import { randomBytes } from 'crypto';
import type { Request, Response } from 'express';

import config from '../config';
import type { Sesion, UsuarioSesion } from '../tipos';

/** Sin actividad durante 15 minutos y como máximo 8 horas de sesión. */
export const TIEMPO_INACTIVIDAD = 15 * 60 * 1000;
export const TIEMPO_ABSOLUTO = 8 * 60 * 60 * 1000;

export const sesiones = new Map<string, Sesion>();

/** Lee las cookies de la petición (parser mínimo, sin dependencias). */
export function leerCookies(req: Request): Record<string, string> {
  const cookies: Record<string, string> = {};
  const header = req.headers.cookie;
  if (!header) return cookies;
  for (const parte of header.split(';')) {
    const separador = parte.indexOf('=');
    if (separador < 0) continue;
    const nombre = parte.slice(0, separador).trim();
    const valor = parte.slice(separador + 1).trim();
    if (nombre) cookies[nombre] = decodeURIComponent(valor);
  }
  return cookies;
}

/** Crea una sesión nueva para el usuario y setea la cookie. */
export function crearSesion(req: Request, res: Response, usuario: UsuarioSesion): string {
  const id = randomBytes(32).toString('hex');
  const ahora = Date.now();

  // Token anti-CSRF aleatorio y distinto para cada sesión. Se guarda en el
  // servidor y se manda en una cookie legible por JavaScript (doble envío).
  const csrfToken = randomBytes(32).toString('hex');

  sesiones.set(id, {
    usuario,
    creadaEn: ahora,
    ultimoAcceso: ahora,
    expiraEn: ahora + TIEMPO_INACTIVIDAD,
    csrfToken,
  });

  const seguro = config.nodeEnv === 'production';

  // HttpOnly: JS no puede leer el id de sesión. Secure: en producción sólo
  // viaja por HTTPS. SameSite ya mitiga CSRF. La demo local corre por HTTP,
  // así que Secure se activa por entorno (NODE_ENV=production).
  res.cookie('sid', id, {
    path: '/',
    httpOnly: true,
    secure: seguro,
    sameSite: 'lax',
    maxAge: TIEMPO_INACTIVIDAD,
  });

  // Ésta sí tiene que ser legible por el cliente para reenviarla.
  res.cookie('csrf', csrfToken, {
    path: '/',
    secure: seguro,
    sameSite: 'lax',
    maxAge: TIEMPO_INACTIVIDAD,
  });

  return id;
}

/**
 * Devuelve la sesión de la petición, si existe y no venció. Cada acceso
 * renueva el vencimiento por inactividad, sin pasar nunca de la vida absoluta.
 */
export function obtenerSesion(req: Request): Sesion | null {
  const cookies = leerCookies(req);
  const id = cookies.sid;
  if (!id) return null;

  const sesion = sesiones.get(id);
  if (!sesion) return null;

  const ahora = Date.now();
  if (ahora > sesion.expiraEn || ahora > sesion.creadaEn + TIEMPO_ABSOLUTO) {
    sesiones.delete(id);
    return null;
  }

  sesion.ultimoAcceso = ahora;
  sesion.expiraEn = Math.min(ahora + TIEMPO_INACTIVIDAD, sesion.creadaEn + TIEMPO_ABSOLUTO);
  return sesion;
}

/** Cierra la sesión en el servidor: la cookie robada deja de servir. */
export function destruirSesion(req: Request): void {
  const cookies = leerCookies(req);
  const id = cookies.sid;
  if (id) sesiones.delete(id);
}
