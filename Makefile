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

# --- bots-v2: especializacion por OFICIO (ADR-027) ---------------------------
# Flota nueva, con namespace UUID propio: puede correr A LA VEZ que bots-v1
# contra la misma economia (sus cuentas son disjuntas), que es la forma de
# comparar las dos. Absorbe el parque hidroelectrico como un oficio mas, asi que
# NO se lanza junto a run-bots-hidro salvo que se quiera duplicar generacion.
build-bots-v2:
	cd bots-v2 && go build -o bots-v2-runner

# Los 6 bots de ejemplo de config.yaml (uno por oficio representativo).
run-bots-v2: build-bots-v2
	cd bots-v2 && ./bots-v2-runner -config config.yaml

# Composicion de la flota sin conectar con el servidor: cuantos bots por oficio
# y en que capa arranca cada uno. Util antes de lanzar 10.000 procesos.
plan-swarm-v2: build-bots-v2
	cd bots-v2 && ./bots-v2-runner -dry-run -scale 10000

# El jitter aqui es INTRA-capa: el escalonado entre capas lo fija
# `segundos_por_capa` de oficios.yaml (el agua primero, la industria pesada al
# final), en vez del jitter uniforme de v1.
run-swarm-v2: build-bots-v2
	ulimit -n 65535
	cd bots-v2 && ./bots-v2-runner -config config.yaml -scale 10000 -jitter 60 -no-persist -quiet

# Reset total: destruye contenedores Y volúmenes. Como las cuentas de los bots
# desaparecen con la base de datos, hay que borrar también el registro de
# quebrados (ADR-026): sus usernames son deterministas y volverían a ser
# registrables, pero el runner los seguiría omitiendo.
clean-docker:
	docker compose -f infra/docker-compose.yml down --volumes --remove-orphans
	rm -f bots-v1/.bots-v1-bankrupt.list bots-hidro/.bots-hidro-bankrupt.list bots-v2/.bots-v2-bankrupt.list

run-swarm-rpi: build-bots
	ulimit -n 65535	
	cd bots-v1 && ./bots-v1-runner -config config.yaml -scale 50000 -jitter 900 -max-active 1500 -active-duration 10m -no-persist -quiet

run-swarm-lite: build-bots
	ulimit -n 65535	
	cd bots-v1 && ./bots-v1-runner -config config.yaml -scale 10000 -jitter 900 -max-active 1500 -active-duration 10m -no-persist -quiet

# A propósito NO borra .bots-*-bankrupt.list: la quiebra vive en la DB del
# servidor (ADR-026, el login rechaza quebrados) y borrar la lista con la DB
# viva solo quema logins en cuentas irrecuperables. Solo la resetea clean-docker.
clean-sessions:
	rm -rf bots-v1/sessions
	rm -rf bots-v2/sessions
	rm -rf bots-hidro/sessions
	rm -rf bots-ciudad/sessions