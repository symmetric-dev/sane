#!/bin/bash
# Sane Installation Script
#
# This script:
# 1. Adds ~/.local/bin to PATH by default
# 2. Creates symlinks for all package CLI tools
# 3. Updates shell configuration (.zshrc, .bashrc)
# 4. Optionally installs agent resources from agent/ directory
#
# Agent resources are organized under agent/:
#   agent/skills/   - Workstream skills for AI agents
#   agent/commands/ - Opencode custom slash commands
#   agent/tools/    - MCP tools for AI agents
#   agent/plugins/  - Agent plugins
#   agent/hooks/    - Git and agent hooks
#
# Usage:
#   ~/sane/repo/install.sh [options]
#
# Options:
#   --with-skills     Also install skills to ~/.claude/skills
#   --skills-all      Install skills to all agent directories
#   --skills-only     Only install skills, skip CLI setup
#   --profile NAME    Skill install profile: manual (default) or managed

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
AGENV_HOME="${AGENV_HOME:-$SCRIPT_DIR}"
AGENV_BIN="${AGENV_BIN:-$HOME/.local/bin}"

# Parse arguments
INSTALL_SKILLS="false"
SKILLS_ALL="false"
SKILLS_ONLY="false"
SKILLS_PROFILE="manual"

while [[ $# -gt 0 ]]; do
    case $1 in
        --with-skills)
            INSTALL_SKILLS="true"
            shift
            ;;
        --skills-all)
            INSTALL_SKILLS="true"
            SKILLS_ALL="true"
            shift
            ;;
        --skills-only)
            SKILLS_ONLY="true"
            shift
            ;;
        --profile)
            SKILLS_PROFILE="$2"
            shift 2
            ;;
        *)
            shift
            ;;
    esac
done

# Skip CLI setup if --skills-only
if [ "$SKILLS_ONLY" = "true" ]; then
    cd "$AGENV_HOME" && bun install --silent
    bun run "$AGENV_HOME/packages/cli/bin/sane.ts" install skills --all --profile "$SKILLS_PROFILE"
    exit 0
fi

echo "Installing Sane..."

# Create bin directory
mkdir -p "$AGENV_BIN"

# Remove legacy 'plan' symlink if it exists (migration from planning package)
if [ -L "$AGENV_BIN/plan" ]; then
    echo "Removing legacy plan symlink..."
    rm -f "$AGENV_BIN/plan"
fi

# Create symlink for the main `sane` command from cli package
echo "Creating sane command symlink..."
chmod +x "$AGENV_HOME/packages/cli/bin/sane.ts"
ln -sf "$AGENV_HOME/packages/cli/bin/sane.ts" "$AGENV_BIN/sane"
echo "  sane -> $AGENV_HOME/packages/cli/bin/sane.ts"

# Create symlink for the standalone `work` command from workstreams package
echo "Creating work command symlink..."
chmod +x "$AGENV_HOME/packages/workstreams/bin/work.ts"
ln -sf "$AGENV_HOME/packages/workstreams/bin/work.ts" "$AGENV_BIN/work"
echo "  work -> $AGENV_HOME/packages/workstreams/bin/work.ts"

# Detect shell and config file
detect_shell_config() {
    # Check for zsh (supports /bin/zsh, /usr/bin/zsh, etc.)
    if [ -n "$ZSH_VERSION" ] || [[ "$SHELL" == *zsh ]]; then
        echo "$HOME/.zshrc"
    # Check for bash (supports /bin/bash, /usr/bin/bash, etc.)
    elif [ -n "$BASH_VERSION" ] || [[ "$SHELL" == *bash ]]; then
        if [ -f "$HOME/.bash_profile" ]; then
            echo "$HOME/.bash_profile"
        else
            echo "$HOME/.bashrc"
        fi
    else
        echo "$HOME/.profile"
    fi
}

SHELL_CONFIG=$(detect_shell_config)
EXPORT_LINE="export PATH=\"$AGENV_BIN:\$PATH\""

# Remove the obsolete pre-wrapper checkout PATH entry before adding the stable bin directory.
LEGACY_PATH_LINE='export PATH="$HOME/agenv/bin:$PATH"'
if grep -Fq "$LEGACY_PATH_LINE" "$SHELL_CONFIG" 2>/dev/null; then
    TEMP_CONFIG="$(mktemp)"
    grep -Fv "$LEGACY_PATH_LINE" "$SHELL_CONFIG" > "$TEMP_CONFIG" || true
    mv "$TEMP_CONFIG" "$SHELL_CONFIG"
    echo "Removed obsolete ~/agenv/bin PATH entry from $SHELL_CONFIG"
fi

# Check if the selected bin directory is already configured. The default may
# appear either as an absolute path or as a $HOME-based shell expression.
if grep -Fq "$AGENV_BIN" "$SHELL_CONFIG" 2>/dev/null \
    || { [ "$AGENV_BIN" = "$HOME/.local/bin" ] && grep -Fq '$HOME/.local/bin' "$SHELL_CONFIG" 2>/dev/null; }; then
    echo "PATH already configured in $SHELL_CONFIG"
else
    echo "" >> "$SHELL_CONFIG"
    echo "# AgEnv - AI Agent Environment" >> "$SHELL_CONFIG"
    echo "$EXPORT_LINE" >> "$SHELL_CONFIG"
    echo "Added PATH to $SHELL_CONFIG"
fi

# Remove legacy CLAUDE_ENV_FILE shell config and helper script if present
if grep -q 'CLAUDE_ENV_FILE' "$SHELL_CONFIG" 2>/dev/null; then
    TEMP_CONFIG="$(mktemp)"
    grep -v 'CLAUDE_ENV_FILE' "$SHELL_CONFIG" > "$TEMP_CONFIG" || true
    mv "$TEMP_CONFIG" "$SHELL_CONFIG"
    echo "Removed legacy CLAUDE_ENV_FILE config from $SHELL_CONFIG"
fi

LEGACY_ENV_FILE="$AGENV_HOME/env-setup.sh"
if [ -f "$LEGACY_ENV_FILE" ]; then
    rm -f "$LEGACY_ENV_FILE"
    echo "Removed legacy $LEGACY_ENV_FILE"
fi

# Install bun dependencies if needed
if [ -f "$AGENV_HOME/package.json" ]; then
    echo "Installing dependencies..."
    cd "$AGENV_HOME" && bun install --silent
fi

echo ""
echo "Sane installed successfully!"
echo ""
echo "Available commands:"
echo "  sane                 - Main CLI entry point"
echo "  sane work            - Workstream management"
echo "  sane install skills  - Install skills to agent directories"
echo "  sane install commands - Install slash commands to opencode"
echo "  work                 - Standalone workstream CLI"

# Install skills if requested
if [ "$INSTALL_SKILLS" = "true" ]; then
    echo ""
    if [ "$SKILLS_ALL" = "true" ]; then
        bun run "$AGENV_HOME/packages/cli/bin/sane.ts" install skills --all --profile "$SKILLS_PROFILE"
    else
        bun run "$AGENV_HOME/packages/cli/bin/sane.ts" install skills --claude --profile "$SKILLS_PROFILE"
    fi
fi

echo ""
echo "To use now in this shell, run:"
echo "  export PATH=\"$AGENV_BIN:\$PATH\""
echo "  rehash 2>/dev/null || hash -r 2>/dev/null || true"
echo ""
echo "Or load your shell config:"
echo "  source $SHELL_CONFIG"
echo "  rehash 2>/dev/null || hash -r 2>/dev/null || true"
echo ""
echo "Or restart your terminal."
echo ""
echo "To install skills separately, run:"
echo "  sane install skills --help"
