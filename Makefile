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

# ---------------------------------------------------------------------------
# Which Apache, and where its modules live.
#
# Homebrew's httpd is preferred when present, for one specific reason on macOS:
# TCC blocks Apple's /usr/sbin/httpd from reading ~/Documents, ~/Desktop and
# ~/Downloads. That surfaces as "Could not open configuration file ...
# Operation not permitted", which looks like a config error but is a permission
# boundary. The Homebrew binary is not covered by that restriction, so the
# project runs wherever it happens to be checked out.
#
# Note also that `httpd` on PATH still resolves to Apple's copy even after
# `brew install httpd` — Homebrew says so in its caveats — which is why this
# uses the absolute path rather than trusting PATH.
#
# Override any of these from the environment if your layout differs.
# ---------------------------------------------------------------------------
BREW_HTTPD := /opt/homebrew/opt/httpd

ifneq ($(wildcard $(BREW_HTTPD)/bin/httpd),)
  HTTPD              ?= $(BREW_HTTPD)/bin/httpd
  APACHE_SERVER_ROOT ?= $(BREW_HTTPD)
  APACHE_MODULE_DIR  ?= $(BREW_HTTPD)/lib/httpd/modules
  APACHE_MIME_TYPES  ?= /opt/homebrew/etc/httpd/mime.types
else ifneq ($(wildcard /usr/libexec/apache2/mod_mpm_event.so),)
  HTTPD              ?= /usr/sbin/httpd
  APACHE_SERVER_ROOT ?= /usr
  APACHE_MODULE_DIR  ?= /usr/libexec/apache2
  APACHE_MIME_TYPES  ?= /private/etc/apache2/mime.types
else
  HTTPD              ?= /usr/sbin/apache2
  APACHE_SERVER_ROOT ?= /etc/apache2
  APACHE_MODULE_DIR  ?= /usr/lib/apache2/modules
  APACHE_MIME_TYPES  ?= /etc/mime.types
endif

export SAFESQUID_ROOT := $(ROOT)
export APACHE_SERVER_ROOT
export APACHE_MODULE_DIR
export APACHE_MIME_TYPES

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
	@echo
	@echo "  Using Apache:  $(HTTPD)"

manifest:
	@./scripts/generate-manifest.sh

serve: manifest
	@mkdir -p logs
	@echo "Apache: $(HTTPD)"
	@echo "Starting on $(BASE)  (Ctrl-C to stop)"
	@"$(HTTPD)" -f "$(ROOT)/httpd.conf" -DFOREGROUND

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
	@"$(HTTPD)" -f "$(ROOT)/httpd.conf" -DFOREGROUND & \
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
