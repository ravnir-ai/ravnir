# Login shells in a Ravnir box. /root is the bot's persistent home: global npm,
# cargo, go and bun installs land there and survive a reset of the box.
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.cargo/bin:$HOME/go/bin:$HOME/.bun/bin:$PATH"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export CARGO_HOME="$HOME/.cargo"
export GOPATH="$HOME/go"
export BUN_INSTALL="$HOME/.bun"
export DISPLAY="${DISPLAY:-:1}"
export TERM="${TERM:-xterm-256color}"
