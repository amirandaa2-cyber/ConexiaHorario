const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const app = express();
app.use(cors());
// Serve static files from repository root so examples can be opened via http://localhost:3001/examples/...
app.use(express.static(path.join(__dirname, '..')));
app.use(bodyParser.json({ limit: '2mb' }));

let dbReady = false;

async function connectWithRetry(delayMs = 5000) {
	try {
		await db.ensureConnection();
		dbReady = true;
		console.log('[server] PostgreSQL connection ready');
	} catch (err) {
		dbReady = false;
		console.error('[server] Failed to connect to PostgreSQL, retrying in %sms', delayMs, err);
		setTimeout(() => connectWithRetry(delayMs), delayMs);
	}
}

connectWithRetry();

function requireDb(handler) {
	return async (req, res) => {
		if (!dbReady) {
			return res.status(503).json({ error: 'DB not available. Check server logs.' });
		}
		try {
			await handler(req, res);
		} catch (err) {
			console.error(`[api] ${req.method} ${req.originalUrl} failed`, err);
			res.status(500).json({ error: 'Unexpected server error' });
		}
	};
}

const selectCarreras = `
	SELECT id,
				 nombre,
				 totalhoras AS "totalHoras",
				 practicahoras AS "practicaHoras",
				 teoricahoras AS "teoricaHoras",
				 colordiurno AS "colorDiurno",
				 colorvespertino AS "colorVespertino",
				 created_at,
				 updated_at
	FROM carreras
	ORDER BY nombre ASC
`;

app.get('/api/carreras', requireDb(async (req, res) => {
	const { rows } = await db.query(selectCarreras);
	res.json(rows);
}));

app.post('/api/carreras', requireDb(async (req, res) => {
	const c = req.body || {};
	const id = c.id || uuidv4();
	await db.query(
		`INSERT INTO carreras (id, nombre, totalhoras, practicahoras, teoricahoras, colordiurno, colorvespertino)
		 VALUES ($1,$2,$3,$4,$5,$6,$7)
		 ON CONFLICT (id) DO UPDATE SET
			 nombre = EXCLUDED.nombre,
			 totalhoras = EXCLUDED.totalhoras,
			 practicahoras = EXCLUDED.practicahoras,
			 teoricahoras = EXCLUDED.teoricahoras,
			 colordiurno = EXCLUDED.colordiurno,
			 colorvespertino = EXCLUDED.colorvespertino`,
		[id, c.nombre || null, c.totalHoras || 0, c.practicaHoras || 0, c.teoricaHoras || 0, c.colorDiurno || null, c.colorVespertino || null]
	);
	res.json({ ok: true, id });
}));

app.put('/api/carreras/:id', requireDb(async (req, res) => {
	const id = req.params.id;
	const c = req.body || {};
	await db.query(
		`UPDATE carreras SET
			 nombre=$1,
			 totalhoras=$2,
			 practicahoras=$3,
			 teoricahoras=$4,
			 colordiurno=$5,
			 colorvespertino=$6,
			 updated_at=NOW()
		 WHERE id=$7`,
		[c.nombre || null, c.totalHoras || 0, c.practicaHoras || 0, c.teoricaHoras || 0, c.colorDiurno || null, c.colorVespertino || null, id]
	);
	res.json({ ok: true, id });
}));

app.delete('/api/carreras/:id', requireDb(async (req, res) => {
	await db.query('DELETE FROM carreras WHERE id=$1', [req.params.id]);
	res.json({ ok: true });
}));

app.get('/api/modulos', requireDb(async (req, res) => {
	const { rows } = await db.query(`
		SELECT id,
					 nombre,
					 carreraid AS "carreraId",
					 horas,
					 tipo,
					 created_at,
					 updated_at
		FROM modulos
		ORDER BY nombre ASC`);
	res.json(rows);
}));

app.post('/api/modulos', requireDb(async (req, res) => {
	const m = req.body || {};
	const id = m.id || uuidv4();
	await db.query(
		`INSERT INTO modulos (id, nombre, carreraid, horas, tipo)
		 VALUES ($1,$2,$3,$4,$5)
		 ON CONFLICT (id) DO UPDATE SET
			 nombre=EXCLUDED.nombre,
			 carreraid=EXCLUDED.carreraid,
			 horas=EXCLUDED.horas,
			 tipo=EXCLUDED.tipo`,
		[id, m.nombre || null, m.carreraId || null, m.horas || 0, m.tipo || 'Teórico']
	);
	res.json({ ok: true, id });
}));

app.put('/api/modulos/:id', requireDb(async (req, res) => {
	const id = req.params.id;
	const m = req.body || {};
	await db.query(
		`UPDATE modulos SET nombre=$1, carreraid=$2, horas=$3, tipo=$4, updated_at=NOW() WHERE id=$5`,
		[m.nombre || null, m.carreraId || null, m.horas || 0, m.tipo || 'Teórico', id]
	);
	res.json({ ok: true, id });
}));

app.delete('/api/modulos/:id', requireDb(async (req, res) => {
	await db.query('DELETE FROM modulos WHERE id=$1', [req.params.id]);
	res.json({ ok: true });
}));

app.get('/api/docentes', requireDb(async (req, res) => {
	const { rows } = await db.query(`
		SELECT id,
					 rut,
					 nombre,
					 edad,
					 estadocivil AS "estadoCivil",
					 contratohoras AS "contratoHoras",
					 horasasignadas AS "horasAsignadas",
					 horastrabajadas AS "horasTrabajadas",
					 turno,
					 activo,
					 created_at,
					 updated_at
		FROM docentes
		ORDER BY nombre ASC`);
	res.json(rows);
}));

app.post('/api/docentes', requireDb(async (req, res) => {
	const d = req.body || {};
	const id = d.id || uuidv4();
	await db.query(
		`INSERT INTO docentes (id, rut, nombre, edad, estadocivil, contratohoras, horasasignadas, horastrabajadas, turno, activo)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
		 ON CONFLICT (id) DO UPDATE SET
			 rut=EXCLUDED.rut,
			 nombre=EXCLUDED.nombre,
			 edad=EXCLUDED.edad,
			 estadocivil=EXCLUDED.estadocivil,
			 contratohoras=EXCLUDED.contratohoras,
			 horasasignadas=EXCLUDED.horasasignadas,
			 horastrabajadas=EXCLUDED.horastrabajadas,
			 turno=EXCLUDED.turno,
			 activo=EXCLUDED.activo`,
		[
			id,
			d.rut || null,
			d.nombre || null,
			d.edad || 0,
			d.estadoCivil || null,
			d.contratoHoras || 0,
			d.horasAsignadas || 0,
			d.horasTrabajadas || 0,
			d.turno || 'Diurno',
			typeof d.activo === 'boolean' ? d.activo : true
		]
	);
	res.json({ ok: true, id });
}));

app.put('/api/docentes/:id', requireDb(async (req, res) => {
	const id = req.params.id;
	const d = req.body || {};
	await db.query(
		`UPDATE docentes SET
			 rut=$1,
			 nombre=$2,
			 edad=$3,
			 estadocivil=$4,
			 contratohoras=$5,
			 horasasignadas=$6,
			 horastrabajadas=$7,
			 turno=$8,
			 activo=$9,
			 updated_at=NOW()
		 WHERE id=$10`,
		[
			d.rut || null,
			d.nombre || null,
			d.edad || 0,
			d.estadoCivil || null,
			d.contratoHoras || 0,
			d.horasAsignadas || 0,
			d.horasTrabajadas || 0,
			d.turno || 'Diurno',
			typeof d.activo === 'boolean' ? d.activo : true,
			id
		]
	);
	res.json({ ok: true, id });
}));

app.delete('/api/docentes/:id', requireDb(async (req, res) => {
	await db.query('DELETE FROM docentes WHERE id=$1', [req.params.id]);
	res.json({ ok: true });
}));

app.get('/api/salas', requireDb(async (req, res) => {
	const { rows } = await db.query('SELECT id, nombre, capacidad, created_at, updated_at FROM salas ORDER BY nombre ASC');
	res.json(rows);
}));

app.post('/api/salas', requireDb(async (req, res) => {
	const s = req.body || {};
	const id = s.id || uuidv4();
	await db.query(
		`INSERT INTO salas (id, nombre, capacidad)
		 VALUES ($1,$2,$3)
		 ON CONFLICT (id) DO UPDATE SET nombre=EXCLUDED.nombre, capacidad=EXCLUDED.capacidad`,
		[id, s.nombre || null, s.capacidad || 0]
	);
	res.json({ ok: true, id });
}));

app.put('/api/salas/:id', requireDb(async (req, res) => {
	const s = req.body || {};
	await db.query('UPDATE salas SET nombre=$1, capacidad=$2, updated_at=NOW() WHERE id=$3', [s.nombre || null, s.capacidad || 0, req.params.id]);
	res.json({ ok: true, id: req.params.id });
}));

app.delete('/api/salas/:id', requireDb(async (req, res) => {
	await db.query('DELETE FROM salas WHERE id=$1', [req.params.id]);
	res.json({ ok: true });
}));

app.get('/api/templates', requireDb(async (req, res) => {
	const { rows } = await db.query(`
		SELECT id,
					 moduloid AS "moduloId",
					 docenteid AS "docenteId",
					 salaid AS "salaId",
					 startdate AS "startDate",
					 time,
					 duration,
					 until,
					 created_at,
					 updated_at
		FROM templates
		ORDER BY created_at DESC NULLS LAST`);
	res.json(rows);
}));

app.post('/api/templates', requireDb(async (req, res) => {
	const t = req.body || {};
	const id = t.id || uuidv4();
	await db.query(
		`INSERT INTO templates (id, moduloid, docenteid, salaid, startdate, time, duration, until)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		 ON CONFLICT (id) DO UPDATE SET
			 moduloid=EXCLUDED.moduloid,
			 docenteid=EXCLUDED.docenteid,
			 salaid=EXCLUDED.salaid,
			 startdate=EXCLUDED.startdate,
			 time=EXCLUDED.time,
			 duration=EXCLUDED.duration,
			 until=EXCLUDED.until`,
		[id, t.moduloId || null, t.docenteId || null, t.salaId || null, t.startDate || null, t.time || null, t.duration || null, t.until || null]
	);
	res.json({ ok: true, id });
}));

app.put('/api/templates/:id', requireDb(async (req, res) => {
	const id = req.params.id;
	const t = req.body || {};
	await db.query(
		`UPDATE templates SET moduloid=$1, docenteid=$2, salaid=$3, startdate=$4, time=$5, duration=$6, until=$7, updated_at=NOW() WHERE id=$8`,
		[t.moduloId || null, t.docenteId || null, t.salaId || null, t.startDate || null, t.time || null, t.duration || null, t.until || null, id]
	);
	res.json({ ok: true, id });
}));

app.delete('/api/templates/:id', requireDb(async (req, res) => {
	await db.query('DELETE FROM templates WHERE id=$1', [req.params.id]);
	res.json({ ok: true });
}));

app.get('/api/events', requireDb(async (req, res) => {
	const { rows } = await db.query(`
		SELECT id,
					 title,
					 start,
					 "end",
					 extendedprops AS "extendedProps",
					 created_at,
					 updated_at
		FROM events
		ORDER BY start ASC`);
	res.json(rows.map(row => ({
		...row,
		extendedProps: row.extendedProps || {}
	})));
}));

app.post('/api/events', requireDb(async (req, res) => {
	const e = req.body || {};
	const id = e.id || uuidv4();
	await db.query(
		`INSERT INTO events (id, title, start, "end", extendedprops)
		 VALUES ($1,$2,$3,$4,$5)
		 ON CONFLICT (id) DO UPDATE SET
			 title=EXCLUDED.title,
			 start=EXCLUDED.start,
			 "end"=EXCLUDED."end",
			 extendedprops=EXCLUDED.extendedprops`,
		[id, e.title || '', e.start, e.end, JSON.stringify(e.extendedProps || {})]
	);
	res.json({ ok: true, id });
}));

app.put('/api/events/:id', requireDb(async (req, res) => {
	const id = req.params.id;
	const e = req.body || {};
	await db.query(
		`UPDATE events SET title=$1, start=$2, "end"=$3, extendedprops=$4, updated_at=NOW() WHERE id=$5`,
		[e.title || '', e.start, e.end, JSON.stringify(e.extendedProps || {}), id]
	);
	res.json({ ok: true, id });
}));

app.delete('/api/events/:id', requireDb(async (req, res) => {
	await db.query('DELETE FROM events WHERE id=$1', [req.params.id]);
	res.json({ ok: true });
}));

// Basic health endpoint
app.get('/api/health', (req, res) => {
	res.json({ ok: true, dbReady });
});

// Fallback for other API paths when DB missing
app.use('/api', (req, res) => {
	if (!dbReady) {
		return res.status(503).json({ error: 'DB not available. Check server logs.' });
	}
	res.status(404).json({ error: 'Not found' });
});

const port = process.env.PORT || 3001;
app.listen(port, () => {
	console.log('Server listening on', port);
});
