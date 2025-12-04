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
		'CREATE EXTENSION IF NOT EXISTS btree_gist',
		`CREATE TABLE IF NOT EXISTS carreras (
			id VARCHAR(50) PRIMARY KEY,
			nombre VARCHAR(255) NOT NULL,
			"jefeCarrera" VARCHAR(255),
			totalHoras INTEGER,
			practicaHoras INTEGER,
			teoricaHoras INTEGER,
			colorDiurno TEXT,
			colorVespertino TEXT
		)`,
		`ALTER TABLE carreras ADD COLUMN IF NOT EXISTS "jefeCarrera" VARCHAR(255)`,
		`ALTER TABLE carreras ADD COLUMN IF NOT EXISTS totalHoras INTEGER`,
		`ALTER TABLE carreras ADD COLUMN IF NOT EXISTS practicaHoras INTEGER`,
		`ALTER TABLE carreras ADD COLUMN IF NOT EXISTS teoricaHoras INTEGER`,
		`ALTER TABLE carreras ADD COLUMN IF NOT EXISTS colorDiurno TEXT`,
		`ALTER TABLE carreras ADD COLUMN IF NOT EXISTS colorVespertino TEXT`,
		`CREATE TABLE IF NOT EXISTS modulos (
			id SERIAL PRIMARY KEY,
			nombre VARCHAR(255) NOT NULL,
			"horasSemana" INTEGER DEFAULT 0,
			nivel INTEGER,
			carrera_id VARCHAR(50) NOT NULL REFERENCES carreras(id) ON DELETE CASCADE,
			codigo_asignatura VARCHAR(50),
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`ALTER TABLE modulos ADD COLUMN IF NOT EXISTS codigo_asignatura VARCHAR(50)`,
		`ALTER TABLE modulos ADD COLUMN IF NOT EXISTS carrera_id VARCHAR(50)`,
		`ALTER TABLE modulos ADD COLUMN IF NOT EXISTS "horasSemana" INTEGER DEFAULT 0`,
		`ALTER TABLE modulos ADD COLUMN IF NOT EXISTS nivel INTEGER`,
		`ALTER TABLE modulos ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
		`ALTER TABLE modulos ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
		`ALTER TABLE modulos DROP CONSTRAINT IF EXISTS fk_modulos_carrera`,
		`ALTER TABLE modulos ADD CONSTRAINT fk_modulos_carrera FOREIGN KEY (carrera_id) REFERENCES carreras(id) ON DELETE CASCADE`,
		`CREATE INDEX IF NOT EXISTS idx_modulos_codigo ON modulos (codigo_asignatura)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_modulos_carrera_codigo ON modulos (carrera_id, LOWER(codigo_asignatura)) WHERE codigo_asignatura IS NOT NULL`,
		`CREATE INDEX IF NOT EXISTS idx_modulos_carrera ON modulos (carrera_id)`,
		`CREATE TABLE IF NOT EXISTS docentes (
			id VARCHAR(50) PRIMARY KEY,
			nombre TEXT NOT NULL,
			email TEXT,
			telefono TEXT,
			turno VARCHAR(20) CHECK (turno IN ('Diurno','Vespertino')),
			contrato_horas NUMERIC(6,2),
			contrato_hora_semanal NUMERIC(6,2),
			carrera_id VARCHAR(50) REFERENCES carreras(id) ON UPDATE CASCADE ON DELETE SET NULL,
			creado_en TIMESTAMPTZ DEFAULT NOW(),
			actualizado_en TIMESTAMPTZ DEFAULT NOW()
		)`,
		`DROP TRIGGER IF EXISTS update_docentes_modtime ON docentes`,
		`DROP FUNCTION IF EXISTS update_modified_column() CASCADE`,
		`CREATE INDEX IF NOT EXISTS idx_docentes_carrera ON docentes (carrera_id)`,
		`CREATE INDEX IF NOT EXISTS idx_docentes_nombre ON docentes (nombre)`,
		`CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
		BEGIN
			NEW.actualizado_en = NOW();
			RETURN NEW;
		END;
		$$ LANGUAGE plpgsql`,
		`DROP TRIGGER IF EXISTS docentes_touch_updated ON docentes`,
		`CREATE TRIGGER docentes_touch_updated BEFORE UPDATE ON docentes FOR EACH ROW EXECUTE FUNCTION touch_updated_at()`,
		`CREATE TABLE IF NOT EXISTS salas (
			id TEXT PRIMARY KEY,
			nombre TEXT,
			capacidad INTEGER
		)`,
		`CREATE TABLE IF NOT EXISTS templates (
			id TEXT PRIMARY KEY,
			moduloId INTEGER REFERENCES modulos(id) ON DELETE CASCADE,
			docenteId VARCHAR(20) REFERENCES docentes(id) ON DELETE SET NULL,
			salaId VARCHAR(50) REFERENCES salas(id) ON DELETE SET NULL,
			startDate DATE,
			time TIME,
			duration REAL,
			until DATE,
			frequency TEXT DEFAULT 'weekly',
			repeat_every INTEGER DEFAULT 1,
			days_of_week SMALLINT[],
			block_start_index INTEGER,
			block_count INTEGER,
			preferred_salas TEXT[],
			status TEXT NOT NULL DEFAULT 'active',
			quota_total INTEGER,
			quota_used INTEGER DEFAULT 0,
			last_run_at TIMESTAMPTZ,
			metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`ALTER TABLE templates ADD COLUMN IF NOT EXISTS frequency TEXT DEFAULT 'weekly'`,
		`ALTER TABLE templates ADD COLUMN IF NOT EXISTS repeat_every INTEGER DEFAULT 1`,
		`ALTER TABLE templates ADD COLUMN IF NOT EXISTS days_of_week SMALLINT[]`,
		`ALTER TABLE templates ADD COLUMN IF NOT EXISTS block_start_index INTEGER`,
		`ALTER TABLE templates ADD COLUMN IF NOT EXISTS block_count INTEGER`,
		`ALTER TABLE templates ADD COLUMN IF NOT EXISTS preferred_salas TEXT[]`,
		`ALTER TABLE templates ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`,
		`ALTER TABLE templates ADD COLUMN IF NOT EXISTS quota_total INTEGER`,
		`ALTER TABLE templates ADD COLUMN IF NOT EXISTS quota_used INTEGER DEFAULT 0`,
		`ALTER TABLE templates ADD COLUMN IF NOT EXISTS last_run_at TIMESTAMPTZ`,
		`ALTER TABLE templates ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb`,
		`CREATE INDEX IF NOT EXISTS idx_templates_modulo ON templates (moduloId)`,
		`CREATE INDEX IF NOT EXISTS idx_templates_docente ON templates (docenteId)`,
		`CREATE INDEX IF NOT EXISTS idx_templates_sala ON templates (salaId)`,
		`CREATE INDEX IF NOT EXISTS idx_templates_status ON templates (status)`,
		`CREATE TABLE IF NOT EXISTS template_blocks (
			id SERIAL PRIMARY KEY,
			template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
			weekday SMALLINT NOT NULL,
			start_block SMALLINT NOT NULL,
			block_count SMALLINT NOT NULL,
			sala_id VARCHAR(50) REFERENCES salas(id) ON DELETE SET NULL,
			metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_template_blocks_template ON template_blocks (template_id)`,
		`CREATE INDEX IF NOT EXISTS idx_template_blocks_weekday ON template_blocks (weekday)`,
		`CREATE TABLE IF NOT EXISTS events (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			start TIMESTAMPTZ NOT NULL,
			"end" TIMESTAMPTZ NOT NULL,
			modulo_id INTEGER REFERENCES modulos(id) ON DELETE CASCADE,
			docente_id VARCHAR(20) REFERENCES docentes(id) ON DELETE SET NULL,
			sala_id VARCHAR(50) REFERENCES salas(id) ON DELETE SET NULL,
			extendedProps JSONB NOT NULL DEFAULT '{}'::jsonb,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_events_start ON events (start)`,
		`CREATE INDEX IF NOT EXISTS idx_events_modulo ON events (modulo_id)`,
		// Natural-key uniqueness to prevent duplicate rows for same timeslot
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_events_natural_key ON events (title, start, "end")`,
		`ALTER TABLE events DROP CONSTRAINT IF EXISTS events_docente_no_overlap`,
		`ALTER TABLE events ADD CONSTRAINT events_docente_no_overlap EXCLUDE USING gist (
			docente_id WITH =,
			tstzrange(start, "end") WITH &&
		) WHERE (docente_id IS NOT NULL)`,
		`ALTER TABLE events DROP CONSTRAINT IF EXISTS events_sala_no_overlap`,
		`ALTER TABLE events ADD CONSTRAINT events_sala_no_overlap EXCLUDE USING gist (
			sala_id WITH =,
			tstzrange(start, "end") WITH &&
		) WHERE (sala_id IS NOT NULL)`,
		// Relación docente_carrera para múltiples pertenencias y activación
		`CREATE TABLE IF NOT EXISTS docente_carrera (
			docente_id VARCHAR(20) REFERENCES docentes(id) ON DELETE CASCADE,
			carrera_id VARCHAR(50) REFERENCES carreras(id) ON DELETE CASCADE,
			activo BOOLEAN NOT NULL DEFAULT TRUE,
			prioridad INTEGER,
			PRIMARY KEY (docente_id, carrera_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_docente_carrera_carrera ON docente_carrera (carrera_id)`,
		`CREATE INDEX IF NOT EXISTS idx_docente_carrera_activo_prioridad ON docente_carrera (carrera_id, activo, prioridad)`,
		`CREATE TABLE IF NOT EXISTS docente_semana_horas (
			docente_id VARCHAR(20) REFERENCES docentes(id) ON DELETE CASCADE,
			semana INTEGER NOT NULL,
			"año" INTEGER NOT NULL,
			bloques_usados INTEGER DEFAULT 0,
			horas_usadas NUMERIC(5,2) GENERATED ALWAYS AS (bloques_usados * 35.0 / 60.0) STORED,
			carrera_id VARCHAR(50) REFERENCES carreras(id) ON DELETE SET NULL,
			PRIMARY KEY (docente_id, semana, "año")
		)`,
		`ALTER TABLE docente_semana_horas ADD COLUMN IF NOT EXISTS carrera_id VARCHAR(50) REFERENCES carreras(id) ON DELETE SET NULL`,
		`CREATE INDEX IF NOT EXISTS idx_docente_semana_carrera ON docente_semana_horas (carrera_id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_docente_semana_scope ON docente_semana_horas (
			docente_id,
			COALESCE(carrera_id, '__global__'),
			semana,
			"año"
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
		try {
			await pool.query(statement);
		} catch (err) {
			console.error('Schema statement failed but continuing to next statement:', statement, err.message || err);
		}
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