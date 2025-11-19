const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

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
		)`,
		`CREATE TABLE IF NOT EXISTS usuarios (
			id BIGSERIAL PRIMARY KEY,
			docente_id BIGINT,
			email VARCHAR(255) NOT NULL UNIQUE,
			username VARCHAR(50) UNIQUE,
			password_hash VARCHAR(255) NOT NULL,
			rol VARCHAR(30) NOT NULL DEFAULT 'docente',
			esta_activo BOOLEAN NOT NULL DEFAULT TRUE,
			ultimo_login TIMESTAMPTZ,
			intentos_fallidos INT NOT NULL DEFAULT 0,
			bloqueo_hasta TIMESTAMPTZ,
			creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
			actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
		)`,
		`CREATE TABLE IF NOT EXISTS login_sessions (
			id UUID PRIMARY KEY,
			usuario_id BIGINT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
			token VARCHAR(255) NOT NULL UNIQUE,
			user_agent TEXT,
			ip_address VARCHAR(45),
			creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
			expira_en TIMESTAMPTZ,
			revocado BOOLEAN NOT NULL DEFAULT FALSE
		)`,
		`CREATE INDEX IF NOT EXISTS idx_login_sessions_usuario ON login_sessions(usuario_id)`,
		`CREATE INDEX IF NOT EXISTS idx_login_sessions_token ON login_sessions(token)`
	];

	for (const statement of statements) {
		await pool.query(statement);
	}

	await ensureSeedAdmin();
}

async function ensureSeedAdmin() {
	const seedEmail = process.env.DEFAULT_ADMIN_EMAIL;
	const seedPassword = process.env.DEFAULT_ADMIN_PASSWORD;
	const seedUsername = process.env.DEFAULT_ADMIN_USERNAME || 'admin';

	if (!seedEmail || !seedPassword) {
		console.warn('DEFAULT_ADMIN_EMAIL o DEFAULT_ADMIN_PASSWORD no están definidos. No se creará un administrador por defecto.');
		return;
	}

	const passwordHash = await bcrypt.hash(seedPassword, 10);
	await pool.query(
		`INSERT INTO usuarios (email, username, password_hash, rol, esta_activo)
		 VALUES ($1, $2, $3, 'admin', TRUE)
		 ON CONFLICT (email) DO NOTHING`,
		[seedEmail, seedUsername, passwordHash]
	);
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