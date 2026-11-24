import { randomBytes } from 'crypto';
import path from 'path';

// Los secretos y credenciales no se versionan: se leen del entorno.
// En development se tolera un secreto efímero; en production su ausencia es un error.
const produccion = process.env.NODE_ENV === 'production';

// Falla rápido si falta una variable obligatoria en producción.
function variable(nombre: string, valorPorDefecto = ''): string {
  const valor = process.env[nombre] || valorPorDefecto;
  if (!valor && produccion) {
    throw new Error(`Falta la variable de entorno ${nombre}`);
  }
  return valor;
}

// randomBytes sólo en dev: en producción se exige SESSION_SECRET explícito.
function secretoDeSesion(): string {
  const secreto = process.env.SESSION_SECRET;
  if (secreto) return secreto;
  if (produccion) {
    throw new Error('Falta la variable de entorno SESSION_SECRET');
  }
  return randomBytes(32).toString('hex');
}

export default {
  port: Number(variable('PORT', '3000')),
  nodeEnv: process.env.NODE_ENV || 'development',

  db: {
    host: variable('DB_HOST', 'db'),
    port: Number(variable('DB_PORT', '5432')),
    database: variable('DB_NAME', 'origen'),
    // Sin valor fijo: origen_app se define en .env.example / despliegue.
    user: variable('DB_USER'),
    password: variable('DB_PASSWORD'),
  },

  sessionSecret: secretoDeSesion(),

  uploadsDir: process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads'),
};