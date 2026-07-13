build:
	docker compose -f infra/docker-compose.yml build

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
	cd bots-v1 && ./bots-v1-runner -config config.yaml -scale 5000 -jitter 120

clean-docker:
	docker compose -f infra/docker-compose.yml down --volumes --remove-orphans