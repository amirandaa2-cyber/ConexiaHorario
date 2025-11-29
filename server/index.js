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
				`INSERT INTO carreras (id,nombre,totalHoras,practicaHoras,teoricaHoras,colorDiurno,colorVespertino)
				 VALUES ($1,$2,$3,$4,$5,$6,$7)
				 ON CONFLICT (id) DO UPDATE
				 SET nombre=EXCLUDED.nombre,
				     totalHoras=EXCLUDED.totalHoras,
				     practicaHoras=EXCLUDED.practicaHoras,
				     teoricaHoras=EXCLUDED.teoricaHoras,
				     colorDiurno=EXCLUDED.colorDiurno,
				     colorVespertino=EXCLUDED.colorVespertino`,
				[id, c.nombre, c.totalHoras||0, c.practicaHoras||0, c.teoricaHoras||0, c.colorDiurno||null, c.colorVespertino||null]
			);
			res.json({ok:true,id});
		}catch(err){ handleDbError(res, err); }
	});

	app.put('/api/carreras/:id', async (req,res)=>{
		const c = req.body;
		try{
			await db.query(
				'UPDATE carreras SET nombre=$1, totalHoras=$2, practicaHoras=$3, teoricaHoras=$4, colorDiurno=$5, colorVespertino=$6 WHERE id=$7',
				[c.nombre, c.totalHoras||0, c.practicaHoras||0, c.teoricaHoras||0, c.colorDiurno||null, c.colorVespertino||null, req.params.id]
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
				       carreraId AS "carreraId",
				       totalHoras,
				       horasTeoricas,
				       horasPracticas,
				       horasSemanales
				  FROM modulos
				 ORDER BY nombre ASC`);
			res.json(rows);
		}catch(err){ handleDbError(res, err); }
	});

	app.post('/api/modulos', async (req,res)=>{
		const m = req.body;
		const id = m.id || uuidv4();
		try{
			await db.query(
				`INSERT INTO modulos (id,nombre,carreraId,totalHoras,horasTeoricas,horasPracticas,horasSemanales)
				 VALUES ($1,$2,$3,$4,$5,$6,$7)
				 ON CONFLICT (id) DO UPDATE
				 SET nombre=EXCLUDED.nombre,
				     carreraId=EXCLUDED.carreraId,
				     totalHoras=EXCLUDED.totalHoras,
				     horasTeoricas=EXCLUDED.horasTeoricas,
				     horasPracticas=EXCLUDED.horasPracticas,
				     horasSemanales=EXCLUDED.horasSemanales`,
				[
					id,
					m.nombre,
					m.carreraId || null,
					m.totalHoras ?? 0,
					m.horasTeoricas ?? 0,
					m.horasPracticas ?? 0,
					m.horasSemanales ?? 0
				]
			);
			res.json({ok:true,id});
		}catch(err){ handleDbError(res, err); }
	});

	app.put('/api/modulos/:id', async (req,res)=>{
		const m = req.body;
		try{
			await db.query(
				'UPDATE modulos SET nombre=$1, carreraId=$2, totalHoras=$3, horasTeoricas=$4, horasPracticas=$5, horasSemanales=$6, updated_at=NOW() WHERE id=$7',
				[
					m.nombre,
					m.carreraId || null,
					m.totalHoras ?? 0,
					m.horasTeoricas ?? 0,
					m.horasPracticas ?? 0,
					m.horasSemanales ?? 0,
					req.params.id
				]
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
			       carreraId AS "carreraId",
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
				`INSERT INTO docentes (id,rut,nombre,email,titulo,"contratoHoras","ContratoHoraSemanal",carreraId,edad,estadoCivil,turno,activo,"TotalHrsModulos","Hrs Teóricas","Hrs Prácticas","Total hrs Semana")
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
				 ON CONFLICT (id) DO UPDATE
				 SET rut=EXCLUDED.rut,
				     nombre=EXCLUDED.nombre,
				     email=EXCLUDED.email,
				     titulo=EXCLUDED.titulo,
				     "contratoHoras"=EXCLUDED."contratoHoras",
			     "ContratoHoraSemanal"=EXCLUDED."ContratoHoraSemanal",
			     carreraId=EXCLUDED.carreraId,
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
				'UPDATE docentes SET rut=$1, nombre=$2, email=$3, titulo=$4, "contratoHoras"=$5, "ContratoHoraSemanal"=$6, carreraId=$7, edad=$8, estadoCivil=$9, turno=$10, activo=$11, "TotalHrsModulos"=$12, "Hrs Teóricas"=$13, "Hrs Prácticas"=$14, "Total hrs Semana"=$15 WHERE id=$16',
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
				       until
				  FROM templates`);
			res.json(rows);
		}catch(err){ handleDbError(res, err); }
	});

	app.post('/api/templates', async (req,res)=>{
		const t = req.body;
		const id = t.id || uuidv4();
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
				     until=EXCLUDED.until`,
				[id, t.moduloId, t.docenteId, t.salaId, t.startDate, t.time, t.duration, t.until]
			);
			res.json({ok:true,id});
		}catch(err){ handleDbError(res, err); }
	});

	app.put('/api/templates/:id', async (req,res)=>{
		const t = req.body;
		try{
			await db.query(
				'UPDATE templates SET moduloId=$1, docenteId=$2, salaId=$3, startDate=$4, time=$5, duration=$6, until=$7 WHERE id=$8',
				[t.moduloId, t.docenteId, t.salaId, t.startDate, t.time, t.duration, t.until, req.params.id]
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
			const { rows } = await db.query("SELECT id, title, start, \"end\", COALESCE(extendedProps, '{}'::jsonb) AS \"extendedProps\" FROM events");
			res.json(rows.map((row)=>({
				id: row.id,
				title: row.title,
				start: row.start,
				end: row.end,
				extendedProps: row.extendedProps || {}
			})));
		}catch(err){ handleDbError(res, err); }
	});

	app.post('/api/events', async (req,res)=>{
		const e = req.body;
		const id = e.id || uuidv4();
		try{
			await db.query(
				`INSERT INTO events (id,title,start,"end",extendedProps)
				 VALUES ($1,$2,$3,$4,$5)
				 ON CONFLICT (id) DO UPDATE
				 SET title=$2,
				     start=$3,
				     "end"=$4,
				     extendedProps=$5`,
				[id, e.title, e.start, e.end, e.extendedProps || {}]
			);
			res.json({ok:true,id});
		}catch(err){ handleDbError(res, err); }
	});

	app.put('/api/events/:id', async (req,res)=>{
		const e = req.body;
		try{
			await db.query(
				'UPDATE events SET title=$1, start=$2, "end"=$3, extendedProps=$4 WHERE id=$5',
				[e.title, e.start, e.end, e.extendedProps || {}, req.params.id]
			);
			res.json({ok:true});
		}catch(err){ handleDbError(res, err); }
	});

	app.delete('/api/events/:id', async (req,res)=>{
		try{
			await db.query('DELETE FROM events WHERE id=$1', [req.params.id]);
			res.json({ok:true});
		}catch(err){ handleDbError(res, err); }
	});
} else {
	// DB missing — return 503 for API routes
	app.get('/api/*', (req,res)=>{ res.status(503).json({ error: 'DB not available on server. Define DATABASE_URL to enable API endpoints.' }); });
}

const port = process.env.PORT || 3001;
app.listen(port, ()=>{ console.log('Server listening on', port); });

async function fetchModulos() {
  if (!USE_API) return load(KEY_MODULOS, []);
  try {
    const r = await authorizedFetch(API_BASE + '/modulos');
    const data = r.ok ? await r.json() : [];
    return (data || []).map(m => {
      if (!m) return m;
      let id = m.id ?? m.moduloId ?? m.codigo;
      if (id != null) id = String(id);

      // añadir carreraid aquí
      let carreraId = m.carreraId ?? m.carrera_id ?? m.id_carrera ?? m.carreraid;
      if (!carreraId && m.carrera && m.carrera.id != null) carreraId = m.carrera.id;
      if (carreraId != null) carreraId = String(carreraId);

      return { ...m, id, carreraId };
    });
  } catch (err) {
    console.error('fetchModulos falló', err);
    return [];
  }
}
