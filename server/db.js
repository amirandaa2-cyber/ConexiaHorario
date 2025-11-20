const { Pool } = require('pg');

function resolveSslConfig() {
	const mode = (process.env.PGSSL || '').toLowerCase();
	if (!mode || mode === 'false' || mode === '0') {
		return undefined;
	}
	if (mode === 'require' || mode === 'true') {
		return { rejectUnauthorized: false };
	}
	// Any other truthy value enforces certificate validation
	return { rejectUnauthorized: true };
}

function buildPoolConfig() {
	const ssl = resolveSslConfig();
	if (process.env.DATABASE_URL) {
		return {
			connectionString: process.env.DATABASE_URL,
			ssl
		};
	}

	return {
		host: process.env.PGHOST || '127.0.0.1',
		port: Number(process.env.PGPORT || 5432),
		user: process.env.PGUSER || 'postgres',
		password: process.env.PGPASSWORD || 'postgres',
		database: process.env.PGDATABASE || 'ceduc',
		ssl
	};
}

const pool = new Pool(buildPoolConfig());
pool.on('error', (err) => {
	console.error('[db] Unexpected PostgreSQL error', err);
});

async function ensureConnection() {
	const client = await pool.connect();
	try {
		await client.query('SELECT 1');
	} finally {
		client.release();
	}
}

module.exports = {
	pool,
	query: (text, params) => pool.query(text, params),
	ensureConnection
};