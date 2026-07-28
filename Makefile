build:
	cd frontend && bun run build
	docker compose -f infra/docker-compose.yml build

install:
	cd backend && bun install
	cd frontend && bun install

run:
	docker compose -f infra/docker-compose.yml up -d

seed:
	docker compose -f infra/docker-compose.yml --profile seed run --rm seed
	docker compose -f infra/docker-compose.yml --profile seed run --rm seed-admin

build-bots:
	cd bots-v1 && go build -o bots-v1-runner

run-bots: build-bots
	cd bots-v1 && ./bots-v1-runner -config config.yaml

# Ciudades (demanda urbana): conjunto FIJO de capitales, instancia única (flock),
# login-only contra cuentas sembradas por el backend. Sin -scale ni -no-persist:
# se conserva la sesión (SQLite) para reutilizar la cadena de refresh tokens.
build-bots-ciudad:
	cd bots-ciudad && go build -o bots-ciudad-runner

run-bots-ciudad: build-bots-ciudad
	cd bots-ciudad && ./bots-ciudad-runner -config config.yaml

# Centrales hidroelectricas (ADR-024): parque renovable dedicado. Se autorregistran
# como `transformer` con usernames derivados de --runner-id (UUID v5), asi que se
# puede repartir entre varias maquinas. SIN rotacion a proposito: la industria
# consume electricidad de forma continua y una central que se apaga cada pocos
# minutos no es una central.
build-bots-hidro:
	cd bots-hidro && go build -o bots-hidro-runner

run-bots-hidro: build-bots-hidro
	cd bots-hidro && ./bots-hidro-runner -config config.yaml -jitter 60

run-swarm: build-bots
	ulimit -n 65535	
	cd bots-v1 && ./bots-v1-runner -config config.yaml -jitter 900 -no-persist -quiet

# Reset total: destruye contenedores Y volúmenes. Como las cuentas de los bots
# desaparecen con la base de datos, hay que borrar también el registro de
# quebrados (ADR-026): sus usernames son deterministas y volverían a ser
# registrables, pero el runner los seguiría omitiendo.
clean-docker:
	docker compose -f infra/docker-compose.yml down --volumes --remove-orphans
	rm -f bots-v1/.bots-v1-bankrupt.list bots-hidro/.bots-hidro-bankrupt.list

run-swarm-rpi: build-bots
	ulimit -n 65535	
	cd bots-v1 && ./bots-v1-runner -config config.yaml -scale 50000 -jitter 900 -max-active 1500 -active-duration 4m -no-persist -quiet

run-swarm-lite: build-bots
	ulimit -n 65535	
	cd bots-v1 && ./bots-v1-runner -config config.yaml -scale 10000 -jitter 900 -max-active 1500 -active-duration 4m -no-persist -quiet

clean-sessions:
	rm -rf bots-v1/sessions
	rm -rf bots-hidro/sessions
	rm -rf bots-ciudad/sessions