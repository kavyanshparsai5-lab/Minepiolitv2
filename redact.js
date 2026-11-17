'use strict'
// Removes secrets from any text before it reaches a log, the dashboard or a file.
// Known secrets (passwords the user typed this session) are replaced wherever they
// appear, and auth commands are masked by shape even when the secret is unknown.

const known = new Set()

function remember (secret) {
  if (typeof secret === 'string' && secret.length >= 1) known.add(secret)
}

function forget (secret) { known.delete(secret) }

const AUTH_CMD = /^(\s*\/(?:register|reg|login|l|log|changepassword|changepass|cp|unregister|email)\b)(.*)$/i

function maskAuthCommand (text) {
  const m = AUTH_CMD.exec(text)
  if (!m) return text
  const args = m[2].trim()
  if (!args) return text
  const masked = args.split(/\s+/).map(() => '******').join(' ')
  return `${m[1]} ${masked}`
}

function redact (input) {
  if (input == null) return input
  let text = String(input)
  text = maskAuthCommand(text)
  for (const s of known) {
    if (s.length >= 3) text = text.split(s).join('******')
  }
  // API keys that look like sk-... never leave either
  text = text.replace(/\bsk-[A-Za-z0-9_\-]{8,}\b/g, 'sk-******')
  return text
}

module.exports = { redact, remember, forget, maskAuthCommand }
