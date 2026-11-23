import express from 'express';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';

import config from '../config';
import * as catalogo from '../services/catalogo.service';
import * as usuarios from '../services/usuarios.service';
import { requiereSesion, requiereRol } from '../middleware/auth';
import {
  texto,
  idEntero,
  ErrorValidacion,
  validarExtension,
  validarMagicNumber,
  validarTamaño,
  nombreArchivoSeguro,
} from '../validacion';
import type { Usuario } from '../tipos';

const router = express.Router();

/** Sólo imágenes: un .html/.svg se ejecutaría como HTML en el propio origen. */
const EXTENSIONES_IMAGEN = ['.png', '.jpg', '.jpeg', '.webp'];
const TAMANO_MAXIMO = 2 * 1024 * 1024; // 2 MB
const MIME_IMAGENES: Record<string, Buffer[]> = {
  'image/png': [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  'image/jpeg': [Buffer.from([0xff, 0xd8, 0xff])],
  'image/webp': [Buffer.from('RIFF')],
};

/**
 * Rutas del panel de administración.
 *
 * -----------------------------------------------------------------------------
 * FALLA — Autorización ausente / escalada de privilegios (OWASP A01:2021)
 * -----------------------------------------------------------------------------
 * Se exige estar autenticado, pero NO se comprueba el rol: `requiereRol` está
 * importado y no se usa. Cualquier usuario autenticado (incluso con rol
 * "cliente") entra al panel y puede:
 *   - crear, editar y BORRAR productos,
 *   - cambiar contraseñas,
 *   - dar de alta usuarios y cambiarles el rol (escalada de privilegios),
 *   - ejecutar comandos en el servidor.
 *
 * Corrección: `router.use(requiereRol('admin'))` sobre las rutas sensibles.
 * -----------------------------------------------------------------------------
 */
router.use(requiereSesion);

/** GET /api/admin/usuarios */
router.get('/usuarios', async (req, res, next) => {
  try {
    res.json({ usuarios: await usuarios.listar() });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/admin/usuarios/:id
 *
 * FALLA — Asignación masiva: se actualiza cualquier campo que llegue en el
 * cuerpo, incluido el `rol`. Un usuario con rol "cliente" puede mandarse
 * `{"rol": "admin"}` y convertirse en administrador.
 */
router.put('/usuarios/:id', async (req, res, next) => {
  try {
    const { username, nombre, rol, password } = req.body || {};
    const cambios: Partial<Usuario> = {};
    if (username !== undefined) cambios.username = username;
    if (nombre !== undefined) cambios.nombre = nombre;
    if (rol !== undefined) cambios.rol = rol;
    if (password !== undefined) cambios.password = password;

    const usuario = await usuarios.actualizar(idEntero(req.params.id), cambios);
    if (!usuario) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }
    res.json(usuario);
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/productos — alta de producto. */
router.post('/productos', async (req, res, next) => {
  try {
    const producto = await catalogo.crear(req.body || {});
    res.status(201).json(producto);
  } catch (err) {
    // El nombre del producto es único en la base.
    if ((err as { code?: string }).code === '23505') {
      return res.status(409).json({ error: 'Ya existe un producto con ese nombre.' });
    }
    next(err);
  }
});

/** PUT /api/admin/productos/:id */
router.put('/productos/:id', async (req, res, next) => {
  try {
    const producto = await catalogo.actualizar(idEntero(req.params.id), req.body || {});
    if (!producto) {
      return res.status(404).json({ error: 'Producto no encontrado.' });
    }
    res.json(producto);
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/admin/productos/:id
 *
 * CSRF: cubierto por el middleware global `verificarCsrf`.
 */
router.delete('/productos/:id', async (req, res, next) => {
  try {
    const producto = await catalogo.eliminar(idEntero(req.params.id));
    if (!producto) {
      return res.status(404).json({ error: 'Producto no encontrado.' });
    }
    res.json(producto);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/cambiar-contrasena
 *
 * CSRF: cubierto por el middleware global `verificarCsrf`.
 *
 * FALLAS: sin límite de intentos, y la contraseña nueva se guarda en texto plano.
 */
router.post('/cambiar-contrasena', async (req, res, next) => {
  try {
    const { nueva } = req.body || {};
    if (!nueva) {
      return res.status(400).json({ error: 'Falta la contraseña nueva.' });
    }
    // FALLA: no se valida la longitud ni la complejidad de la contraseña.
    // (`req.usuario!`: requiereSesion ya garantizó que hay un usuario.)
    const usuario = await usuarios.cambiarPassword(req.usuario!.id, nueva);
    res.json({ mensaje: 'Contraseña actualizada.', usuario });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/probar-conexion
 *
 * -----------------------------------------------------------------------------
 * FALLA — Inyección de comandos del sistema operativo (OWASP A03:2021)
 * -----------------------------------------------------------------------------
 * La dirección del proveedor se mete dentro de una cadena de shell.
 * Como `exec` launches /bin/sh -c, los operadores del shell (|, ;, &&, $())
 * se interpretan y permiten ejecutar comandos arbitrarios en el contenedor.
 *
 * Corrección: validar el host contra una LISTA BLANCA y ejecutar el proceso
 * con `spawn('ping', ['-c', '3', host], { shell: false })`, sin pasar por el
 * shell.
 * -----------------------------------------------------------------------------
 */
router.post('/probar-conexion', (req, res) => {
  const { host } = req.body || {};

  // FALLA: entrada de usuario concatenada en un comando de shell.
  const comando = `ping -c 3 ${host}`;

  exec(comando, (error, stdout, stderr) => {
    res.json({
      comando,
      salida: stdout,
      error: stderr || (error ? error.message : null),
    });
  });
});

/**
 * POST /api/admin/subir-archivo
 *
 * Práctica 4: lista blanca de extensiones de imagen, comprobación del tipo
 * MIME real por magic number, límite de tamaño y nombre generado en el
 * servidor. El nombre del cliente nunca decide la ruta de escritura.
 */
router.post('/subir-archivo', express.json({ limit: '8mb' }), (req, res, next) => {
  try {
    const nombre = texto(req.body?.nombre, 1, 200, 'nombre');
    const contenidoBase64 = texto(req.body?.contenidoBase64, 1, 11_000_000, 'contenidoBase64');

    // Sólo el nombre base: se descarta cualquier "../" que viniera del cliente.
    const extension = validarExtension(
      path.extname(path.basename(nombre)),
      EXTENSIONES_IMAGEN
    );
    const buffer = Buffer.from(contenidoBase64, 'base64');
    validarTamaño(buffer.length, TAMANO_MAXIMO);
    validarMagicNumber(buffer, MIME_IMAGENES);

    // Defensa en profundidad: aunque el nombre viniera saneado, verificamos
    // que el destino resuelto siga dentro de uploads/.
    const archivo = nombreArchivoSeguro(extension);
    const raiz = path.resolve(config.uploadsDir) + path.sep;
    const destino = path.resolve(config.uploadsDir, archivo);
    if (!destino.startsWith(raiz)) {
      throw new ErrorValidacion('Ruta de destino no permitida.');
    }

    fs.mkdirSync(config.uploadsDir, { recursive: true });
    fs.writeFileSync(destino, buffer);

    res.json({
      mensaje: 'Archivo subido.',
      url: `/uploads/${archivo}`,
      bytes: buffer.length,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
