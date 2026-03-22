#!/usr/bin/env bash
# agent-sessions shell hook
# Renames the current Zellij pane to "claude-<pid>" when Claude starts,
# enabling the agent-sessions desktop app to focus it by name.
#
# Installation: add this line to your ~/.zshrc or ~/.bashrc:
#   source ~/.config/agent-sessions/shell-hook.sh
#
# This hook is a no-op outside Zellij ($ZELLIJ is unset).

# ─── Zsh ────────────────────────────────────────────────────────────────────
if [ -n "$ZSH_VERSION" ]; then

  _agent_sessions_preexec() {
    # Only act inside Zellij
    [ -z "$ZELLIJ" ] && return

    local cmd="${1%% *}"  # first word of the command
    if [ "$cmd" = "claude" ]; then
      # Save original pane name so we can restore it on exit
      _agent_sessions_orig_pane_name=$(zellij action dump-screen 2>/dev/null | head -1 || echo "")
      zellij action rename-pane "claude-$$" 2>/dev/null || true
    fi
  }

  _agent_sessions_precmd() {
    [ -z "$ZELLIJ" ] && return
    # Restore pane name after claude exits (only if we renamed it)
    if [ -n "$_agent_sessions_orig_pane_name" ]; then
      zellij action rename-pane "${_agent_sessions_orig_pane_name}" 2>/dev/null || true
      _agent_sessions_orig_pane_name=""
    fi
  }

  autoload -Uz add-zsh-hook 2>/dev/null
  add-zsh-hook preexec _agent_sessions_preexec
  add-zsh-hook precmd  _agent_sessions_precmd

# ─── Bash ───────────────────────────────────────────────────────────────────
elif [ -n "$BASH_VERSION" ]; then

  _agent_sessions_debug_trap() {
    [ -z "$ZELLIJ" ] && return
    local cmd="${BASH_COMMAND%% *}"
    if [ "$cmd" = "claude" ]; then
      # Save original name before renaming so we can restore it on exit.
      # Use the shell's basename as a reliable fallback (e.g. "bash", "zsh").
      _agent_sessions_orig_pane_name="${SHELL##*/}"
      zellij action rename-pane "claude-$$" 2>/dev/null || true
    fi
  }

  _agent_sessions_prompt_command() {
    [ -z "$ZELLIJ" ] && return
    if [ -n "$_agent_sessions_orig_pane_name" ]; then
      zellij action rename-pane "${_agent_sessions_orig_pane_name}" 2>/dev/null || true
      _agent_sessions_orig_pane_name=""
    fi
  }

  trap '_agent_sessions_debug_trap' DEBUG
  PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND; }_agent_sessions_prompt_command"

fi
