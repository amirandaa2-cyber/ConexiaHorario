const catalogService = require('../services/catalogService');

function sendOk(res, payload) {
	res.status(200).json({ data: payload });
}

async function getCarreras(req, res, next) {
	try {
		const carreras = await catalogService.getCarreras();
		sendOk(res, carreras);
	} catch (error) {
		next(error);
	}
}

async function getModulos(req, res, next) {
	try {
		const modulos = await catalogService.getModulos();
		sendOk(res, modulos);
	} catch (error) {
		next(error);
	}
}

async function getDocentes(req, res, next) {
	try {
		const docentes = await catalogService.getDocentes();
		sendOk(res, docentes);
	} catch (error) {
		next(error);
	}
}

async function getSalas(req, res, next) {
	try {
		const salas = await catalogService.getSalas();
		sendOk(res, salas);
	} catch (error) {
		next(error);
	}
}

module.exports = {
	getCarreras,
	getModulos,
	getDocentes,
	getSalas
};
