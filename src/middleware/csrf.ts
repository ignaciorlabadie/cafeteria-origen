/**
 * Protección contra Cross-Site Request Forgery (CSRF).
 *
 * Tres capas:
 *  1. Token aleatorio por sesión, enviado en la cookie `csrf` (legible por JS)
 *     y reenviado por el cliente en `X-CSRF-Token`, `_csrf` o `?_csrf=`.
 *     El servidor compara ambas copias (patrón double-submit) y, si hay
 *     sesión, también compara con el token guardado en ella.
 *  2. Cookie de sesión con `SameSite: lax` (ver middleware/sesion.ts).
 *  3. Verificación de `Origin`/`Referer` cuando la cabecera está presente.
 *
 * Se exceptúa el login: todavía no hay sesión y los clientes de la batería
 * no envían token ahí. Un login forzado desde otro sitio no entrega una
 * sesión utilizada por el atacante y además queda cubierto por SameSite y
 * por el chequeo de Origin.
 */

import { randomBytes, timingSafeEqual } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

import { leerCookies, obtenerSesion } from './sesion';

const METODOS_SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS']);
const RUTAS_EXENTAS = new Set(['/api/auth/login']);

/** Compara dos tokens sin filtrar cuál carácter falló. */
function iguales(a: string, b: string): boolean {
  if (!a || !b) return false;
  const primera = Buffer.from(a);
  const segunda = Buffer.from(b);
  if (primera.length !== segunda.length) return false;
  return timingSafeEqual(primera, segunda);
}

/** El token puede venir en la cabecera, en el cuerpo o en la query. */
function tokenDePeticion(req: Request): string {
  const cabecera = req.get('X-CSRF-Token');
  if (cabecera) return cabecera;

  const cuerpo = req.body as Record<string, unknown> | undefined;
  if (cuerpo && typeof cuerpo._csrf === 'string') return cuerpo._csrf;

  const parametro = req.query._csrf;
  return typeof parametro === 'string' ? parametro : '';
}

/**
 * `Origin` y `Referer` deben apuntar al mismo host que recibió la petición.
 * Si no hay ninguna cabecera (curl, Postman, supertest) no se rechaza: la
 * decisión la toma el token. `Origin: null` (archivos locales) se ignora acá
 * y también se resuelve por el token.
 */
function mismoOrigen(req: Request): boolean {
  const host = req.get('host');
  if (!host) return true;

  const candidatos = [req.headers.origin, req.headers.referer].filter(
    (valor): valor is string => typeof valor === 'string' && valor.length > 0 && valor !== 'null'
  );

  for (const valor of candidatos) {
    try {
      if (new URL(valor).host.toLowerCase() !== host.toLowerCase()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Entrega el token de la sesión (o uno anónimo) y setea la cookie `csrf`. */
export function emitirTokenCsrf(req: Request, res: Response): void {
  const sesion = obtenerSesion(req);
  const token = sesion ? sesion.csrfToken : randomBytes(32).toString('hex');

  // No HttpOnly: el navegador tiene que poder leerlo para reenviarlo.
  res.cookie('csrf', token, { path: '/', sameSite: 'lax' });
  res.json({ token, csrfToken: token });
}

/** Middleware global para todas las operaciones que cambian estado. */
export function verificarCsrf(req: Request, res: Response, next: NextFunction): void {
  if (METODOS_SEGUROS.has(req.method.toUpperCase())) return next();
  if (RUTAS_EXENTAS.has(req.path)) return next();

  if (!mismoOrigen(req)) {
    res.status(403).json({ error: 'Origen de la petición no permitido.' });
    return;
  }

  const token = tokenDePeticion(req);
  const cookie = leerCookies(req).csrf || '';

  if (!iguales(token, cookie)) {
    res.status(403).json({ error: 'Token anti-CSRF inválido o ausente.' });
    return;
  }

  const sesion = obtenerSesion(req);
  if (sesion && !iguales(token, sesion.csrfToken)) {
    res.status(403).json({ error: 'Token anti-CSRF inválido o ausente.' });
    return;
  }

  next();
}
