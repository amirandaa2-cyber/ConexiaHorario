Server scaffold for FullCalendar prototype

How to run:

1. `cd server`
2. Configure PostgreSQL connection via one of the following:
	- Set `DATABASE_URL=postgres://user:password@host:port/dbname`
	- or provide `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` (defaults: `127.0.0.1:5432`, database `ceduc`, user/password `postgres`).
	- Optional: set `PGSSL=true` to require SSL (set `PGSSL=verify` to enforce certificate validation).
3. `npm install`
4. `npm start`

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
- Uses PostgreSQL and expects the schema defined in the shared DB (tables: carreras, modulos, docentes, salas, templates, events, auth_* ...).
- If the DB is temporarily unavailable the API returns 503 until the connection can be re-established.
