import * as db from '../db';
import bcrypt from 'bcryptjs';
import type { Usuario } from '../tipos';

/** Busca un usuario por nombre de usuario exacto (query parametrizada). */
export async function buscarPorUsername(username: string): Promise<Usuario | null> {
  const { rows } = await db.query<Usuario>(
    'SELECT * FROM usuarios WHERE username = $1',
    [username]
  );
  return rows[0] || null;
}

/**
 * Autentica a un usuario comparando usuario y contraseña.
 * Devuelve el usuario o null.
 *
 * La contraseña almacenada es un hash de bcrypt (VUL-13). Se compara con
 * bcrypt.compare, nunca en texto plano ni dentro de la consulta SQL.
 */
export async function autenticar(username: string, password: string): Promise<Usuario | null> {
  const usuario = await buscarPorUsername(username);
  if (!usuario) return null;

  const coincide = await bcrypt.compare(password, usuario.password);
  return coincide ? usuario : null;
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
      cambios.password ?? null,
      id,
    ]
  );
  return rows[0] || null;
}

/** Cambia la contraseña de un usuario (se guarda hasheada con bcrypt). */
export async function cambiarPassword(id: number, nuevaPassword: string): Promise<Usuario | null> {
  const hash = await bcrypt.hash(nuevaPassword, 12);
  const { rows } = await db.query<Usuario>(
    'UPDATE usuarios SET password = $1 WHERE id = $2 RETURNING *',
    [hash, id]
  );
  return rows[0] || null;
}
