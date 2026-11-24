import express from 'express';

import { requiereRol, requiereSesion } from '../middleware/auth';

const router = express.Router();

// CFG-03: el diagnóstico no es público; sólo admin con sesión.
router.use(requiereSesion, requiereRol('admin'));

router.get('/', (req, res) => {
  res.json({
    mensaje: 'Diagnóstico del servidor',
    version: '1.0.0',
    // CFG-04: sólo métricas del proceso; nunca process.env ni credenciales.
    sistema: {
      node: process.version,
      plataforma: process.platform,
      arquitectura: process.arch,
      memoria: process.memoryUsage(),
      uptime: process.uptime(),
      pid: process.pid,
    },
  });
});

export default router;