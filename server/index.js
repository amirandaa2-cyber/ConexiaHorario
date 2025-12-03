const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');
const db = require('./db');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
// Serve static files from repository root so examples can be opened via http://localhost:3001/examples/...
app.use(express.static(path.join(__dirname, '..')));
app.use(bodyParser.json());

const dbReady = db && db.ready;
const AUTH_TOKEN_TTL_HOURS = parseInt(process.env.SESSION_TTL_HOURS || '12', 10);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET || undefined) : null;
const USE_DB_ONLY = /^(1|true)$/i.test(process.env.USE_DB_ONLY || '');
const ALLOWED_ROLE_CODES = (process.env.ALLOWED_ROLE_CODES || 'admin,docente')
	.split(',')
	.map((code) => code.trim().toLowerCase())
	.filter(Boolean);
const BLOCK_MINUTES = 35;

// DAO helpers for auto-organize
async function getDocentesPorCarrera(carreraId) {
	const { rows } = await db.query(
		`SELECT d.id, d.nombre, d."ContratoHoraSemanal" AS contrato_semana,
						dc.activo, COALESCE(dc.prioridad, 999) AS prioridad
			 FROM docente_carrera dc
			 JOIN docentes d ON d.id = dc.docente_id
			WHERE dc.carrera_id = $1 AND COALESCE(dc.activo, TRUE)
			ORDER BY prioridad ASC, d.nombre ASC`,
		[String(carreraId).trim()]
	);
	return rows;
}

async function getCargaDocente(docenteId) {
	const { rows } = await db.query(
		`SELECT COALESCE(SUM(ROUND(EXTRACT(EPOCH FROM ("end" - start)) / (60.0 * $2))), 0)::int AS bloques,
						COALESCE(MAX(d."ContratoHoraSemanal"), 0) AS contrato_semana
			 FROM events e
			 LEFT JOIN docentes d ON d.id = e.docente_id
			WHERE e.docente_id = $1`,
		[String(docenteId).trim(), BLOCK_MINUTES]
	);
	const bloques = Number(rows[0]?.bloques) || 0;
	const contratoSemana = Number(rows[0]?.contrato_semana) || 0;
	return { bloques, contratoSemana };
}

async function asignarEvento({ moduloId, docenteId, start, end }) {
	const id = uuidv4();
	const titleRow = await db.query('SELECT nombre, carrera_id FROM modulos WHERE id=$1', [moduloId]);
	const title = titleRow.rows[0]?.nombre || `Módulo ${moduloId}`;
	const carreraId = titleRow.rows[0]?.carrera_id ? String(titleRow.rows[0].carrera_id) : null;
	const meta = {
		moduloId,
		docenteId,
		...(carreraId ? { carreraId } : {})
	};
	await db.query(
		`INSERT INTO events (id, title, start, "end", modulo_id, docente_id, extendedProps)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 ON CONFLICT (title, start, "end") DO NOTHING`,
		[id, title, start, end, moduloId, docenteId, JSON.stringify({ __meta: meta })]
	);
	return { id };
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
	return {
		moduloId: toSafeInteger(moduloCandidate),
		docenteId: docenteCandidate ? String(docenteCandidate).trim() : null,
		salaId: salaCandidate ? String(salaCandidate).trim() : null,
		carreraId: meta.carreraId ? String(meta.carreraId).trim() : null
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
		meta.docenteRut,
		meta.docenteRUT,
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
		const rut = normalizeRut(hint);
		if (rut) {
			const byRut = await db.query('SELECT id FROM docentes WHERE REPLACE(REPLACE(UPPER(rut), ".", \'\'), \'-\', \'\') = $1 LIMIT 1', [rut]);
			if (byRut.rowCount) return byRut.rows[0].id;
		}
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
	const existingMeta = safeProps.__meta && typeof safeProps.__meta === 'object' ? safeProps.__meta : {};
	const mergedMeta = {
		...existingMeta,
		...(linking.moduloId !== null && linking.moduloId !== undefined ? { moduloId: String(linking.moduloId) } : {}),
		...(linking.docenteId ? { docenteId: String(linking.docenteId) } : {}),
		...(linking.salaId ? { salaId: String(linking.salaId) } : {}),
		...(linking.carreraId ? { carreraId: String(linking.carreraId) } : {})
	};
	safeProps.__meta = mergedMeta;
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
				: existingMeta.carreraId ?? null
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
	const expiresAt = new Date(Date.now() + AUTH_TOKEN_TTL_HOURS * 60 * 60 * 1000);
	const token = uuidv4();
	await db.query(
		`INSERT INTO auth_session_token (token, user_id, expires_at, metadata)
		 VALUES ($1, $2, $3, $4)`,
		[token, userId, expiresAt.toISOString(), JSON.stringify({
			source: 'admin-ui',
			ip: req?.ip || null,
			userAgent: req?.headers?.['user-agent'] || null
		})]
	);
	return { token, expiresAt: expiresAt.toISOString() };
}

async function loadSessionFromToken(rawToken, { requireAdmin = false } = {}){
	if (!rawToken) return null;
	const { rows } = await db.query(
		`SELECT s.token, s.user_id, s.expires_at,
		        u.full_name, u.email, u.is_active,
		        ARRAY_REMOVE(ARRAY_AGG(r.code), NULL) AS roles
		   FROM auth_session_token s
		   JOIN auth_user u ON u.id = s.user_id
		   LEFT JOIN auth_user_role ur ON ur.user_id = u.id
		   LEFT JOIN auth_role r ON r.id = ur.role_id
		  WHERE s.token = $1
		  GROUP BY s.token, s.user_id, s.expires_at, u.full_name, u.email, u.is_active
		  LIMIT 1`,
		[rawToken]
	);
	if (!rows.length) return null;
	const row = rows[0];
	const expired = row.expires_at && new Date(row.expires_at) < new Date();
	if (!row.is_active || expired) {
		await db.query('DELETE FROM auth_session_token WHERE token = $1', [rawToken]);
		return null;
	}
	const roles = mapRoleCodes(row.roles);
	if (requireAdmin && !roles.includes('admin')) {
		return null;
	}
	return {
		sessionId: row.token,
		userId: row.user_id,
		expiraEn: row.expires_at,
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
		allowedRoles: ALLOWED_ROLE_CODES
	});
});

// Basic CRUD endpoints (only enabled if DB loaded)
if(dbReady){
	// Auto-organize endpoint: assigns pending modules to eligible docentes
	app.post('/api/auto-organizar', async (req, res) => {
		try {
			const token = extractToken(req);
			const session = await loadSessionFromToken(token, { requireAdmin: true });
			if (!session) return res.status(401).json({ error: 'No autorizado' });

			const { carreraId, startDate, weeks = 1 } = req.body || {};
			const carrera = String(carreraId || '').trim();
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
			let baseStart = startDate ? new Date(startDate) : new Date();
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

			res.json({ assigned: assignments.length, assignments });
		} catch (err) {
			handleDbError(res, err);
		}
	});
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
			res.json({ user: session.user, tokenExpiresAt: session.expiraEn });
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
				       rut,
				       nombre,
				       email,
				       titulo,
				       "contratoHoras" AS "contratoHoras",
			       "ContratoHoraSemanal" AS "ContratoHoraSemanal",
	       carrera_id AS "carreraId",
			       edad AS edad,
			       estadoCivil AS "estadoCivil",
			       turno AS turno,
			       COALESCE(activo, TRUE) AS activo,
				       "TotalHrsModulos" AS "TotalHrsModulos",
				       "Hrs Teóricas" AS "Hrs Teóricas",
				       "Hrs Prácticas" AS "Hrs Prácticas",
				       "Total hrs Semana" AS "Total hrs Semana",
				       created_at,
				       updated_at
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
				`INSERT INTO docentes (id,rut,nombre,email,titulo,"contratoHoras","ContratoHoraSemanal",carrera_id,edad,estadoCivil,turno,activo,"TotalHrsModulos","Hrs Teóricas","Hrs Prácticas","Total hrs Semana")
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
				 ON CONFLICT (id) DO UPDATE
				 SET rut=EXCLUDED.rut,
				     nombre=EXCLUDED.nombre,
				     email=EXCLUDED.email,
				     titulo=EXCLUDED.titulo,
				     "contratoHoras"=EXCLUDED."contratoHoras",
		     "ContratoHoraSemanal"=EXCLUDED."ContratoHoraSemanal",
		     carrera_id=EXCLUDED.carrera_id,
			     edad=EXCLUDED.edad,
			     estadoCivil=EXCLUDED.estadoCivil,
			     turno=EXCLUDED.turno,
			     activo=EXCLUDED.activo,
				     "TotalHrsModulos"=EXCLUDED."TotalHrsModulos",
				     "Hrs Teóricas"=EXCLUDED."Hrs Teóricas",
				     "Hrs Prácticas"=EXCLUDED."Hrs Prácticas",
				     "Total hrs Semana"=EXCLUDED."Total hrs Semana"`,
				[
					id,
					d.rut,
					d.nombre,
					d.email||null,
					d.titulo||null,
					d.contratoHoras||0,
					d.ContratoHoraSemanal||0,
					d.carreraId||null,
					Number.isFinite(d.edad) ? d.edad : null,
					d.estadoCivil||null,
					d.turno||null,
					(d.activo === false ? false : true),
					d.TotalHrsModulos||0,
					d['Hrs Teóricas']||0,
					d['Hrs Prácticas']||0,
					d['Total hrs Semana']||0
				]
			);
			res.json({ok:true,id});
		}catch(err){ handleDbError(res, err); }
	});

	app.put('/api/docentes/:id', async (req,res)=>{
		const d = req.body;
		try{
			await db.query(
				'UPDATE docentes SET rut=$1, nombre=$2, email=$3, titulo=$4, "contratoHoras"=$5, "ContratoHoraSemanal"=$6, carrera_id=$7, edad=$8, estadoCivil=$9, turno=$10, activo=$11, "TotalHrsModulos"=$12, "Hrs Teóricas"=$13, "Hrs Prácticas"=$14, "Total hrs Semana"=$15 WHERE id=$16',
				[d.rut, d.nombre, d.email||null, d.titulo||null, d.contratoHoras||0, d.ContratoHoraSemanal||0, d.carreraId||null, Number.isFinite(d.edad)?d.edad:null, d.estadoCivil||null, d.turno||null, (d.activo===false?false:true), d.TotalHrsModulos||0, d['Hrs Teóricas']||0, d['Hrs Prácticas']||0, d['Total hrs Semana']||0, req.params.id]
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
				[id, payload.title, payload.start, payload.end, linking.moduloId, linking.docenteId, linking.salaId, extendedProps]
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
		try{
			const existingResult = await db.query('SELECT docente_id, start FROM events WHERE id=$1 LIMIT 1', [req.params.id]);
			if (!existingResult.rowCount) {
				return res.status(404).json({ error: 'Evento no encontrado.' });
			}
			const previousEvent = existingResult.rows[0];
			const updatedResult = await db.query(
				'UPDATE events SET title=$1, start=$2, "end"=$3, modulo_id=$4, docente_id=$5, sala_id=$6, extendedProps=$7, updated_at=NOW() WHERE id=$8 RETURNING id, docente_id, start',
				[payload.title, payload.start, payload.end, linking.moduloId, linking.docenteId, linking.salaId, extendedProps, req.params.id]
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
} else {
	// DB missing — return 503 for API routes
	app.get('/api/*', (req,res)=>{ res.status(503).json({ error: 'DB not available on server. Define DATABASE_URL to enable API endpoints.' }); });
}

const port = process.env.PORT || 3001;
app.listen(port, ()=>{ console.log('Server listening on', port); });
// Eliminado helper fetchModulos: fragmento copiado del frontend que nunca se ejecutaba.
