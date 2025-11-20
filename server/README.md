# Conexia API Server

Express + PostgreSQL backend that powers the Conexia scheduling experience.

## Run locally

1. `cd server`
2. `npm install`
3. Configure environment variables:
	- `DATABASE_URL` (PostgreSQL connection string)
	- `DEFAULT_ADMIN_EMAIL`, `DEFAULT_ADMIN_PASSWORD`, `DEFAULT_ADMIN_USERNAME` (seed admin user)
4. `npm start`

## REST endpoints

- `/api/carreras`
- `/api/modulos`
- `/api/docentes`
- `/api/salas`
- `/api/templates`
- `/api/events`
- `/api/auth/*` (admin login/session helpers)

Each resource supports the usual CRUD verbs (`GET`, `POST`, `PUT`, `DELETE`).

## Notes

- Authentication endpoints secure the admin dashboard; regular collections expect a valid session token.
- SSL is enabled automatically when the `DATABASE_URL` host requires it.
