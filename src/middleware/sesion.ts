/**
 * Gestión de sesiones.
 *
 * -----------------------------------------------------------------------------
 * FALLA — Gestión de sesiones insegura (Autenticación insegura)
 * -----------------------------------------------------------------------------
 * 1. El identificador de sesión es un contador incremental (`sesion_1`,
 *    `sesion_2`, ...): es PREDECIBLE y adivinable. Un atacante puede recorrer
 *    los valores y usurpar la sesión de otro usuario (fijación de sesión).
 * 2. La cookie se emite SIN `httpOnly` (JavaScript puede leerla) y SIN `secure`
 *    (viaja en texto plano por HTTP). `sameSite: 'lax'` ya está configurado
 *    como defensa contra CSRF (ver middleware/csrf.ts).
 * 3. Las sesiones NO expiran nunca.
 * 4. Al iniciar sesión no se regenera el identificador.
 * 5. El cierre de sesión sólo borra la cookie del cliente: la sesión sigue
 *    viva en el servidor.
 *
 * Corrección: usar crypto.randomUUID() (o crypto.randomBytes -> hex) para el
 * id, con expiración por inactividad y absoluta, cookie con
 * { httpOnly: true, secure: true, sameSite: 'lax' }, regeneración del id tras
 * el login y borrado de la sesión en el servidor al hacer logout.
 * -----------------------------------------------------------------------------
 */

import { randomBytes } from 'crypto';
import type { Request, Response } from 'express';

import type { Sesion, UsuarioSesion } from '../tipos';

export const sesiones = new Map<string, Sesion>();
let contadorSesiones = 0;

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
  contadorSesiones += 1;

  // FALLA: identificador predecible.
  const id = `sesion_${contadorSesiones}`;

  // Token anti-CSRF aleatorio y distinto para cada sesión. Se guarda en el
  // servidor y se manda en una cookie legible por JavaScript (doble envío).
  const csrfToken = randomBytes(32).toString('hex');

  // FALLA (Práctica 5): la sesión nunca expira.
  sesiones.set(id, {
    usuario,
    creadaEn: Date.now(),
    expiraEn: null,
    csrfToken,
  });

  // FALLA (Práctica 5): cookie sin httpOnly / secure.
  // SameSite ya mitiga CSRF: el navegador no envía la cookie en POST desde otro sitio.
  res.cookie('sid', id, { path: '/', sameSite: 'lax' });
  res.cookie('csrf', csrfToken, { path: '/', sameSite: 'lax' });

  return id;
}

/** Devuelve la sesión de la petición, si existe. */
export function obtenerSesion(req: Request): Sesion | null {
  const cookies = leerCookies(req);
  const id = cookies.sid;
  if (!id) return null;
  return sesiones.get(id) || null;
}

/** Cierra la sesión en el servidor (debería llamarse en el logout). */
export function destruirSesion(req: Request): void {
  const cookies = leerCookies(req);
  const id = cookies.sid;
  if (id) sesiones.delete(id);
}
