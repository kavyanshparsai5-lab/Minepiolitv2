'use strict'
// Optional: turns free-form text into one MinePilot command using any
// OpenAI-compatible /chat/completions endpoint. Off unless enabled in Settings
// with an API key. The model only picks a command; the deterministic parser
// still decides what actually runs.
const { COMMAND_HELP } = require('./commands')

async function translate (text, { baseUrl, model, apiKey, context }) {
  const system = [
    'You convert a Minecraft player\'s request into exactly ONE bot command.',
    'Allowed commands (reply with the command text only, no quotes, no explanation):',
    ...COMMAND_HELP.map(([c, d]) => `- ${c}  (${d})`),
    'Use Minecraft registry names with spaces, e.g. "mine 3 iron ore", "craft 2 wooden pickaxe".',
    'If the request cannot be expressed with these commands, reply exactly: unknown',
    context ? `Context: ${context}` : ''
  ].join('\n')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, temperature: 0, max_tokens: 40, messages: [{ role: 'system', content: system }, { role: 'user', content: text }] }),
      signal: ctrl.signal
    })
    const body = await res.text()
    if (!res.ok) {
      let msg = body.slice(0, 200)
      try { msg = JSON.parse(body).error.message || msg } catch {}
      throw new Error(`AI service answered ${res.status}: ${msg}`)
    }
    const data = JSON.parse(body)
    const out = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim().split('\n')[0].replace(/^["'`]|["'`]$/g, '').trim()
    return out
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('AI service timed out after 15 s')
    throw e
  } finally { clearTimeout(timer) }
}

module.exports = { translate }
