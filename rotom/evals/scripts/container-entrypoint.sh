#!/bin/sh
set -eu

umask 077
mkdir -p "$HOME" "$PI_CODING_AGENT_DIR" "$XDG_CACHE_HOME"

if [ -n "${ROTOM_EVAL_AUTH_SOURCE:-}" ]; then
	cp "$ROTOM_EVAL_AUTH_SOURCE" "$PI_CODING_AGENT_DIR/auth.json"
	chmod 0600 "$PI_CODING_AGENT_DIR/auth.json"
fi

if [ -n "${ROTOM_EVAL_MODELS_SOURCE:-}" ]; then
	cp "$ROTOM_EVAL_MODELS_SOURCE" "$PI_CODING_AGENT_DIR/models.json"
	chmod 0600 "$PI_CODING_AGENT_DIR/models.json"
fi

if [ "${1:-}" = "__infrastructure_test__" ]; then
	shift
	exec /opt/dev-agent-evals/bin/test "$@"
fi

exec /opt/dev-agent-evals/bin/eval "$@"
