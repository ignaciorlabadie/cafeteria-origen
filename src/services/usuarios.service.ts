import bcrypt from 'bcryptjs';

import * as db from '../db';
import type { Usuario } from '../tipos';

const RONDAS = 12;

/**
 * Hash fijo para comparar cuando el usuario no existe. Sin esto, un login con
 * usuario inexistente responde mucho antes que uno con contraseña incorrecta
 * y permite enumerar usuarios por timing (aunque el mensaje sea genérico).
 */
const HASH_SEÑUELO = bcrypt.hashSync('usuario-inexistente', 10);

/** Hashea una contraseña con salt antes de guardarla. */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, RONDAS);
}

/** Busca un usuario por nombre de usuario exacto (query parametrizada). */
export async function buscarPorUsername(username: string): Promise<Usuario | null> {
  const { rows } = await db.query<Usuario>(
    'SELECT * FROM usuarios WHERE username = $1',
    [username]
  );
  return rows[0] || null;
}

/**
 * Autentica comparando la contraseña con el hash guardado (nunca en claro).
 * Siempre se ejecuta un bcrypt.compare, incluso si el usuario no existe.
 */
export async function autenticar(username: string, password: string): Promise<Usuario | null> {
  const { rows } = await db.query<Usuario>(
    'SELECT * FROM usuarios WHERE username = $1',
    [username]
  );
  const usuario = rows[0] || null;
  const coincide = await bcrypt.compare(password, usuario ? usuario.password : HASH_SEÑUELO);
  return usuario && coincide ? usuario : null;
}

/** Lista todos los usuarios (para el panel de administración). */
export async function listar(): Promise<Usuario[]> {
  const { rows } = await db.query<Usuario>('SELECT * FROM usuarios ORDER BY id');
  return rows;
}

export async function actualizar(id: number | string, cambios: Partial<Usuario>): Promise<Usuario | null> {
  const permitidos = ['username', 'nombre', 'rol', 'password'];
  const claves = Object.keys(cambios).filter((campo) => permitidos.includes(campo));
  if (claves.length === 0) return null;

  // Nunca se guarda la contraseña que mandó el cliente: siempre su hash.
  const passwordHash = cambios.password === undefined ? null : await hashPassword(cambios.password);

  const { rows } = await db.query<Usuario>(
    `UPDATE usuarios
        SET username = COALESCE($1, username),
            nombre = COALESCE($2, nombre),
            rol = COALESCE($3, rol),
            password = COALESCE($4, password)
      WHERE id = $5
      RETURNING *`,
    [
      cambios.username ?? null,
      cambios.nombre ?? null,
      cambios.rol ?? null,
      passwordHash,
      id,
    ]
  );
  return rows[0] || null;
}

/** Cambia la contraseña de un usuario guardando su hash con salt. */
export async function cambiarPassword(id: number, nuevaPassword: string): Promise<Usuario | null> {
  const hash = await hashPassword(nuevaPassword);
  const { rows } = await db.query<Usuario>(
    'UPDATE usuarios SET password = $1 WHERE id = $2 RETURNING *',
    [hash, id]
  );
  return rows[0] || null;
}
