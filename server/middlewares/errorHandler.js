const ServiceError = require('../utils/ServiceError');

function errorHandler(err, req, res, next) {
	const statusCode = err instanceof ServiceError && err.statusCode ? err.statusCode : err.statusCode || 500;
	const isOperational = err instanceof ServiceError;

	console.error('[API ERROR]', {
		path: req.originalUrl,
		method: req.method,
		statusCode,
		message: err.message,
		stack: isOperational ? undefined : err.stack
	});

	res.status(statusCode).json({
		error: err.message || 'Error interno del servidor',
		statusCode
	});
}

module.exports = errorHandler;
