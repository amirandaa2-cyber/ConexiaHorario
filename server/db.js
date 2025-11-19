const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
	console.warn('DATABASE_URL no está definido. La API responderá 503 hasta configurarlo.');
}

const pool = connectionString
	? new Pool({
			connectionString,
			ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
		})
	: null;

async function initializeSchema() {
	if (!pool) {
		return;
	}

	const statements = [
		`CREATE TABLE IF NOT EXISTS carreras (
			id TEXT PRIMARY KEY,
			nombre TEXT,
			totalHoras INTEGER,
			practicaHoras INTEGER,
			teoricaHoras INTEGER,
			colorDiurno TEXT,
			colorVespertino TEXT
		)`,
		`CREATE TABLE IF NOT EXISTS modulos (
			id TEXT PRIMARY KEY,
			nombre TEXT,
			carreraId TEXT,
			horas REAL,
			tipo TEXT
		)`,
		`CREATE TABLE IF NOT EXISTS docentes (
			id TEXT PRIMARY KEY,
			rut TEXT,
			nombre TEXT,
			edad INTEGER,
			estadoCivil TEXT,
			contratoHoras REAL,
			horasAsignadas REAL,
			horasTrabajadas REAL,
			turno TEXT,
			activo BOOLEAN
		)`,
		`CREATE TABLE IF NOT EXISTS salas (
			id TEXT PRIMARY KEY,
			nombre TEXT,
			capacidad INTEGER
		)`,
		`CREATE TABLE IF NOT EXISTS templates (
			id TEXT PRIMARY KEY,
			moduloId TEXT,
			docenteId TEXT,
			salaId TEXT,
			startDate TEXT,
			time TEXT,
			duration REAL,
			until TEXT
		)`,
		`CREATE TABLE IF NOT EXISTS events (
			id TEXT PRIMARY KEY,
			title TEXT,
			start TEXT,
			"end" TEXT,
			extendedProps JSONB
		)`
	];

	for (const statement of statements) {
		await pool.query(statement);
	}
}

initializeSchema().catch((err) => {
	console.error('Error creando las tablas base en PostgreSQL', err);
});

module.exports = {
	pool,
	ready: Boolean(pool),
	query: async (text, params = []) => {
		if (!pool) {
			throw new Error('Pool de PostgreSQL no inicializado.');
		}
		return pool.query(text, params);
	}
};