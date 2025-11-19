const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const db = require('./db');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
// Serve static files from repository root so examples can be opened via http://localhost:3001/examples/...
app.use(express.static(path.join(__dirname, '..')));
app.use(bodyParser.json());

const dbReady = db && db.ready;

function handleDbError(res, err){
  console.error('Database error', err);
  res.status(500).json({ error: 'Database error', details: err.message });
}

// Basic CRUD endpoints (only enabled if DB loaded)
if(dbReady){
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
