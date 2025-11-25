const db = require('../db');

function requireDatabase(req, res, next) {
	if (!db.ready) {
		return res.status(503).json({ error: 'Base de datos no disponible. Define DATABASE_URL para habilitar las APIs.' });
	}
	next();
}

module.exports = requireDatabase;
