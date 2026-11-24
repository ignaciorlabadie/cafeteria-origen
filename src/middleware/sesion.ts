/**
 * Gestión de sesiones.
 *
 * Corrección (Práctica 5 · VUL-15 a VUL-18):
 *  - Identificador de sesión aleatorio (crypto.randomBytes).
 *  - Cookie de sesión con httpOnly, secure (en producción) y sameSite lax.
 *  - Expiración por inactividad (30 min) y absoluta (8 h); se renueva al usarla.
 *  - Regeneración del identificador al iniciar sesión (destruirSesion antes de crearSesion).
 *  - Logout borra la sesión del almacén del servidor, no solo la cookie.
 */

import { randomBytes } from 'crypto';
import type { Request, Response } from 'express';

import type { Sesion, UsuarioSesion } from '../tipos';

export const sesiones = new Map<string, Sesion>();

// TTL de sesión: 30 minutos de inactividad y 8 horas de vida absoluta.
const INACTIVIDAD_TTL = 30 * 60 * 1000; // 30 min
const ABSOLUTO_TTL = 8 * 60 * 60 * 1000; // 8 h

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
  // Identificador de sesión aleatorio e impredecible (VUL-16).
  const id = randomBytes(32).toString('hex');

  // Token anti-CSRF aleatorio y distinto para cada sesión. Se guarda en el
  // servidor y se manda en una cookie legible por JavaScript (doble envío).
  const csrfToken = randomBytes(32).toString('hex');

  const ahora = Date.now();

  // Expiración absoluta (8 h). La expiración por inactividad se renueva en obtenerSesion.
  sesiones.set(id, {
    usuario,
    creadaEn: ahora,
    expiraEn: ahora + ABSOLUTO_TTL,
    csrfToken,
  });

  // Cookie segura: httpOnly (no accesible desde JS), secure en producción,
  // sameSite lax y maxAge por inactividad (VUL-15).
  res.cookie('sid', id, {
    path: '/',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: INACTIVIDAD_TTL,
  });
  res.cookie('csrf', csrfToken, { path: '/', sameSite: 'lax' });

  return id;
}

/** Devuelve la sesión de la petición, si existe y no expiró. */
export function obtenerSesion(req: Request): Sesion | null {
  const cookies = leerCookies(req);
  const id = cookies.sid;
  if (!id) return null;

  const sesion = sesiones.get(id);
  if (!sesion) return null;

  const ahora = Date.now();

  // Si la sesión expiró (vida absoluta), borrarla y devolver null (VUL-17).
  if (sesion.expiraEn && ahora > sesion.expiraEn) {
    sesiones.delete(id);
    return null;
  }

  // Renovar expiración por actividad (inactividad).
  sesion.expiraEn = ahora + INACTIVIDAD_TTL;
  sesiones.set(id, sesion);

  return sesion;
}

/** Cierra la sesión en el servidor (debería llamarse en el logout). */
export function destruirSesion(req: Request): void {
  const cookies = leerCookies(req);
  const id = cookies.sid;
  if (id) sesiones.delete(id);
}
