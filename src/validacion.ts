/**
 * Helpers de validación de entrada del servidor.
 *
 * Toda validación se hace en el servidor: el cliente se puede saltar con el
 * devtools, así que nunca confiamos en lo que llega en req.body, req.query
 * ni req.params.
 *
 * Este archivo se va extendiendo a medida que avanzan las prácticas:
 * - commit 1: ErrorValidacion (tipo de error 400)
 * - commit 2: texto(), entero(), arrayNoVacio()
 * - commit 3: helpers de archivo para Juan (extensión, MIME, tamaño, nombre seguro)
 */

import type { ErrorHttp } from './tipos';

/**
 * Error de validación de entrada (HTTP 400).
 * El middleware de errores lo atrapa y responde con mensaje genérico y sin stack.
 */
export class ErrorValidacion extends Error implements ErrorHttp {
  status = 400;

  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'ErrorValidacion';
  }
}
