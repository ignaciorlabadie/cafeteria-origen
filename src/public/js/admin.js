/* =============================================================================
   Cafetería Origen — lógica del panel de administración

   XSS: los datos de la API, del parámetro ?vista= y de los formularios se
   insertan como TEXTO (textContent / createTextNode / createElement). No se
   construye HTML con valores que pueda controlar un usuario.
   ============================================================================= */
(function () {
  'use strict';

  var API = '/api';
  var usuario = null;
  var productosCache = {};
  var csrfToken = '';

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  function txt(valor) {
    return valor == null ? '' : String(valor);
  }

  function elemento(etiqueta, clase, texto) {
    var el = document.createElement(etiqueta);
    if (clase) el.className = clase;
    if (texto !== undefined) el.textContent = txt(texto);
    return el;
  }

  function vaciar(nodo) {
    while (nodo.firstChild) nodo.removeChild(nodo.firstChild);
  }

  function celda(texto, clase) {
    return elemento('td', clase || '', texto);
  }

  function crearTabla(tabla, columnas) {
    vaciar(tabla);
    var thead = document.createElement('thead');
    var cabecera = document.createElement('tr');
    columnas.forEach(function (col) {
      cabecera.appendChild(elemento('th', col.clase || '', col.texto));
    });
    thead.appendChild(cabecera);
    tabla.appendChild(thead);

    var tbody = document.createElement('tbody');
    tabla.appendChild(tbody);
    return tbody;
  }

  function agregarKpis(contenedor, kpis) {
    vaciar(contenedor);
    kpis.forEach(function (k) {
      var tarjeta = elemento('div', 'kpi');
      tarjeta.appendChild(elemento('div', 'kpi-label', k.label));
      tarjeta.appendChild(elemento('div', 'kpi-value', k.value));
      contenedor.appendChild(tarjeta);
    });
  }

  function money(valor) {
    return Number(valor || 0).toLocaleString('es-AR', { style: 'currency', currency: 'ARS' });
  }

  function cargarCsrf() {
    return fetch(API + '/csrf-token', { credentials: 'same-origin' })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        csrfToken = data.token || data.csrfToken || '';
        return csrfToken;
      })
      .catch(function () { return ''; });
  }

  function api(url, opciones) {
    var opts = opciones || {};
    var metodo = (opts.method || 'GET').toUpperCase();
    var esEscritura = ['POST', 'PUT', 'PATCH', 'DELETE'].indexOf(metodo) !== -1;
    var listo = !esEscritura || csrfToken ? Promise.resolve() : cargarCsrf();

    return listo.then(function () {
      var headers = Object.assign({}, opts.headers || {});
      if (esEscritura && csrfToken) headers['X-CSRF-Token'] = csrfToken;
      return fetch(API + url, Object.assign({}, opts, { headers: headers })).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          return { ok: res.ok, status: res.status, data: data };
        });
      });
    });
  }

  function postJSON(url, cuerpo) {
    return api(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo || {}),
    });
  }

  function putJSON(url, cuerpo) {
    return api(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo || {}),
    });
  }

  function patchJSON(url, cuerpo) {
    return api(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo || {}),
    });
  }

  function feedback(el, mensaje, ok) {
    el.className = 'form-feedback ' + (ok ? 'is-ok' : 'is-error');
    el.textContent = txt(mensaje);
  }

  /* ------------------------------------------------------------------ login */
  function iniciarSesion(evento) {
    evento.preventDefault();
    var caja = $('#login-feedback');
    caja.className = 'form-feedback';

    postJSON('/auth/login', {
      username: $('#login-usuario').value,
      password: $('#login-password').value,
    }).then(function (resp) {
      if (!resp.ok) {
        feedback(caja, 'No pudimos iniciar sesión: ' + (resp.data.error || 'error desconocido'), false);
        return;
      }
      usuario = resp.data.usuario;
      // El login creó una sesión nueva con su propio token: lo refrescamos
      // antes de habilitar el panel para que las próximas escrituras usen el
      // token correcto.
      cargarCsrf().then(mostrarPanel);
    });
  }

  function cerrarSesion() {
    postJSON('/auth/logout', {}).then(function () {
      usuario = null;
      $('#vista-login').hidden = false;
      $('#vista-panel').hidden = true;
      vaciar($('#admin-user'));
    });
  }

  function mostrarPanel() {
    $('#vista-login').hidden = true;
    $('#vista-panel').hidden = false;

    var adminUser = $('#admin-user');
    vaciar(adminUser);
    adminUser.appendChild(document.createTextNode('Sesión de '));
    adminUser.appendChild(elemento('strong', '', usuario.nombre));
    adminUser.appendChild(document.createTextNode(' · rol: '));
    adminUser.appendChild(elemento('strong', '', usuario.rol));

    $('#panel-bienvenida').textContent = 'Hola, ' + usuario.nombre;
    cargarTodo();
  }

  function cargarTodo() {
    cargarResumen();
    cargarPedidos();
    cargarProductos();
    cargarReportes();
    cargarUsuarios();
  }

  /* ---------------------------------------------------------------- resumen */
  function cargarResumen() {
    api('/reportes/facturacion').then(function (f) {
      api('/reportes/mas-vendido').then(function (m) {
        api('/reportes/cantidad-vendida').then(function (c) {
          var mas = m.data.producto;
          var kpis = [
            { label: 'Facturación total', value: money(f.data.facturado) },
            { label: 'Pedidos registrados', value: f.data.pedidos },
            {
              label: 'Producto más vendido',
              value: mas ? txt(mas.nombre) : '—',
            },
            {
              label: 'Unidades por tipo',
              value: Object.keys(c.data.cantidadVendida || {})
                .map(function (k) { return k + ': ' + c.data.cantidadVendida[k]; })
                .join(' · ') || '—',
            },
          ];
          agregarKpis($('#kpis'), kpis);
        });
      });
    });
  }

  /* --------------------------------------------------------------- pedidos */
  function tablaPedidos(tabla, filas, conAcciones) {
    var columnas = [
      { texto: '#' }, { texto: 'Mesa' }, { texto: 'Cliente' }, { texto: 'Estado' },
      { texto: 'Total', clase: 'num' }, { texto: 'Fecha' },
    ];
    if (conAcciones) columnas.push({ texto: 'Acciones' });

    var tbody = crearTabla(tabla, columnas);

    if (!filas || filas.length === 0) {
      var filaVacia = document.createElement('tr');
      var celdaVacia = elemento('td', 'empty', 'No hay pedidos.');
      celdaVacia.colSpan = columnas.length;
      filaVacia.appendChild(celdaVacia);
      tbody.appendChild(filaVacia);
      return;
    }

    filas.forEach(function (p) {
      var fila = document.createElement('tr');
      fila.appendChild(celda(p.id));
      fila.appendChild(celda(p.mesa));
      fila.appendChild(celda(p.cliente));

      var estado = celda();
      estado.appendChild(elemento('span', 'badge badge-' + txt(p.estado), p.estado));
      fila.appendChild(estado);

      fila.appendChild(celda(money(p.total), 'num'));
      fila.appendChild(celda(new Date(p.creado_en).toLocaleString('es-AR')));

      if (conAcciones) {
        var accion = celda();
        var select = elemento('select', 'sel-estado');
        select.setAttribute('data-pedido', txt(p.id));
        ['abierto', 'preparando', 'listo', 'entregado'].forEach(function (e) {
          var opcion = elemento('option', '', e);
          opcion.value = e;
          if (e === p.estado) opcion.selected = true;
          select.appendChild(opcion);
        });
        accion.appendChild(select);
        fila.appendChild(accion);
      }

      tbody.appendChild(fila);
    });
  }

  function cargarPedidos() {
    api('/pedidos').then(function (resp) {
      var pedidos = resp.data.pedidos || [];
      tablaPedidos($('#tabla-pedidos'), pedidos, true);
      tablaPedidos($('#tabla-ultimos'), pedidos.slice(0, 5), false);
    });
  }

  function cambiarEstado(evento) {
    var select = evento.target.closest('.sel-estado');
    if (!select) return;
    var id = select.getAttribute('data-pedido');
    patchJSON('/pedidos/' + id + '/estado', { estado: select.value }).then(function (resp) {
      if (!resp.ok) {
        alert('No se pudo cambiar el estado: ' + (resp.data.error || 'error'));
      }
      cargarPedidos();
    });
  }

  /* ------------------------------------------------------------- productos */
  function cargarProductos() {
    api('/productos').then(function (resp) {
      var productos = resp.data.productos || [];
      productosCache = {};
      var tbody = crearTabla($('#tabla-productos'), [
        { texto: '#' }, { texto: 'Nombre' }, { texto: 'Tipo' }, { texto: 'Origen' },
        { texto: 'Precio', clase: 'num' }, { texto: 'Acciones' },
      ]);

      productos.forEach(function (p) {
        productosCache[p.id] = p;

        var fila = document.createElement('tr');
        fila.appendChild(celda(p.id));
        fila.appendChild(celda(p.nombre));
        fila.appendChild(celda(p.tipo));
        fila.appendChild(celda(p.variedad || '—'));
        fila.appendChild(celda(money(p.precio), 'num'));

        var accion = celda();
        var borrar = elemento('button', 'link-danger', 'Borrar');
        borrar.setAttribute('data-borrar', txt(p.id));
        accion.appendChild(borrar);
        fila.appendChild(accion);

        tbody.appendChild(fila);
      });
    });
  }

  function guardarProducto(evento) {
    evento.preventDefault();
    var caja = $('#producto-feedback');
    var id = $('#producto-id').value;

    var cuerpo = {
      nombre: $('#p-nombre').value,
      tipo: $('#p-tipo').value,
      variedad: $('#p-variedad').value || null,
      tamano: $('#p-tamano').value || null,
      gramos: $('#p-gramos').value ? Number($('#p-gramos').value) : null,
      precio_base: Number($('#p-precio-base').value || 0),
      precio_por_gramo: Number($('#p-precio-gramo').value || 0),
      descripcion: $('#p-descripcion').value,
    };

    var peticion = id ? putJSON('/admin/productos/' + id, cuerpo) : postJSON('/admin/productos', cuerpo);

    peticion.then(function (resp) {
      if (!resp.ok) {
        feedback(caja, 'No se pudo guardar: ' + (resp.data.error || 'error desconocido'), false);
        return;
      }
      feedback(caja, 'Producto guardado correctamente.', true);
      $('#form-producto').reset();
      $('#producto-id').value = '';
      cargarProductos();
    });
  }

  function borrarProducto(evento) {
    var btn = evento.target.closest('[data-borrar]');
    if (!btn) return;
    var id = btn.getAttribute('data-borrar');
    if (!confirm('¿Borrar el producto #' + id + '?')) return;

    api('/admin/productos/' + id, { method: 'DELETE' }).then(function (resp) {
      if (!resp.ok) alert('No se pudo borrar: ' + (resp.data.error || 'error'));
      cargarProductos();
    });
  }

  function limpiarFormularioProducto() {
    $('#form-producto').reset();
    $('#producto-id').value = '';
  }

  /* ---------------------------------------------------------------- upload */
  function subirArchivo(evento) {
    evento.preventDefault();
    var caja = $('#upload-feedback');
    var input = $('#archivo-subida');
    if (!input.files || !input.files[0]) {
      feedback(caja, 'Elegí un archivo primero.', false);
      return;
    }

    var archivo = input.files[0];
    var lector = new FileReader();

    lector.onload = function () {
      var base64 = String(lector.result).split(',')[1] || '';
      postJSON('/admin/subir-archivo', {
        nombre: archivo.name,
        contenidoBase64: base64,
      }).then(function (resp) {
        if (!resp.ok) {
          feedback(caja, 'No se pudo subir: ' + (resp.data.error || 'error desconocido'), false);
          return;
        }
        feedback(caja, 'Archivo subido a ' + resp.data.url, true);
      });
    };

    lector.readAsDataURL(archivo);
  }

  /* -------------------------------------------------------------- reportes */
  function cargarReportes() {
    api('/reportes/facturacion').then(function (f) {
      api('/reportes/ticket-promedio').then(function (t) {
        api('/reportes/mas-vendido').then(function (m) {
          var mas = m.data.producto;
          var kpis = [
            { label: 'Facturación', value: money(f.data.facturado) },
            { label: 'Pedidos', value: f.data.pedidos },
            { label: 'Ticket promedio', value: money(t.data.promedio) },
            {
              label: 'Más vendido',
              value: mas ? txt(mas.nombre) + ' (' + txt(mas.unidades) + ')' : '—',
            },
          ];
          agregarKpis($('#kpis-reportes'), kpis);
        });
      });
    });
  }

  function consultarVentas() {
    var caja = $('#reporte-feedback');
    var variedad = $('#reporte-variedad').value;

    api('/reportes/ventas-por-variedad?variedad=' + encodeURIComponent(variedad)).then(function (resp) {
      if (!resp.ok) {
        feedback(caja, 'Error: ' + (resp.data.error || 'desconocido'), false);
        vaciar($('#tabla-ventas'));
        return;
      }
      var ventas = resp.data.ventas || [];
      var tbody = crearTabla($('#tabla-ventas'), [
        { texto: 'Origen' }, { texto: 'Producto' },
        { texto: 'Unidades', clase: 'num' }, { texto: 'Total', clase: 'num' },
      ]);
      ventas.forEach(function (v) {
        var fila = document.createElement('tr');
        fila.appendChild(celda(v.variedad));
        fila.appendChild(celda(v.nombre));
        fila.appendChild(celda(v.unidades, 'num'));
        fila.appendChild(celda(money(v.total), 'num'));
        tbody.appendChild(fila);
      });
      feedback(caja, 'Consulta realizada.', true);
    });
  }

  /* -------------------------------------------------------------- usuarios */
  function cargarUsuarios() {
    api('/admin/usuarios').then(function (resp) {
      var usuarios = resp.data.usuarios || [];
      var tbody = crearTabla($('#tabla-usuarios'), [
        { texto: '#' }, { texto: 'Usuario' }, { texto: 'Nombre' },
        { texto: 'Rol' }, { texto: 'Acciones' },
      ]);

      usuarios.forEach(function (u) {
        var fila = document.createElement('tr');
        fila.appendChild(celda(u.id));
        fila.appendChild(celda(u.username));
        fila.appendChild(celda(u.nombre));

        var rol = celda();
        rol.appendChild(elemento('span', 'badge' + (u.rol === 'admin' ? ' badge-admin' : ''), u.rol));
        fila.appendChild(rol);

        var accion = celda();
        var select = elemento('select', 'sel-rol');
        select.setAttribute('data-usuario', txt(u.id));
        ['cliente', 'mozo', 'barista', 'admin'].forEach(function (r) {
          var opcion = elemento('option', '', r);
          opcion.value = r;
          if (r === u.rol) opcion.selected = true;
          select.appendChild(opcion);
        });
        accion.appendChild(select);
        fila.appendChild(accion);

        tbody.appendChild(fila);
      });
    });
  }

  function cambiarRol(evento) {
    var select = evento.target.closest('.sel-rol');
    if (!select) return;
    var id = select.getAttribute('data-usuario');

    putJSON('/admin/usuarios/' + id, { rol: select.value }).then(function (resp) {
      if (!resp.ok) alert('No se pudo actualizar: ' + (resp.data.error || 'error'));
      cargarUsuarios();
    });
  }

  function cambiarPassword(evento) {
    evento.preventDefault();
    var caja = $('#password-feedback');
    postJSON('/admin/cambiar-contrasena', { nueva: $('#nueva-password').value }).then(function (resp) {
      if (!resp.ok) {
        feedback(caja, 'No se pudo cambiar: ' + (resp.data.error || 'error desconocido'), false);
        return;
      }
      feedback(caja, 'Contraseña actualizada.', true);
      $('#nueva-password').value = '';
    });
  }

  /* ----------------------------------------------------------- herramientas */
  function probarConexion(evento) {
    evento.preventDefault();
    var salida = $('#salida-conexion');
    salida.textContent = 'Probando…';

    postJSON('/admin/probar-conexion', { host: $('#conexion-host').value }).then(function (resp) {
      if (!resp.ok) {
        salida.textContent = 'Error: ' + (resp.data.error || 'desconocido');
        return;
      }
      salida.textContent =
        '$ ' + resp.data.comando + '\n\n' +
        (resp.data.salida || '') +
        (resp.data.error ? '\n[stderr]\n' + resp.data.error : '');
    });
  }

  function verDiagnostico() {
    var salida = $('#salida-diagnostico');
    salida.textContent = 'Cargando…';
    api('/_diagnostico').then(function (resp) {
      salida.textContent = JSON.stringify(resp.data, null, 2);
    });
  }

  /* ------------------------------------------------------------------ tabs */
  function activarTab(evento) {
    var tab = evento.target.closest('.tab');
    if (!tab) return;
    var vista = tab.getAttribute('data-vista');
    $$('.tab').forEach(function (t) { t.classList.remove('is-active'); });
    tab.classList.add('is-active');
    $$('.tab-panel').forEach(function (p) {
      p.classList.toggle('is-active', p.getAttribute('data-panel') === vista);
    });
  }

  /* ------------------------------------------------------------------ init */
  function init() {
    // El parámetro ?vista= se escribe como texto: nunca se interpreta como HTML.
    var params = new URLSearchParams(window.location.search);
    var objetivo = params.get('vista');
    if (objetivo) {
      $('#panel-bienvenida').textContent = 'Panel ' + objetivo;
    }

    $('#form-login').addEventListener('submit', iniciarSesion);
    $('#btn-logout').addEventListener('click', cerrarSesion);
    $('#btn-refrescar').addEventListener('click', cargarTodo);
    $('#tabs').addEventListener('click', activarTab);
    $('#tabla-pedidos').addEventListener('change', cambiarEstado);
    $('#tabla-productos').addEventListener('click', borrarProducto);
    $('#form-producto').addEventListener('submit', guardarProducto);
    $('#btn-limpiar-producto').addEventListener('click', limpiarFormularioProducto);
    $('#form-upload').addEventListener('submit', subirArchivo);
    $('#form-password').addEventListener('submit', cambiarPassword);
    $('#btn-reporte-variedad').addEventListener('click', consultarVentas);
    $('#tabla-usuarios').addEventListener('change', cambiarRol);
    $('#form-conexion').addEventListener('submit', probarConexion);
    $('#btn-diagnostico').addEventListener('click', verDiagnostico);

    // ¿Ya hay sesión?
    api('/auth/yo').then(function (resp) {
      if (resp.ok) {
        usuario = resp.data.usuario;
        mostrarPanel();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
