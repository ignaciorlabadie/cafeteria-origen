/**
 * Manejo de errores.
 *
 * Los errores 4xx devuelven el mensaje de validación (no reflejan entrada del
 * cliente). Los 5xx responden con un mensaje fijo: la traza real queda sólo
 * en el log del servidor, nunca en la respuesta HTTP.
 */

import type { NextFunction, Request, Response } from 'express';

import type { ErrorHttp } from '../tipos';

export function rutaNoEncontrada(req: Request, res: Response): void {
  // No devolver req.originalUrl: es entrada del cliente y podría reflejarse
  // como HTML en un cliente que pinte el mensaje sin escapar (XSS reflejado).
  res.status(404).json({ error: 'Ruta no encontrada.' });
}

// Express reconoce al manejador de errores por sus CUATRO parámetros: `next`
// tiene que estar aunque no se use.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function manejadorErrores(err: ErrorHttp, req: Request, res: Response, next: NextFunction): void {
  const status = err.status || 500;
  // El objeto completo (con su traza) se registra acá, no se devuelve.
  console.error('[error]', status, err);

  if (status >= 500) {
    res.status(500).json({ error: 'Error interno del servidor.' });
    return;
  }
  res.status(status).json({ error: err.message });
}
