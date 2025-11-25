const { Router } = require('express');
const catalogController = require('../controllers/catalogController');

const router = Router();

router.get('/carreras', catalogController.getCarreras);
router.get('/modulos', catalogController.getModulos);
router.get('/docentes', catalogController.getDocentes);
router.get('/salas', catalogController.getSalas);

module.exports = router;
