/* =============================================================================
   Cafetería Origen — lógica del sitio público

   XSS: los datos que vienen de la API, de la URL o del localStorage se insertan
   siempre como TEXTO (textContent / createTextNode / createElement). No se
   construye HTML con valores que pueda controlar un usuario.
   ============================================================================= */
(function () {
  'use strict';

  var API = '/api';
  var CARRITO_KEY = 'origen.carrito';
  var csrfToken = '';

  var estado = {
    tipo: '',
    variedad: '',
    q: '',
    carrito: cargarCarrito(),
  };

  /* ---------------------------------------------------------------- utils */
  function $(sel) { return document.querySelector(sel); }

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

  function money(valor) {
    var n = Number(valor || 0);
    return n.toLocaleString('es-AR', { style: 'currency', currency: 'ARS' });
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

  function guardarCarrito() {
    try {
      localStorage.setItem(CARRITO_KEY, JSON.stringify(estado.carrito));
    } catch (e) { /* almacenamiento no disponible */ }
  }

  function cargarCarrito() {
    try {
      return JSON.parse(localStorage.getItem(CARRITO_KEY)) || [];
    } catch (e) {
      return [];
    }
  }

  /* ------------------------------------------------------------- catálogo */
  function urlCatalogo() {
    var params = new URLSearchParams();
    if (estado.tipo) params.set('tipo', estado.tipo);
    if (estado.variedad) params.set('variedad', estado.variedad);
    if (estado.q) params.set('q', estado.q);
    var s = params.toString();
    return '/productos' + (s ? '?' + s : '');
  }

  function cargarProductos() {
    return api(urlCatalogo()).then(function (resp) {
      if (!resp.ok) {
        renderErrorProductos(resp.data && resp.data.error);
        return;
      }
      renderProductos(resp.data.productos);
      renderResultado(resp.data.filtros, resp.data.total);
    });
  }

  function renderProductos(productos) {
    var grid = $('#productos-grid');
    vaciar(grid);

    if (!productos || productos.length === 0) {
      grid.appendChild(elemento('p', 'empty', 'No encontramos productos con esos filtros.'));
      return;
    }

    productos.forEach(function (p) {
      window.__productos[p.id] = p;

      var tarjeta = elemento('article', 'product-card');

      var top = elemento('div', 'product-top');
      top.appendChild(elemento('h3', 'product-name', p.nombre));
      top.appendChild(elemento('span', 'product-price', money(p.precio)));
      tarjeta.appendChild(top);

      var tags = elemento('div', 'product-tags');
      tags.appendChild(elemento('span', 'tag', p.tipo));
      if (p.variedad) tags.appendChild(elemento('span', 'tag tag-origen', p.variedad));
      if (p.tamano) tags.appendChild(elemento('span', 'tag', p.tamano));
      tarjeta.appendChild(tags);

      tarjeta.appendChild(elemento('p', 'product-desc', p.descripcion));

      var agregar = elemento('button', 'btn btn-ghost btn-agregar', 'Agregar');
      agregar.setAttribute('data-id', txt(p.id));
      tarjeta.appendChild(agregar);

      grid.appendChild(tarjeta);
    });
  }

  function renderResultado(filtros, total) {
    var el = $('#resultado-busqueda');
    vaciar(el);

    if (filtros && filtros.q) {
      el.appendChild(document.createTextNode('Resultados para '));
      el.appendChild(elemento('strong', '', filtros.q));
      el.appendChild(document.createTextNode(' — ' + txt(total) + ' producto(s)'));
    } else {
      el.textContent = txt(total) + ' producto(s) en el menú';
    }
  }

  function renderErrorProductos(mensaje) {
    var grid = $('#productos-grid');
    vaciar(grid);
    grid.appendChild(elemento(
      'p',
      'empty',
      'No se pudo cargar el menú: ' + (mensaje || 'error desconocido')
    ));
  }

  /* --------------------------------------------------------------- carrito */
  function agregarAlCarrito(productoId) {
    var existente = null;
    for (var i = 0; i < estado.carrito.length; i++) {
      if (String(estado.carrito[i].id) === String(productoId)) existente = estado.carrito[i];
    }
    if (existente) {
      existente.cantidad += 1;
    } else {
      estado.carrito.push({
        id: productoId,
        nombre: window.__productos[productoId] ? window.__productos[productoId].nombre : 'Producto',
        precio: window.__productos[productoId] ? window.__productos[productoId].precio : 0,
        cantidad: 1,
      });
    }
    guardarCarrito();
    renderCarrito();
  }

  function cambiarCantidad(indice, delta) {
    var item = estado.carrito[indice];
    if (!item) return;
    item.cantidad += delta;
    if (item.cantidad <= 0) estado.carrito.splice(indice, 1);
    guardarCarrito();
    renderCarrito();
  }

  function quitarDelCarrito(indice) {
    estado.carrito.splice(indice, 1);
    guardarCarrito();
    renderCarrito();
  }

  function botonCantidad(accion, indice, etiqueta) {
    var btn = elemento('button', '', etiqueta);
    btn.type = 'button';
    btn.setAttribute('data-acc', accion);
    btn.setAttribute('data-i', txt(indice));
    return btn;
  }

  function renderCarrito() {
    var cont = $('#carrito');
    var lista = $('#resumen-carrito');
    var total = 0;

    vaciar(cont);
    vaciar(lista);

    if (estado.carrito.length === 0) {
      cont.appendChild(elemento('p', 'empty', 'El carrito está vacío.'));
      $('#resumen-total').textContent = money(0);
      return;
    }

    estado.carrito.forEach(function (item, i) {
      var subtotal = item.precio * item.cantidad;
      total += subtotal;

      var fila = elemento('div', 'cart-item');

      var datos = elemento('div');
      datos.appendChild(elemento('div', 'cart-item-name', item.nombre));
      datos.appendChild(elemento('div', 'cart-item-meta', money(item.precio) + ' c/u'));
      fila.appendChild(datos);

      var cantidad = elemento('div', 'qty-control');
      cantidad.appendChild(botonCantidad('menos', i, '\u2212'));
      cantidad.appendChild(elemento('span', '', item.cantidad));
      cantidad.appendChild(botonCantidad('mas', i, '+'));
      fila.appendChild(cantidad);

      var derecha = elemento('div');
      derecha.appendChild(elemento('div', 'cart-item-price', money(subtotal)));
      var quitar = elemento('button', 'link-danger', 'Quitar');
      quitar.type = 'button';
      quitar.setAttribute('data-acc', 'quitar');
      quitar.setAttribute('data-i', txt(i));
      derecha.appendChild(quitar);
      fila.appendChild(derecha);

      cont.appendChild(fila);

      var li = document.createElement('li');
      li.appendChild(elemento('span', '', txt(item.nombre) + ' × ' + txt(item.cantidad)));
      li.appendChild(elemento('span', '', money(item.precio * item.cantidad)));
      lista.appendChild(li);
    });

    $('#resumen-total').textContent = money(total);
  }

  /* ---------------------------------------------------------------- pedidos */
  function enviarPedido(evento) {
    evento.preventDefault();
    var feedback = $('#pedido-feedback');
    feedback.className = 'form-feedback';
    feedback.textContent = 'Enviando…';

    postJSON('/pedidos', {
      mesa: $('#pedido-mesa').value,
      cliente: $('#pedido-cliente').value,
      items: estado.carrito.map(function (item) {
        return { productoId: item.id, cantidad: item.cantidad };
      }),
    }).then(function (resp) {
      if (!resp.ok) {
        feedback.className = 'form-feedback is-error';
        feedback.textContent = 'No pudimos enviar el pedido: ' +
          (resp.data.error || 'error desconocido');
        return;
      }
      feedback.className = 'form-feedback is-ok';
      feedback.textContent = '¡Pedido #' + resp.data.id + ' recibido! Total ' + money(resp.data.total) +
        '. Te atendemos en la mesa ' + resp.data.mesa + '.';
      estado.carrito = [];
      guardarCarrito();
      renderCarrito();
      $('#form-pedido').reset();
    }).catch(function () {
      feedback.className = 'form-feedback is-error';
      feedback.textContent = 'Error de conexión con el servidor.';
    });
  }

  /* --------------------------------------------------------------- reseñas */
  function cargarReseñas() {
    return api('/comentarios').then(function (resp) {
      var cont = $('#lista-resenas');
      vaciar(cont);

      if (!resp.ok || !resp.data.comentarios || resp.data.comentarios.length === 0) {
        cont.appendChild(elemento('p', 'empty', 'Todavía no hay reseñas. ¡Sé el primero!'));
        return;
      }

      resp.data.comentarios.forEach(function (c) {
        var estrellas = '';
        for (var i = 0; i < Number(c.calificacion || 0); i++) estrellas += '★';

        var reseña = elemento('article', 'review');
        var head = elemento('div', 'review-head');
        head.appendChild(elemento('span', 'review-author', c.autor));
        head.appendChild(elemento('span', 'review-stars', estrellas));
        reseña.appendChild(head);
        reseña.appendChild(elemento('p', 'review-text', c.texto));
        cont.appendChild(reseña);
      });
    });
  }

  function enviarReseña(evento) {
    evento.preventDefault();
    var feedback = $('#resena-feedback');
    feedback.className = 'form-feedback';
    feedback.textContent = 'Publicando…';

    postJSON('/comentarios', {
      autor: $('#resena-autor').value,
      texto: $('#resena-texto').value,
      calificacion: Number($('#resena-calificacion').value),
    }).then(function (resp) {
      if (!resp.ok) {
        feedback.className = 'form-feedback is-error';
        feedback.textContent = 'No se pudo publicar: ' + (resp.data.error || 'error desconocido');
        return;
      }
      feedback.className = 'form-feedback is-ok';
      feedback.textContent = '¡Gracias por tu reseña!';
      $('#form-resena').reset();
      cargarReseñas();
    });
  }

  /* ------------------------------------------------------------- listeners */
  function init() {
    window.__productos = {};

    // Filtros
    document.querySelectorAll('.chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        document.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('is-active'); });
        chip.classList.add('is-active');
        estado.tipo = chip.getAttribute('data-tipo');
        cargarProductos();
      });
    });

    $('#filtro-variedad').addEventListener('change', function (e) {
      estado.variedad = e.target.value;
      cargarProductos();
    });

    var temporizador = null;
    $('#filtro-busqueda').addEventListener('input', function (e) {
      estado.q = e.target.value;
      clearTimeout(temporizador);
      temporizador = setTimeout(cargarProductos, 250);
    });

    // Carrito (delegación de eventos)
    $('#productos-grid').addEventListener('click', function (e) {
      var btn = e.target.closest('.btn-agregar');
      if (!btn) return;
      agregarAlCarrito(btn.getAttribute('data-id'));
    });

    $('#carrito').addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      var i = Number(btn.getAttribute('data-i'));
      var accion = btn.getAttribute('data-acc');
      if (accion === 'mas') cambiarCantidad(i, 1);
      else if (accion === 'menos') cambiarCantidad(i, -1);
      else if (accion === 'quitar') quitarDelCarrito(i);
    });

    $('#form-pedido').addEventListener('submit', enviarPedido);
    $('#form-resena').addEventListener('submit', enviarReseña);

    // Carga inicial
    api(urlCatalogo()).then(function (resp) {
      if (resp.ok) {
        (resp.data.productos || []).forEach(function (p) { window.__productos[p.id] = p; });
        renderProductos(resp.data.productos);
        renderResultado(resp.data.filtros, resp.data.total);
      } else {
        renderErrorProductos(resp.data.error);
      }
    });
    cargarReseñas();
    renderCarrito();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
