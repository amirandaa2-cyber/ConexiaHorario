class ServiceError extends Error {
	constructor(message, { statusCode = 500, cause = null } = {}) {
		super(message);
		this.name = 'ServiceError';
		this.statusCode = statusCode;
		if (cause) {
			this.cause = cause;
		}
	}
}

module.exports = ServiceError;
