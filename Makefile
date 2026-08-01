# SafeSquid file server
#
# `make serve` is the entry point. It regenerates the manifest and then starts
# Apache, in that order and always together — which is the point. The manifest
# is a cache of the filesystem, and the most likely way to be confused by this
# project is to add a file to storage/ and wonder why the site does not show
# it. Coupling regeneration to startup removes the step you can forget.

SHELL := /bin/bash
ROOT  := $(shell pwd)
PORT  ?= 8081
BASE  ?= http://localhost:$(PORT)

export SAFESQUID_ROOT := $(ROOT)

.PHONY: help serve manifest verify test check stop clean

help:
	@echo "SafeSquid file server"
	@echo
	@echo "  make serve      regenerate the manifest, then run Apache on :$(PORT)"
	@echo "  make manifest   rebuild public/manifest.json from storage/"
	@echo "  make verify     run the security assertions against a running server"
	@echo "  make test       run the manifest generator tests"
	@echo "  make check      manifest + generator tests + security assertions"
	@echo "  make stop       stop a server started by make serve"
	@echo "  make clean      remove generated logs"
	@echo
	@echo "  Override the port with:  make serve PORT=9000"
	@echo "  Client-side assertions:  $(BASE)/tests/"

manifest:
	@./scripts/generate-manifest.sh

serve: manifest
	@mkdir -p logs
	@echo "Apache starting on $(BASE)  (Ctrl-C to stop)"
	@httpd -f "$(ROOT)/httpd.conf" -DFOREGROUND

verify:
	@./scripts/verify-security.sh "$(BASE)"

test:
	@./scripts/test-generate-manifest.sh

# Everything that can be checked without a browser. The client-side assertions
# need a DOM, so they live at /tests/ and are not part of this target.
check: manifest test
	@echo
	@echo "Starting a server to run the security assertions…"
	@mkdir -p logs
	@httpd -f "$(ROOT)/httpd.conf" -DFOREGROUND & \
	 SERVER_PID=$$!; \
	 sleep 2; \
	 ./scripts/verify-security.sh "$(BASE)"; \
	 RESULT=$$?; \
	 kill $$SERVER_PID 2>/dev/null; \
	 exit $$RESULT

stop:
	@if [ -f logs/httpd.pid ]; then \
	   kill "$$(cat logs/httpd.pid)" 2>/dev/null && echo "stopped"; \
	 else \
	   echo "no logs/httpd.pid — nothing to stop"; \
	 fi

clean:
	@rm -f logs/*.log logs/*.pid
	@echo "logs cleared"
