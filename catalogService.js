const db = require('../db');
const ServiceError = require('../utils/ServiceError');

const entityQueries = {
	carreras: `
		SELECT id,
		       nombre,
		       totalHoras AS "totalHoras",
		       practicaHoras AS "practicaHoras",
		       teoricaHoras AS "teoricaHoras",
		       colorDiurno AS "colorDiurno",
		       colorVespertino AS "colorVespertino"
		  FROM carreras
		 ORDER BY nombre ASC` ,
	modulos: `
		SELECT id,
		       nombre,
		       carreraId AS "carreraId",
		       horas,
		       tipo
		  FROM modulos
		 ORDER BY nombre ASC` ,
	docentes: `
		SELECT id,
		       rut,
		       nombre,
		       edad,
		       estadoCivil AS "estadoCivil",
		       contratoHoras AS "contratoHoras",
		       horasAsignadas AS "horasAsignadas",
		       horasTrabajadas AS "horasTrabajadas",
		       turno,
		       activo
		  FROM docentes
		 ORDER BY nombre ASC` ,
	salas: `
		SELECT id,
		       nombre,
		       capacidad,
		       es_restringida AS "esRestringida"
		  FROM salas
		 ORDER BY nombre ASC`
};

async function fetchEntityRows(entity) {
	const query = entityQueries[entity];
	if (!query) {
		throw new ServiceError(`Entidad desconocida: ${entity}`, { statusCode: 400 });
	}
	try {
		const { rows } = await db.query(query);
		return rows;
	} catch (error) {
		throw new ServiceError(`No se pudieron obtener ${entity}`, { cause: error });
	}
}

const getCarreras = () => fetchEntityRows('carreras');
const getModulos = () => fetchEntityRows('modulos');
const getDocentes = () => fetchEntityRows('docentes');
const getSalas = () => fetchEntityRows('salas');

module.exports = {
	getCarreras,
	getModulos,
	getDocentes,
	getSalas
};
