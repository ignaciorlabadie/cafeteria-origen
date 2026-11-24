import express from 'express';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

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
import type { Rol, Usuario } from '../tipos';

const router = express.Router();

/** Lista blanca de roles: no se acepta cualquier texto desde el cliente. */
const ROLES: Rol[] = ['admin', 'barista', 'mozo', 'cliente'];

/** Sólo imágenes: un .html/.svg se ejecutaría como HTML en el propio origen. */
const EXTENSIONES_IMAGEN = ['.png', '.jpg', '.jpeg', '.webp'];
const TAMANO_MAXIMO = 2 * 1024 * 1024; // 2 MB
const MIME_IMAGENES: Record<string, Buffer[]> = {
  'image/png': [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  'image/jpeg': [Buffer.from([0xff, 0xd8, 0xff])],
  'image/webp': [Buffer.from('RIFF')],
};

// CMD-03: lista blanca de hosts; cualquier otra entrada se rechaza.
const HOSTS_PERMITIDOS = ['127.0.0.1', 'proveedor.origen.com'];

/**
 * Rutas del panel de administración.
 *
 * AUTH-14: toda la ruta exige sesión y rol admin. CSRF se aplica de forma
 * global en src/app.ts mediante `verificarCsrf`.
 */
router.use(requiereSesion);
router.use(requiereRol('admin'));

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
 * Sólo un admin llega acá (middleware anterior). Igual se comprueba de nuevo
 * el rol antes de aceptar un cambio de `rol`, y se valida contra una lista
 * blanca. La contraseña nunca se guarda en claro: el servicio la hashea.
 */
router.put('/usuarios/:id', async (req, res, next) => {
  try {
    const cuerpo = req.body || {};
    const cambios: Partial<Usuario> = {};

    if (cuerpo.username !== undefined) {
      cambios.username = texto(cuerpo.username, 2, 40, 'usuario');
    }
    if (cuerpo.nombre !== undefined) {
      cambios.nombre = texto(cuerpo.nombre, 1, 80, 'nombre');
    }
    // Se manda en claro por HTTPS, se guarda como hash bcrypt.
    if (cuerpo.password !== undefined) {
      cambios.password = texto(cuerpo.password, 8, 200, 'contraseña');
    }

    if (cuerpo.rol !== undefined) {
      if (!req.usuario || req.usuario.rol !== 'admin') {
        return res.status(403).json({ error: 'Sólo un administrador puede cambiar roles.' });
      }
      if (!ROLES.includes(cuerpo.rol as Rol)) {
        throw new ErrorValidacion('Rol no permitido.');
      }
      cambios.rol = cuerpo.rol as Rol;
    }

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
 * La contraseña nueva se valida y se guarda como hash bcrypt (el servicio se
 * encarga de hashearla). El endpoint sólo lo alcanza un admin con sesión.
 */
router.post('/cambiar-contrasena', async (req, res, next) => {
  try {
    // (`req.usuario!`: requiereSesion ya garantizó que hay un usuario.)
    const nueva = texto(req.body?.nueva, 8, 200, 'contraseña nueva');
    const usuario = await usuarios.cambiarPassword(req.usuario!.id, nueva);
    res.json({ mensaje: 'Contraseña actualizada.', usuario });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/probar-conexion
 *
 * CMD-01/02/03: el host se valida contra una lista blanca y el ping se
 * ejecuta con `spawn('ping', ['-c', '3', host], { shell: false })`, argumentos
 * separados y sin interpolación en un shell.
 */
router.post('/probar-conexion', (req, res, next) => {
  try {
    const host = texto(req.body?.host, 1, 253, 'host');

    if (!HOSTS_PERMITIDOS.includes(host)) {
      return res.status(400).json({
        comando: 'ping',
        salida: '',
        error: 'Host no permitido.',
      });
    }

    // CMD-02: nunca concatenar la entrada del usuario en un comando
    const proceso = spawn('ping', ['-c', '3', host], { shell: false });
    let salida = '';
    let error = '';

    proceso.stdout.on('data', (datos: Buffer) => {
      salida += datos.toString();
    });
    proceso.stderr.on('data', (datos: Buffer) => {
      error += datos.toString();
    });
    proceso.on('error', (err) => {
      if (!res.headersSent) {
        res.status(500).json({ comando: `ping -c 3 ${host}`, salida, error: err.message });
      }
    });
    proceso.on('close', (codigo) => {
      if (res.headersSent) return;
      res.json({
        comando: `ping -c 3 ${host}`,
        salida,
        error: error || (codigo === 0 ? null : `ping terminó con código ${codigo}.`),
      });
    });
  } catch (err) {
    next(err);
  }
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