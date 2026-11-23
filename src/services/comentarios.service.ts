import * as db from '../db';
import { texto, entero } from '../validacion';
import type { Comentario } from '../tipos';

/** Datos de una reseña nueva, tal como llegan en el cuerpo de la petición. */
export interface NuevoComentario {
  autor: string;
  texto: string;
  calificacion: number;
}

/**
 * Servicio de comentarios / reseñas de la cafetería.
 *
 * Validación (Práctica 4): autor y texto se recortan y se acotan por longitud,
 * la calificación se restringe a 1..5. Se valida acá también, aunque la ruta
 * ya lo haga, por defensa en profundidad.
 *
 * XSS almacenado: el texto se guarda tal cual en la base, pero el cliente lo
 * pinta con textContent y la CSP bloquea scripts inline, así que el payload
 * se muestra como texto y no se ejecuta.
 */

/** Lista todos los comentarios, del más nuevo al más viejo. */
export async function listar(): Promise<Comentario[]> {
  const { rows } = await db.query<Comentario>(
    'SELECT * FROM comentarios ORDER BY id DESC'
  );
  return rows;
}

/** Crea un comentario. */
export async function crear({
  autor,
  texto: textoComentario,
  calificacion,
}: NuevoComentario): Promise<Comentario> {
  const a = texto(autor, 2, 40, 'autor');
  const t = texto(textoComentario, 3, 280, 'texto').trim();
  const c = entero(calificacion, 1, 5, 'calificación');
  const { rows } = await db.query<Comentario>(
    `INSERT INTO comentarios (autor, texto, calificacion)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [a, t, c]
  );
  return rows[0];
}

/** Elimina un comentario. */
export async function eliminar(id: number | string): Promise<Comentario | null> {
  const { rows } = await db.query<Comentario>(
    'DELETE FROM comentarios WHERE id = $1 RETURNING *',
    [id]
  );
  return rows[0] || null;
}
