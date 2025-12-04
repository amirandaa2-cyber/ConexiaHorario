const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');
const db = require('./db');
const { v4: uuidv4 } = require('uuid');
let dashboardRoutes = null;
try {
	const dashboardPath = path.join(__dirname, 'routes', 'dashboardRoutes.js');
	if (fs.existsSync(dashboardPath)) {
		dashboardRoutes = require('./routes/dashboardRoutes');
	} else {
		console.warn('dashboardRoutes no disponible: archivo no encontrado en', dashboardPath);
	}
} catch (e) {
	console.warn('dashboardRoutes no disponible:', e && e.message ? e.message : e);
}

const app = express();
app.use(cors());
// Serve static files from repository root so examples can be opened via http://localhost:3001/examples/...
app.use(express.static(path.join(__dirname, '..')));
app.use(bodyParser.json());

const dbReady = db && db.ready;
const AUTH_TOKEN_TTL_HOURS = parseInt(process.env.SESSION_TTL_HOURS || '12', 10);
const SESSION_IDLE_MINUTES = Math.max(parseInt(process.env.SESSION_IDLE_MINUTES || '30', 10), 0);
const SESSION_ACTIVITY_GRACE_SECONDS = Math.max(parseInt(process.env.SESSION_ACTIVITY_GRACE_SECONDS || '60', 10), 0);
const SESSION_ACTIVITY_GRACE_MS = SESSION_ACTIVITY_GRACE_SECONDS * 1000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET || undefined) : null;
const USE_DB_ONLY = /^(1|true)$/i.test(process.env.USE_DB_ONLY || '');
const AUTO_ORGANIZE_ALLOW_PUBLIC = /^(1|true)$/i.test(process.env.AUTO_ORGANIZE_ALLOW_PUBLIC || '');
const ALLOWED_ROLE_CODES = (process.env.ALLOWED_ROLE_CODES || 'admin,docente')
	.split(',')
	.map((code) => code.trim().toLowerCase())
	.filter(Boolean);
const BLOCK_MINUTES = 35;

// DAO helpers for auto-organize
async function getDocentesPorCarrera(carreraId) {
	const { rows } = await db.query(
		`SELECT d.id, d.nombre, d.contrato_hora_semanal AS contrato_semana
			 FROM docentes_carreras dc
			 JOIN docentes d ON d.id = dc.docente_id
			WHERE dc.carrera_id = $1
			ORDER BY d.nombre ASC`,
		[String(carreraId).trim()]
	);
	return rows;
}

async function getCargaDocente(docenteId) {
	const { rows } = await db.query(
		`SELECT COALESCE(SUM(ROUND(EXTRACT(EPOCH FROM ("end" - start)) / (60.0 * $2))), 0)::int AS bloques,
					COALESCE(MAX(d.contrato_hora_semanal), 0) AS contrato_semana
			 FROM events e
			 LEFT JOIN docentes d ON d.id = e.docente_id
			WHERE e.docente_id = $1`,
		[String(docenteId).trim(), BLOCK_MINUTES]
	);
	const bloques = Number(rows[0]?.bloques) || 0;
	const contratoSemana = Number(rows[0]?.contrato_semana) || 0;
	return { bloques, contratoSemana };
}

async function asignarEvento({ moduloId, docenteId, salaId, start, end }) {
	const id = uuidv4();
	const titleRow = await db.query('SELECT nombre, carrera_id FROM modulos WHERE id=$1', [moduloId]);
	const title = titleRow.rows[0]?.nombre || `Módulo ${moduloId}`;
	const carreraId = titleRow.rows[0]?.carrera_id ? String(titleRow.rows[0].carrera_id) : null;
	const extendedProps = mergeMetaIntoExtendedProps({}, { moduloId, docenteId, salaId, carreraId });
	await db.query(
		`INSERT INTO events (id, title, start, "end", modulo_id, docente_id, sala_id, extendedProps)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		 ON CONFLICT (title, start, "end") DO NOTHING`,
		[id, title, start, end, moduloId, docenteId, salaId, JSON.stringify(extendedProps)]
	);
	return { id };
}

// Funciones auxiliares para usar disponibilidad_horaria
async function docenteDisponibleEnBloque(docenteId, diaSemana, bloque, fecha = null) {
	const { rows } = await db.query(
		`SELECT docente_disponible_en_bloque($1, $2, $3, $4) AS disponible`,
		[docenteId, diaSemana, bloque, fecha]
	);
	return rows[0]?.disponible ?? true;
}

async function calcularScoreDisponibilidad(docenteId, salaId, moduloId, diaSemana, bloque, fecha = null) {
	const { rows } = await db.query(
		`SELECT calcular_score_disponibilidad($1, $2, $3, $4, $5, $6) AS score`,
		[docenteId, salaId, moduloId, diaSemana, bloque, fecha]
	);
	return rows[0]?.score ?? 50;
}

async function obtenerSalasDisponibles(carreraId, diaSemana, bloqueInicio, bloqueFin) {
	// Obtener salas sin restricción de carrera o permitidas para esta carrera
	const { rows } = await db.query(
		`SELECT DISTINCT s.id, s.nombre, s.capacidad
		 FROM salas s
		 LEFT JOIN sala_restriccion sr ON sr.sala_id = s.id
		 WHERE sr.carrera_id IS NULL OR sr.carrera_id = $1
		 ORDER BY s.capacidad DESC`,
		[carreraId]
	);
	return rows;
}

async function validarConflictosSala(salaId, start, end, excludeEventId = null) {
	const query = excludeEventId
		? `SELECT COUNT(*) AS conflictos FROM events 
		   WHERE sala_id = $1 
		   AND id != $4
		   AND NOT (start >= $3 OR "end" <= $2)`
		: `SELECT COUNT(*) AS conflictos FROM events 
		   WHERE sala_id = $1 
		   AND NOT (start >= $3 OR "end" <= $2)`;
	const params = excludeEventId ? [salaId, start, end, excludeEventId] : [salaId, start, end];
	const { rows } = await db.query(query, params);
	return Number(rows[0]?.conflictos || 0) === 0;
}

function handleDbError(res, err){
  console.error('Database error', err);
  res.status(500).json({ error: 'Database error', details: err.message });
}

function extractToken(req){
	const header = req.headers?.authorization || '';
	if (header.toLowerCase().startsWith('bearer ')) {
		return header.slice(7).trim();
	}
	if (req.headers && req.headers['x-session-token']) {
		return req.headers['x-session-token'];
	}
	if (req.body && req.body.token) {
		return req.body.token;
	}
	if (req.query && req.query.token) {
		return req.query.token;
	}
	return null;
}

function normalizeEmail(value) {
	return (value || '').trim().toLowerCase();
}

function mapRoleCodes(roleArray = []) {
	return roleArray
		.filter(Boolean)
		.map((code) => String(code).toLowerCase())
		.filter((code, idx, list) => list.indexOf(code) === idx);
}

function cloneMetadata(raw) {
	if (!raw) return {};
	if (typeof raw === 'object') return { ...raw };
	try {
		return JSON.parse(raw);
	} catch (_) {
		return {};
	}
}

function getLastActivityDate(metadata, fallback = null) {
	if (!metadata || typeof metadata !== 'object') return fallback;
	const raw = metadata.lastActivity || metadata.last_activity || metadata.lastactivity || null;
	if (!raw) return fallback;
	const date = new Date(raw);
	return Number.isNaN(date.getTime()) ? fallback : date;
}

async function refreshSessionActivity(token, metadata = {}, { force = false } = {}) {
	if (!token) return null;
	const now = new Date();
	const ttlMs = AUTH_TOKEN_TTL_HOURS * 60 * 60 * 1000;
	const updatedExpiresAt = new Date(now.getTime() + ttlMs);
	const lastActivity = getLastActivityDate(metadata);
	const shouldSkip = !force && lastActivity && now - lastActivity < SESSION_ACTIVITY_GRACE_MS;
	if (shouldSkip) {
		return { expiresAt: updatedExpiresAt.toISOString(), metadata };
	}
	const safeMetadata = cloneMetadata(metadata);
	safeMetadata.lastActivity = now.toISOString();
	await db.query('UPDATE auth_session_token SET expires_at=$2, metadata=$3 WHERE token=$1', [token, updatedExpiresAt.toISOString(), JSON.stringify(safeMetadata)]);
	return { expiresAt: updatedExpiresAt.toISOString(), metadata: safeMetadata };
}

function formatUserPayload(row) {
	if (!row) return null;
	const roles = mapRoleCodes(row.roles || row.role_codes || []);
	return {
		id: row.id,
		email: row.email,
		fullName: row.full_name || row.fullname || row.username || row.email,
		roles
	};
}

function userHasAllowedRole(user) {
	if (!ALLOWED_ROLE_CODES.length) return true;
	const userRoles = mapRoleCodes(user.roles || []);
	return userRoles.some((code) => ALLOWED_ROLE_CODES.includes(code));
}

function toSafeInteger(value) {
	const num = Number(value);
	return Number.isFinite(num) ? Math.trunc(num) : null;
}

function normalizeModuloPayload(raw = {}) {
	const nombre = (raw.nombre || '').trim();
	const carreraId = raw.carreraId || raw.carrera_id || raw.id_carrera || raw.carrera || null;
	const horasSemanaSource = raw.horasSemana ?? raw.horas ?? raw.totalHoras ?? raw.horasSemanales;
	const horasSemana = Number(horasSemanaSource || 0) || 0;
	const nivel = raw.nivel !== undefined && raw.nivel !== null && raw.nivel !== '' ? toSafeInteger(raw.nivel) : null;
	const codigoAsignatura = raw.codigoAsignatura || raw.codigo_asignatura || raw.codigo || null;
	const providedId = raw.id !== undefined && raw.id !== null && raw.id !== '' ? toSafeInteger(raw.id) : null;
	return {
		id: providedId,
		nombre,
		carreraId: carreraId ? String(carreraId).trim() : null,
		horasSemana,
		nivel,
		codigoAsignatura: codigoAsignatura ? String(codigoAsignatura).trim() : null
	};
}

function extractEventLinking(payload = {}) {
	const meta = (payload.extendedProps && payload.extendedProps.__meta) || {};
	const moduloCandidate = payload.modulo_id ?? payload.moduloId ?? meta.moduloId ?? meta.modulo_id ?? meta.modulo;
	const docenteCandidate = payload.docente_id ?? payload.docenteId ?? meta.docenteId ?? meta.docente_id;
	const salaCandidate = payload.sala_id ?? payload.salaId ?? meta.salaId ?? meta.sala_id;
	const carreraCandidate =
		payload.carrera_id ??
		payload.carreraId ??
		(payload.extendedProps ? payload.extendedProps.carreraId ?? payload.extendedProps.carrera : undefined) ??
		meta.carreraId ?? meta.carrera_id;
	return {
		moduloId: toSafeInteger(moduloCandidate),
		docenteId: docenteCandidate ? String(docenteCandidate).trim() : null,
		salaId: salaCandidate ? String(salaCandidate).trim() : null,
		carreraId: carreraCandidate ? String(carreraCandidate).trim() : null
	};
}

function collectHints(...values) {
	const hints = [];
	for (const value of values) {
		if (value === undefined || value === null) continue;
		const str = String(value).trim();
		if (!str) continue;
		hints.push(str);
	}
	return hints;
}

async function findModuloIdFromHints(meta = {}, payload = {}) {
	const hints = collectHints(
		meta.moduloId,
		meta.modulo_id,
		meta.modulo,
		meta.moduloCode,
		meta.moduloCodigo,
		meta.moduloCodigoAsignatura,
		meta.codigoAsignatura,
		meta.codigo_asignatura,
		meta.moduloName,
		meta.moduloNombre,
		payload.moduloId,
		payload.modulo_id
	);
	if (payload.title) {
		const maybeModulo = String(payload.title).split('-')[0]?.trim();
		if (maybeModulo) hints.push(maybeModulo);
	}
	for (const hint of hints) {
		const numeric = toSafeInteger(hint);
		if (Number.isInteger(numeric)) {
			const checkById = await db.query('SELECT id FROM modulos WHERE id=$1 LIMIT 1', [numeric]);
			if (checkById.rowCount) return numeric;
		}
		if (hint.length <= 2) continue;
		const byCode = await db.query('SELECT id FROM modulos WHERE LOWER(codigo_asignatura) = LOWER($1) LIMIT 1', [hint]);
		if (byCode.rowCount) return byCode.rows[0].id;
		const byName = await db.query('SELECT id FROM modulos WHERE LOWER(nombre) = LOWER($1) LIMIT 1', [hint]);
		if (byName.rowCount) return byName.rows[0].id;
	}
	return null;
}

function normalizeRut(value) {
	if (!value) return null;
	return String(value).replace(/[^0-9kK]/g, '').toUpperCase();
}

async function findDocenteIdFromHints(meta = {}, payload = {}) {
	const hints = collectHints(
		meta.docenteId,
		meta.docente_id,
		meta.docente,
		meta.docenteName,
		payload.docenteId,
		payload.docente_id
	);
	if (payload.title && payload.title.includes('-')) {
		const maybeDocente = payload.title.split('-').slice(1).join('-').trim();
		if (maybeDocente) hints.push(maybeDocente);
	}
	for (const hint of hints) {
		const checkById = await db.query('SELECT id FROM docentes WHERE id=$1 LIMIT 1', [hint]);
		if (checkById.rowCount) return checkById.rows[0].id;
		const byName = await db.query('SELECT id FROM docentes WHERE LOWER(nombre) = LOWER($1) LIMIT 1', [hint]);
		if (byName.rowCount) return byName.rows[0].id;
	}
	return null;
}

async function findSalaIdFromHints(meta = {}, payload = {}) {
	const hints = collectHints(meta.salaId, meta.sala_id, meta.sala, meta.salaName, payload.salaId, payload.sala_id);
	for (const hint of hints) {
		const byId = await db.query('SELECT id FROM salas WHERE id=$1 LIMIT 1', [hint]);
		if (byId.rowCount) return byId.rows[0].id;
		const byName = await db.query('SELECT id FROM salas WHERE LOWER(nombre) = LOWER($1) LIMIT 1', [hint]);
		if (byName.rowCount) return byName.rows[0].id;
	}
	return null;
}

async function resolveEventLinking(payload = {}) {
	const linking = extractEventLinking(payload);
	const meta = (payload.extendedProps && payload.extendedProps.__meta) || {};
	if (!Number.isInteger(linking.moduloId)) {
		const resolvedModuloId = await findModuloIdFromHints(meta, payload);
		linking.moduloId = resolvedModuloId ?? null;
	}
	if (!linking.docenteId) {
		linking.docenteId = await findDocenteIdFromHints(meta, payload);
	}
	if (!linking.salaId) {
		linking.salaId = await findSalaIdFromHints(meta, payload);
	}
	if (!linking.carreraId && linking.moduloId) {
		const carreraLookup = await db.query('SELECT carrera_id FROM modulos WHERE id=$1 LIMIT 1', [linking.moduloId]);
		const carreraId = carreraLookup.rows[0]?.carrera_id;
		linking.carreraId = carreraId ? String(carreraId) : null;
	}
	return linking;
}

function normalizeTemplatePayload(raw = {}) {
	const moduloCandidate = raw.moduloId ?? raw.modulo_id ?? raw.modulo;
	const docenteCandidate = raw.docenteId ?? raw.docente_id ?? raw.docente;
	const salaCandidate = raw.salaId ?? raw.sala_id ?? raw.sala;
	const durationCandidate = raw.duration ?? raw.duracion ?? raw.blocks ?? raw.blockCount;
	return {
		moduloId: toSafeInteger(moduloCandidate),
		docenteId: docenteCandidate ? String(docenteCandidate).trim() : null,
		salaId: salaCandidate ? String(salaCandidate).trim() : null,
		startDate: raw.startDate || raw.start_date || null,
		time: raw.time || raw.hora || null,
		duration: (() => {
			if (durationCandidate === undefined || durationCandidate === null || durationCandidate === '') return null;
			const normalized = Number(durationCandidate);
			return Number.isFinite(normalized) ? normalized : null;
		})(),
		until: raw.until || raw.hasta || null
	};
}

function mergeMetaIntoExtendedProps(baseProps = {}, linking = {}) {
	const safeProps = baseProps && typeof baseProps === 'object' ? { ...baseProps } : {};
	const existingMetaRaw = safeProps.__meta && typeof safeProps.__meta === 'object' ? safeProps.__meta : {};
	const existingMeta = { ...existingMetaRaw };
	const legacyCarreraMeta = existingMeta && Object.prototype.hasOwnProperty.call(existingMeta, 'carreraId') ? existingMeta.carreraId : null;
	if (legacyCarreraMeta !== null) {
		delete existingMeta.carreraId;
	}
	const mergedMeta = {
		...existingMeta,
		...(linking.moduloId !== null && linking.moduloId !== undefined ? { moduloId: String(linking.moduloId) } : {}),
		...(linking.docenteId ? { docenteId: String(linking.docenteId) } : {}),
		...(linking.salaId ? { salaId: String(linking.salaId) } : {})
	};
	safeProps.__meta = mergedMeta;
	if (linking.carreraId) {
		safeProps.carreraId = String(linking.carreraId);
	} else if (safeProps.carreraId === undefined && legacyCarreraMeta) {
		safeProps.carreraId = String(legacyCarreraMeta);
	}
	return safeProps;
}


function mapEventRow(row) {
	const baseProps = row.extendedProps && typeof row.extendedProps === 'object' ? row.extendedProps : {};
	const existingMeta = baseProps.__meta && typeof baseProps.__meta === 'object' ? baseProps.__meta : {};
	const linking = {
		moduloId: row.modulo_id !== null && row.modulo_id !== undefined ? String(row.modulo_id) : null,
		docenteId: row.docente_id || null,
		salaId: row.sala_id || null,
		carreraId:
			row.modulo_carrera !== null && row.modulo_carrera !== undefined
				? String(row.modulo_carrera)
				: baseProps.carreraId ?? existingMeta.carreraId ?? null
	};
	const extendedProps = mergeMetaIntoExtendedProps(baseProps, linking);
	return {
		id: row.id,
		title: row.title,
		start: row.start,
		end: row.end,
		moduloId: linking.moduloId,
		docenteId: linking.docenteId,
		salaId: linking.salaId,
		extendedProps
	};
}

function normalizeDateInput(value) {
	if (!value) return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

function getIsoWeekYear(value) {
	const date = normalizeDateInput(value);
	if (!date) return null;
	const utcDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
	const day = utcDate.getUTCDay() || 7;
	utcDate.setUTCDate(utcDate.getUTCDate() + 4 - day);
	const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1));
	const week = Math.ceil(((utcDate - yearStart) / 86400000 + 1) / 7);
	return { week, year: utcDate.getUTCFullYear() };
}

function buildDocenteWeekKey(docenteId, startValue) {
	if (!docenteId) return null;
	const iso = getIsoWeekYear(startValue);
	if (!iso) return null;
	return {
		docenteId: String(docenteId).trim(),
		week: iso.week,
		year: iso.year
	};
}

function extractDocenteWeekKeyFromEventRow(row) {
	if (!row) return null;
	return buildDocenteWeekKey(row.docente_id ?? row.docenteId, row.start);
}

async function recalcDocenteSemanaHoras(key) {
	if (!key || !dbReady) return;
	const { docenteId, week, year } = key;
	if (!docenteId || !Number.isInteger(week) || !Number.isInteger(year)) {
		return;
	}
	const { rows } = await db.query(
		`SELECT COALESCE(SUM(ROUND(EXTRACT(EPOCH FROM ("end" - start)) / (60.0 * $4))), 0)::int AS bloques
		   FROM events
		  WHERE docente_id = $1
		    AND date_part('isoyear', start AT TIME ZONE 'UTC') = $2
		    AND date_part('week', start AT TIME ZONE 'UTC') = $3`,
		[docenteId, year, week, BLOCK_MINUTES]
	);
	const bloques = Number(rows[0]?.bloques) || 0;
	if (bloques > 0) {
		await db.query(
			`INSERT INTO docente_semana_horas (docente_id, semana, "año", bloques_usados)
			 VALUES ($1, $2, $3, $4)
			 ON CONFLICT (docente_id, semana, "año") DO UPDATE
			 SET bloques_usados = EXCLUDED.bloques_usados`,
			[docenteId, week, year, bloques]
		);
	} else {
		await db.query('DELETE FROM docente_semana_horas WHERE docente_id=$1 AND semana=$2 AND "año"=$3', [docenteId, week, year]);
	}
}

async function refreshDocenteSemanaHoras(keys = []) {
	if (!Array.isArray(keys) || !keys.length) return;
	const seen = new Set();
	for (const key of keys) {
		if (!key || !key.docenteId || !Number.isInteger(key.week) || !Number.isInteger(key.year)) continue;
		const signature = `${key.docenteId}__${key.week}__${key.year}`;
		if (seen.has(signature)) continue;
		seen.add(signature);
		await recalcDocenteSemanaHoras(key);
	}
}

async function fetchUserByEmail(email) {
	const normalized = normalizeEmail(email);
	if (!normalized) return null;
	const { rows } = await db.query(
		`SELECT u.id, u.email, u.full_name, u.password_hash, u.is_active, u.must_reset_pwd,
		        ARRAY_REMOVE(ARRAY_AGG(r.code), NULL) AS roles
		   FROM auth_user u
		   LEFT JOIN auth_user_role ur ON ur.user_id = u.id
		   LEFT JOIN auth_role r ON r.id = ur.role_id
		  WHERE LOWER(u.email) = LOWER($1)
		  GROUP BY u.id`,
		[normalized]
	);
	if (!rows.length) return null;
	const user = rows[0];
	user.roles = mapRoleCodes(user.roles);
	return user;
}

async function logLoginAttempt({ userId = null, emailInput = '', success = false, reason = null, req }) {
	try {
		await db.query(
			`INSERT INTO auth_login_audit (user_id, email_input, ip_address, user_agent, was_success, reason)
			 VALUES ($1, $2, $3, $4, $5, $6)`,
			[userId, emailInput || '', req?.ip || null, req?.headers?.['user-agent'] || null, success, reason]
		);
	} catch (auditErr) {
		console.warn('No se pudo registrar el intento de login', auditErr);
	}
}

async function touchUserLogin(userId) {
	await db.query('UPDATE auth_user SET updated_at = now() WHERE id = $1', [userId]);
}

async function createLoginSession(userId, req){
	const now = new Date();
	const expiresAt = new Date(now.getTime() + AUTH_TOKEN_TTL_HOURS * 60 * 60 * 1000);
	const token = uuidv4();
	const metadata = {
		source: 'admin-ui',
		ip: req?.ip || null,
		userAgent: req?.headers?.['user-agent'] || null,
		lastActivity: now.toISOString()
	};
	await db.query(
		`INSERT INTO auth_session_token (token, user_id, expires_at, metadata)
		 VALUES ($1, $2, $3, $4)`,
		[token, userId, expiresAt.toISOString(), JSON.stringify(metadata)]
	);
	return { token, expiresAt: expiresAt.toISOString(), metadata };
}

async function loadSessionFromToken(rawToken, { requireAdmin = false } = {}){
	if (!rawToken) return null;
	const { rows } = await db.query(
		`SELECT s.token, s.user_id, s.expires_at, s.metadata,
		        u.full_name, u.email, u.is_active,
		        ARRAY_REMOVE(ARRAY_AGG(r.code), NULL) AS roles
		   FROM auth_session_token s
		   JOIN auth_user u ON u.id = s.user_id
		   LEFT JOIN auth_user_role ur ON ur.user_id = u.id
		   LEFT JOIN auth_role r ON r.id = ur.role_id
		  WHERE s.token = $1
		  GROUP BY s.token, s.user_id, s.expires_at, s.metadata, u.full_name, u.email, u.is_active
		  LIMIT 1`,
		[rawToken]
	);
	if (!rows.length) return null;
	const row = rows[0];
	const metadata = cloneMetadata(row.metadata);
	const now = new Date();
	const expired = row.expires_at && new Date(row.expires_at) < now;
	if (!row.is_active || expired) {
		await db.query('DELETE FROM auth_session_token WHERE token = $1', [rawToken]);
		return null;
	}
	const ttlMs = AUTH_TOKEN_TTL_HOURS * 60 * 60 * 1000;
	const fallbackLastActivity = row.expires_at ? new Date(new Date(row.expires_at).getTime() - ttlMs) : null;
	const lastActivityDate = getLastActivityDate(metadata, fallbackLastActivity);
	const idleLimitMs = SESSION_IDLE_MINUTES > 0 ? SESSION_IDLE_MINUTES * 60 * 1000 : null;
	if (idleLimitMs && lastActivityDate && now - lastActivityDate > idleLimitMs) {
		await db.query('DELETE FROM auth_session_token WHERE token = $1', [rawToken]);
		return null;
	}
	const roles = mapRoleCodes(row.roles);
	if (requireAdmin && !roles.includes('admin')) {
		return null;
	}
	const refreshed = await refreshSessionActivity(row.token, metadata);
	const nextExpiry = refreshed?.expiresAt || row.expires_at;
	return {
		sessionId: row.token,
		userId: row.user_id,
		expiraEn: nextExpiry,
		user: {
			id: row.user_id,
			email: row.email,
			fullName: row.full_name,
			roles
		}
	};
}

app.get('/api/public-config', (req,res)=>{
	res.json({
		googleClientId: GOOGLE_CLIENT_ID || null,
		useDbOnly: USE_DB_ONLY,
		allowedRoles: ALLOWED_ROLE_CODES,
		sessionIdleMinutes: SESSION_IDLE_MINUTES
	});
});

// Basic CRUD endpoints (only enabled if DB loaded)
if(dbReady){
	if (dashboardRoutes) {
		app.use('/api/dashboard', dashboardRoutes);
	}
	// Auto-organize endpoint: assigns pending modules to eligible docentes
	async function handleAutoOrganizar(req, res) {
		try {
			const token = extractToken(req);
			let session = null;
			try {
				session = await loadSessionFromToken(token, { requireAdmin: true });
			} catch (authErr) {
				console.warn('Auth check failed for auto-organizar:', authErr?.message || authErr);
			}
			if (!session && !AUTO_ORGANIZE_ALLOW_PUBLIC) {
				return res.status(401).json({ error: 'No autorizado' });
			}

			const { carreraId: bodyCarreraId, startDate: bodyStartDate, weeks: bodyWeeks } = req.body || {};
			const { carreraId: queryCarreraId, startDate: queryStartDate, weeks: queryWeeks } = req.query || {};
			const weeks = Number(bodyWeeks ?? queryWeeks ?? 1) || 1;
			const carrera = String(bodyCarreraId ?? queryCarreraId ?? '').trim();
			if (!carrera) return res.status(400).json({ error: 'carreraId requerido' });

			const docentes = await getDocentesPorCarrera(carrera);
			if (!docentes.length) return res.status(404).json({ error: 'Sin docentes elegibles para la carrera' });

			// Find modules without templates/events assigned (simple heuristic)
			const { rows: modulosPend } = await db.query(
				`SELECT m.id, m.nombre, m."horasSemana"
					 FROM modulos m
					WHERE m.carrera_id = $1
						AND NOT EXISTS (
							SELECT 1 FROM templates t WHERE t.moduloId = m.id
						)
						AND NOT EXISTS (
							SELECT 1 FROM events e WHERE e.modulo_id = m.id
						)
					ORDER BY m.id ASC`,
				[carrera]
			);

			const assignments = [];
			let baseStart = (bodyStartDate || queryStartDate) ? new Date(bodyStartDate || queryStartDate) : new Date();
			baseStart.setHours(8, 30, 0, 0);

			for (const mod of modulosPend) {
				// choose docente by lowest carga and prioridad
				let chosen = null;
				let bestScore = Number.POSITIVE_INFINITY;
				for (const d of docentes) {
					const carga = await getCargaDocente(d.id);
					const score = (isNaN(d.prioridad) ? 999 : d.prioridad) * 1000 + (carga.bloques || 0);
					if (score < bestScore) { bestScore = score; chosen = { docenteId: d.id, carga }; }
				}
				if (!chosen) continue;

				// build start/end from horasSemana in blocks of 35 minutes across weeks
				const blocks = Math.max(1, Math.round((mod.horasSemana || 0) * 60 / BLOCK_MINUTES));
				const start = new Date(baseStart);
				const end = new Date(start.getTime() + blocks * BLOCK_MINUTES * 60000);
				const startIso = start.toISOString();
				const endIso = end.toISOString();

				await asignarEvento({ moduloId: mod.id, docenteId: chosen.docenteId, start: startIso, end: endIso });
				assignments.push({ moduloId: mod.id, docenteId: chosen.docenteId, start: startIso, end: endIso });

				// move baseStart for next module
				baseStart = new Date(end.getTime() + 10 * 60000);
			}

			res.json({ assigned: assignments.length, assignments, weeks });
		} catch (err) {
			handleDbError(res, err);
		}
	}

	app.post('/api/auto-organizar', handleAutoOrganizar);
	app.get('/api/auto-organizar', handleAutoOrganizar);
	app.post('/api/auth/login', async (req,res)=>{
		const { identifier, password } = req.body || {};
		const email = normalizeEmail(identifier);
		if (!email || !password) {
			return res.status(400).json({ error: 'Debes proporcionar correo y contraseña.' });
		}
		try {
			const user = await fetchUserByEmail(email);
			if (!user) {
				await logLoginAttempt({ emailInput: email, success: false, reason: 'user_not_found', req });
				return res.status(401).json({ error: 'Credenciales inválidas.' });
			}
			if (!user.is_active) {
				await logLoginAttempt({ userId: user.id, emailInput: email, success: false, reason: 'inactive', req });
				return res.status(403).json({ error: 'La cuenta está deshabilitada.' });
			}
			const passOk = await bcrypt.compare(password, user.password_hash || '');
			if (!passOk) {
				await logLoginAttempt({ userId: user.id, emailInput: email, success: false, reason: 'wrong_password', req });
				return res.status(401).json({ error: 'Credenciales inválidas.' });
			}
			if (!userHasAllowedRole(user)) {
				await logLoginAttempt({ userId: user.id, emailInput: email, success: false, reason: 'forbidden_role', req });
				return res.status(403).json({ error: 'Esta cuenta no tiene permisos para acceder.' });
			}
			const session = await createLoginSession(user.id, req);
			await touchUserLogin(user.id);
			await logLoginAttempt({ userId: user.id, emailInput: email, success: true, req });
			res.json({
				token: session.token,
				expiresAt: session.expiresAt,
				sessionIdleMinutes: SESSION_IDLE_MINUTES,
				user: formatUserPayload(user)
			});
		} catch (err) {
			handleDbError(res, err);
		}
	});

	app.post('/api/auth/google', async (req,res)=>{
		if (!googleClient) {
			return res.status(503).json({ error: 'Inicio con Google no está configurado.' });
		}
		const { credential } = req.body || {};
		if (!credential) {
			return res.status(400).json({ error: 'Token de Google faltante.' });
		}
		try {
			const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
			const payload = ticket.getPayload();
			const email = normalizeEmail(payload?.email);
			if (!email) {
				return res.status(400).json({ error: 'Cuenta de Google sin correo verificado.' });
			}
			const user = await fetchUserByEmail(email);
			if (!user) {
				await logLoginAttempt({ emailInput: email, success: false, reason: 'user_not_found', req });
				return res.status(403).json({ error: 'Esta cuenta no tiene permisos para acceder.' });
			}
			if (!user.is_active) {
				await logLoginAttempt({ userId: user.id, emailInput: email, success: false, reason: 'inactive', req });
				return res.status(403).json({ error: 'La cuenta está deshabilitada.' });
			}
			if (!userHasAllowedRole(user)) {
				await logLoginAttempt({ userId: user.id, emailInput: email, success: false, reason: 'forbidden_role', req });
				return res.status(403).json({ error: 'Esta cuenta no tiene permisos para acceder.' });
			}
			const session = await createLoginSession(user.id, req);
			await touchUserLogin(user.id);
			await logLoginAttempt({ userId: user.id, emailInput: email, success: true, req });
			res.json({
				token: session.token,
				expiresAt: session.expiresAt,
				sessionIdleMinutes: SESSION_IDLE_MINUTES,
				user: formatUserPayload(user)
			});
		} catch (err) {
			console.error('Google auth error', err);
			res.status(401).json({ error: 'No se pudo validar la sesión de Google.' });
		}
	});

	app.post('/api/auth/logout', async (req,res)=>{
		const token = extractToken(req);
		if (!token) {
			return res.status(400).json({ error: 'Token requerido para cerrar sesión.' });
		}
		try {
			await db.query('DELETE FROM auth_session_token WHERE token=$1', [token]);
			res.json({ ok: true });
		} catch (err) {
			handleDbError(res, err);
		}
	});

	// Health endpoint to verify DB connectivity and trigger status
	app.get('/api/health', async (req, res) => {
		try {
			const ping = await db.query('SELECT 1 AS ok');
			const trg = await db.query(
				`SELECT tgname AS name
				   FROM pg_trigger
				  WHERE tgrelid = 'docentes'::regclass
				    AND NOT tgisinternal`
			);
			const hasDocentesTouch = trg.rows.some(r => r.name === 'docentes_touch_updated');
			res.json({ db: !!ping.rowCount, docentesTriggerOk: hasDocentesTouch });
		} catch (err) {
			return handleDbError(res, err);
		}
	});

	app.get('/api/auth/session', async (req,res)=>{
		const token = extractToken(req);
		if (!token) {
			return res.status(401).json({ error: 'Token no enviado.' });
		}
		try {
			const session = await loadSessionFromToken(token);
			if (!session) {
				return res.status(401).json({ error: 'Sesión inválida o expirada.' });
			}
			res.json({ user: session.user, tokenExpiresAt: session.expiraEn, sessionIdleMinutes: SESSION_IDLE_MINUTES });
		} catch (err) {
			handleDbError(res, err);
		}
	});

		app.post('/api/auth/heartbeat', async (req,res)=>{
			const token = extractToken(req);
			if (!token) {
				return res.status(401).json({ error: 'Token no enviado.' });
			}
			try {
				const session = await loadSessionFromToken(token);
				if (!session) {
					return res.status(401).json({ error: 'Sesión inválida o expirada.' });
				}
				res.json({ ok: true, tokenExpiresAt: session.expiraEn, sessionIdleMinutes: SESSION_IDLE_MINUTES });
			} catch (err) {
				handleDbError(res, err);
			}
		});

	app.get('/api/carreras', async (req,res)=>{
		try{
			const { rows } = await db.query(`
				SELECT id,
				       nombre,
				       "jefeCarrera" AS "jefeCarrera",
				       totalHoras AS "totalHoras",
				       practicaHoras AS "practicaHoras",
				       teoricaHoras AS "teoricaHoras",
				       colorDiurno AS "colorDiurno",
				       colorVespertino AS "colorVespertino"
				  FROM carreras
				 ORDER BY nombre ASC`);
			res.json(rows);
		}catch(err){ handleDbError(res, err); }
	});

	app.post('/api/carreras', async (req,res)=>{
		const c = req.body;
		const id = c.id || uuidv4();
		try{
			await db.query(
				`INSERT INTO carreras (id,nombre,"jefeCarrera",totalHoras,practicaHoras,teoricaHoras,colorDiurno,colorVespertino)
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
				 ON CONFLICT (id) DO UPDATE
				 SET nombre=EXCLUDED.nombre,
				     "jefeCarrera"=EXCLUDED."jefeCarrera",
				     totalHoras=EXCLUDED.totalHoras,
				     practicaHoras=EXCLUDED.practicaHoras,
				     teoricaHoras=EXCLUDED.teoricaHoras,
				     colorDiurno=EXCLUDED.colorDiurno,
				     colorVespertino=EXCLUDED.colorVespertino`,
				[id, c.nombre, c.jefeCarrera || null, c.totalHoras||0, c.practicaHoras||0, c.teoricaHoras||0, c.colorDiurno||null, c.colorVespertino||null]
			);
			res.json({ok:true,id});
		}catch(err){ handleDbError(res, err); }
	});

	app.put('/api/carreras/:id', async (req,res)=>{
		const c = req.body;
		try{
			await db.query(
				'UPDATE carreras SET nombre=$1, "jefeCarrera"=$2, totalHoras=$3, practicaHoras=$4, teoricaHoras=$5, colorDiurno=$6, colorVespertino=$7 WHERE id=$8',
				[c.nombre, c.jefeCarrera || null, c.totalHoras||0, c.practicaHoras||0, c.teoricaHoras||0, c.colorDiurno||null, c.colorVespertino||null, req.params.id]
			);
			res.json({ok:true});
		}catch(err){ handleDbError(res, err); }
	});

	app.delete('/api/carreras/:id', async (req,res)=>{
		try{
			await db.query('DELETE FROM carreras WHERE id=$1', [req.params.id]);
			res.json({ok:true});
		}catch(err){ handleDbError(res, err); }
	});

	app.get('/api/modulos', async (req,res)=>{
		try{
			const { rows } = await db.query(`
				SELECT id,
				       nombre,
				       "horasSemana" AS "horasSemana",
				       nivel,
				       carrera_id AS "carreraId",
				       codigo_asignatura AS "codigoAsignatura",
				       created_at,
				       updated_at
			  FROM modulos
			 ORDER BY nombre ASC`);
			const normalized = rows.map((row) => {
				const horasSemana = Number(row.horasSemana ?? 0) || 0;
				return {
					id: row.id !== null && row.id !== undefined ? String(row.id) : null,
					nombre: row.nombre,
					carreraId: row.carreraId ? String(row.carreraId) : null,
					horasSemana,
					nivel: row.nivel ?? null,
					codigoAsignatura: row.codigoAsignatura || null,
					totalHoras: horasSemana,
					horasTeoricas: 0,
					horasPracticas: 0,
					horasSemanales: horasSemana,
					created_at: row.created_at,
					updated_at: row.updated_at
				};
			});
			res.json(normalized);
		}catch(err){ handleDbError(res, err); }
	});

	app.post('/api/modulos', async (req,res)=>{
		const payload = normalizeModuloPayload(req.body || {});
		if (!payload.nombre) {
			return res.status(400).json({ error: 'El nombre del módulo es obligatorio.' });
		}
		if (!payload.carreraId) {
			return res.status(400).json({ error: 'carreraId es obligatorio.' });
		}
		try{
			let insertedId;
			if (Number.isInteger(payload.id)) {
				await db.query(
					`INSERT INTO modulos (id,nombre,"horasSemana",nivel,carrera_id,codigo_asignatura)
					 VALUES ($1,$2,$3,$4,$5,$6)
					 ON CONFLICT (id) DO UPDATE
					 SET nombre=EXCLUDED.nombre,
					     "horasSemana"=EXCLUDED."horasSemana",
					     nivel=EXCLUDED.nivel,
					     carrera_id=EXCLUDED.carrera_id,
					     codigo_asignatura=EXCLUDED.codigo_asignatura,
					     updated_at=NOW()`,
					[payload.id, payload.nombre, payload.horasSemana, payload.nivel, payload.carreraId, payload.codigoAsignatura]
				);
				insertedId = payload.id;
			} else {
				const { rows } = await db.query(
					`INSERT INTO modulos (nombre,"horasSemana",nivel,carrera_id,codigo_asignatura)
					 VALUES ($1,$2,$3,$4,$5)
					 RETURNING id`,
					[payload.nombre, payload.horasSemana, payload.nivel, payload.carreraId, payload.codigoAsignatura]
				);
				insertedId = rows[0]?.id;
			}
			res.json({ok:true,id: insertedId});
		}catch(err){ handleDbError(res, err); }
	});

	app.put('/api/modulos/:id', async (req,res)=>{
		const moduloId = toSafeInteger(req.params.id);
		const payload = normalizeModuloPayload({ ...(req.body || {}), id: moduloId });
		if (!Number.isInteger(moduloId)) {
			return res.status(400).json({ error: 'ID de módulo inválido.' });
		}
		if (!payload.nombre) {
			return res.status(400).json({ error: 'El nombre del módulo es obligatorio.' });
		}
		if (!payload.carreraId) {
			return res.status(400).json({ error: 'carreraId es obligatorio.' });
		}
		try{
			await db.query(
				'UPDATE modulos SET nombre=$1, "horasSemana"=$2, nivel=$3, carrera_id=$4, codigo_asignatura=$5, updated_at=NOW() WHERE id=$6',
				[payload.nombre, payload.horasSemana, payload.nivel, payload.carreraId, payload.codigoAsignatura, moduloId]
			);
			res.json({ok:true});
		}catch(err){ handleDbError(res, err); }
	});

	app.delete('/api/modulos/:id', async (req,res)=>{
		try{
			await db.query('DELETE FROM modulos WHERE id=$1', [req.params.id]);
			res.json({ok:true});
		}catch(err){ handleDbError(res, err); }
	});

	app.get('/api/docentes', async (req,res)=>{
		try{
			const { rows } = await db.query(`
				SELECT id,
				       nombre,
				       email,
				       telefono,
				       turno,
				       contrato_horas AS "contrato_horas",
				       contrato_hora_semanal AS "contrato_hora_semanal",
			       carrera_id AS "carreraId",
			       creado_en,
			       actualizado_en
			  FROM docentes
			 ORDER BY nombre ASC`);
			res.json(rows);
		}catch(err){ handleDbError(res, err); }
	});

	app.post('/api/docentes', async (req,res)=>{
		const d = req.body;
		const id = d.id || uuidv4();
		try{
			await db.query(
				`INSERT INTO docentes (id, nombre, email, telefono, turno, contrato_horas, contrato_hora_semanal, carrera_id)
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
				 ON CONFLICT (id) DO UPDATE
				 SET nombre=EXCLUDED.nombre,
				     email=EXCLUDED.email,
				     telefono=EXCLUDED.telefono,
				     turno=EXCLUDED.turno,
				     contrato_horas=EXCLUDED.contrato_horas,
				     contrato_hora_semanal=EXCLUDED.contrato_hora_semanal,
				     carrera_id=EXCLUDED.carrera_id`,
				[
					id,
					d.nombre,
					d.email||null,
					d.telefono||null,
					d.turno||null,
					Number.isFinite(d.contrato_horas) ? d.contrato_horas : null,
					Number.isFinite(d.contrato_hora_semanal) ? d.contrato_hora_semanal : null,
					d.carreraId||null
				]
			);
			res.json({ok:true,id});
		}catch(err){ handleDbError(res, err); }
	});

	app.put('/api/docentes/:id', async (req,res)=>{
		const d = req.body;
		try{
			await db.query(
				'UPDATE docentes SET nombre=$1, email=$2, telefono=$3, turno=$4, contrato_horas=$5, contrato_hora_semanal=$6, carrera_id=$7 WHERE id=$8',
				[d.nombre, d.email||null, d.telefono||null, d.turno||null, Number.isFinite(d.contrato_horas)?d.contrato_horas:null, Number.isFinite(d.contrato_hora_semanal)?d.contrato_hora_semanal:null, d.carreraId||null, req.params.id]
			);
			res.json({ok:true});
		}catch(err){ handleDbError(res, err); }
	});

	// Nuevo endpoint: detalle completo de un docente por id
	app.get('/api/docentes/:id', async (req,res)=>{
		try {
			const { rows } = await db.query('SELECT * FROM docentes WHERE id=$1 LIMIT 1',[req.params.id]);
			if(!rows.length){ return res.status(404).json({error:'Docente no encontrado'}); }
			res.json(rows[0]);
		} catch(err){ handleDbError(res, err); }
	});

	app.delete('/api/docentes/:id', async (req,res)=>{
		try{
			await db.query('DELETE FROM docentes WHERE id=$1', [req.params.id]);
			res.json({ok:true});
		}catch(err){ handleDbError(res, err); }
	});

	app.get('/api/salas', async (req,res)=>{
		try{
			const { rows } = await db.query(`
				SELECT id,
				       nombre,
				       capacidad
				  FROM salas
				 ORDER BY nombre ASC`);
			res.json(rows);
		}catch(err){ handleDbError(res, err); }
	});

	app.post('/api/salas', async (req,res)=>{
		const s = req.body;
		const id = s.id || uuidv4();
		try{
			await db.query(
				`INSERT INTO salas (id,nombre,capacidad)
				 VALUES ($1,$2,$3)
				 ON CONFLICT (id) DO UPDATE
				 SET nombre=EXCLUDED.nombre,
				     capacidad=EXCLUDED.capacidad`,
				[id, s.nombre, s.capacidad||0]
			);
			res.json({ok:true,id});
		}catch(err){ handleDbError(res, err); }
	});

	app.put('/api/salas/:id', async (req,res)=>{
		const s = req.body;
		try{
			await db.query('UPDATE salas SET nombre=$1, capacidad=$2 WHERE id=$3', [s.nombre, s.capacidad||0, req.params.id]);
			res.json({ok:true});
		}catch(err){ handleDbError(res, err); }
	});

	app.delete('/api/salas/:id', async (req,res)=>{
		try{
			await db.query('DELETE FROM salas WHERE id=$1', [req.params.id]);
			res.json({ok:true});
		}catch(err){ handleDbError(res, err); }
	});

	app.get('/api/templates', async (req,res)=>{
		try{
			const { rows } = await db.query(`
				SELECT id,
				       moduloId AS "moduloId",
				       docenteId AS "docenteId",
				       salaId AS "salaId",
				       startDate AS "startDate",
				       time,
				       duration,
				       until,
				       created_at,
				       updated_at
			  FROM templates
			 ORDER BY startDate ASC NULLS LAST, time ASC NULLS LAST`);
			const normalized = rows.map((row) => ({
				...row,
				moduloId: row.moduloId !== null && row.moduloId !== undefined ? String(row.moduloId) : null,
				docenteId: row.docenteId || null,
				salaId: row.salaId || null,
				duration: row.duration === null || row.duration === undefined ? null : Number(row.duration)
			}));
			res.json(normalized);
		}catch(err){ handleDbError(res, err); }
	});

	app.post('/api/templates', async (req,res)=>{
		const raw = req.body || {};
		const id = raw.id || uuidv4();
		const payload = normalizeTemplatePayload(raw);
		if (!Number.isInteger(payload.moduloId)) {
			return res.status(400).json({ error: 'moduloId es obligatorio y debe ser numérico.' });
		}
		try{
			await db.query(
				`INSERT INTO templates (id,moduloId,docenteId,salaId,startDate,time,duration,until)
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
				 ON CONFLICT (id) DO UPDATE
				 SET moduloId=EXCLUDED.moduloId,
			     docenteId=EXCLUDED.docenteId,
			     salaId=EXCLUDED.salaId,
			     startDate=EXCLUDED.startDate,
			     time=EXCLUDED.time,
			     duration=EXCLUDED.duration,
			     until=EXCLUDED.until,
			     updated_at=NOW()`,
				[id, payload.moduloId, payload.docenteId, payload.salaId, payload.startDate, payload.time, payload.duration, payload.until]
			);
			res.json({ok:true,id});
		}catch(err){ handleDbError(res, err); }
	});

	app.put('/api/templates/:id', async (req,res)=>{
		const payload = normalizeTemplatePayload(req.body || {});
		if (!Number.isInteger(payload.moduloId)) {
			try {
				const existing = await db.query('SELECT moduloId FROM templates WHERE id=$1 LIMIT 1', [req.params.id]);
				if (!existing.rowCount) {
					return res.status(404).json({ error: 'Template no encontrado.' });
				}
				const existingModulo = existing.rows[0]?.moduloid ?? existing.rows[0]?.moduloId;
				payload.moduloId = toSafeInteger(existingModulo);
				if (!Number.isInteger(payload.moduloId)) {
					return res.status(400).json({ error: 'moduloId es obligatorio y debe ser numérico.' });
				}
			} catch (lookupErr) {
				return handleDbError(res, lookupErr);
			}
		}
		try{
			await db.query(
				'UPDATE templates SET moduloId=$1, docenteId=$2, salaId=$3, startDate=$4, time=$5, duration=$6, until=$7, updated_at=NOW() WHERE id=$8',
				[payload.moduloId, payload.docenteId, payload.salaId, payload.startDate, payload.time, payload.duration, payload.until, req.params.id]
			);
			res.json({ok:true});
		}catch(err){ handleDbError(res, err); }
	});

	app.delete('/api/templates/:id', async (req,res)=>{
		try{
			await db.query('DELETE FROM templates WHERE id=$1', [req.params.id]);
			res.json({ok:true});
		}catch(err){ handleDbError(res, err); }
	});

	app.get('/api/events', async (req,res)=>{
		try{
			const { rows } = await db.query(`
				SELECT e.id,
				       e.title,
				       e.start,
				       e."end",
				       e.modulo_id,
				       e.docente_id,
				       e.sala_id,
				       m.carrera_id AS modulo_carrera,
				       COALESCE(e.extendedProps, '{}'::jsonb) AS "extendedProps"
		  FROM events e
		  LEFT JOIN modulos m ON m.id = e.modulo_id
		 ORDER BY e.start ASC`);
			res.json(rows.map(mapEventRow));
		}catch(err){ handleDbError(res, err); }
	});

	app.post('/api/events', async (req,res)=>{
		const payload = req.body || {};
		const id = payload.id || uuidv4();
		const linking = await resolveEventLinking(payload);
		const extendedProps = mergeMetaIntoExtendedProps(payload.extendedProps || {}, linking);
		const extendedPropsJson = JSON.stringify(extendedProps);
		try{
			// Soft-dedupe: avoid inserting duplicate event by same title+start+end
			if (payload.title && payload.start) {
				const dupCheck = await db.query(
					'SELECT id FROM events WHERE title=$1 AND start=$2 AND ("end" IS NOT DISTINCT FROM $3) LIMIT 1',
					[payload.title, payload.start, payload.end || null]
				);
				if (dupCheck.rowCount) {
					return res.json({ ok: true, id: dupCheck.rows[0].id, dedup: true });
				}
			}
			let previousEvent = null;
			if (payload.id) {
				const prevResult = await db.query('SELECT docente_id, start FROM events WHERE id=$1 LIMIT 1', [id]);
				previousEvent = prevResult.rows[0] || null;
			}
			const upsertResult = await db.query(
				`INSERT INTO events (id,title,start,"end",modulo_id,docente_id,sala_id,extendedProps)
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
				 ON CONFLICT (id) DO UPDATE
				 SET title=EXCLUDED.title,
			     start=EXCLUDED.start,
			     "end"=EXCLUDED."end",
			     modulo_id=EXCLUDED.modulo_id,
			     docente_id=EXCLUDED.docente_id,
			     sala_id=EXCLUDED.sala_id,
		     extendedProps=EXCLUDED.extendedProps,
		     updated_at=NOW()
		     RETURNING id, docente_id, start`,
				[id, payload.title, payload.start, payload.end, linking.moduloId, linking.docenteId, linking.salaId, extendedPropsJson]
			);
			const savedEvent = upsertResult.rows[0] || null;
			await refreshDocenteSemanaHoras([
				extractDocenteWeekKeyFromEventRow(previousEvent),
				extractDocenteWeekKeyFromEventRow(savedEvent)
			]);
			res.json({ok:true,id});
		}catch(err){ handleDbError(res, err); }
	});

	app.put('/api/events/:id', async (req,res)=>{
		const payload = req.body || {};
		const linking = await resolveEventLinking(payload);
		const extendedProps = mergeMetaIntoExtendedProps(payload.extendedProps || {}, linking);
		const extendedPropsJson = JSON.stringify(extendedProps);
		try{
			const existingResult = await db.query('SELECT docente_id, start FROM events WHERE id=$1 LIMIT 1', [req.params.id]);
			if (!existingResult.rowCount) {
				return res.status(404).json({ error: 'Evento no encontrado.' });
			}
			const previousEvent = existingResult.rows[0];
			const updatedResult = await db.query(
				'UPDATE events SET title=$1, start=$2, "end"=$3, modulo_id=$4, docente_id=$5, sala_id=$6, extendedProps=$7, updated_at=NOW() WHERE id=$8 RETURNING id, docente_id, start',
				[payload.title, payload.start, payload.end, linking.moduloId, linking.docenteId, linking.salaId, extendedPropsJson, req.params.id]
			);
			const updatedEvent = updatedResult.rows[0] || null;
			await refreshDocenteSemanaHoras([
				extractDocenteWeekKeyFromEventRow(previousEvent),
				extractDocenteWeekKeyFromEventRow(updatedEvent)
			]);
			res.json({ok:true});
		}catch(err){ handleDbError(res, err); }
	});

	app.delete('/api/events/:id', async (req,res)=>{
		try{
			const existingResult = await db.query('SELECT docente_id, start FROM events WHERE id=$1 LIMIT 1', [req.params.id]);
			if (!existingResult.rowCount) {
				return res.status(404).json({ error: 'Evento no encontrado.' });
			}
			const previousEvent = existingResult.rows[0];
			await db.query('DELETE FROM events WHERE id=$1', [req.params.id]);
			await refreshDocenteSemanaHoras([extractDocenteWeekKeyFromEventRow(previousEvent)]);
			res.json({ok:true});
		}catch(err){ handleDbError(res, err); }
	});

	// =====================================================
	// ENDPOINT: Auto-organizar (usando disponibilidad_horaria)
	// =====================================================
	app.post('/api/auto-organizar', async (req, res) => {
		try {
			const { carreraId, semanas = 1, fechaInicio } = req.body;
			console.log('[AUTO-ORGANIZAR] Request recibido:', { carreraId, semanas, fechaInicio });

			if (!carreraId) {
				console.warn('[AUTO-ORGANIZAR] Error: carreraId faltante');
				return res.status(400).json({ error: 'carreraId es obligatorio' });
			}

			// 1. Obtener módulos de la carrera que no tienen asignaciones suficientes
			const { rows: modulos } = await db.query(
				`SELECT m.id, m.nombre, m.codigo_asignatura, m."horasSemana", 
				        COALESCE(m."horasSemana", 0) AS horas_requeridas,
				        COUNT(e.id) * ${BLOCK_MINUTES / 60.0} AS horas_asignadas
				 FROM modulos m
				 LEFT JOIN events e ON e.modulo_id = m.id
				 WHERE m.carrera_id = $1
				 GROUP BY m.id
				 HAVING COALESCE(m."horasSemana", 0) > COUNT(e.id) * ${BLOCK_MINUTES / 60.0}
				 ORDER BY m."horasSemana" DESC`,
				[carreraId]
			);

			console.log(`[AUTO-ORGANIZAR] Módulos pendientes encontrados: ${modulos.length}`);
			if (!modulos.length) {
				console.log('[AUTO-ORGANIZAR] Sin módulos pendientes, finalizando');
				return res.json({ 
					ok: true, 
					mensaje: 'No hay módulos pendientes de asignar', 
					asignaciones: [] 
				});
			}

			// 2. Obtener docentes disponibles para esta carrera (ordenados por prioridad)
			const docentes = await getDocentesPorCarrera(carreraId);
			console.log(`[AUTO-ORGANIZAR] Docentes elegibles: ${docentes.length}`);

			if (!docentes.length) {
				console.warn('[AUTO-ORGANIZAR] Error: sin docentes para carrera', carreraId);
				return res.status(400).json({ 
					error: 'No hay docentes asignados a esta carrera' 
				});
			}

			// 3. Configurar fechas de asignación
			const fechaBase = fechaInicio ? new Date(fechaInicio) : new Date();
			const asignaciones = [];
			const errores = [];

			// 4. Para cada módulo, intentar asignar bloques
			for (const modulo of modulos) {
				const horasPendientes = modulo.horas_requeridas - modulo.horas_asignadas;
				const bloquesPendientes = Math.ceil(horasPendientes / (BLOCK_MINUTES / 60.0));

				// Verificar preferencias de docente para este módulo
				const { rows: preferencias } = await db.query(
					`SELECT docente_rut FROM modulo_docente_preferencias 
					 WHERE codigo_modulo = $1`,
					[modulo.codigo_asignatura]
				);

				// Priorizar docente preferido si existe
				let docentesOrdenados = [...docentes];
				if (preferencias.length > 0) {
					const rutPreferido = preferencias[0].docente_rut;
					const docentePreferido = docentes.find(d => d.id === rutPreferido || d.rut === rutPreferido);
					if (docentePreferido) {
						docentesOrdenados = [
							docentePreferido,
							...docentes.filter(d => d.id !== docentePreferido.id)
						];
					}
				}

				// Intentar asignar bloques a lo largo de las semanas
				let bloquesAsignados = 0;
				for (let semana = 0; semana < semanas && bloquesAsignados < bloquesPendientes; semana++) {
					// Recorrer días de la semana (Lunes=1 a Viernes=5)
					for (let diaSemana = 1; diaSemana <= 5 && bloquesAsignados < bloquesPendientes; diaSemana++) {
						// Calcular fecha específica
						const fecha = new Date(fechaBase);
						fecha.setDate(fecha.getDate() + (semana * 7) + (diaSemana - 1));

						// Recorrer bloques del día (1-22)
						for (let bloque = 1; bloque <= 22 && bloquesAsignados < bloquesPendientes; bloque++) {
							// Buscar docente disponible con mejor score
							let mejorDocente = null;
							let mejorScore = 0;
							let mejorSala = null;

							for (const docente of docentesOrdenados) {
								// Verificar disponibilidad del docente
								const disponible = await docenteDisponibleEnBloque(
									docente.id, 
									diaSemana, 
									bloque, 
									fecha
								);

								if (!disponible) continue;

								// Verificar carga del docente
								const carga = await getCargaDocente(docente.id);
								const bloquesContrato = (carga.contratoSemana * 60) / BLOCK_MINUTES;
								if (carga.bloques >= bloquesContrato) continue;

								// Obtener salas disponibles
								const salas = await obtenerSalasDisponibles(carreraId, diaSemana, bloque, bloque);
								
								for (const sala of salas) {
									// Calcular timestamp para el bloque
									const startTime = new Date(fecha);
									const horaInicio = 8 * 60 + 30 + (bloque - 1) * BLOCK_MINUTES;
									startTime.setHours(Math.floor(horaInicio / 60), horaInicio % 60, 0, 0);
									
									const endTime = new Date(startTime);
									endTime.setMinutes(endTime.getMinutes() + BLOCK_MINUTES);

									// Validar que la sala esté libre
									const salaLibre = await validarConflictosSala(sala.id, startTime, endTime);
									if (!salaLibre) continue;

									// Calcular score de esta combinación
									const score = await calcularScoreDisponibilidad(
										docente.id,
										sala.id,
										modulo.id,
										diaSemana,
										bloque,
										fecha
									);

									if (score > mejorScore) {
										mejorScore = score;
										mejorDocente = docente;
										mejorSala = sala;
									}
								}
							}

							// Si encontramos una buena combinación, asignar el evento
							if (mejorDocente && mejorSala && mejorScore > 0) {
								try {
									const startTime = new Date(fecha);
									const horaInicio = 8 * 60 + 30 + (bloque - 1) * BLOCK_MINUTES;
									startTime.setHours(Math.floor(horaInicio / 60), horaInicio % 60, 0, 0);
									
									const endTime = new Date(startTime);
									endTime.setMinutes(endTime.getMinutes() + BLOCK_MINUTES);

									const resultado = await asignarEvento({
										moduloId: modulo.id,
										docenteId: mejorDocente.id,
										salaId: mejorSala.id,
										start: startTime.toISOString(),
										end: endTime.toISOString()
									});

									asignaciones.push({
										eventoId: resultado.id,
										modulo: modulo.nombre,
										docente: mejorDocente.nombre,
										sala: mejorSala.nombre,
										fecha: fecha.toISOString().split('T')[0],
										bloque,
										score: mejorScore
									});

									bloquesAsignados++;
								} catch (error) {
									errores.push({
										modulo: modulo.nombre,
										error: error.message
									});
								}
							}
						}
					}
				}

				// Si no se pudieron asignar todos los bloques necesarios
				if (bloquesAsignados < bloquesPendientes) {
					errores.push({
						modulo: modulo.nombre,
						mensaje: `Solo se asignaron ${bloquesAsignados} de ${bloquesPendientes} bloques requeridos`
					});
				}
			}

			const resultado = {
				ok: true,
				asignaciones,
				errores: errores.length > 0 ? errores : undefined,
				resumen: {
					totalAsignaciones: asignaciones.length,
					modulosProcesados: modulos.length,
					errores: errores.length
				}
			};
			console.log('[AUTO-ORGANIZAR] Resultado final con resumen:', JSON.stringify(resultado, null, 2));
			res.json(resultado);

		} catch (error) {
			console.error('[AUTO-ORGANIZAR] Error crítico:', error);
			res.status(500).json({ 
				error: 'Error al auto-organizar', 
				details: error.message 
			});
		}
	});
} else {
	// DB missing — return 503 for API routes
	app.get('/api/*', (req,res)=>{ res.status(503).json({ error: 'DB not available on server. Define DATABASE_URL to enable API endpoints.' }); });
}

const port = process.env.PORT || 3001;
app.listen(port, ()=>{ console.log('Server listening on', port); });
// Eliminado helper fetchModulos: fragmento copiado del frontend que nunca se ejecutaba.
