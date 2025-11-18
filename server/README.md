Server scaffold for FullCalendar prototype

How to run:

1. cd server
2. npm install
3. npm start

API endpoints (basic):
- GET /api/carreras
- POST /api/carreras
- PUT /api/carreras/:id
- DELETE /api/carreras/:id

- GET /api/modulos
- POST /api/modulos
- PUT /api/modulos/:id
- DELETE /api/modulos/:id

- GET /api/docentes
- POST /api/docentes
- PUT /api/docentes/:id
- DELETE /api/docentes/:id

- GET /api/salas
- POST /api/salas
- PUT /api/salas/:id
- DELETE /api/salas/:id

- GET /api/templates
- POST /api/templates
- PUT /api/templates/:id
- DELETE /api/templates/:id

- GET /api/events
- POST /api/events
- PUT /api/events/:id
- DELETE /api/events/:id

Notes:
- This is a development scaffold. No authentication included.
- Uses SQLite (better-sqlite3) and creates a local `data.db` file in the server folder.
