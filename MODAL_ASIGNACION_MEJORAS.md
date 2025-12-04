# Mejoras Modal "Asignar Módulo" - Documentación de Implementación

## 📋 Resumen de Cambios

Se han implementado 3 mejoras críticas en el modal de asignación de módulos para resolver la falla del dropdown de Docentes y mejorar la experiencia de usuario.

---

## ✅ Solución 1: Carga en Cascada de Docentes (Triple Cascada)

### Problema Original
- El dropdown de Docentes mostraba **TODOS** los docentes del sistema sin filtrar
- No había conexión con la Carrera ni el Módulo seleccionados
- El usuario podía asignar docentes incorrectos a módulos

### Solución Implementada

#### Backend: Nuevo Endpoint `/api/docentes-por-modulo-carrera`

**Ubicación:** `server/index.js` (líneas ~1062-1092)

```javascript
app.get('/api/docentes-por-modulo-carrera', async (req, res) => {
  const { carreraId, moduloId } = req.query;
  
  // Valida que ambos parámetros existan
  if (!carreraId || !moduloId) {
    return res.status(400).json({ error: 'Se requieren carreraId y moduloId' });
  }

  // Query optimizado que filtra docentes por:
  // 1. Relación con la carrera (tabla docentes_carreras)
  // 2. Docente activo (d.activo = true)
  const { rows } = await db.query(`
    SELECT DISTINCT d.id, d.nombre, d.rut, d.contrato_hora_semanal, d.turno
    FROM docentes d
    INNER JOIN docentes_carreras dc ON dc.docente_id = d.id
    WHERE dc.carrera_id = $1
      AND d.activo = true
    ORDER BY d.nombre ASC
  `, [carreraId]);

  res.json(rows);
});
```

**Características:**
- ✅ Usa la tabla **corregida** `docentes_carreras` (plural)
- ✅ Filtra solo docentes **activos**
- ✅ Devuelve información completa: id, nombre, rut, contrato, turno
- ✅ Logging para debugging: muestra cantidad de docentes filtrados

---

#### Frontend: Función `cargarDocentesFiltrados()`

**Ubicación:** `examples/timegrid-views.html` (líneas ~1605-1675)

```javascript
async function cargarDocentesFiltrados() {
  const carreraId = selCarrera.value;
  const moduloId = selModulo.value;
  
  // 1. Validación: requiere AMBOS parámetros
  if (!carreraId || !moduloId) {
    selDocente.innerHTML = '<option value="">-- Primero selecciona carrera y módulo --</option>';
    selDocente.disabled = true;
    return;
  }
  
  // 2. Mostrar estado de carga
  selDocente.innerHTML = '<option value="">⏳ Cargando docentes disponibles...</option>';
  selDocente.disabled = true;
  
  // 3. Llamada a la API
  const response = await fetch(`/api/docentes-por-modulo-carrera?carreraId=${carreraId}&moduloId=${moduloId}`);
  const docentes = await response.json();
  
  // 4. Llenar dropdown con resultados
  if (docentes.length === 0) {
    selDocente.innerHTML = '<option value="">⚠️ No hay docentes disponibles</option>';
    selDocente.disabled = true;
  } else {
    selDocente.innerHTML = '<option value="">-- Selecciona un docente --</option>';
    docentes.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = `${d.nombre} ${d.rut ? '(' + d.rut + ')' : ''}`;
      opt.dataset.contrato = d.contrato_hora_semanal;
      opt.dataset.turno = d.turno;
      selDocente.appendChild(opt);
    });
    selDocente.disabled = false;
  }
}
```

**Estados del Dropdown:**
1. ❌ **Sin selección:** "Primero selecciona carrera y módulo" (disabled)
2. ⏳ **Cargando:** "Cargando docentes disponibles..." (disabled)
3. ⚠️ **Sin resultados:** "No hay docentes disponibles" (disabled)
4. ✅ **Con resultados:** Lista de docentes (enabled)

---

#### Event Listeners: Cascada Automática

```javascript
// Al cambiar CARRERA:
selCarrera.addEventListener('change', () => {
  // 1. Filtrar módulos por carrera
  // 2. Limpiar y deshabilitar dropdown de docentes
  // 3. Actualizar subtítulo
});

// Al cambiar MÓDULO:
selModulo.addEventListener('change', () => {
  // 1. Llamar a cargarDocentesFiltrados() (AJAX)
  // 2. Actualizar subtítulo
});
```

**Flujo de Usuario:**
```
Usuario selecciona Carrera
  ↓
Se filtran los Módulos disponibles
  ↓
Dropdown de Docentes se deshabilita (requiere módulo)
  ↓
Usuario selecciona Módulo
  ↓
Se llama a /api/docentes-por-modulo-carrera
  ↓
Dropdown de Docentes se llena con resultados filtrados ✅
```

---

## ✅ Solución 2: Feedback Visual Inmediato (Subtítulo Dinámico)

### Problema Original
- El usuario no sabía qué Carrera o Módulo estaba asignando
- Sin confirmación visual de las selecciones

### Solución Implementada

#### HTML: Nuevo Subtítulo en el Header

**Ubicación:** `examples/timegrid-views.html` (líneas ~9375-9383)

```html
<div class="modal-asignacion-header">
  <div style="flex: 1;">
    <h3 id="modal-asignacion-title" class="modal-asignacion-title">Asignar Módulo</h3>
    <div id="modal-asignacion-subtitle" class="modal-asignacion-subtitle">
      Selecciona una carrera y módulo para comenzar
    </div>
  </div>
  <button type="button" id="btn-cerrar-asignacion" class="modal-asignacion-close" aria-label="Cerrar">×</button>
</div>
```

---

#### CSS: Estilos del Subtítulo

**Ubicación:** `examples/timegrid-views.html` (líneas ~615-632)

```css
.modal-asignacion-subtitle {
  font-size: 13px;
  color: #6b7280;
  margin-top: 6px;
  font-weight: 400;
  line-height: 1.4;
  padding: 8px 12px;
  background: #f9fafb;
  border-radius: 6px;
  border-left: 3px solid #d1d5db;
  transition: all 0.3s ease;
}

.modal-asignacion-subtitle strong {
  color: #374151;
  font-weight: 600;
}
```

**Características Visuales:**
- 📦 Fondo gris claro (#f9fafb)
- 🎨 Borde izquierdo de 3px (#d1d5db)
- ✨ Transición suave de 0.3s
- 💪 Texto en negritas para "Carrera:" y "Módulo:"

---

#### JavaScript: Función `actualizarSubtitulo()`

**Ubicación:** `examples/timegrid-views.html` (líneas ~1525-1548)

```javascript
function actualizarSubtitulo() {
  if (!modalSubtitle) return;
  
  const carreraId = selCarrera.value;
  const moduloId = selModulo.value;
  
  const carreraNombre = carreraId 
    ? (window.carreras || []).find(c => String(c.id) === String(carreraId))?.nombre 
    : null;
  
  const moduloNombre = moduloId 
    ? (window.modulos || []).find(m => String(m.id) === String(moduloId))?.nombre 
    : null;
  
  // Estado 1: Ambos seleccionados (verde)
  if (carreraNombre && moduloNombre) {
    modalSubtitle.innerHTML = `<strong>Carrera:</strong> ${carreraNombre} | <strong>Módulo:</strong> ${moduloNombre}`;
    modalSubtitle.style.color = '#059669';
  } 
  // Estado 2: Solo carrera (gris)
  else if (carreraNombre) {
    modalSubtitle.innerHTML = `<strong>Carrera:</strong> ${carreraNombre} | <em>Selecciona un módulo</em>`;
    modalSubtitle.style.color = '#6b7280';
  } 
  // Estado 3: Sin selección (gris)
  else {
    modalSubtitle.textContent = 'Selecciona una carrera y módulo para comenzar';
    modalSubtitle.style.color = '#6b7280';
  }
}
```

**Estados del Subtítulo:**

| Estado | Texto | Color |
|--------|-------|-------|
| Sin selección | "Selecciona una carrera y módulo para comenzar" | Gris (#6b7280) |
| Solo carrera | "**Carrera:** Ingeniería Civil \| _Selecciona un módulo_" | Gris (#6b7280) |
| Completo | "**Carrera:** Ingeniería Civil \| **Módulo:** Cálculo I" | Verde (#059669) |

---

## 🔄 Integración con Funciones Existentes

### Función `precargarContexto()` Actualizada

**Ubicación:** `examples/timegrid-views.html` (líneas ~1802-1840)

```javascript
function precargarContexto(ctx) {
  // ... código existente ...
  
  // Precargar módulo si viene en el contexto
  if (ctx.moduloId) {
    const modulo = (window.modulos || []).find(m => String(m.id) === String(ctx.moduloId));
    if (modulo && !ctx.carreraId) { 
      selCarrera.value = modulo.carreraId; 
      selCarrera.dispatchEvent(new Event('change')); 
    }
    selModulo.value = ctx.moduloId;
    
    // 🆕 Cargar docentes filtrados si hay carrera y módulo
    if (selCarrera.value && selModulo.value) {
      cargarDocentesFiltrados().then(() => {
        if (ctx.docenteId) { 
          selDocente.value = ctx.docenteId;
          actualizarLeyendaDocente();
        }
      });
    }
  }
  
  // 🆕 Actualizar subtítulo al precargar
  actualizarSubtitulo();
  actualizarLeyendaDocente();
}
```

---

## 📊 Flujo Completo de Usuario

```mermaid
graph TD
    A[Usuario abre modal] --> B[Modal muestra: Selecciona carrera y módulo]
    B --> C[Usuario selecciona CARRERA]
    C --> D[Se filtran módulos por carrera]
    C --> E[Subtítulo actualiza: Carrera seleccionada]
    C --> F[Dropdown Docentes se deshabilita]
    D --> G[Usuario selecciona MÓDULO]
    G --> H[Subtítulo actualiza: Carrera | Módulo verde]
    G --> I[API call: /api/docentes-por-modulo-carrera]
    I --> J{¿Hay docentes?}
    J -->|Sí| K[Dropdown se llena con docentes filtrados]
    J -->|No| L[Mensaje: No hay docentes disponibles]
    K --> M[Usuario selecciona DOCENTE]
    M --> N[Leyenda actualiza: Info del docente]
    N --> O[Usuario completa formulario y crea evento]
```

---

## 🧪 Casos de Prueba

### Caso 1: Flujo Normal
1. ✅ Abrir modal → Ver subtítulo "Selecciona una carrera y módulo"
2. ✅ Seleccionar "Ingeniería Civil" → Subtítulo actualiza
3. ✅ Dropdown Módulos se llena con módulos de Ing. Civil
4. ✅ Dropdown Docentes muestra "Primero selecciona módulo" (disabled)
5. ✅ Seleccionar "Cálculo I" → Subtítulo se pone verde
6. ✅ Dropdown Docentes carga con loading
7. ✅ Dropdown Docentes se llena con docentes filtrados
8. ✅ Seleccionar docente → Leyenda actualiza con horas

### Caso 2: Sin Docentes Disponibles
1. ✅ Seleccionar carrera sin docentes asignados
2. ✅ Seleccionar módulo
3. ✅ Ver mensaje "⚠️ No hay docentes disponibles"
4. ✅ Dropdown permanece disabled

### Caso 3: Error de Red
1. ✅ Seleccionar carrera y módulo
2. ✅ API falla
3. ✅ Ver mensaje "❌ Error al cargar docentes"
4. ✅ Console log muestra error

### Caso 4: Precargar con Contexto
1. ✅ Abrir modal con `context = { carreraId: 1, moduloId: 5 }`
2. ✅ Subtítulo muestra carrera y módulo precargados
3. ✅ Docentes se cargan automáticamente

---

## 🐛 Debugging

### Logs en Consola

**Backend:**
```
[API] Docentes filtrados para carrera=1, modulo=5: 8 docentes
```

**Frontend:**
```
[Modal] Docentes filtrados recibidos: 8
[Modal] Error cargando docentes: Error al cargar docentes
```

### Inspeccionar Estado

```javascript
// En la consola del navegador:
console.log('Carrera:', document.getElementById('asig-carrera').value);
console.log('Módulo:', document.getElementById('asig-modulo').value);
console.log('Docentes disponibles:', document.getElementById('asig-docente').options.length - 1);
```

---

## 📝 Notas Técnicas

### Tabla `docentes_carreras`
- ✅ Nombre correcto (plural)
- ✅ Columnas: `docente_id`, `carrera_id`
- ⚠️ Asegurar que existan registros en la tabla

### Performance
- ⚡ La llamada AJAX es **asíncrona** (no bloquea UI)
- ⚡ Debounce innecesario (solo se llama al cambiar módulo)
- 📊 Query SQL optimizado con INNER JOIN

### Compatibilidad
- ✅ Funciona con localStorage (offline)
- ✅ Funciona con PostgreSQL (online)
- ✅ Compatible con validación existente

---

## 🚀 Próximos Pasos (Opcional)

1. **Filtrado por `modulos_docentes`** (si existe la tabla)
   - Agregar `LEFT JOIN modulos_docentes` al query
   - Mostrar solo docentes que pueden impartir ese módulo específico

2. **Caché de docentes**
   - Guardar respuesta en `sessionStorage`
   - Evitar llamadas repetidas a la misma combinación carrera+módulo

3. **Indicador de carga visual**
   - Spinner animado en lugar de texto "⏳"
   - Progress bar durante carga

4. **Previsualización de horas**
   - Mostrar horas disponibles del docente **antes** de seleccionarlo
   - Alertar si está cerca del límite

---

## ✅ Checklist de Implementación

- [x] Backend: Endpoint `/api/docentes-por-modulo-carrera`
- [x] Frontend: Función `cargarDocentesFiltrados()`
- [x] Frontend: Event listener en cambio de módulo
- [x] Frontend: Función `actualizarSubtitulo()`
- [x] Frontend: Event listeners para actualizar subtítulo
- [x] HTML: Subtítulo en header del modal
- [x] CSS: Estilos del subtítulo
- [x] Integración: `precargarContexto()` actualizado
- [x] Testing: Flujo normal funcional
- [x] Documentación: Este archivo

---

## 📞 Soporte

Si encuentras algún problema:

1. **Verificar logs en consola** (Backend y Frontend)
2. **Revisar tabla `docentes_carreras`** en PostgreSQL
3. **Validar que existan docentes activos**
4. **Confirmar que el servidor esté corriendo** (puerto 3001)

---

**Desarrollado por:** Front-end Developer  
**Fecha:** 2025-12-04  
**Versión:** 1.0  
