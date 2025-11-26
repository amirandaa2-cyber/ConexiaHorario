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
		'CREATE EXTENSION IF NOT EXISTS pgcrypto',
		'CREATE EXTENSION IF NOT EXISTS citext',
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
			capacidad INTEGER,
			es_restringida BOOLEAN NOT NULL DEFAULT FALSE
		)`,
		'ALTER TABLE salas ADD COLUMN IF NOT EXISTS es_restringida BOOLEAN NOT NULL DEFAULT FALSE',
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
		`CREATE TABLE IF NOT EXISTS auth_role (
			id SERIAL PRIMARY KEY,
			code TEXT UNIQUE NOT NULL,
			name TEXT NOT NULL,
			description TEXT
		)`,
		`INSERT INTO auth_role (code, name, description) VALUES
			('admin', 'Administrador', 'Acceso completo al panel'),
			('docente', 'Docente', 'Puede consultar/modificar su horario'),
			('viewer', 'Lector', 'Solo lectura de reportes')
		ON CONFLICT (code) DO NOTHING`,
		`CREATE TABLE IF NOT EXISTS auth_user (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			full_name TEXT NOT NULL,
			email CITEXT UNIQUE NOT NULL,
			password_hash TEXT NOT NULL,
			is_active BOOLEAN NOT NULL DEFAULT TRUE,
			must_reset_pwd BOOLEAN NOT NULL DEFAULT FALSE,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_auth_user_email ON auth_user (email)`,
		`CREATE TABLE IF NOT EXISTS auth_user_role (
			user_id UUID REFERENCES auth_user(id) ON DELETE CASCADE,
			role_id INTEGER REFERENCES auth_role(id) ON DELETE CASCADE,
			PRIMARY KEY (user_id, role_id)
		)`,
		`CREATE TABLE IF NOT EXISTS auth_session_token (
			token UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			user_id UUID NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
			issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			expires_at TIMESTAMPTZ NOT NULL,
			metadata JSONB DEFAULT '{}'::jsonb
		)`,
		`CREATE INDEX IF NOT EXISTS idx_session_user ON auth_session_token (user_id)`,
		`CREATE TABLE IF NOT EXISTS auth_login_audit (
			id BIGSERIAL PRIMARY KEY,
			user_id UUID REFERENCES auth_user(id) ON DELETE SET NULL,
			email_input CITEXT NOT NULL,
			ip_address INET,
			user_agent TEXT,
			was_success BOOLEAN NOT NULL,
			reason TEXT,
			occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`
	];

	for (const statement of statements) {
		await pool.query(statement);
	}

	await ensureSeedAdmin();
}

async function ensureSeedAdmin() {
	if (!pool) return;
	const seedEmail = process.env.DEFAULT_ADMIN_EMAIL;
	const seedPassword = process.env.DEFAULT_ADMIN_PASSWORD;
	const seedName = process.env.DEFAULT_ADMIN_NAME || process.env.DEFAULT_ADMIN_USERNAME || 'Administrador Conexia';

	if (!seedEmail || !seedPassword) {
		console.warn('DEFAULT_ADMIN_EMAIL o DEFAULT_ADMIN_PASSWORD no están definidos. No se creará un administrador por defecto.');
		return;
	}

	const existing = await pool.query('SELECT id FROM auth_user WHERE LOWER(email) = LOWER($1) LIMIT 1', [seedEmail]);
	let userId = existing.rows[0]?.id;
	if (!userId) {
		const passwordHash = await bcrypt.hash(seedPassword, 10);
		const inserted = await pool.query(
			'INSERT INTO auth_user (full_name, email, password_hash) VALUES ($1, $2, $3) RETURNING id',
			[seedName, seedEmail, passwordHash]
		);
		userId = inserted.rows[0]?.id;
	}
	if (userId) {
		await pool.query(
			`INSERT INTO auth_user_role (user_id, role_id)
			 SELECT $1, r.id FROM auth_role r WHERE r.code = 'admin'
			 ON CONFLICT DO NOTHING`,
			[userId]
		);
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