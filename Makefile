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

run-swarm: build-bots
	ulimit -n 65535	
	cd bots-v1 && ./bots-v1-runner -config config.yaml -jitter 900 -no-persist -quiet

clean-docker:
	docker compose -f infra/docker-compose.yml down --volumes --remove-orphans

run-swarm-rpi: build-bots
	ulimit -n 65535	
	cd bots-v1 && ./bots-v1-runner -config config.yaml -scale 50000 -jitter 900 -max-active 1500 -active-duration 4m -no-persist -quiet

run-swarm-lite: build-bots
	ulimit -n 65535	
	cd bots-v1 && ./bots-v1-runner -config config.yaml -scale 10000 -jitter 900 -max-active 1000 -active-duration 4m -no-persist -quiet