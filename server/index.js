const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
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
const MAX_FAILED_ATTEMPTS = parseInt(process.env.MAX_FAILED_ATTEMPTS || '5', 10);
const LOCKOUT_MINUTES = parseInt(process.env.LOCKOUT_MINUTES || '15', 10);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET) : null;
const USE_DB_ONLY = /^(1|true)$/i.test(process.env.USE_DB_ONLY || '');

function handleDbError(res, err){
  console.error('Database error', err);
  res.status(500).json({ error: 'Database error', details: err.message });
}

function hashToken(raw){
	return crypto.createHash('sha256').update(String(raw || '')).digest('hex');
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

async function recordFailedAttempt(user){
	const attempts = (user.intentos_fallidos || 0) + 1;
	if (attempts >= MAX_FAILED_ATTEMPTS){
		const lockUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000);
		await db.query(
			'UPDATE usuarios SET intentos_fallidos=$1, bloqueo_hasta=$2, actualizado_en=now() WHERE id=$3',
			[attempts, lockUntil, user.id]
		);
	} else {
		await db.query('UPDATE usuarios SET intentos_fallidos=$1, actualizado_en=now() WHERE id=$2', [attempts, user.id]);
	}
}

async function resetFailedAttempts(userId){
	await db.query('UPDATE usuarios SET intentos_fallidos=0, bloqueo_hasta=NULL, actualizado_en=now() WHERE id=$1', [userId]);
}

async function createLoginSession(userId, rawToken, req){
	const expiresAt = new Date(Date.now() + AUTH_TOKEN_TTL_HOURS * 60 * 60 * 1000);
	await db.query(
		'INSERT INTO login_sessions (id, usuario_id, token, user_agent, ip_address, expira_en) VALUES ($1,$2,$3,$4,$5,$6)',
		[uuidv4(), userId, hashToken(rawToken), req.headers['user-agent'] || null, req.ip || null, expiresAt]
	);
	return expiresAt.toISOString();
}

async function loadSessionFromToken(rawToken, { requireAdmin = false } = {}){
	if (!rawToken) return null;
	const tokenHash = hashToken(rawToken);
	const { rows } = await db.query(
		`SELECT ls.id AS session_id, ls.usuario_id, ls.expira_en, ls.revocado,
						u.username, u.email, u.rol, u.esta_activo
			 FROM login_sessions ls
			 JOIN usuarios u ON u.id = ls.usuario_id
			WHERE ls.token=$1
			LIMIT 1`,
		[tokenHash]
	);
	if (!rows.length) return null;
	const row = rows[0];
	const now = new Date();
	if (row.revocado || (row.expira_en && new Date(row.expira_en) < now) || !row.esta_activo) {
		if (!row.revocado) {
			await db.query('UPDATE login_sessions SET revocado=true WHERE id=$1', [row.session_id]);
		}
		return null;
	}
	if (requireAdmin && row.rol !== 'admin') {
		return null;
	}
	return {
		sessionId: row.session_id,
		userId: row.usuario_id,
		expiraEn: row.expira_en,
		user: {
			id: row.usuario_id,
			username: row.username,
			email: row.email,
			rol: row.rol
		}
	};
}

app.get('/api/public-config', (req,res)=>{
	res.json({
		googleClientId: GOOGLE_CLIENT_ID || null,
		useDbOnly: USE_DB_ONLY
	});
});

// Basic CRUD endpoints (only enabled if DB loaded)
if(dbReady){
	app.post('/api/auth/login', async (req,res)=>{
		const { identifier, password } = req.body || {};
		if (!identifier || !password) {
			return res.status(400).json({ error: 'Debes proporcionar usuario/correo y contraseña.' });
		}
		try {
			const { rows } = await db.query(
				`SELECT id, email, username, password_hash, rol, esta_activo, ultimo_login, intentos_fallidos, bloqueo_hasta
				   FROM usuarios
				  WHERE (LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1))
				    AND rol = 'admin'
				  LIMIT 1`,
				[identifier]
			);
			if (!rows.length) {
				return res.status(401).json({ error: 'Credenciales inválidas.' });
			}
			const user = rows[0];
			if (!user.esta_activo) {
				return res.status(403).json({ error: 'La cuenta está deshabilitada.' });
			}
			if (user.bloqueo_hasta && new Date(user.bloqueo_hasta) > new Date()) {
				return res.status(423).json({ error: 'Cuenta bloqueada temporalmente. Inténtalo más tarde.' });
			}
			const passOk = await bcrypt.compare(password, user.password_hash || '');
			if (!passOk) {
				await recordFailedAttempt(user);
				return res.status(401).json({ error: 'Credenciales inválidas.' });
			}
			await resetFailedAttempts(user.id);
			await db.query('UPDATE usuarios SET ultimo_login=now(), actualizado_en=now() WHERE id=$1', [user.id]);
			const token = crypto.randomBytes(48).toString('hex');
			const expiresAt = await createLoginSession(user.id, token, req);
			res.json({
				token,
				expiresAt,
				user: {
					id: user.id,
					email: user.email,
					username: user.username,
					rol: user.rol
				}
			});
		} catch (err) {
			handleDbError(res, err);
		}
	});

	app.post('/api/auth/logout', async (req,res)=>{
		const token = extractToken(req);
		if (!token) {
			return res.status(400).json({ error: 'Token requerido para cerrar sesión.' });
		}
		try {
			await db.query('UPDATE login_sessions SET revocado=true WHERE token=$1', [hashToken(token)]);
			res.json({ ok: true });
		} catch (err) {
			handleDbError(res, err);
		}
	});

	app.get('/api/auth/session', async (req,res)=>{
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
					const email = (payload && payload.email) ? payload.email.toLowerCase() : null;
					if (!email) {
						return res.status(400).json({ error: 'Cuenta de Google sin correo verificado.' });
					}
					const { rows } = await db.query(
						`SELECT id, email, username, rol, esta_activo
						   FROM usuarios
						  WHERE LOWER(email) = LOWER($1)
						    AND rol = 'admin'
						  LIMIT 1`,
						[email]
					);
					if (!rows.length) {
						return res.status(403).json({ error: 'Esta cuenta no tiene permisos para acceder.' });
					}
					const user = rows[0];
					if (!user.esta_activo) {
						return res.status(403).json({ error: 'La cuenta está deshabilitada.' });
					}
					await db.query('UPDATE usuarios SET ultimo_login=now(), actualizado_en=now() WHERE id=$1', [user.id]);
					const token = crypto.randomBytes(48).toString('hex');
					const expiresAt = await createLoginSession(user.id, token, req);
					res.json({
						token,
						expiresAt,
						user: {
							id: user.id,
							email: user.email,
							username: user.username,
							rol: user.rol
						}
					});
				} catch (err) {
					console.error('Google auth error', err);
					res.status(401).json({ error: 'No se pudo validar la sesión de Google.' });
				}
			});
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
			const { rows } = await db.query('SELECT * FROM carreras ORDER BY nombre ASC');
			res.json(rows);
		}catch(err){ handleDbError(res, err); }
	});

	app.post('/api/carreras', async (req,res)=>{
		const c = req.body;
		const id = c.id || uuidv4();
		try{
			await db.query(
				'INSERT INTO carreras (id,nombre,totalHoras,practicaHoras,teoricaHoras,colorDiurno,colorVespertino) VALUES ($1,$2,$3,$4,$5,$6,$7)',
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
			const { rows } = await db.query('SELECT * FROM modulos ORDER BY nombre ASC');
			res.json(rows);
		}catch(err){ handleDbError(res, err); }
	});

	app.post('/api/modulos', async (req,res)=>{
		const m = req.body;
		const id = m.id || uuidv4();
		try{
			await db.query(
				'INSERT INTO modulos (id,nombre,carreraId,horas,tipo) VALUES ($1,$2,$3,$4,$5)',
				[id, m.nombre, m.carreraId, m.horas||0, m.tipo||'Teórico']
			);
			res.json({ok:true,id});
		}catch(err){ handleDbError(res, err); }
	});

	app.put('/api/modulos/:id', async (req,res)=>{
		const m = req.body;
		try{
			await db.query(
				'UPDATE modulos SET nombre=$1, carreraId=$2, horas=$3, tipo=$4 WHERE id=$5',
				[m.nombre, m.carreraId, m.horas||0, m.tipo||'Teórico', req.params.id]
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
			const { rows } = await db.query('SELECT * FROM docentes ORDER BY nombre ASC');
			res.json(rows);
		}catch(err){ handleDbError(res, err); }
	});

	app.post('/api/docentes', async (req,res)=>{
		const d = req.body;
		const id = d.id || uuidv4();
		try{
			await db.query(
				'INSERT INTO docentes (id,rut,nombre,edad,estadoCivil,contratoHoras,horasAsignadas,horasTrabajadas,turno,activo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
				[id, d.rut, d.nombre, d.edad||0, d.estadoCivil||'', d.contratoHoras||0, d.horasAsignadas||0, d.horasTrabajadas||0, d.turno||'Diurno', !!d.activo]
			);
			res.json({ok:true,id});
		}catch(err){ handleDbError(res, err); }
	});

	app.put('/api/docentes/:id', async (req,res)=>{
		const d = req.body;
		try{
			await db.query(
				'UPDATE docentes SET rut=$1, nombre=$2, edad=$3, estadoCivil=$4, contratoHoras=$5, horasAsignadas=$6, horasTrabajadas=$7, turno=$8, activo=$9 WHERE id=$10',
				[d.rut, d.nombre, d.edad||0, d.estadoCivil||'', d.contratoHoras||0, d.horasAsignadas||0, d.horasTrabajadas||0, d.turno||'Diurno', !!d.activo, req.params.id]
			);
			res.json({ok:true});
		}catch(err){ handleDbError(res, err); }
	});

	app.delete('/api/docentes/:id', async (req,res)=>{
		try{
			await db.query('DELETE FROM docentes WHERE id=$1', [req.params.id]);
			res.json({ok:true});
		}catch(err){ handleDbError(res, err); }
	});

	app.get('/api/salas', async (req,res)=>{
		try{
			const { rows } = await db.query('SELECT * FROM salas ORDER BY nombre ASC');
			res.json(rows);
		}catch(err){ handleDbError(res, err); }
	});

	app.post('/api/salas', async (req,res)=>{
		const s = req.body;
		const id = s.id || uuidv4();
		try{
			await db.query(
				'INSERT INTO salas (id,nombre,capacidad) VALUES ($1,$2,$3)',
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
			const { rows } = await db.query('SELECT * FROM templates');
			res.json(rows);
		}catch(err){ handleDbError(res, err); }
	});

	app.post('/api/templates', async (req,res)=>{
		const t = req.body;
		const id = t.id || uuidv4();
		try{
			await db.query(
				'INSERT INTO templates (id,moduloId,docenteId,salaId,startDate,time,duration,until) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
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
				'INSERT INTO events (id,title,start,"end",extendedProps) VALUES ($1,$2,$3,$4,$5)',
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
