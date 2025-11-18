const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
let db = null;
try{
	db = require('./db');
}catch(e){
	console.warn('DB not available at server startup (better-sqlite3 missing). API endpoints will return 503.');
}
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
// Serve static files from repository root so examples can be opened via http://localhost:3001/examples/...
app.use(express.static(path.join(__dirname, '..')));
app.use(bodyParser.json());

// Helper to stringify/parse extendedProps
function serialize(obj){ return JSON.stringify(obj || {}); }
function deserialize(str){ try{ return JSON.parse(str||'{}'); }catch(e){ return {}; } }

// Basic CRUD endpoints (only enabled if DB loaded)
if(db){
	app.get('/api/carreras', (req,res)=>{ const rows = db.prepare('SELECT * FROM carreras').all(); res.json(rows); });
	app.post('/api/carreras', (req,res)=>{ const c = req.body; db.prepare('INSERT INTO carreras (id,nombre,totalHoras,practicaHoras,teoricaHoras,colorDiurno,colorVespertino) VALUES (?,?,?,?,?,?,?)').run(c.id||uuidv4(), c.nombre, c.totalHoras||0, c.practicaHoras||0, c.teoricaHoras||0, c.colorDiurno||null, c.colorVespertino||null); res.json({ok:true}); });
	app.put('/api/carreras/:id', (req,res)=>{ const c = req.body; db.prepare('UPDATE carreras SET nombre=?, totalHoras=?, practicaHoras=?, teoricaHoras=?, colorDiurno=?, colorVespertino=? WHERE id=?').run(c.nombre, c.totalHoras||0, c.practicaHoras||0, c.teoricaHoras||0, c.colorDiurno||null, c.colorVespertino||null, req.params.id); res.json({ok:true}); });
	app.delete('/api/carreras/:id', (req,res)=>{ db.prepare('DELETE FROM carreras WHERE id=?').run(req.params.id); res.json({ok:true}); });

	app.get('/api/modulos', (req,res)=>{ res.json(db.prepare('SELECT * FROM modulos').all()); });
	app.post('/api/modulos', (req,res)=>{ const m = req.body; db.prepare('INSERT INTO modulos (id,nombre,carreraId,horas,tipo) VALUES (?,?,?,?,?)').run(m.id||uuidv4(), m.nombre, m.carreraId, m.horas||0, m.tipo||'Teórico'); res.json({ok:true}); });
	app.put('/api/modulos/:id', (req,res)=>{ const m = req.body; db.prepare('UPDATE modulos SET nombre=?, carreraId=?, horas=?, tipo=? WHERE id=?').run(m.nombre, m.carreraId, m.horas||0, m.tipo||'Teórico', req.params.id); res.json({ok:true}); });
	app.delete('/api/modulos/:id', (req,res)=>{ db.prepare('DELETE FROM modulos WHERE id=?').run(req.params.id); res.json({ok:true}); });

	app.get('/api/docentes', (req,res)=>{ res.json(db.prepare('SELECT * FROM docentes').all()); });
	app.post('/api/docentes', (req,res)=>{ const d = req.body; db.prepare('INSERT INTO docentes (id,rut,nombre,edad,estadoCivil,contratoHoras,horasAsignadas,horasTrabajadas,turno,activo) VALUES (?,?,?,?,?,?,?,?,?,?)').run(d.id||uuidv4(), d.rut, d.nombre, d.edad||0, d.estadoCivil||'', d.contratoHoras||0, d.horasAsignadas||0, d.horasTrabajadas||0, d.turno||'Diurno', d.activo?1:0); res.json({ok:true}); });
	app.put('/api/docentes/:id', (req,res)=>{ const d = req.body; db.prepare('UPDATE docentes SET rut=?, nombre=?, edad=?, estadoCivil=?, contratoHoras=?, horasAsignadas=?, horasTrabajadas=?, turno=?, activo=? WHERE id=?').run(d.rut, d.nombre, d.edad||0, d.estadoCivil||'', d.contratoHoras||0, d.horasAsignadas||0, d.horasTrabajadas||0, d.turno||'Diurno', d.activo?1:0, req.params.id); res.json({ok:true}); });
	app.delete('/api/docentes/:id', (req,res)=>{ db.prepare('DELETE FROM docentes WHERE id=?').run(req.params.id); res.json({ok:true}); });

	app.get('/api/salas', (req,res)=>{ res.json(db.prepare('SELECT * FROM salas').all()); });
	app.post('/api/salas', (req,res)=>{ const s = req.body; db.prepare('INSERT INTO salas (id,nombre,capacidad) VALUES (?,?,?)').run(s.id||uuidv4(), s.nombre, s.capacidad||0); res.json({ok:true}); });
	app.put('/api/salas/:id', (req,res)=>{ const s = req.body; db.prepare('UPDATE salas SET nombre=?, capacidad=? WHERE id=?').run(s.nombre, s.capacidad||0, req.params.id); res.json({ok:true}); });
	app.delete('/api/salas/:id', (req,res)=>{ db.prepare('DELETE FROM salas WHERE id=?').run(req.params.id); res.json({ok:true}); });

	app.get('/api/templates', (req,res)=>{ res.json(db.prepare('SELECT * FROM templates').all()); });
	app.post('/api/templates', (req,res)=>{ const t = req.body; db.prepare('INSERT INTO templates (id,moduloId,docenteId,salaId,startDate,time,duration,until) VALUES (?,?,?,?,?,?,?,?)').run(t.id||uuidv4(), t.moduloId, t.docenteId, t.salaId, t.startDate, t.time, t.duration, t.until); res.json({ok:true}); });
	app.put('/api/templates/:id', (req,res)=>{ const t = req.body; db.prepare('UPDATE templates SET moduloId=?, docenteId=?, salaId=?, startDate=?, time=?, duration=?, until=? WHERE id=?').run(t.moduloId, t.docenteId, t.salaId, t.startDate, t.time, t.duration, t.until, req.params.id); res.json({ok:true}); });
	app.delete('/api/templates/:id', (req,res)=>{ db.prepare('DELETE FROM templates WHERE id=?').run(req.params.id); res.json({ok:true}); });

	app.get('/api/events', (req,res)=>{ const rows = db.prepare('SELECT * FROM events').all().map(r=>({id:r.id,title:r.title,start:r.start,end:r.end,extendedProps:deserialize(r.extendedProps)})); res.json(rows); });
	app.post('/api/events', (req,res)=>{ const e = req.body; db.prepare('INSERT INTO events (id,title,start,end,extendedProps) VALUES (?,?,?,?,?)').run(e.id||uuidv4(), e.title, e.start, e.end, serialize(e.extendedProps)); res.json({ok:true}); });
	app.put('/api/events/:id', (req,res)=>{ const e = req.body; db.prepare('UPDATE events SET title=?, start=?, end=?, extendedProps=? WHERE id=?').run(e.title, e.start, e.end, serialize(e.extendedProps), req.params.id); res.json({ok:true}); });
	app.delete('/api/events/:id', (req,res)=>{ db.prepare('DELETE FROM events WHERE id=?').run(req.params.id); res.json({ok:true}); });
} else {
	// DB missing — return 503 for API routes
	app.get('/api/*', (req,res)=>{ res.status(503).json({ error: 'DB not available on server. Install dependencies or run a static server to view examples.' }); });
}

const port = process.env.PORT || 3001;
app.listen(port, ()=>{ console.log('Server listening on', port); });
