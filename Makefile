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
	cd bots-v1 && ./bots-v1-runner -config config.yaml -jitter 900

clean-docker:
	docker compose -f infra/docker-compose.yml down --volumes --remove-orphans

run-swarm-rpi: build-bots
	ulimit -n 65535	
	cd bots-v1 && ./bots-v1-runner -config config.yaml -scale 100000 -jitter 60 -max-active 2500 -active-duration 4m -no-persist -quiet