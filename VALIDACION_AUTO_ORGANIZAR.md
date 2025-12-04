# Plan de Validación: Auto-Organizar Carrera

## Resumen de Implementación

Se ha implementado el flujo completo Backend → Frontend → Renderizado para el botón "Auto-Organizar Carrera" con logs detallados en cada etapa crítica.

---

## 1. Backend: Logs en `/api/auto-organizar`

### Ubicación
`server/index.js` línea 1303+

### Logs Implementados

1. **Request recibido**:
   ```
   [AUTO-ORGANIZAR] Request recibido: { carreraId: 'xxx', semanas: 1, fechaInicio: '2025-12-04' }
   ```

2. **Módulos pendientes**:
   ```
   [AUTO-ORGANIZAR] Módulos pendientes encontrados: 5
   ```

3. **Docentes elegibles**:
   ```
   [AUTO-ORGANIZAR] Docentes elegibles: 8
   ```

4. **Resultado final**:
   ```json
   [AUTO-ORGANIZAR] Resultado final con resumen: {
     "ok": true,
     "asignaciones": [...],
     "resumen": {
       "totalAsignaciones": 12,
       "modulosProcesados": 5,
       "errores": 0
     }
   }
   ```

---

## 2. Frontend: Botón y Handler

### Ubicación
`examples/timegrid-views.html`

### Sección Nueva en Sidebar
- Grupo "Auto-Organizador API"
- Select de carreras (poblado dinámicamente)
- Input fecha inicio
- Input semanas
- Botón "🚀 Auto-Organizar Carrera"
- Div de status

### Handler `handleAutoOrganizarCarrera()`

#### Logs de Request:
```javascript
[AUTO-ORGANIZAR Frontend] Request: { carreraId: 'xxx', fechaInicio: '2025-12-04', semanas: 1 }
[AUTO-ORGANIZAR Frontend] Response status: 200
```

#### Logs de Respuesta:
```javascript
[AUTO-ORGANIZAR Frontend] Respuesta recibida: { ok: true, asignaciones: [...], resumen: {...} }
[AUTO-ORGANIZAR Frontend] Total asignaciones: 12
```

#### Logs de Mapeo:
```javascript
[AUTO-ORGANIZAR Frontend] Mapeando asignaciones a eventos...
[AUTO-ORGANIZAR Frontend] Evento mapeado: { id: 'xxx', title: 'Módulo - Docente', start: '...', extendedProps: {...} }
[AUTO-ORGANIZAR Frontend] Eventos agregados al calendario: 12
[AUTO-ORGANIZAR Frontend] Total eventos en storedEvents: 50
```

---

## 3. Validación de Renderizado

### Logs en `events()` (línea ~3625+)

1. **Eventos obtenidos**:
   ```
   [Calendar] events() - Eventos desde API: 50
   [Calendar] events() - Total storedEvents después de dedup: 50
   ```

2. **Filtro activo**:
   ```
   [Calendar] events() - Filtro carrera activo: 'carrera-123'
   ```

3. **Eventos renderizados**:
   ```
   [Calendar] events() - Eventos después de filtro carrera: 12
   [Calendar] events() - Eventos que se renderizarán: 12
   ```

---

## Pasos de Prueba

### Pre-requisitos
1. ✅ Activar Modo API en la interfaz: **Ajustes → Alternar Modo API**
2. ✅ Configurar `API_BASE` apuntando a servidor backend
3. ✅ Backend corriendo con `DATABASE_URL` configurado
4. ✅ Base de datos con:
   - Tabla `carreras` con al menos 1 carrera
   - Tabla `modulos` con módulos asignados a esa carrera
   - Tabla `docentes_carreras` con docentes asignados
   - Tabla `disponibilidad_horaria` con bloques de disponibilidad (opcional)

### Test 1: Conexión Carrera → Módulos

**Acción**: Abrir la app y ver el select de carreras

**Verificación**:
- ✅ El select "Carrera" en la sección "Auto-Organizador API" debe estar poblado
- ✅ Ver en consola: logs de `fetchCarreras()` y `poblarAutoOrganizarCarreras()`

---

### Test 2: Request Backend

**Acción**: 
1. Seleccionar una carrera
2. Ingresar fecha inicio (ej: 2025-12-09)
3. Semanas: 1
4. Click en "🚀 Auto-Organizar Carrera"

**Verificación Backend** (ver logs de `node server/index.js`):
```
[AUTO-ORGANIZAR] Request recibido: { carreraId: 'xxx', semanas: 1, fechaInicio: '2025-12-09' }
[AUTO-ORGANIZAR] Módulos pendientes encontrados: X
[AUTO-ORGANIZAR] Docentes elegibles: Y
[AUTO-ORGANIZAR] Resultado final con resumen: { ... totalAsignaciones: Z }
```

**Verificación Frontend** (consola del navegador):
```
[AUTO-ORGANIZAR Frontend] Request: { ... }
[AUTO-ORGANIZAR Frontend] Response status: 200
[AUTO-ORGANIZAR Frontend] Respuesta recibida: { ok: true, ... }
[AUTO-ORGANIZAR Frontend] Total asignaciones: Z
```

---

### Test 3: Mapeo y Renderizado

**Verificación Frontend** (consola del navegador):

1. **Mapeo exitoso**:
   ```
   [AUTO-ORGANIZAR Frontend] Mapeando asignaciones a eventos...
   [AUTO-ORGANIZAR Frontend] Evento mapeado: { ... }
   ...
   [AUTO-ORGANIZAR Frontend] Eventos agregados al calendario: Z
   ```

2. **Llamada a `events()`**:
   ```
   [Calendar] events() - Fetching eventos...
   [Calendar] events() - Eventos desde API: X
   [Calendar] events() - Total storedEvents después de dedup: X
   [Calendar] events() - Filtro carrera activo: 'xxx'
   [Calendar] events() - Eventos después de filtro carrera: Z
   [Calendar] events() - Eventos que se renderizarán: Z
   ```

3. **Visual**:
   - ✅ Ver bloques de 35 minutos renderizados en el calendario
   - ✅ Eventos con formato: "Nombre Módulo - Nombre Docente"
   - ✅ Colores correspondientes a la carrera
   - ✅ Hover muestra tooltip con sala, docente, módulo

---

### Test 4: Ajuste a Cuadrícula 35 minutos

**Verificación**:
- ✅ Cada evento debe alinearse perfectamente con los bloques de 35 minutos
- ✅ Horario de inicio: múltiplo de 35 minutos desde 08:30
- ✅ Ejemplo: 08:30-09:05, 09:05-09:40, 09:40-10:15, etc.

**Función involucrada**: `ajustarEventoABloque(event)` en `timegrid-views.html`

---

## Solución de Problemas

### Error: "Sin docentes elegibles"
- **Causa**: No hay docentes asignados a la carrera en la tabla `docentes_carreras`
- **Solución**: 
  ```sql
  INSERT INTO docentes_carreras (docente_id, carrera_id, activo, prioridad)
  VALUES ('docente-123', 'carrera-456', TRUE, 1);
  ```

### Error: "Sin módulos pendientes"
- **Causa**: Todos los módulos ya tienen eventos asignados
- **Solución**: Borrar eventos de prueba o crear nuevos módulos sin asignar

### Error 401: No autorizado
- **Causa**: Endpoint requiere autenticación
- **Solución**: Configurar variable de entorno `AUTO_ORGANIZE_ALLOW_PUBLIC=1` en el backend

### Eventos no se renderizan
1. Verificar logs en `[AUTO-ORGANIZAR Frontend]` para confirmar que `eventosAgregados > 0`
2. Verificar logs en `[Calendar] events()` para confirmar que eventos pasan el filtro
3. Si filtro de carrera está activo, verificar que `extendedProps.carreraId` coincide

---

## Estructura de Datos

### Formato de asignación del backend:
```json
{
  "eventoId": "uuid-xxx",
  "modulo": "Programación I",
  "moduloId": 123,
  "docente": "Juan Pérez",
  "docenteId": "12345678-9",
  "sala": "Lab A",
  "salaId": "sala-001",
  "fecha": "2025-12-09",
  "bloque": 5,
  "start": "2025-12-09T10:15:00Z",
  "end": "2025-12-09T10:50:00Z",
  "score": 85
}
```

### Formato de evento FullCalendar:
```json
{
  "id": "uuid-xxx",
  "title": "Programación I - Juan Pérez",
  "start": "2025-12-09T10:15:00Z",
  "end": "2025-12-09T10:50:00Z",
  "extendedProps": {
    "moduloId": 123,
    "docenteId": "12345678-9",
    "salaId": "sala-001",
    "carreraId": "carrera-456",
    "carreraNombre": "Ingeniería Civil Informática",
    "moduloNombre": "Programación I",
    "docenteNombre": "Juan Pérez",
    "salaNombre": "Lab A",
    "autoGenerado": true,
    "__meta": {
      "moduloId": "123",
      "docenteId": "12345678-9",
      "salaId": "sala-001"
    }
  }
}
```

---

## Checklist Final

- [ ] Backend devuelve status 200 con `asignaciones` array
- [ ] Frontend recibe respuesta sin error 401/404
- [ ] Mapeo convierte correctamente asignaciones → eventos FullCalendar
- [ ] `calendar.addEvent()` se ejecuta para cada asignación
- [ ] `storedEvents` contiene los nuevos eventos
- [ ] `events()` retorna eventos que incluyen los nuevos
- [ ] Calendario renderiza visualmente los bloques
- [ ] Bloques respetan cuadrícula de 35 minutos
- [ ] Tooltips muestran información completa
- [ ] Filtro por carrera funciona correctamente

---

## Contacto de Soporte

Si después de seguir estos pasos persiste el problema:
1. Capturar todos los logs de Backend (consola de Node.js)
2. Capturar todos los logs de Frontend (consola del navegador)
3. Tomar screenshot del estado del calendario
4. Verificar estructura de la BD (especialmente `modulos.horasSemana > 0`)
