/**
 * Terminal emulators that take "run this command in this directory" on their command line, and
 * how each one spells it. Shared by the Linux and macOS launchers: kitty, alacritty, ghostty and
 * wezterm ship on both and take the same flags there.
 */
/**
 * How each terminal wants "run this command in this directory". The command comes after the
 * terminal's own end-of-options marker where it has one, so nothing in it is ever read as a
 * flag; the working directory is also set on the spawn itself, which is all the xterm family
 * needs and what the D-Bus terminals forward to their server anyway.
 *
 * Only terminals whose flags are documented are listed. `tilix` is deliberately absent: its `-e`
 * takes one string that it re-splits itself, which would mean building a shell string.
 */
export const TERMINALS = {
  'gnome-terminal': (dir, cmd) => [`--working-directory=${dir}`, '--', ...cmd],
  kgx: (dir, cmd) => [`--working-directory=${dir}`, '--', ...cmd],
  ptyxis: (dir, cmd) => [`--working-directory=${dir}`, '--', ...cmd],
  konsole: (dir, cmd) => ['--workdir', dir, '-e', ...cmd],
  'xfce4-terminal': (dir, cmd) => [`--working-directory=${dir}`, '-x', ...cmd],
  'mate-terminal': (dir, cmd) => [`--working-directory=${dir}`, '-x', ...cmd],
  kitty: (dir, cmd) => [`--directory=${dir}`, ...cmd],
  alacritty: (dir, cmd) => ['--working-directory', dir, '-e', ...cmd],
  ghostty: (dir, cmd) => [`--working-directory=${dir}`, '-e', ...cmd],
  wezterm: (dir, cmd) => ['start', '--cwd', dir, '--', ...cmd],
  foot: (dir, cmd) => [`--working-directory=${dir}`, ...cmd],
  terminator: (dir, cmd) => [`--working-directory=${dir}`, '-x', ...cmd],
  xterm: (_dir, cmd) => ['-e', ...cmd],
  uxterm: (_dir, cmd) => ['-e', ...cmd],
  urxvt: (_dir, cmd) => ['-e', ...cmd],
  rxvt: (_dir, cmd) => ['-e', ...cmd],
  st: (_dir, cmd) => ['-e', ...cmd],
}

