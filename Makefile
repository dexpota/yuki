SHELL := /bin/sh

VERSION ?=
export VERSION

.PHONY: smoke-release-images
smoke-release-images:
	@set -eu; \
	if ! printf '%s\n' "$${VERSION:-}" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$$'; then \
		echo 'Usage: make smoke-release-images VERSION=MAJOR.MINOR.PATCH' >&2; \
		exit 2; \
	fi; \
	revision=$$(git rev-parse HEAD); \
	created=$$(git show --no-patch --format=%cI HEAD); \
	for specification in backend:backend:production frontend:web:production processor:processor:production backend:supervisor:supervisor; do \
		directory=$${specification%%:*}; \
		image_and_target=$${specification#*:}; \
		image=$${image_and_target%%:*}; \
		target=$${image_and_target#*:}; \
		docker build \
			--file "$$directory/Dockerfile" \
			--target "$$target" \
			--build-arg "VERSION=$$VERSION" \
			--build-arg "REVISION=$$revision" \
			--build-arg "CREATED=$$created" \
			--tag "yuki-$$image:release-smoke" \
			.; \
	done; \
	for role in backend web processor supervisor; do \
		YUKI_EXPECTED_VERSION="$$VERSION" \
		YUKI_EXPECTED_REVISION="$$revision" \
			./deploy/smoke-release-image.sh "$$role" "yuki-$$role:release-smoke"; \
	done; \
	node deploy/smoke-compose-supervisor.mjs \
		yuki-supervisor:release-smoke \
		yuki-backend:release-smoke \
		yuki-processor:release-smoke
