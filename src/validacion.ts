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

/**
 * Valida que un valor sea un string dentro de un rango de longitud.
 * Lanza ErrorValidacion si no es string o está fuera de rango.
 */
export function texto(
  valor: unknown,
  min: number,
  max: number,
  campo: string
): string {
  if (typeof valor !== 'string' || valor.length < min || valor.length > max) {
    throw new ErrorValidacion(
      `El campo "${campo}" debe ser un texto de ${min} a ${max} caracteres.`
    );
  }
  return valor;
}

/**
 * Valida que un valor sea un entero dentro de un rango.
 * Lanza ErrorValidacion si no es un número entero o está fuera de rango.
 */
export function entero(
  valor: unknown,
  min: number,
  max: number,
  campo: string
): number {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ErrorValidacion(
      `El campo "${campo}" debe ser un entero entre ${min} y ${max}.`
    );
  }
  return n;
}

/**
 * Valida que un valor sea un array con entre 1 y maxItems elementos.
 * Lanza ErrorValidacion si no es un array o excede la cantidad.
 */
export function arrayNoVacio(
  valor: unknown,
  maxItems: number,
  campo: string
): unknown[] {
  if (!Array.isArray(valor) || valor.length === 0 || valor.length > maxItems) {
    throw new ErrorValidacion(
      `El campo "${campo}" debe ser un array con entre 1 y ${maxItems} elementos.`
    );
  }
  return valor;
}
