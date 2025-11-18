const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, 'data.db'));

// initialize tables
db.prepare(`CREATE TABLE IF NOT EXISTS carreras (id TEXT PRIMARY KEY, nombre TEXT, totalHoras INTEGER, practicaHoras INTEGER, teoricaHoras INTEGER, colorDiurno TEXT, colorVespertino TEXT)`).run();
db.prepare(`CREATE TABLE IF NOT EXISTS modulos (id TEXT PRIMARY KEY, nombre TEXT, carreraId TEXT, horas REAL, tipo TEXT)`).run();
db.prepare(`CREATE TABLE IF NOT EXISTS docentes (id TEXT PRIMARY KEY, rut TEXT, nombre TEXT, edad INTEGER, estadoCivil TEXT, contratoHoras REAL, horasAsignadas REAL, horasTrabajadas REAL, turno TEXT, activo INTEGER)`).run();
db.prepare(`CREATE TABLE IF NOT EXISTS salas (id TEXT PRIMARY KEY, nombre TEXT, capacidad INTEGER)`).run();
db.prepare(`CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, moduloId TEXT, docenteId TEXT, salaId TEXT, startDate TEXT, time TEXT, duration REAL, until TEXT)`).run();
db.prepare(`CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, title TEXT, start TEXT, end TEXT, extendedProps TEXT)`).run();

module.exports = db;