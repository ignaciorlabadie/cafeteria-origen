import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';

import * as db from './db';
import { CATALOGO } from './catalogo';
import type { Rol } from './tipos';

interface UsuarioInicial {
  username: string;
  /** Variable de entorno que permite elegir la contraseña de esa cuenta. */
  passwordEnv: string;
  rol: Rol;
  nombre: string;
}

/**
 * Carga los datos iniciales (usuarios y catálogo) si la base está vacía.
 *
 * Las contraseñas se guardan con bcrypt + salt. No hay contraseñas escritas en
 * el código: se leen de SEED_*_PASSWORD y, si no están definidas, se genera una
 * aleatoria que se muestra una sola vez en el log del servidor.
 */

export const USUARIOS_INICIALES: UsuarioInicial[] = [
  {
    username: 'admin',
    passwordEnv: 'SEED_ADMIN_PASSWORD',
    rol: 'admin',
    nombre: 'Administración',
  },
  {
    username: 'valentina',
    passwordEnv: 'SEED_VALENTINA_PASSWORD',
    rol: 'admin',
    nombre: 'Valentina',
  },
  {
    username: 'barista',
    passwordEnv: 'SEED_BARISTA_PASSWORD',
    rol: 'barista',
    nombre: 'Barista',
  },
  {
    username: 'mozo',
    passwordEnv: 'SEED_MOZO_PASSWORD',
    rol: 'mozo',
    nombre: 'Mozo de sala',
  },
  {
    username: 'cliente',
    passwordEnv: 'SEED_CLIENTE_PASSWORD',
    rol: 'cliente',
    nombre: 'Cliente',
  },
];

/** Contraseña configurada por entorno, o una aleatoria para esa cuenta. */
function passwordInicial(usuario: UsuarioInicial): { valor: string; generada: boolean } {
  const configurada = process.env[usuario.passwordEnv];
  if (configurada) return { valor: configurada, generada: false };
  return { valor: randomBytes(18).toString('base64url'), generada: true };
}

export async function inicializarBase(): Promise<void> {
  // --- Usuarios -------------------------------------------------------------
  for (const usuario of USUARIOS_INICIALES) {
    const { valor, generada } = passwordInicial(usuario);
    const hash = await bcrypt.hash(valor, 12);

    const { rowCount } = await db.query(
      `INSERT INTO usuarios (username, password, rol, nombre)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (username) DO NOTHING`,
      [usuario.username, hash, usuario.rol, usuario.nombre]
    );

    // Sólo se muestra al crear la cuenta: es la única vez que se conoce el
    // valor en claro. En producción conviene definir SEED_*_PASSWORD.
    if (rowCount && generada) {
      console.warn(
        `[semilla] ${usuario.username}: contraseña aleatoria ${valor} ` +
          `(definí ${usuario.passwordEnv} para elegirla).`
      );
    }
  }

  // Migración: una base vieja puede tener contraseñas en texto plano. Se
  // hashean en el primer arranque para que ninguna siga legible en la tabla.
  const { rows: pendientes } = await db.query<{
    id: number;
    username: string;
    password: string;
  }>("SELECT id, username, password FROM usuarios WHERE password NOT LIKE '$2%'");

  for (const fila of pendientes) {
    const env = USUARIOS_INICIALES.find((u) => u.username === fila.username)?.passwordEnv;
    const plano = (env && process.env[env]) || fila.password;
    await db.query('UPDATE usuarios SET password = $1 WHERE id = $2', [
      await bcrypt.hash(plano, 12),
      fila.id,
    ]);
  }
  if (pendientes.length) {
    console.log(`[semilla] ${pendientes.length} contraseña(s) migrada(s) a bcrypt.`);
  }

  // --- Catálogo -------------------------------------------------------------
  for (const producto of CATALOGO) {
    await db.query(
      `INSERT INTO productos
         (nombre, tipo, variedad, tamano, gramos, precio_base, precio_por_gramo, descripcion)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (nombre) DO NOTHING`,
      [
        producto.nombre,
        producto.tipo,
        producto.variedad,
        producto.tamano,
        producto.gramos,
        producto.precio_base,
        producto.precio_por_gramo,
        producto.descripcion,
      ]
    );
  }
}
