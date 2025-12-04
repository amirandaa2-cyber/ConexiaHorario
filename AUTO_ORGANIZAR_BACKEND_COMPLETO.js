// =====================================================
// ENDPOINT COMPLETO: /api/auto-organizar
// Implementa TODAS las soluciones solicitadas:
// 1. Manejo de turnos (Diurno vs Vespertino)
// 2. Asignación correcta de docentes por módulo (no repetir)
// 3. Asignación real de salas disponibles
// 4. Duración correcta de bloques (horas pedagógicas)
// 5. Logs completos y manejo de errores
// =====================================================

app.post('/api/auto-organizar', async (req, res) => {
	try {
		const { carreraId, semanas = 1, fechaInicio, turno = 'Diurno' } = req.body;
		console.log('[AUTO-ORGANIZAR] Request recibido:', { carreraId, semanas, fechaInicio, turno });

		if (!carreraId) {
			console.warn('[AUTO-ORGANIZAR] Error: carreraId faltante');
			return res.status(400).json({ error: 'carreraId es obligatorio' });
		}

		// ========== SOLUCI\u00d3N 1: Definir lapsos horarios por turno ==========
		const rangosHorarios = {
			Diurno: { 
				bloqueInicio: 1,  // 08:30
				bloqueFin: 11,    // ~14:00
				label: '08:30-14:00'
			},
			Vespertino: { 
				bloqueInicio: 18, // 18:00
				bloqueFin: 22,    // 22:00
				label: '18:00-22:00'
			}
		};

		const rango = rangosHorarios[turno] || rangosHorarios.Diurno;
		console.log(`[AUTO-ORGANIZAR] Turno ${turno}: ${rango.label}, bloques ${rango.bloqueInicio}-${rango.bloqueFin}`);

		// ========== Obtener módulos de la carrera ==========
		const { rows: modulos } = await db.query(
			`SELECT m.id, m.nombre, m.codigo_asignatura, m."horasSemana", m.turno
			 FROM modulos m
			 WHERE m.carrera_id = $1
			 ORDER BY m."horasSemana" DESC`,
			[carreraId]
		);

		console.log(`[AUTO-ORGANIZAR] Módulos encontrados: ${modulos.length}`);
		if (!modulos.length) {
			return res.json({ 
				ok: true, 
				mensaje: 'No hay módulos en esta carrera', 
				asignaciones: [],
				errores: []
			});
		}

		// ========== SOLUCIÓN 2: Obtener docentes asignados a la carrera ==========
		const docentes = await getDocentesPorCarrera(carreraId);
		console.log(`[AUTO-ORGANIZAR] Docentes elegibles: ${docentes.length}`);

		if (!docentes.length) {
			console.warn('[AUTO-ORGANIZAR] Error: sin docentes para carrera', carreraId);
			return res.status(400).json({ 
				error: 'No hay docentes asignados a esta carrera en docentes_carreras' 
			});
		}

		// ========== SOLUCIÓN 2: Obtener salas disponibles ==========
		const { rows: todasLasSalas } = await db.query(
			`SELECT id, nombre, capacidad FROM salas ORDER BY nombre ASC`
		);
		console.log(`[AUTO-ORGANIZAR] Salas totales: ${todasLasSalas.length}`);

		if (todasLasSalas.length === 0) {
			console.warn('[AUTO-ORGANIZAR] Warning: sin salas en el sistema');
		}

		// ========== Configurar fechas de asignación ==========
		const fechaBase = fechaInicio ? new Date(fechaInicio) : new Date();
		const asignaciones = [];
		const errores = [];
		let docenteIndex = 0; // Para rotar docentes entre módulos

		// ========== LOOP PRINCIPAL: Asignar cada módulo ==========
		for (const modulo of modulos) {
			// ===== SOLUCIÓN 3: Calcular duración real en bloques =====
			const horasSemanales = Number(modulo.horasSemana) || 0;
			const minutosNecesarios = horasSemanales * 60;
			const bloquesNecesarios = Math.ceil(minutosNecesarios / BLOCK_MINUTES);
			
			console.log(`[AUTO-ORGANIZAR] Módulo "${modulo.nombre}": ${horasSemanales}h = ${minutosNecesarios}min = ${bloquesNecesarios} bloques`);
			
			if (bloquesNecesarios === 0) {
				console.log(`[AUTO-ORGANIZAR] Módulo sin horas, omitiendo`);
				continue;
			}

			// ===== SOLUCIÓN 2: Seleccionar docente (rotar entre disponibles) =====
			const docenteAsignado = docentes[docenteIndex % docentes.length];
			docenteIndex++; // Siguiente módulo usará otro docente

			console.log(`[AUTO-ORGANIZAR] Asignando docente: ${docenteAsignado.nombre} (${docenteAsignado.id})`);

			// ===== Buscar slots disponibles para asignar este módulo =====
			let bloquesAsignados = 0;
			const intentosMaximos = semanas * 5 * (rango.bloqueFin - rango.bloqueInicio + 1); // semanas * días * bloques_por_día
			let intentos = 0;

			// Intentar asignar en diferentes días/bloques hasta completar
			for (let semana = 0; semana < semanas && bloquesAsignados < bloquesNecesarios; semana++) {
				for (let diaSemana = 1; diaSemana <= 5 && bloquesAsignados < bloquesNecesarios; diaSemana++) {
					// Calcular fecha específica
					const fecha = new Date(fechaBase);
					fecha.setDate(fecha.getDate() + (semana * 7) + (diaSemana - 1));
					const fechaStr = fecha.toISOString().split('T')[0];

					// ===== SOLUCIÓN 1: Recorrer solo bloques del turno seleccionado =====
					for (let bloque = rango.bloqueInicio; bloque <= rango.bloqueFin && bloquesAsignados < bloquesNecesarios; bloque++) {
						intentos++;
						if (intentos > intentosMaximos) break;

						// Calcular timestamps del bloque
						const horaInicio = 8 * 60 + 30 + (bloque - 1) * BLOCK_MINUTES; // minutos desde medianoche
						const startTime = new Date(fecha);
						startTime.setHours(Math.floor(horaInicio / 60), horaInicio % 60, 0, 0);
						
						const endTime = new Date(startTime);
						endTime.setMinutes(endTime.getMinutes() + BLOCK_MINUTES);

						// ===== SOLUCIÓN 2: Buscar sala disponible =====
						let salaAsignada = null;

						for (const sala of todasLasSalas) {
							// Verificar si la sala está libre en este horario
							const { rows: conflictos } = await db.query(
								`SELECT id FROM events 
								 WHERE sala_id = $1 
								   AND start < $2 
								   AND "end" > $3
								 LIMIT 1`,
								[sala.id, endTime.toISOString(), startTime.toISOString()]
							);

							if (conflictos.length === 0) {
								salaAsignada = sala;
								break; // Encontramos sala libre
							}
						}

						// ===== SOLUCIÓN 2: Si no hay sala, registrar error =====
						if (!salaAsignada) {
							if (bloquesAsignados === 0) { // Solo log del primer bloque
								console.log(`[AUTO-ORGANIZAR] Sin sala disponible para módulo "${modulo.nombre}" en ${fechaStr} bloque ${bloque}`);
								errores.push({
									modulo: modulo.nombre,
									moduloId: modulo.id,
									error: `Sin sala disponible en ${fechaStr} bloque ${bloque}`
								});
							}
							continue; // Intentar siguiente bloque
						}

						// ===== Verificar conflicto de docente =====
						const { rows: conflictosDocente } = await db.query(
							`SELECT id FROM events 
							 WHERE docente_id = $1 
							   AND start < $2 
							   AND "end" > $3
							 LIMIT 1`,
							[docenteAsignado.id, endTime.toISOString(), startTime.toISOString()]
						);

						if (conflictosDocente.length > 0) {
							console.log(`[AUTO-ORGANIZAR] Docente ${docenteAsignado.nombre} ocupado en ${fechaStr} bloque ${bloque}`);
							continue; // Docente ocupado, intentar siguiente bloque
						}

						// ===== TODO OK: Crear evento =====
						try {
							const resultado = await asignarEvento({
								moduloId: modulo.id,
								docenteId: docenteAsignado.id,
								salaId: salaAsignada.id,
								start: startTime.toISOString(),
								end: endTime.toISOString()
							});

							asignaciones.push({
								eventoId: resultado.id,
								moduloId: modulo.id,
								modulo: modulo.nombre,
								docenteId: docenteAsignado.id,
								docente: docenteAsignado.nombre,
								salaId: salaAsignada.id,
								sala: salaAsignada.nombre,
								start: startTime.toISOString(),
								end: endTime.toISOString(),
								fecha: fechaStr,
								bloque,
								turno
							});

							bloquesAsignados++;
							console.log(`[AUTO-ORGANIZAR] ✓ Evento creado: ${modulo.nombre} - ${fechaStr} bloque ${bloque} (${bloquesAsignados}/${bloquesNecesarios})`);
							
						} catch (error) {
							console.error(`[AUTO-ORGANIZAR] Error creando evento:`, error.message);
							errores.push({
								modulo: modulo.nombre,
								moduloId: modulo.id,
								error: `Error al crear evento: ${error.message}`
							});
						}
					}
				}
			}

			// ===== SOLUCIÓN 4: Log si no se completaron todos los bloques =====
			if (bloquesAsignados < bloquesNecesarios) {
				const mensaje = `Módulo "${modulo.nombre}": solo se asignaron ${bloquesAsignados} de ${bloquesNecesarios} bloques requeridos`;
				console.warn(`[AUTO-ORGANIZAR] ${mensaje}`);
				errores.push({
					modulo: modulo.nombre,
					moduloId: modulo.id,
					error: mensaje,
					bloquesAsignados,
					bloquesNecesarios
				});
			}
		}

		// ===== Resultado final =====
		const resultado = {
			ok: true,
			mensaje: `Auto-organización completada para turno ${turno}`,
			asignaciones,
			errores,
			resumen: {
				turno,
				totalModulos: modulos.length,
				totalAsignaciones: asignaciones.length,
				totalErrores: errores.length,
				docentesUsados: docentes.length,
				salasDisponibles: todasLasSalas.length
			}
		};

		console.log('[AUTO-ORGANIZAR] Resultado final:', {
			totalAsignaciones: asignaciones.length,
			totalErrores: errores.length
		});

		res.json(resultado);

	} catch (error) {
		console.error('[AUTO-ORGANIZAR] Error crítico:', error);
		res.status(500).json({ 
			error: 'Error interno del servidor',
			mensaje: error.message 
		});
	}
});
